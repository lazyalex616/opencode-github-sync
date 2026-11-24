import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { childEnv } from "./env.js";
import { writeIfDiffers } from "./fsx.js";
import type { Roots } from "./paths.js";
import { recoveryRoot } from "./recovery.js";
import type { Settings } from "./settings.js";

/**
 * Downloaded skills come from their upstream, not from the sync repository.
 *
 * A skill counts as "upstream" when its record in `~/.agents/.skill-lock.json`
 * was written by the `skills` CLI from a remote source (a `sourceUrl`) and is
 * not taken over locally. Hand-written skills have no lock record. A
 * downloaded skill the user has taken over carries `sourceType: "local"` or a
 * `localOwned` note, in this machine's lock or the repository's; it stays
 * repository-synced and is never touched here.
 *
 * With `upstreamSkills.enabled`, the repository stops carrying upstream
 * skills. What the machines share instead is one small record per skill in
 * `_upstream/<name>.json`: `{ state: "installed" | "removed", at, by, entry }`.
 * One file per skill keeps two machines that change different skills from
 * ever touching the same file.
 *
 * Each reconcile:
 *   1. compares this machine's upstream skills with its own snapshot from the
 *      last run: a new one was installed here, a vanished one was removed here;
 *      both become records, the newest `at` winning;
 *   2. applies the records: installs what is listed and missing (at most a few
 *      per run, failures retried hourly), and moves what was removed elsewhere
 *      into the recovery folder;
 *   3. runs `skills update` for the upstream skills every `updateHours`.
 *
 * Removal never runs `skills remove`: it deletes by name from the real home
 * directory whatever HOME the process was given.
 */

export const UPSTREAM_DIR = "_upstream";
export const UPSTREAM_SNAPSHOT = "opencode-sync-upstream.json";
const SKILL_LOCK = ".skill-lock.json";
const NAME_RE = /^[A-Za-z0-9@][A-Za-z0-9@._-]*$/;
const INSTALL_RETRY_MS = 60 * 60 * 1000;
const MAX_INSTALLS_PER_RUN = 3;

export interface SkillEntry {
  source?: string;
  sourceType?: string;
  sourceUrl?: string;
  ref?: string;
  skillPath?: string;
  updatedAt?: string;
  installedAt?: string;
  localOwned?: unknown;
  [key: string]: unknown;
}

export interface UpstreamRecord {
  state: "installed" | "removed";
  at: string;
  by: string;
  entry?: { source?: string; sourceUrl: string; ref?: string; skillPath?: string };
}

export function isLocalOwned(entry: SkillEntry | undefined): boolean {
  return Boolean(
    entry && (entry.localOwned || entry.sourceType === "local" || entry.source === "local"),
  );
}

export function isUpstreamEntry(entry: SkillEntry | undefined): boolean {
  if (!entry || isLocalOwned(entry)) return false;
  return typeof entry.sourceUrl === "string" && /^https?:\/\//.test(entry.sourceUrl);
}

type Lock = { skills?: Record<string, SkillEntry>; [key: string]: unknown };

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Merge two lock `skills` maps, `primary` winning, except that a taken-over
 * (local-owned) record always beats an upstream one for the same skill: a
 * machine that has not seen the takeover yet must not undo it for everyone.
 */
export function mergeLockSkills(
  primary: Record<string, SkillEntry> = {},
  secondary: Record<string, SkillEntry> = {},
): Record<string, SkillEntry> {
  const out: Record<string, SkillEntry> = { ...secondary, ...primary };
  for (const name of Object.keys(out)) {
    const a = primary[name];
    const b = secondary[name];
    if (a && b && isLocalOwned(b) && !isLocalOwned(a)) out[name] = b;
  }
  return out;
}

export function localLockPath(roots: Roots): string {
  return path.join(path.dirname(roots.agents), SKILL_LOCK);
}

export function readRecords(repoRoot: string): Record<string, UpstreamRecord> {
  const dir = path.join(repoRoot, UPSTREAM_DIR);
  const out: Record<string, UpstreamRecord> = {};
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of names) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -5);
    const rec = readJson<UpstreamRecord>(path.join(dir, file));
    if (NAME_RE.test(name) && rec && (rec.state === "installed" || rec.state === "removed")) {
      out[name] = rec;
    }
  }
  return out;
}

function writeRecord(repoRoot: string, name: string, rec: UpstreamRecord): void {
  writeIfDiffers(
    path.join(repoRoot, UPSTREAM_DIR, `${name}.json`),
    `${JSON.stringify(rec, null, 2)}\n`,
  );
}

/** Skills taken over locally, in this machine's lock or the repository's. */
function takenOver(roots: Roots, repoRoot: string): Set<string> {
  const out = new Set<string>();
  for (const file of [localLockPath(roots), path.join(repoRoot, "_agents", SKILL_LOCK)]) {
    for (const [name, entry] of Object.entries(readJson<Lock>(file)?.skills ?? {})) {
      if (isLocalOwned(entry)) out.add(name);
    }
  }
  return out;
}

/**
 * Names the sync must leave alone in the skills folder: upstream skills of
 * this machine plus every skill the records track. Empty when disabled.
 */
export function upstreamNames(roots: Roots, repoRoot: string, settings: Settings): Set<string> {
  if (!settings.upstreamSkills?.enabled) return new Set();
  const taken = takenOver(roots, repoRoot);
  const names = new Set<string>();
  for (const [name, entry] of Object.entries(readJson<Lock>(localLockPath(roots))?.skills ?? {})) {
    if (NAME_RE.test(name) && isUpstreamEntry(entry) && !taken.has(name)) names.add(name);
  }
  for (const name of Object.keys(readRecords(repoRoot))) if (!taken.has(name)) names.add(name);
  return names;
}

// ── The skills CLI ──────────────────────────────────────────────────────────

export interface CliResult {
  ok: boolean;
  error?: string;
}

function runSkillsCli(args: string[]): CliResult {
  const npxCli = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "npm", "bin", "npx-cli.js")
      : "",
  ].find((f) => f && fs.existsSync(f));
  const [cmd, base] = npxCli
    ? [process.execPath, [npxCli]]
    : [process.platform === "win32" ? "npx.cmd" : "npx", [] as string[]];
  const res = spawnSync(cmd, [...base, "-y", "skills", ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    env: childEnv(),
    shell: !npxCli && process.platform === "win32",
  });
  if (res.status === 0) return { ok: true };
  const text = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^npm notice/.test(l))
    .pop();
  return { ok: false, error: (res.error?.message ?? line ?? `exit ${res.status}`).slice(0, 200) };
}

export interface UpstreamDeps {
  install: (name: string, entry: NonNullable<UpstreamRecord["entry"]>) => CliResult;
  update: (names: string[]) => CliResult;
}

export const defaultUpstreamDeps: UpstreamDeps = {
  install: (name, entry) =>
    runSkillsCli([
      "add",
      entry.ref ? `${entry.sourceUrl}#${entry.ref}` : entry.sourceUrl,
      "-g",
      "-s",
      name,
      "-a",
      "opencode",
      "-y",
    ]),
  update: (names) => runSkillsCli(["update", ...names, "-g", "-y"]),
};

// ── Reconcile ───────────────────────────────────────────────────────────────

interface Snapshot {
  present?: string[];
  lastUpdateAt?: string;
  failures?: Record<string, { at: string; error: string }>;
}

export interface ReconcileSummary {
  recorded: string[];
  installed: string[];
  removed: string[];
  failed: string[];
  updated: boolean;
}

function lockTime(entry: SkillEntry | undefined): number {
  const t = Date.parse(entry?.updatedAt ?? entry?.installedAt ?? "");
  return Number.isFinite(t) ? t : 0;
}

/** Bring this machine and the shared records in line. Never throws. */
export function reconcileUpstream(options: {
  roots: Roots;
  repoRoot: string;
  settings: Settings;
  alias: string;
  now?: number;
  deps?: UpstreamDeps;
}): ReconcileSummary {
  const { roots, repoRoot, settings, alias } = options;
  const now = options.now ?? Date.now();
  const deps = options.deps ?? defaultUpstreamDeps;
  const summary: ReconcileSummary = {
    recorded: [],
    installed: [],
    removed: [],
    failed: [],
    updated: false,
  };
  if (!settings.upstreamSkills?.enabled) return summary;
  try {
    const iso = new Date(now).toISOString();
    const snapshotFile = path.join(roots.data, UPSTREAM_SNAPSHOT);
    const snapshot = readJson<Snapshot>(snapshotFile) ?? {};
    const firstRun = !Array.isArray(snapshot.present);
    const known = new Set(snapshot.present ?? []);
    const failures = snapshot.failures ?? {};
    const records = readRecords(repoRoot);
    const taken = takenOver(roots, repoRoot);
    let lock = readJson<Lock>(localLockPath(roots)) ?? {};
    const present = (): Set<string> =>
      new Set(
        Object.keys(lock.skills ?? {}).filter(
          (n) =>
            NAME_RE.test(n) &&
            !taken.has(n) &&
            isUpstreamEntry(lock.skills?.[n]) &&
            fs.existsSync(path.join(roots.agents, n, "SKILL.md")),
        ),
      );
    let here = present();

    const record = (
      name: string,
      state: UpstreamRecord["state"],
      at: string,
      entry?: UpstreamRecord["entry"],
    ) => {
      const cur = records[name];
      if (cur && Date.parse(cur.at) > Date.parse(at)) return;
      if (cur && cur.state === state && Date.parse(cur.at) === Date.parse(at)) return;
      const rec: UpstreamRecord = { state, at, by: alias, entry: entry ?? cur?.entry };
      records[name] = rec;
      writeRecord(repoRoot, name, rec);
      summary.recorded.push(`${state}:${name}`);
    };

    // 1. What happened on this machine since the last run.
    for (const name of here) {
      if (known.has(name)) continue;
      const cur = records[name];
      if (cur && cur.state === "installed") continue;
      const local = lock.skills?.[name];
      const at = firstRun ? new Date(lockTime(local) || now).toISOString() : iso;
      if (local?.sourceUrl) {
        const entry: UpstreamRecord["entry"] = {
          source: local.source,
          sourceUrl: local.sourceUrl,
          skillPath: local.skillPath,
        };
        if (local.ref) entry.ref = local.ref;
        record(name, "installed", at, entry);
      }
    }
    for (const name of known) {
      if (here.has(name) || taken.has(name)) continue;
      if (records[name]?.state === "installed") record(name, "removed", iso);
    }

    // 2. Apply the records.
    let installs = 0;
    for (const [name, rec] of Object.entries(records)) {
      if (taken.has(name)) continue;
      const dir = path.join(roots.agents, name);
      if (rec.state === "removed" && here.has(name)) {
        // A newer local install of a skill removed long ago wins.
        if (!known.has(name) && Date.parse(rec.at) < lockTime(lock.skills?.[name])) continue;
        try {
          const dest = path.join(
            recoveryRoot(roots),
            `${iso.replace(/[:.]/g, "-")}-upstream-removed`,
            name,
          );
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(dir, dest);
          if (lock.skills) delete lock.skills[name];
          writeIfDiffers(localLockPath(roots), `${JSON.stringify(lock, null, 2)}\n`);
          summary.removed.push(name);
        } catch (err) {
          summary.failed.push(`${name}: ${(err as Error).message}`);
        }
        continue;
      }
      if (rec.state === "installed" && !fs.existsSync(dir) && rec.entry?.sourceUrl) {
        const last = Date.parse(failures[name]?.at ?? "");
        if (Number.isFinite(last) && now - last < INSTALL_RETRY_MS) continue;
        if (installs >= MAX_INSTALLS_PER_RUN) continue;
        installs++;
        const result = deps.install(name, rec.entry);
        if (result.ok && fs.existsSync(path.join(dir, "SKILL.md"))) {
          delete failures[name];
          summary.installed.push(name);
        } else {
          failures[name] = { at: iso, error: result.error ?? "SKILL.md missing after install" };
          summary.failed.push(`${name}: ${failures[name].error}`);
        }
        lock = readJson<Lock>(localLockPath(roots)) ?? {};
      }
    }

    // 3. Periodic update from upstream. Pinned (`ref`) installs stay pinned.
    here = present();
    let lastUpdateAt = snapshot.lastUpdateAt;
    const everyMs = Math.max(1, settings.upstreamSkills.updateHours ?? 24) * 3600_000;
    if (here.size > 0 && (!lastUpdateAt || now - Date.parse(lastUpdateAt) >= everyMs)) {
      const result = deps.update([...here].sort());
      lastUpdateAt = iso;
      summary.updated = result.ok;
      if (!result.ok) summary.failed.push(`update: ${result.error ?? "failed"}`);
      lock = readJson<Lock>(localLockPath(roots)) ?? {};
      here = present();
    }

    fs.mkdirSync(roots.data, { recursive: true });
    writeIfDiffers(
      snapshotFile,
      `${JSON.stringify({ present: [...here].sort(), lastUpdateAt, failures }, null, 2)}\n`,
    );
  } catch (err) {
    summary.failed.push((err as Error).message);
  }
  return summary;
}

export function describeReconcile(summary: ReconcileSummary): string {
  return [
    summary.recorded.length ? `recorded ${summary.recorded.join(", ")}` : "",
    summary.installed.length ? `installed ${summary.installed.join(", ")}` : "",
    summary.removed.length ? `removed ${summary.removed.join(", ")}` : "",
    summary.updated ? "updated from upstream" : "",
    summary.failed.length ? `failed ${summary.failed.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}
