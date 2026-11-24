import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyDirRecursive } from "../src/core/fsx.js";
import { notifyLauncherScript, notifyRegisterScript } from "../src/core/notify.js";
import type { Roots } from "../src/core/paths.js";
import { repoDirFor } from "../src/core/paths.js";
import { DEFAULT_GITATTRIBUTES } from "../src/core/repo.js";
import { defaultSettings, loadSettings, saveSettings, settingsPath } from "../src/core/settings.js";
import { isMachineStatePath } from "../src/core/stage.js";
import { integrateRemote } from "../src/core/sync.js";
import {
  type UpstreamDeps,
  isUpstreamEntry,
  mergeLockSkills,
  readRecords,
  reconcileUpstream,
  upstreamNames,
} from "../src/core/upstream.js";

let sandbox: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-34-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

/** Two clones of one bare remote, with a conflicting edit to `file` on each. */
function conflict(file: string, attributes?: string): { a: string; b: string } {
  const remote = path.join(sandbox, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  const a = path.join(sandbox, "a");
  const b = path.join(sandbox, "b");
  execFileSync("git", ["init", "-b", "main", a], { stdio: "pipe" });
  for (const dir of [a]) {
    gitIn(dir, "config", "user.email", "t@t");
    gitIn(dir, "config", "user.name", "t");
    gitIn(dir, "config", "core.autocrlf", "false");
  }
  if (attributes) write(path.join(a, ".gitattributes"), attributes);
  write(path.join(a, file), "# Notes\n\nbase line\n");
  gitIn(a, "add", "-A");
  gitIn(a, "commit", "-m", "base");
  gitIn(a, "remote", "add", "origin", remote);
  gitIn(a, "push", "-u", "origin", "main");
  execFileSync("git", ["clone", remote, b], { stdio: "pipe" });
  gitIn(b, "config", "user.email", "t@t");
  gitIn(b, "config", "user.name", "t");
  gitIn(b, "config", "core.autocrlf", "false");
  write(path.join(b, file), "# Notes\n\nrewritten by b\n");
  gitIn(b, "commit", "-am", "b");
  gitIn(b, "push");
  write(path.join(a, file), "# Notes\n\nedited by a\n\n## Added by a\n");
  gitIn(a, "commit", "-am", "a");
  return { a, b };
}

describe("push integration", () => {
  it("keeps a conflict already resolved in a local merge commit", () => {
    const { a } = conflict("notes.txt");
    gitIn(a, "fetch", "origin", "main");
    expect(spawnSync("git", ["merge", "origin/main"], { cwd: a }).status).not.toBe(0);
    write(path.join(a, "notes.txt"), "# Notes\n\nedited by a\nrewritten by b\n");
    gitIn(a, "commit", "-am", "resolved by hand");

    integrateRemote(a, "main");
    expect(
      spawnSync("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"], { cwd: a }).status,
    ).toBe(0);
    expect(fs.readFileSync(path.join(a, "notes.txt"), "utf8")).toContain(
      "edited by a\nrewritten by b",
    );
    expect(fs.existsSync(path.join(a, ".git", "rebase-merge"))).toBe(false);
  });

  it("merges skill notes on its own, keeping both sides", () => {
    const file = "_agents/demo/references/lessons-learned.md";
    const { a } = conflict(file, DEFAULT_GITATTRIBUTES);
    integrateRemote(a, "main");
    const merged = fs.readFileSync(path.join(a, file), "utf8");
    expect(merged).toContain("edited by a");
    expect(merged).toContain("rewritten by b");
    expect(merged).toContain("## Added by a");
  });

  it("still stops on a real conflict and names the file", () => {
    const { a } = conflict("opencode.jsonc", DEFAULT_GITATTRIBUTES);
    expect(() => integrateRemote(a, "main")).toThrow(/opencode\.jsonc/);
    expect(fs.existsSync(path.join(a, ".git", "MERGE_HEAD"))).toBe(false);
    expect(fs.existsSync(path.join(a, ".git", "rebase-merge"))).toBe(false);
  });
});

describe("state folder (#13)", () => {
  it("treats locks, pty records and TUI tabs as machine-local at any depth", () => {
    expect(isMachineStatePath("locks", true)).toBe(true);
    expect(isMachineStatePath("a/b/locks", true)).toBe(true);
    expect(isMachineStatePath("pty", true)).toBe(true);
    expect(isMachineStatePath("latest/tui", true)).toBe(true);
    expect(isMachineStatePath("latest/tui/highlights.json", false)).toBe(true);
    expect(isMachineStatePath("x/y.lock", false)).toBe(true);
    expect(isMachineStatePath("model.json", false)).toBe(false);
    expect(isMachineStatePath("latest/models.json", false)).toBe(false);
  });

  it("skips a file another process holds open instead of failing the copy", () => {
    const src = path.join(sandbox, "src");
    write(path.join(src, "kept.json"), "{}");
    write(path.join(src, "busy.json"), "{}");
    const real = fs.copyFileSync;
    vi.spyOn(fs, "copyFileSync").mockImplementation((from, to, mode) => {
      if (String(from).endsWith("busy.json")) {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return real(from, to, mode);
    });
    const skipped: string[] = [];
    const count = copyDirRecursive(src, path.join(sandbox, "dst"), {
      tolerant: true,
      onSkip: (target) => skipped.push(path.basename(target)),
    });
    expect(count).toBe(1);
    expect(skipped).toEqual(["busy.json"]);
    expect(() => copyDirRecursive(src, path.join(sandbox, "dst2"))).toThrow(/not permitted/);
  });
});

describe("shared policy (#14)", () => {
  it("applies the policy, lets the machine override it, and ignores machine identity", () => {
    const root = path.join(sandbox, "config");
    write(
      path.join(repoDirFor(root), "opencode-sync.policy.jsonc"),
      `{ // shared
        "includeState": false,
        "sessions": { "enabled": true },
        "repo": { "url": "https://evil.example/repo.git" },
        "proxy": "http://evil:1"
      }`,
    );
    let s = loadSettings(root);
    expect(s.includeState).toBe(false);
    expect(s.sessions.enabled).toBe(true);
    expect(s.repo.url).toBeUndefined();
    expect(s.proxy).toBe("");

    s.sessions.enabled = false;
    saveSettings(s, root);
    const saved = JSON.parse(fs.readFileSync(settingsPath(root), "utf8"));
    expect(saved.includeState).toBeUndefined();
    expect(saved.sessions.enabled).toBe(false);
    s = loadSettings(root);
    expect(s.sessions.enabled).toBe(false);
    expect(s.includeState).toBe(false);
  });
});

describe("downloaded skills from upstream", () => {
  const GH = (name: string, extra = {}) => ({
    source: `o/${name}`,
    sourceType: "github",
    sourceUrl: `https://github.com/o/${name}.git`,
    skillPath: `skills/${name}/SKILL.md`,
    updatedAt: "2026-11-01T00:00:00Z",
    ...extra,
  });
  const LOCAL = { source: "local", sourceType: "local", localOwned: { reason: "edited here" } };

  function roots(): Roots {
    const base = path.join(sandbox, "m");
    const r: Roots = {
      config: path.join(base, "config"),
      data: path.join(base, "data"),
      state: path.join(base, "state"),
      agents: path.join(base, "agents", "skills"),
      cache: path.join(base, "cache"),
    };
    for (const dir of Object.values(r)) fs.mkdirSync(dir, { recursive: true });
    return r;
  }
  const lockPath = (r: Roots) => path.join(path.dirname(r.agents), ".skill-lock.json");
  const addSkill = (r: Roots, name: string) => write(path.join(r.agents, name, "SKILL.md"), "x");
  const enabled = () => {
    const s = defaultSettings();
    s.upstreamSkills.enabled = true;
    return s;
  };

  it("counts only remote skills that were not taken over", () => {
    expect(isUpstreamEntry(GH("a"))).toBe(true);
    expect(isUpstreamEntry({ ...GH("a"), localOwned: {} })).toBe(false);
    expect(isUpstreamEntry(undefined)).toBe(false);
    expect(mergeLockSkills({ w: GH("w") }, { w: LOCAL }).w).toBe(LOCAL);
    expect(mergeLockSkills({ w: LOCAL }, { w: GH("w") }).w).toBe(LOCAL);
  });

  it("does nothing while switched off", () => {
    const r = roots();
    addSkill(r, "a");
    write(lockPath(r), JSON.stringify({ skills: { a: GH("a") } }));
    expect(upstreamNames(r, r.config, defaultSettings()).size).toBe(0);
    const summary = reconcileUpstream({
      roots: r,
      repoRoot: r.config,
      settings: defaultSettings(),
      alias: "m",
    });
    expect(summary.recorded).toEqual([]);
  });

  it("records, installs, removes and leaves taken-over skills alone", () => {
    const r = roots();
    addSkill(r, "a");
    addSkill(r, "watch");
    write(lockPath(r), JSON.stringify({ skills: { a: GH("a"), watch: LOCAL } }));
    const calls: string[] = [];
    const deps: UpstreamDeps = {
      install: (name) => {
        calls.push(`install:${name}`);
        addSkill(r, name);
        const lock = JSON.parse(fs.readFileSync(lockPath(r), "utf8"));
        lock.skills[name] = GH(name);
        write(lockPath(r), JSON.stringify(lock));
        return { ok: true };
      },
      update: () => {
        calls.push("update");
        return { ok: true };
      },
    };
    const now = Date.now();
    reconcileUpstream({ roots: r, repoRoot: r.config, settings: enabled(), alias: "m", deps, now });
    let records = readRecords(r.config);
    expect(records.a?.state).toBe("installed");
    expect(records.watch).toBeUndefined();
    expect(upstreamNames(r, r.config, enabled()).has("watch")).toBe(false);

    // Another machine installed "b" and removed "a".
    write(
      path.join(r.config, "_upstream", "b.json"),
      JSON.stringify({
        state: "installed",
        at: new Date(now).toISOString(),
        by: "x",
        entry: GH("b"),
      }),
    );
    write(
      path.join(r.config, "_upstream", "a.json"),
      JSON.stringify({ state: "removed", at: new Date(now + 5000).toISOString(), by: "x" }),
    );
    const summary = reconcileUpstream({
      roots: r,
      repoRoot: r.config,
      settings: enabled(),
      alias: "m",
      deps,
      now: now + 10_000,
    });
    expect(summary.installed).toEqual(["b"]);
    expect(summary.removed).toEqual(["a"]);
    expect(fs.existsSync(path.join(r.agents, "a"))).toBe(false);
    expect(fs.existsSync(path.join(r.agents, "watch", "SKILL.md"))).toBe(true);
    expect(calls).toContain("install:b");

    // Uninstalled here: recorded as removed for the others.
    fs.rmSync(path.join(r.agents, "b"), { recursive: true });
    reconcileUpstream({
      roots: r,
      repoRoot: r.config,
      settings: enabled(),
      alias: "m",
      deps,
      now: now + 20_000,
    });
    records = readRecords(r.config);
    expect(records.b?.state).toBe("removed");
  });

  it("retries a failed install at most hourly", () => {
    const r = roots();
    write(lockPath(r), JSON.stringify({ skills: {} }));
    write(
      path.join(r.config, "_upstream", "gone.json"),
      JSON.stringify({
        state: "installed",
        at: "2026-11-01T00:00:00Z",
        by: "x",
        entry: GH("gone"),
      }),
    );
    let calls = 0;
    const deps: UpstreamDeps = {
      install: () => {
        calls++;
        return { ok: false, error: "HTTP 404" };
      },
      update: () => ({ ok: true }),
    };
    const now = Date.now();
    const first = reconcileUpstream({
      roots: r,
      repoRoot: r.config,
      settings: enabled(),
      alias: "m",
      deps,
      now,
    });
    expect(first.failed[0]).toMatch(/HTTP 404/);
    reconcileUpstream({
      roots: r,
      repoRoot: r.config,
      settings: enabled(),
      alias: "m",
      deps,
      now: now + 60_000,
    });
    expect(calls).toBe(1);
    reconcileUpstream({
      roots: r,
      repoRoot: r.config,
      settings: enabled(),
      alias: "m",
      deps,
      now: now + 61 * 60_000,
    });
    expect(calls).toBe(2);
  });
});

describe("notifications from a session without a desktop", () => {
  it("hands the toast to a hidden one-shot task in the user's session", () => {
    const vbs = notifyLauncherScript("TOAST", "C:\\Windows\\powershell.exe");
    expect(vbs).toContain(", 0, False");
    expect(vbs).toContain("-WindowStyle Hidden");
    const reg = notifyRegisterScript("C:\\Users\\O'Brien\\toast.vbs");
    expect(reg).toContain("-LogonType Interactive");
    expect(reg).toContain("wscript.exe");
    expect(reg).toContain("O''Brien");
    expect(reg).toContain("Unregister-ScheduledTask");
  });
});
