import fs from "node:fs";
import path from "node:path";
import { deepMerge, parseJsonc } from "./jsonc.js";
import { OVERRIDES_FILE, overridesPath } from "./settings.js";

/**
 * Per-machine configuration overrides.
 *
 * A synced repository makes every machine identical, which is wrong for the
 * settings that are genuinely machine-specific: a corporate proxy, a local
 * toolchain path, an MCP server that only exists on one box. Overrides restore
 * that freedom by splitting the config into two layers.
 *
 *   working copy `opencode.jsonc`          shared baseline, committed
 *   `~/.config/opencode-sync/overrides.jsonc`  this machine only
 *   ───────────────────────────────────────  deep merge
 *   live `~/.config/opencode/opencode.jsonc`   what OpenCode actually reads
 *
 * Copying the live file into the working copy restores every override-owned
 * key to the value the repository already had (or removes it when the
 * repository never had it), so overridden keys are invisible to sync in both
 * directions. Without overrides the config is copied byte for byte, which keeps
 * comments and formatting untouched.
 */

const CONFIG_FILENAMES = ["opencode.jsonc", "opencode.json"] as const;

/** Locate the OpenCode config file inside a directory, if there is one. */
export function findConfigFile(dir: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function loadOverrides(configRoot: string): Record<string, any> {
  const file = overridesPath(configRoot);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = parseJsonc<Record<string, any>>(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (e) {
    throw new Error(`Cannot read ${OVERRIDES_FILE}: ${(e as Error).message}`);
  }
}

/**
 * Remove override-owned keys from an effective config so it can be pushed.
 *
 * `previous` is the version currently stored in the repository; the values it
 * holds for overridden keys are what gets restored. Keys the repository has
 * never seen are dropped.
 */
export function stripOverrides(
  effective: Record<string, any>,
  overrides: Record<string, any>,
  previous: Record<string, any> | undefined,
): Record<string, any> {
  const result: Record<string, any> = { ...effective };

  for (const [key, overrideValue] of Object.entries(overrides)) {
    const previousValue = previous?.[key];
    const isNestedMerge =
      isPlainObject(overrideValue) && isPlainObject(result[key]) && isPlainObject(previousValue);

    if (isNestedMerge) {
      result[key] = stripOverrides(result[key], overrideValue, previousValue);
      continue;
    }

    if (previous && Object.hasOwn(previous, key)) {
      result[key] = previousValue;
    } else {
      delete result[key];
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Serialise with sorted keys, so comparisons ignore key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The committed form of an effective config text: override-owned keys put
 * back to the repository's values (`previousText`), or removed when the
 * repository never had them. `undefined` when there are no overrides, which
 * means the text is committed byte for byte.
 */
export function repoTextFromEffective(
  effectiveText: string,
  overrides: Record<string, any>,
  previousText: string | undefined,
): string | undefined {
  if (Object.keys(overrides).length === 0) return undefined;
  const effective = parseJsonc<Record<string, any>>(effectiveText);
  const previous = previousText ? parseJsonc<Record<string, any>>(previousText) : undefined;
  return `${JSON.stringify(stripOverrides(effective, overrides, previous), null, 2)}\n`;
}

/** The effective form of a committed config text: overrides merged in. */
export function effectiveTextFromRepo(
  repoText: string,
  overrides: Record<string, any>,
): string | undefined {
  if (Object.keys(overrides).length === 0) return undefined;
  const base = parseJsonc<Record<string, any>>(repoText);
  return `${JSON.stringify(deepMerge(base ?? {}, overrides), null, 2)}\n`;
}

/** True when two config texts hold the same data, ignoring layout and key order. */
export function sameConfigData(a: string, b: string): boolean {
  try {
    return canonical(parseJsonc(a)) === canonical(parseJsonc(b));
  } catch {
    return false;
  }
}
