import fs from "node:fs";
import path from "node:path";
import { parseJsonc } from "./jsonc.js";
import { getConfigRoot } from "./paths.js";

/** Filename of the tool's own settings (local-only, never committed). */
export const SETTINGS_FILE = "opencode-sync.jsonc";
/** Filename of the per-machine OpenCode config patch (local-only). */
export const OVERRIDES_FILE = "opencode-sync.overrides.jsonc";
/**
 * Filename of the shared sync policy. Unlike the settings file it IS
 * committed, so every machine reads the same intended scope (#14). It may
 * only set the keys in `POLICY_KEYS`; machine identity (repository, alias,
 * proxy, language), autosync timing and credential sync stay per machine.
 */
export const POLICY_FILE = "opencode-sync.policy.jsonc";

/** Settings a shared policy may set, as dotted paths. */
export const POLICY_KEYS = [
  "includeSkills",
  "includeState",
  "extraPaths",
  "sessions.enabled",
  "sessions.days",
  "sessions.maxSessions",
  "sessions.maxSessionBytes",
  "sessions.include",
  "sessions.exclude",
  "sessions.directories",
  "categories.config",
  "categories.instructions",
  "categories.agents",
  "categories.commands",
  "categories.plugins",
  "guard.maxFiles",
  "guard.maxBytes",
  "guard.maxFileBytes",
  "guard.skipDirs",
  "upstreamSkills.enabled",
  "upstreamSkills.updateHours",
] as const;

export interface RepoSettings {
  /** Full git remote URL. Takes precedence over owner/name. */
  url?: string;
  owner?: string;
  name?: string;
  branch?: string;
}

export interface SessionSettings {
  /** Master switch. Session sync is opt-in. */
  enabled: boolean;
  /** Only sync sessions touched within this many days. */
  days: number;
  /** Hard cap on how many sessions a single push may export. */
  maxSessions: number;
  /**
   * Skip any single session whose exported payload exceeds this many bytes.
   * Tool output can make one session hundreds of megabytes; without a cap a
   * single runaway session would dominate the repository.
   */
  maxSessionBytes: number;
  /** Explicit session ids to always include, regardless of the time window. */
  include: string[];
  /** Session ids to never export. */
  exclude: string[];
  /** Only export sessions belonging to these project directories. */
  directories: string[];
}

/** Background sync driven by the operating system's scheduler. Machine-local. */
export interface AutosyncSettings {
  /** Opt-in. Only a machine that turned this on ever syncs unattended. */
  enabled: boolean;
  /** Minutes between scheduled runs. Minimum 2. */
  intervalMinutes: number;
  /** Seconds the synced trees must be quiet before a push. */
  settleSeconds: number;
  /** Windows only: register with S4U so it runs while logged off (needs elevation). */
  runWhenLoggedOff: boolean;
  /** Epoch milliseconds; no unattended sync before this moment. 0 = not paused. */
  pausedUntil: number;
  /** Check npm once a day from the scheduled job and upgrade when newer. */
  autoUpdate: boolean;
}

/** Thresholds above which a push needs explicit confirmation. */
export interface GuardSettings {
  /** Maximum number of newly added files in one push. */
  maxFiles: number;
  /** Maximum total size of added and modified files in one push. */
  maxBytes: number;
  /** Maximum size of any single added or modified file. */
  maxFileBytes: number;
  /** Directory names never copied out of synced trees (generated content). */
  skipDirs: string[];
}

/**
 * Which parts of the config directory this machine shares.
 *
 * A category switched off is local to this machine in both directions: its
 * local changes are never committed and incoming versions never replace it.
 */
export interface SyncCategories {
  config: boolean;
  instructions: boolean;
  agents: boolean;
  commands: boolean;
  plugins: boolean;
}

export interface Settings {
  repo: RepoSettings;
  /** Stable alias for this machine used in commit messages. */
  machineAlias?: string;
  /** Sync `auth.json` / `account.json`. Requires a private repository. */
  includeCredentials: boolean;
  /**
   * With credential sync on, let only one machine at a time renew the shared
   * ChatGPT (OpenAI OAuth) login, from the scheduled job. Without it machines
   * that refresh the same login log each other out.
   */
  openaiRefreshLease: boolean;
  /** Sync `~/.agents/skills`. */
  includeSkills: boolean;
  /** Sync `~/.local/state/opencode`. */
  includeState: boolean;
  /** Extra absolute paths to sync, relative to the home directory. */
  extraPaths: string[];
  sessions: SessionSettings;
  /** Pull automatically when OpenCode starts (plugin only). */
  autoPullOnStartup: boolean;
  /** Push automatically when a session goes idle (plugin only). */
  autoPushOnIdle: boolean;
  /** Parts of the config directory to share. */
  categories: SyncCategories;
  autosync: AutosyncSettings;
  guard: GuardSettings;
  /** HTTP(S) proxy for git, gh and npm child processes. Empty = none. */
  proxy: string;
  /** Interface language; empty = auto-detect. */
  language: string;
  /** Desktop notifications from the scheduled job. */
  notifications: boolean;
  /** Downloaded skills come from their upstream instead of the repository. */
  upstreamSkills: UpstreamSkillsSettings;
}

/**
 * Skills installed with the `skills` CLI from a remote source. When enabled,
 * the repository stops carrying them; each machine installs, removes and
 * updates them from upstream, following a small per-skill registry. Skills
 * without a remote lock record, or marked `localOwned`, are never touched.
 * Turn it on for every machine at once, ideally through the shared policy.
 */
export interface UpstreamSkillsSettings {
  enabled: boolean;
  /** Hours between `skills update` runs from the scheduled job. */
  updateHours: number;
}

export const DEFAULT_SKIP_DIRS = ["node_modules", ".venv", "venv", "__pycache__", "dist", ".cache"];

export const DEFAULT_SETTINGS: Settings = {
  repo: { branch: "main" },
  includeCredentials: false,
  openaiRefreshLease: true,
  includeSkills: true,
  includeState: true,
  extraPaths: [],
  sessions: {
    enabled: false,
    days: 7,
    maxSessions: 50,
    maxSessionBytes: 5 * 1024 * 1024,
    include: [],
    exclude: [],
    directories: [],
  },
  autoPullOnStartup: true,
  autoPushOnIdle: false,
  categories: { config: true, instructions: true, agents: true, commands: true, plugins: true },
  autosync: {
    enabled: false,
    intervalMinutes: 5,
    settleSeconds: 60,
    runWhenLoggedOff: false,
    pausedUntil: 0,
    autoUpdate: false,
  },
  guard: {
    maxFiles: 300,
    maxBytes: 10 * 1024 * 1024,
    maxFileBytes: 2 * 1024 * 1024,
    skipDirs: [...DEFAULT_SKIP_DIRS],
  },
  proxy: "",
  language: "",
  notifications: true,
  upstreamSkills: { enabled: false, updateHours: 24 },
};

export const MIN_AUTOSYNC_INTERVAL = 2;

export function settingsPath(configRoot = getConfigRoot()): string {
  return path.join(configRoot, SETTINGS_FILE);
}

export function overridesPath(configRoot = getConfigRoot()): string {
  return path.join(configRoot, OVERRIDES_FILE);
}

function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    repo: { ...base.repo, ...(patch.repo ?? {}) },
    sessions: { ...base.sessions, ...(patch.sessions ?? {}) },
    categories: { ...base.categories, ...(patch.categories ?? {}) },
    autosync: { ...base.autosync, ...(patch.autosync ?? {}) },
    guard: { ...base.guard, ...(patch.guard ?? {}) },
    upstreamSkills: { ...base.upstreamSkills, ...(patch.upstreamSkills ?? {}) },
  };
}

/** A deep copy of the defaults, so callers can mutate the result freely. */
export function defaultSettings(): Settings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
}

export function policyPath(configRoot = getConfigRoot()): string {
  return path.join(configRoot, POLICY_FILE);
}

function getPath(obj: any, key: string): unknown {
  return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function setPath(obj: any, key: string, value: unknown): void {
  const parts = key.split(".");
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cur[part] || typeof cur[part] !== "object") cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1] as string] = value;
}

function deletePath(obj: any, key: string): void {
  const parts = key.split(".");
  const parent = parts
    .slice(0, -1)
    .reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
  if (parent && typeof parent === "object") delete parent[parts[parts.length - 1] as string];
}

/**
 * The shared policy, reduced to the keys a policy may set. Anything else in
 * the file (a repository URL, a proxy) is ignored, so a policy can never
 * point another machine at a different repository. A missing or unreadable
 * file is no policy.
 */
export function loadPolicy(configRoot = getConfigRoot()): Partial<Settings> {
  const file = policyPath(configRoot);
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = parseJsonc(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  const policy: Record<string, unknown> = {};
  for (const key of POLICY_KEYS) {
    const value = getPath(parsed, key);
    if (value !== undefined) setPath(policy, key, value);
  }
  return policy as Partial<Settings>;
}

/**
 * Effective settings: defaults, then the shared policy, then this machine's
 * own file. A value set locally always wins, so a machine can opt out of any
 * part of the policy.
 */
export function loadSettings(configRoot = getConfigRoot()): Settings {
  const withPolicy = mergeSettings(defaultSettings(), loadPolicy(configRoot));
  const file = settingsPath(configRoot);
  if (!fs.existsSync(file)) return withPolicy;
  let parsed: Partial<Settings>;
  try {
    parsed = parseJsonc<Partial<Settings>>(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read ${SETTINGS_FILE}: ${(e as Error).message}`);
  }
  return mergeSettings(withPolicy, parsed ?? {});
}

/** Load, change and save in one step. Returns the saved settings. */
export function updateSettings(
  mutate: (settings: Settings) => void,
  configRoot = getConfigRoot(),
): Settings {
  const settings = loadSettings(configRoot);
  mutate(settings);
  saveSettings(settings, configRoot);
  return settings;
}

/**
 * Save this machine's settings. A value equal to the shared policy is not
 * written, so the machine keeps following the policy when it changes later;
 * only a deliberate local difference is stored (#14).
 */
export function saveSettings(settings: Settings, configRoot = getConfigRoot()): void {
  fs.mkdirSync(configRoot, { recursive: true });
  const policy = loadPolicy(configRoot);
  const out: Settings = JSON.parse(JSON.stringify(settings));
  for (const key of POLICY_KEYS) {
    const shared = getPath(policy, key);
    if (shared !== undefined && JSON.stringify(shared) === JSON.stringify(getPath(out, key))) {
      deletePath(out, key);
    }
  }
  fs.writeFileSync(settingsPath(configRoot), `${JSON.stringify(out, null, 2)}\n`);
}

export function repoUrl(settings: Settings): string | undefined {
  if (process.env.SYNC_REMOTE_URL) return process.env.SYNC_REMOTE_URL;
  if (settings.repo.url) return settings.repo.url;
  if (settings.repo.owner && settings.repo.name) {
    return `https://github.com/${settings.repo.owner}/${settings.repo.name}.git`;
  }
  return undefined;
}

export function repoBranch(settings: Settings): string {
  return settings.repo.branch || "main";
}

/**
 * Idle pushes from inside OpenCode race the scheduled autosync job for the
 * same files, so once autosync owns a machine the plugin keeps only its
 * startup pull.
 */
export function idlePushEnabled(settings: Settings): boolean {
  return settings.autoPushOnIdle && !settings.autosync?.enabled;
}

export const SETTINGS_TEMPLATE = `{
  // opencode-github-sync settings. This file is never committed.
  "repo": {
    "owner": "YOUR_GITHUB_USERNAME",
    "name": "my-opencode-config",
    "branch": "main"
  },

  // A short name for this machine, used in commit messages.
  // Leave unset to auto-generate a stable pseudonym from the hostname.
  // "machineAlias": "laptop",

  // Sync auth.json / account.json. Only enable for a PRIVATE repository.
  "includeCredentials": false,

  "includeSkills": true,
  "includeState": true,

  // Selective session sync. Off by default.
  "sessions": {
    "enabled": false,
    "days": 7,
    "maxSessions": 50,
    "maxSessionBytes": 5242880,
    "include": [],
    "exclude": [],
    "directories": []
  },

  "autoPullOnStartup": true,
  "autoPushOnIdle": false
}
`;

export const OVERRIDES_TEMPLATE = `{
  // Per-machine OpenCode configuration.
  //
  // This file is never committed. After every pull its contents are merged
  // back into opencode.json(c), so machine-specific settings survive syncing.
  //
  // Merge rules:
  //   - objects merge key by key
  //   - arrays and scalars replace whatever is in the shared config
  //   - null deletes the key
  //
  // Example:
  //   "model": "github-copilot/claude-sonnet-4",
  //   "mcp": { "playwright": { "enabled": true } }
}
`;
