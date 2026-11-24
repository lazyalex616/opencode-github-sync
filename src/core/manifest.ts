import fs from "node:fs";
import path from "node:path";
import { CATEGORY_PATHS, type CategoryKey, disabledCategories } from "./categories.js";
import { AGENTS_DIR, DATA_DIR, SESSIONS_DIR, STATE_DIR } from "./paths.js";
import type { Settings } from "./settings.js";

/**
 * Which files of `~/.config/opencode` take part in the sync (#14).
 *
 * Deny by default: a file is synced only when a `+` rule matches it, so a
 * helper script dropped into the folder, or a file a new OpenCode release
 * starts writing there, never reaches the repository unasked.
 *
 * Rules, one per line, last match wins:
 *
 *   +opencode.jsonc     a file at the root
 *   +*.md               `*` stays inside one path segment, so root files only
 *   +agents/            a trailing slash covers the folder and everything below
 *   -agents/scratch/    a later `-` rule takes part of it back out
 *   +themes/**\/*.json  `**` crosses folders
 *
 * Every pattern is anchored at the config folder's root. A line without a
 * sign means `+`. Blank lines and `#` comments are ignored.
 *
 * The shared list is `opencode-sync.manifest` at the root of the repository;
 * without it the built-in `DEFAULT_MANIFEST` applies. Each machine appends its
 * own lines (`manifest` in its settings) and a `-` rule for every category it
 * switched off.
 */

export const MANIFEST_FILE = "opencode-sync.manifest";

/** What OpenCode itself reads from its config folder. */
export const DEFAULT_MANIFEST = [
  "+opencode.json",
  "+opencode.jsonc",
  "+tui.json",
  "+tui.jsonc",
  "+cli.json",
  "+package.json",
  "+*.md",
  "+agent/",
  "+agents/",
  "+command/",
  "+commands/",
  "+plugins/",
  "+tool/",
  "+tools/",
  "+mode/",
  "+modes/",
  "+themes/",
  "+skill/",
  "+skills/",
];

/**
 * Names at the root that are never config, whatever a rule says: the
 * repository's own metadata and mirror folders, OpenCode 2's background
 * service record (it holds a password), and files 3.x kept here.
 */
export const RESERVED_ROOT = new Set([
  ".git",
  ".gitignore",
  ".gitattributes",
  MANIFEST_FILE,
  "opencode-sync.policy.jsonc",
  "opencode-sync.jsonc",
  "opencode-sync.overrides.jsonc",
  ".opencode-sync.lock",
  "service.json",
  "logs",
  AGENTS_DIR,
  DATA_DIR,
  STATE_DIR,
  SESSIONS_DIR,
  "_extra",
  "_upstream",
]);

/** Folder names skipped at any depth. */
const SKIP_ANY_DIR = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", "logs"]);
/** File names skipped at any depth. */
const SKIP_ANY_FILE = new Set([".DS_Store", "Thumbs.db", "desktop.ini", "bun.lock"]);

export interface Rule {
  include: boolean;
  pattern: string;
  regex: RegExp;
}

export type Rules = Rule[];

function escapeRegex(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** Compile one pattern (without its sign) into an anchored regex. */
export function compilePattern(pattern: string): RegExp {
  let p = pattern
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "");
  const dir = p.endsWith("/");
  if (dir) p = p.replace(/\/+$/, "");
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === "*") {
      if (p[i + 1] === "*") {
        const slash = p[i + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(c);
    }
  }
  return new RegExp(dir ? `^${out}(?:/.*)?$` : `^${out}$`, "i");
}

export function parseRules(lines: Iterable<string>): Rules {
  const rules: Rules = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const include = !line.startsWith("-");
    const pattern = line.replace(/^[+-]\s*/, "");
    if (!pattern) continue;
    rules.push({ include, pattern, regex: compilePattern(pattern) });
  }
  return rules;
}

/** `true` / `false` from the last matching rule, `undefined` when none matched. */
export function ruleFor(rules: Rules, rel: string): boolean | undefined {
  const clean = rel.replace(/\\/g, "/");
  let result: boolean | undefined;
  for (const rule of rules) if (rule.regex.test(clean)) result = rule.include;
  return result;
}

export function isReserved(rel: string): boolean {
  const clean = rel.replace(/\\/g, "/");
  const parts = clean.split("/");
  if (RESERVED_ROOT.has(parts[0] as string)) return true;
  const name = parts[parts.length - 1] as string;
  if (SKIP_ANY_FILE.has(name) || name.endsWith(".pyc")) return true;
  return parts.slice(0, -1).some((p) => SKIP_ANY_DIR.has(p));
}

export function isIncluded(rules: Rules, rel: string, skipDirs: Iterable<string> = []): boolean {
  if (isReserved(rel)) return false;
  const skip = new Set(skipDirs);
  if (
    skip.size > 0 &&
    rel
      .replace(/\\/g, "/")
      .split("/")
      .slice(0, -1)
      .some((p) => skip.has(p))
  ) {
    return false;
  }
  return ruleFor(rules, rel) === true;
}

/** `-` rules for the categories this machine switched off. */
export function categoryRules(disabled: CategoryKey[]): string[] {
  const lines: string[] = [];
  for (const key of disabled) {
    const spec = CATEGORY_PATHS[key];
    for (const f of spec.files ?? []) lines.push(`-${f}`);
    for (const d of spec.dirs ?? []) lines.push(`-${d}/`);
    for (const ext of spec.rootExtensions ?? []) lines.push(`-*${ext}`);
  }
  return lines;
}

/** The shared manifest's lines from the working copy, or the default. */
export function sharedManifestLines(repoRoot: string): string[] {
  try {
    return fs.readFileSync(path.join(repoRoot, MANIFEST_FILE), "utf8").split(/\r?\n/);
  } catch {
    return [...DEFAULT_MANIFEST];
  }
}

/** Shared manifest, then this machine's lines, then its switched-off categories. */
export function effectiveRules(repoRoot: string, settings: Settings): Rules {
  return parseRules([
    ...sharedManifestLines(repoRoot),
    ...(settings.manifest ?? []),
    ...categoryRules(disabledCategories(settings.categories)),
  ]);
}

/**
 * Every file below `root` the rules include, as `/`-separated relative paths.
 * Symbolic links are never followed or listed.
 */
export function listIncluded(
  root: string,
  rules: Rules,
  skipDirs: Iterable<string> = [],
): string[] {
  const skip = new Set(skipDirs);
  const out: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > 16) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && RESERVED_ROOT.has(entry.name)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_ANY_DIR.has(entry.name) && !skip.has(entry.name)) walk(child, depth + 1);
        continue;
      }
      if (entry.isFile() && isIncluded(rules, child, skip)) out.push(child);
    }
  };
  walk("", 0);
  return out.sort();
}

/**
 * Entries at the root of the config folder that no rule mentions: files, or
 * folders (with a trailing `/`) holding at least one unmentioned file. A file
 * a `-` rule excludes on purpose is not listed.
 */
export function listUnlisted(
  root: string,
  rules: Rules,
  skipDirs: Iterable<string> = [],
): string[] {
  const skip = new Set(skipDirs);
  const found = new Set<string>();
  const walk = (rel: string, top: string, depth: number): boolean => {
    if (depth > 16) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_ANY_DIR.has(entry.name) || skip.has(entry.name)) continue;
        if (walk(child, top, depth + 1)) return true;
      } else if (entry.isFile() && !isReserved(child) && ruleFor(rules, child) === undefined) {
        found.add(`${top}/`);
        return true;
      }
    }
    return false;
  };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || RESERVED_ROOT.has(entry.name)) continue;
    if (entry.isDirectory()) {
      if (!SKIP_ANY_DIR.has(entry.name) && !skip.has(entry.name)) walk(entry.name, entry.name, 0);
    } else if (
      entry.isFile() &&
      !isReserved(entry.name) &&
      ruleFor(rules, entry.name) === undefined
    ) {
      found.add(entry.name);
    }
  }
  return [...found].sort();
}

/**
 * Manifest lines that keep what a 3.x repository already shared: one `+`
 * entry for each root file or folder it tracked that the default does not
 * cover. Used by the migration so upgrading never silently drops a file.
 */
export function legacyExtras(trackedRootEntries: Iterable<string>): string[] {
  const defaults = parseRules(DEFAULT_MANIFEST);
  const extras: string[] = [];
  for (const entry of trackedRootEntries) {
    const isDir = entry.endsWith("/");
    const name = entry.replace(/\/$/, "");
    if (RESERVED_ROOT.has(name)) continue;
    const probe = isDir ? `${name}/x` : name;
    if (ruleFor(defaults, probe) === true) continue;
    extras.push(isDir ? `+${name}/` : `+${name}`);
  }
  return extras.sort();
}
