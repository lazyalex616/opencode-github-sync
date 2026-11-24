import type { SyncCategories } from "./settings.js";

/**
 * Optional parts of the config directory.
 *
 * Since 4.0 a category switched off becomes `-` rules in this machine's
 * manifest (see `manifest.ts`): its files are never copied into the working
 * copy from here, and incoming versions are never written out here.
 */

export type CategoryKey = keyof SyncCategories;

interface CategoryPaths {
  files?: string[];
  dirs?: string[];
  /** Match root-level files by extension. */
  rootExtensions?: string[];
}

export const CATEGORY_PATHS: Record<CategoryKey, CategoryPaths> = {
  config: { files: ["opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc", "cli.json"] },
  instructions: { rootExtensions: [".md"] },
  agents: { dirs: ["agent", "agents"] },
  commands: { dirs: ["command", "commands"] },
  plugins: { dirs: ["plugin", "plugins"] },
};

export function disabledCategories(categories: SyncCategories | undefined): CategoryKey[] {
  if (!categories) return [];
  return (Object.keys(CATEGORY_PATHS) as CategoryKey[]).filter((key) => categories[key] === false);
}

/** True when a repository-relative path belongs to a disabled category. */
export function isDisabledPath(rel: string, disabled: CategoryKey[]): boolean {
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const key of disabled) {
    const spec = CATEGORY_PATHS[key];
    if (spec.files?.includes(clean)) return true;
    if (spec.dirs?.some((d) => clean === d || clean.startsWith(`${d}/`))) return true;
    if (
      spec.rootExtensions &&
      !clean.includes("/") &&
      spec.rootExtensions.some((ext) => clean.toLowerCase().endsWith(ext))
    ) {
      return true;
    }
  }
  return false;
}
