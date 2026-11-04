import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LEASE_REF,
  LEASE_TTL_MS,
  MARGIN_MS,
  isDue,
  maybeRefreshOpenai,
  refreshInChild,
} from "../src/core/lease.js";
import type { Roots } from "../src/core/paths.js";
import { DEFAULT_SETTINGS, type Settings } from "../src/core/settings.js";

/**
 * The OpenAI refresh lease against a real bare repository. Tokens are fake and
 * the token endpoint is either a stub function or a local HTTP server.
 */

let sandbox: string;
let remote: string;
const NOW = 2_000_000_000_000;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-lease-"));
  remote = path.join(sandbox, "remote.git");
  run(sandbox, "init", "-q", "--bare", "-b", "main", remote);
  // Seed the branch so `origin/main` exists for the published-expiry check.
  const seed = path.join(sandbox, "seed");
  run(sandbox, "clone", "-q", remote, seed);
  fs.writeFileSync(path.join(seed, "README"), "x\n");
  run(seed, "add", "-A");
  run(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  run(seed, "push", "-q", "origin", "main");
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function machine(name: string, expires: number): Roots {
  const base = path.join(sandbox, name);
  const roots: Roots = {
    config: path.join(base, "config"),
    data: path.join(base, "data"),
    state: path.join(base, "state"),
    agents: path.join(base, "agents"),
    cache: path.join(base, "cache"),
  };
  run(sandbox, "clone", "-q", remote, roots.config);
  run(roots.config, "config", "user.name", name);
  run(roots.config, "config", "user.email", `${name}@test`);
  fs.mkdirSync(roots.data, { recursive: true });
  fs.writeFileSync(
    path.join(roots.data, "auth.json"),
    JSON.stringify({
      openai: { type: "oauth", access: "FAKE_A0", refresh: "FAKE_R0", expires },
      other: { type: "api", key: "sk-FAKE-KEEP" },
    }),
  );
  return roots;
}

const settings = (alias: string, patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  includeCredentials: true,
  machineAlias: alias,
  ...patch,
});

const readAuth = (roots: Roots): any =>
  JSON.parse(fs.readFileSync(path.join(roots.data, "auth.json"), "utf8"));

describe("isDue", () => {
  it("is due only inside the margin, using the newest known expiry", () => {
    expect(isDue(NOW, NOW + MARGIN_MS + 1, undefined)).toBe(false);
    expect(isDue(NOW, NOW + MARGIN_MS - 1, undefined)).toBe(true);
    // Someone already published a renewed login: not due here.
    expect(isDue(NOW, NOW + 1, NOW + MARGIN_MS * 2)).toBe(false);
    expect(isDue(NOW, undefined, undefined)).toBe(false);
  });
});

describe("OpenAI refresh lease", () => {
  it("lets exactly one machine refresh, and the other waits", async () => {
    const a = machine("a", NOW + 1000);
    const b = machine("b", NOW + 1000);
    const calls: string[] = [];
    const refresh = (who: string) => async (token: string) => {
      calls.push(`${who}:${token}`);
      return { access_token: "FAKE_A1", refresh_token: "FAKE_R1", expires_in: 864_000 };
    };

    const first = await maybeRefreshOpenai({
      roots: a,
      settings: settings("a"),
      now: () => NOW,
      refresh: refresh("a"),
    });
    const second = await maybeRefreshOpenai({
      roots: b,
      settings: settings("b"),
      now: () => NOW + 1000,
      refresh: refresh("b"),
    });

    expect(first).toMatch(/^claimed; refreshed/);
    expect(second).toBe("held by a");
    expect(calls).toEqual(["a:FAKE_R0"]);
    expect(readAuth(a).openai).toMatchObject({ access: "FAKE_A1", refresh: "FAKE_R1" });
    expect(readAuth(a).other.key).toBe("sk-FAKE-KEEP");
    expect(readAuth(b).openai.refresh).toBe("FAKE_R0");
    expect(run(remote, "rev-parse", "--verify", LEASE_REF)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("takes over a stale claim", async () => {
    const a = machine("a", NOW + 1000);
    const b = machine("b", NOW + 1000);
    const ok = async () => ({ access_token: "FAKE_A1", refresh_token: "FAKE_R1" });
    await maybeRefreshOpenai({ roots: a, settings: settings("a"), now: () => NOW, refresh: ok });

    const later = await maybeRefreshOpenai({
      roots: b,
      settings: settings("b"),
      now: () => NOW + LEASE_TTL_MS + 1,
      refresh: ok,
    });
    expect(later).toMatch(/^claimed; refreshed/);
  });

  it("does nothing when not due, when off, or without credential sync", async () => {
    const a = machine("a", NOW + MARGIN_MS * 2);
    const never = async () => {
      throw new Error("must not be called");
    };
    expect(
      await maybeRefreshOpenai({
        roots: a,
        settings: settings("a"),
        now: () => NOW,
        refresh: never,
      }),
    ).toBe("not due");
    expect(
      await maybeRefreshOpenai({
        roots: a,
        settings: settings("a", { openaiRefreshLease: false }),
        refresh: never,
      }),
    ).toBe("off");
    expect(
      await maybeRefreshOpenai({
        roots: a,
        settings: settings("a", { includeCredentials: false }),
        refresh: never,
      }),
    ).toBe("off");
  });

  it("keeps the old token when the refresh fails, and never prints a token", async () => {
    const a = machine("a", NOW + 1000);
    const outcome = await maybeRefreshOpenai({
      roots: a,
      settings: settings("a"),
      now: () => NOW,
      refresh: async () => {
        throw new Error("HTTP 401");
      },
    });
    expect(outcome).toBe("claimed; refresh failed (HTTP 401)");
    expect(outcome).not.toMatch(/FAKE/);
    expect(readAuth(a).openai.refresh).toBe("FAKE_R0");
  });
});

describe("refreshInChild", () => {
  it("posts the refresh token from a child process and returns the response", async () => {
    let received: any;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        received = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "FAKE_NEW", expires_in: 10 }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const saved = { url: process.env.OPENCODE_OPENAI_TOKEN_URL, noProxy: process.env.NO_PROXY };
    process.env.OPENCODE_OPENAI_TOKEN_URL = `http://127.0.0.1:${port}/token`;
    process.env.NO_PROXY = "127.0.0.1,localhost";
    try {
      const token = await refreshInChild("FAKE_REFRESH");
      expect(token.access_token).toBe("FAKE_NEW");
      expect(received).toMatchObject({
        grant_type: "refresh_token",
        refresh_token: "FAKE_REFRESH",
      });
    } finally {
      if (saved.url === undefined) delete process.env.OPENCODE_OPENAI_TOKEN_URL;
      else process.env.OPENCODE_OPENAI_TOKEN_URL = saved.url;
      if (saved.noProxy === undefined) delete process.env.NO_PROXY;
      else process.env.NO_PROXY = saved.noProxy;
      server.close();
    }
  });
});
