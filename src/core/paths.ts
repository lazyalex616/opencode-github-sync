import os from "node:os";
import path from "node:path";

/**
 * Resolve every directory opencode-github-sync knows about.
 *
 * Each root can be overridden with an environment variable, which is what the
 * test-suite uses to run against a scratch directory instead of the real
 * machine.
 */
export interface Roots {
  /**
   * `~/.config/opencode` — OpenCode's live configuration. Since 4.0 it is no
   * longer a git worktree: listed files are copied to and from the working
   * copy in the tool's own home (see `toolRootFor`).
   */
  config: string;
  /** `~/.local/share/opencode` — auth, account, sqlite database. */
  data: string;
  /** `~/.local/state/opencode` — frecency, kv store, model cache. */
  state: string;
  /** `~/.agents/skills` — skills installed by the `skills` CLI. */
  agents: string;
  /** `~/.cache/opencode` — plugin package cache. */
  cache: string;
}

function xdg(envVar: string, ...fallback: string[]): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ...fallback);
}

export function getConfigRoot(): string {
  if (process.env.SYNC_CONFIG_ROOT) return process.env.SYNC_CONFIG_ROOT;
  return path.join(xdg("XDG_CONFIG_HOME", ".config"), "opencode");
}

export function getDataRoot(): string {
  if (process.env.SYNC_DATA_ROOT) return process.env.SYNC_DATA_ROOT;
  return path.join(xdg("XDG_DATA_HOME", ".local", "share"), "opencode");
}

export function getStateRoot(): string {
  if (process.env.SYNC_STATE_ROOT) return process.env.SYNC_STATE_ROOT;
  return path.join(xdg("XDG_STATE_HOME", ".local", "state"), "opencode");
}

export function getAgentsRoot(): string {
  if (process.env.SYNC_AGENTS_ROOT) return process.env.SYNC_AGENTS_ROOT;
  return path.join(os.homedir(), ".agents", "skills");
}

export function getCacheRoot(): string {
  if (process.env.SYNC_CACHE_ROOT) return process.env.SYNC_CACHE_ROOT;
  return path.join(xdg("XDG_CACHE_HOME", ".cache"), "opencode");
}

export function getRoots(): Roots {
  return {
    config: getConfigRoot(),
    data: getDataRoot(),
    state: getStateRoot(),
    agents: getAgentsRoot(),
    cache: getCacheRoot(),
  };
}

/** Name of the tool's home, a sibling of the OpenCode config directory. */
export const TOOL_DIR_NAME = "opencode-sync";
/** The git working copy inside the tool's home. */
export const REPO_DIR_NAME = "repo";

/**
 * The tool's own home: `~/.config/opencode-sync`, next to the OpenCode config
 * directory. It holds this machine's settings, overrides, runtime state, logs,
 * the sync lock and the git working copy. It is always derived from the config
 * root, so anything that points the config root at a sandbox (tests, CI) gets
 * a sandboxed tool home with it. `SYNC_TOOL_ROOT` overrides it outright.
 */
export function toolRootFor(configRoot: string): string {
  if (process.env.SYNC_TOOL_ROOT) return process.env.SYNC_TOOL_ROOT;
  return path.join(path.dirname(configRoot), TOOL_DIR_NAME);
}

export function toolRoot(roots: Roots): string {
  return toolRootFor(roots.config);
}

/** The git working copy the tool syncs through. Never the live config. */
export function repoDirFor(configRoot: string): string {
  return path.join(toolRootFor(configRoot), REPO_DIR_NAME);
}

export function repoDir(roots: Roots): string {
  return repoDirFor(roots.config);
}

/** Path of the OpenCode SQLite database that holds all sessions. */
export function getDatabasePath(roots: Roots = getRoots()): string {
  return path.join(roots.data, "opencode.db");
}

/** Directory inside the sync repo where session shards are written. */
export const SESSIONS_DIR = "_sessions";
/** Directory inside the sync repo mirroring the OpenCode data root. */
export const DATA_DIR = "_data";
/** Directory inside the sync repo mirroring the OpenCode state root. */
export const STATE_DIR = "_state";
/** Directory inside the sync repo mirroring `~/.agents/skills`. */
export const AGENTS_DIR = "_agents";
