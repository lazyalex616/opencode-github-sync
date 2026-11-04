import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { bridgeCredentials, hasCredentialTable } from "./credentials.js";
import { childEnv } from "./env.js";
import { git } from "./git.js";
import { hostAlias } from "./host.js";
import { DATA_DIR, type Roots, getDatabasePath } from "./paths.js";
import { type Settings, repoBranch } from "./settings.js";
import { sqliteAvailable } from "./sqlite.js";

/**
 * One machine renews the shared ChatGPT (OpenAI OAuth) login, never several.
 *
 * With credential sync on, every machine holds the same OpenAI login. A
 * refresh returns a new refresh token and invalidates the old one, so when two
 * machines refresh the same login the second one is left with a dead token —
 * machines log each other out. This lease makes exactly one machine refresh
 * per expiry window, three days before the token would expire; the next sync
 * carries the new token to everyone else long before they would need it.
 *
 * The lease is a dedicated git ref, `refs/leases/openai`, in the sync
 * repository. Pushing it with `--force-with-lease` is an atomic
 * compare-and-swap on the server: of two machines claiming at the same moment,
 * one push is rejected. The claim never touches a branch or the worktree, so
 * it cannot conflict with an ordinary sync. A claim older than the TTL is
 * stale (its owner crashed or lost the network) and may be taken over.
 *
 * Runs only from the scheduled job, and only when credential sync is on and
 * this machine has an OpenAI login with a refresh token.
 */

export const LEASE_REF = "refs/leases/openai";
export const MARGIN_MS = 3 * 24 * 60 * 60 * 1000;
export const LEASE_TTL_MS = 15 * 60 * 1000;
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface LeaseDeps {
  roots: Roots;
  settings: Settings;
  now?: () => number;
  /** Exchange a refresh token; the default runs in a child process. */
  refresh?: (refreshToken: string) => Promise<TokenResponse>;
}

type AuthMap = Record<string, any>;

function authFile(roots: Roots): string {
  return path.join(roots.data, "auth.json");
}

function readAuth(roots: Roots): AuthMap | undefined {
  try {
    return JSON.parse(fs.readFileSync(authFile(roots), "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

/** Expiry of the OpenAI login in a credential map, or undefined when there is none to renew. */
export function openaiExpiry(auth: AuthMap | undefined): number | undefined {
  const entry = auth?.openai;
  if (!entry || entry.type !== "oauth" || typeof entry.refresh !== "string") return undefined;
  return typeof entry.expires === "number" ? entry.expires : 0;
}

/** Due when neither this machine nor the published copy is safely in date. */
export function isDue(
  now: number,
  live: number | undefined,
  published: number | undefined,
): boolean {
  if (live === undefined) return false;
  return Math.max(live, published ?? 0) - now < MARGIN_MS;
}

function publishedExpiry(root: string, branch: string): number | undefined {
  const shown = git(["show", `origin/${branch}:${DATA_DIR}/auth.json`], { cwd: root });
  if (!shown.ok) return undefined;
  try {
    return openaiExpiry(JSON.parse(shown.stdout));
  } catch {
    return undefined;
  }
}

interface Lease {
  sha: string;
  machine?: string;
  at: number;
}

function readLease(root: string): Lease | undefined {
  const fetched = git(["fetch", "-q", "origin", `+${LEASE_REF}:${LEASE_REF}`], {
    cwd: root,
    timeoutMs: 60_000,
  });
  if (!fetched.ok) {
    if (/couldn't find remote ref|no such ref|not our ref/i.test(fetched.stderr)) {
      git(["update-ref", "-d", LEASE_REF], { cwd: root });
      return undefined;
    }
    throw new Error(`lease fetch failed: ${fetched.stderr.split("\n")[0]}`);
  }
  const sha = git(["rev-parse", LEASE_REF], { cwd: root }).stdout;
  let body: { machine?: string; at?: number } = {};
  try {
    body = JSON.parse(git(["log", "-1", "--format=%B", sha], { cwd: root }).stdout);
  } catch {
    // An unreadable claim counts as stale.
  }
  return { sha, machine: body.machine, at: Number(body.at) || 0 };
}

/** Try to take the lease. True only when this machine's push won the compare-and-swap. */
function claim(root: string, previous: Lease | undefined, machine: string, now: number): boolean {
  const tree = git(["mktree"], { cwd: root });
  if (!tree.ok) return false;
  const message = JSON.stringify({ machine, at: now });
  const commit = git(["commit-tree", tree.stdout, "-m", message], { cwd: root });
  if (!commit.ok) return false;
  const expect = `--force-with-lease=${LEASE_REF}:${previous ? previous.sha : ""}`;
  return git(["push", "-q", expect, "origin", `${commit.stdout}:${LEASE_REF}`], {
    cwd: root,
    timeoutMs: 60_000,
  }).ok;
}

/**
 * Run the token request in a child Node process. Node's built-in `fetch`
 * ignores proxy variables unless `NODE_USE_ENV_PROXY` is set at start-up, and
 * the configured proxy must reach this request like every git call. The
 * refresh token travels on stdin, never on a command line.
 */
const CHILD_SCRIPT = `
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", async () => {
  const { url, body } = JSON.parse(input);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    process.stdout.write(JSON.stringify({ status: r.status, text }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: String(e && e.message || e) }));
  }
});`;

export function refreshInChild(refreshToken: string): Promise<TokenResponse> {
  const url = process.env.OPENCODE_OPENAI_TOKEN_URL || DEFAULT_TOKEN_URL;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", CHILD_SCRIPT], {
      env: childEnv({ NODE_USE_ENV_PROXY: "1" }),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out);
        if (result.error) return reject(new Error(result.error));
        if (result.status < 200 || result.status >= 300) {
          return reject(new Error(`HTTP ${result.status}`));
        }
        const token = JSON.parse(result.text) as TokenResponse;
        if (!token.access_token) return reject(new Error("no access_token in response"));
        resolve(token);
      } catch {
        reject(new Error("no response from the token endpoint"));
      }
    });
    child.stdin.end(
      JSON.stringify({
        url,
        body: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID },
      }),
    );
  });
}

function writeOpenai(roots: Roots, fields: Record<string, unknown>): void {
  // Re-read right before writing so a concurrent change to other providers is kept.
  const current = readAuth(roots) ?? {};
  current.openai = { ...current.openai, ...fields };
  const file = authFile(roots);
  const temp = `${file}.lease-${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** Whether the lease applies to this machine at all. */
export function leaseEnabled(settings: Settings): boolean {
  return settings.includeCredentials && settings.openaiRefreshLease !== false;
}

/**
 * One check. Returns a short outcome for the autosync log; never throws and
 * never includes a token.
 */
export async function maybeRefreshOpenai(deps: LeaseDeps): Promise<string> {
  const { roots, settings } = deps;
  if (!leaseEnabled(settings)) return "off";
  const now = (deps.now ?? Date.now)();
  try {
    const v2 = (await sqliteAvailable()) && (await hasCredentialTable(getDatabasePath(roots)));
    // On OpenCode 2 the database is the newer truth: OpenCode may have
    // refreshed the token by itself since the last sync.
    if (v2) await bridgeCredentials(roots.data, "database", now);

    const auth = readAuth(roots);
    const live = openaiExpiry(auth);
    if (live === undefined) return "no OpenAI login here";
    if (!isDue(now, live, publishedExpiry(roots.config, repoBranch(settings)))) return "not due";

    const machine = hostAlias(settings.machineAlias);
    const lease = readLease(roots.config);
    if (lease && lease.machine !== machine && now - lease.at < LEASE_TTL_MS) {
      return `held by ${lease.machine ?? "another machine"}`;
    }
    if (!claim(roots.config, lease, machine, now)) return "lost the claim to another machine";

    let token: TokenResponse;
    try {
      token = await (deps.refresh ?? refreshInChild)(auth!.openai.refresh);
    } catch (error) {
      return `claimed; refresh failed (${(error as Error).message})`;
    }
    const expires = now + (token.expires_in ?? 864_000) * 1000;
    writeOpenai(roots, {
      access: token.access_token,
      refresh: token.refresh_token ?? auth!.openai.refresh,
      expires,
    });
    if (v2) await bridgeCredentials(roots.data, "file", now);
    return `claimed; refreshed, valid until ${new Date(expires).toISOString()}`;
  } catch (error) {
    return `error (${String((error as Error).message).split("\n")[0]})`;
  }
}
