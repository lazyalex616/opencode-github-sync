import fs from "node:fs";
import path from "node:path";
import { git } from "./git.js";
import { parseJsonc } from "./jsonc.js";
import { DEFAULT_MANIFEST, MANIFEST_FILE, legacyExtras } from "./manifest.js";
import {
  AGENTS_DIR,
  DATA_DIR,
  type Roots,
  SESSIONS_DIR,
  STATE_DIR,
  repoDir,
  toolRoot,
} from "./paths.js";
import { saveToRecovery } from "./recovery.js";
import { DEFAULT_GITATTRIBUTES, DEFAULT_GITIGNORE } from "./repo.js";
import {
  LEGACY_OVERRIDES_FILE,
  LEGACY_SETTINGS_FILE,
  overridesPath,
  settingsPath,
  writeRuntime,
} from "./settings.js";

/**
 * One-time upgrade of a 3.x machine to the 4.0 layout.
 *
 * 3.x made `~/.config/opencode` itself the git worktree and kept its own
 * settings inside it. 4.0 keeps both in `~/.config/opencode-sync`. The move:
 *
 *   1. `config/.git` and the mirror folders (`_agents`, `_state`, ...) are
 *      renamed into `opencode-sync/repo/` (same disk, so nothing is copied),
 *      and the tracked root files are checked out there from the index.
 *   2. The settings, overrides, autosync state and log are copied into the
 *      tool's home.
 *   3. When the repository shared a root file or folder the default manifest
 *      does not list, a manifest keeping it is written, so upgrading never
 *      quietly stops syncing something.
 *   4. The 3.x files left in the config folder (settings, overrides, and the
 *      tool's own `.gitignore` / `.gitattributes`) go to the recovery folder.
 *
 * The live config files are not touched. Anything that fails before step 4
 * is undone, so the machine is left exactly as 3.x had it.
 */

const MIRRORS = [AGENTS_DIR, DATA_DIR, STATE_DIR, SESSIONS_DIR, "_extra", "_upstream"];
const LEGACY_AUTOSYNC_STATE = "opencode-sync-autosync.json";
const LEGACY_LOG = "opencode-sync-autosync.log";

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface MigrationResult {
  movedRepository: boolean;
  manifestWritten: string[];
  recovery?: string;
}

export function needsMigration(roots: Roots): boolean {
  if (fs.existsSync(settingsPath(roots.config))) return false;
  return fs.existsSync(path.join(roots.config, LEGACY_SETTINGS_FILE));
}

/** Upgrade a 3.x machine if it still has the 3.x layout. Cheap when not. */
export function ensureMigrated(roots: Roots): MigrationResult | undefined {
  if (!needsMigration(roots)) return undefined;
  return migrateFrom3x(roots);
}

function sameText(file: string, expected: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") === expected;
  } catch {
    return false;
  }
}

/** Root entries HEAD tracks, folders with a trailing slash. */
function trackedRootEntries(repo: string): string[] {
  const listed = git(["ls-tree", "-z", "HEAD"], { cwd: repo });
  if (!listed.ok) return [];
  return listed.stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [meta = "", name = ""] = record.split("\t");
      return meta.split(" ")[1] === "tree" ? `${name}/` : name;
    })
    .filter((name) => name && name !== "/");
}

export function migrateFrom3x(roots: Roots): MigrationResult | undefined {
  const tool = toolRoot(roots);
  const repo = repoDir(roots);
  fs.mkdirSync(tool, { recursive: true });

  // Two processes starting at once: the second one leaves it to the first.
  const guard = path.join(tool, ".migrating");
  try {
    fs.mkdirSync(guard);
  } catch {
    return undefined;
  }

  const moved: { from: string; to: string }[] = [];
  const created: string[] = [];
  const move = (from: string, to: string): void => {
    fs.renameSync(from, to);
    moved.push({ from, to });
  };
  const copy = (from: string, to: string): void => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    created.push(to);
  };

  const result: MigrationResult = { movedRepository: false, manifestWritten: [] };
  try {
    const legacyGit = path.join(roots.config, ".git");
    if (fs.existsSync(legacyGit)) {
      if (fs.existsSync(repo) && fs.readdirSync(repo).length > 0) {
        throw new MigrationError(`${repo} already exists and is not empty`);
      }
      fs.mkdirSync(repo, { recursive: true });
      move(legacyGit, path.join(repo, ".git"));
      for (const dir of MIRRORS) {
        const from = path.join(roots.config, dir);
        if (fs.existsSync(from)) move(from, path.join(repo, dir));
      }
      // Only what is missing comes back from the index. Files that were
      // edited in the old worktree stay as they are and are shared next push.
      const deleted = git(["ls-files", "--deleted", "-z"], { cwd: repo });
      if (!deleted.ok) throw new MigrationError(deleted.stderr || "git ls-files failed");
      const missing = deleted.stdout.split("\0").filter(Boolean);
      for (let i = 0; i < missing.length; i += 200) {
        const out = git(["checkout", "--", ...missing.slice(i, i + 200)], { cwd: repo });
        if (!out.ok) throw new MigrationError(out.stderr || "git checkout failed");
      }
      result.movedRepository = true;

      if (!fs.existsSync(path.join(repo, MANIFEST_FILE))) {
        const extras = legacyExtras(trackedRootEntries(repo));
        if (extras.length > 0) {
          const text = [
            "# Files of ~/.config/opencode this repository shares (opencode-github-sync 4.0).",
            "# Written on upgrade from 3.x; the last block keeps what 3.x already shared.",
            ...DEFAULT_MANIFEST,
            "",
            "# Shared by 3.x",
            ...extras,
            "",
          ].join("\n");
          fs.writeFileSync(path.join(repo, MANIFEST_FILE), text);
          created.push(path.join(repo, MANIFEST_FILE));
          result.manifestWritten = extras;
        }
      }
    }

    const legacySettings = path.join(roots.config, LEGACY_SETTINGS_FILE);
    copy(legacySettings, settingsPath(roots.config));
    try {
      const paused = Number(
        parseJsonc<Record<string, any>>(fs.readFileSync(legacySettings, "utf8"))?.autosync
          ?.pausedUntil,
      );
      if (Number.isFinite(paused) && paused > Date.now()) {
        writeRuntime(roots.config, { pausedUntil: paused });
      }
    } catch {
      // An unreadable 3.x file is copied as it is; loading it reports the error.
    }
    const legacyOverrides = path.join(roots.config, LEGACY_OVERRIDES_FILE);
    if (fs.existsSync(legacyOverrides)) copy(legacyOverrides, overridesPath(roots.config));

    const legacyState = path.join(roots.state, LEGACY_AUTOSYNC_STATE);
    if (fs.existsSync(legacyState)) {
      try {
        writeRuntime(roots.config, JSON.parse(fs.readFileSync(legacyState, "utf8")));
      } catch {
        // Bookkeeping only: losing it costs one extra attempt.
      }
    }
    const legacyLog = path.join(roots.config, "logs", LEGACY_LOG);
    if (fs.existsSync(legacyLog)) copy(legacyLog, path.join(tool, "logs", LEGACY_LOG));
  } catch (error) {
    for (const file of created.reverse()) fs.rmSync(file, { force: true });
    for (const { from, to } of moved.reverse()) {
      try {
        if (fs.existsSync(to) && !fs.existsSync(from)) fs.renameSync(to, from);
      } catch {
        // Reported below; the paths are in the message.
      }
    }
    fs.rmSync(guard, { recursive: true, force: true });
    throw new MigrationError(
      `Upgrading from 3.x failed and was undone: ${(error as Error).message}\n` +
        `Nothing in ${roots.config} was changed.`,
    );
  }

  // Past this point the new layout is complete; cleanup is best effort.
  const leftovers = [LEGACY_SETTINGS_FILE, LEGACY_OVERRIDES_FILE];
  if (result.movedRepository) {
    if (sameText(path.join(roots.config, ".gitignore"), DEFAULT_GITIGNORE)) {
      leftovers.push(".gitignore");
    }
    if (sameText(path.join(roots.config, ".gitattributes"), DEFAULT_GITATTRIBUTES)) {
      leftovers.push(".gitattributes");
    }
  }
  try {
    result.recovery = saveToRecovery(
      roots,
      "upgrade-from-3x",
      leftovers.map((rel) => ({ source: path.join(roots.config, rel), rel })),
    );
    for (const rel of leftovers) fs.rmSync(path.join(roots.config, rel), { force: true });
    fs.rmSync(path.join(roots.config, "logs", LEGACY_LOG), { force: true });
    fs.rmSync(path.join(roots.state, LEGACY_AUTOSYNC_STATE), { force: true });
    fs.rmSync(path.join(roots.config, ".opencode-sync.lock"), { recursive: true, force: true });
  } catch {
    // Leftover 3.x files are ignored by 4.0.
  }
  fs.rmSync(guard, { recursive: true, force: true });
  return result;
}
