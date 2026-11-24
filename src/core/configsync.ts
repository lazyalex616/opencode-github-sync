import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitBlobId } from "./compare.js";
import { git } from "./git.js";
import { type Rules, effectiveRules, listIncluded } from "./manifest.js";
import {
  effectiveTextFromRepo,
  loadOverrides,
  repoTextFromEffective,
  sameConfigData,
} from "./overrides.js";
import type { Roots } from "./paths.js";
import { saveToRecovery } from "./recovery.js";
import { type Reporter, silentReporter } from "./reporter.js";
import type { Settings } from "./settings.js";
import { cliJsonForRepo } from "./stage.js";

/**
 * Move the listed config files between `~/.config/opencode` and the working
 * copy (4.0, #14).
 *
 * The live folder is never a git worktree any more. Before git runs, the
 * listed files are copied in (`configStageIn`); after git has brought in
 * other machines' work, the result is copied out (`configStageOut`). Files
 * the manifest does not list are never read from or written to the live
 * folder, and are left exactly as they are in the working copy, so a file
 * another machine shares on purpose is not deleted by one that ignores it.
 *
 * Two forms of the same file exist. The live folder holds the effective
 * form: the OpenCode config with this machine's overrides merged in, and
 * `cli.json` with this machine's plugin paths. The working copy holds the
 * shared form. Comparisons are always made in the shared form, by git blob
 * id after CRLF->LF, so line endings never count as a change.
 *
 * Writing out only replaces a live file nobody touched since it was read:
 * the content it had when this run copied it in (`Baseline`), or when
 * nothing was copied in, the version last written out (the stage-out mark).
 * A file edited in between is left alone and wins on the next push.
 */

const CONFIG_FILES = new Set(["opencode.json", "opencode.jsonc"]);

export interface ConfigSyncContext {
  roots: Roots;
  repoRoot: string;
  settings: Settings;
  reporter?: Reporter;
}

/** Blob id of each live file as this run read it; `null` = it was absent. */
export type Baseline = Map<string, string | null>;

export type StageInMode = "normal" | "mirror";
export type StageOutMode = "normal" | "lagging" | "force" | "adopt";

export interface StageOutOptions {
  mode: StageOutMode;
  /** From `configStageIn` in the same run (mode `normal`). */
  baseline?: Baseline;
  /** The last commit written out (mode `lagging`, and deletions in `normal`). */
  mark?: string;
  /** Recovery label for `force` and `adopt`. */
  label?: string;
}

export interface ConfigSyncResult {
  written: string[];
  deleted: string[];
  kept: string[];
  recovery?: string;
}

interface Forms {
  overrides: Record<string, any>;
  head: (rel: string) => string | undefined;
}

function rulesFor(ctx: ConfigSyncContext): Rules {
  return effectiveRules(ctx.repoRoot, ctx.settings);
}

function skipDirs(ctx: ConfigSyncContext): string[] {
  return ctx.settings.guard?.skipDirs ?? [];
}

function read(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function blob(buf: Buffer | null): string | null {
  return buf === null ? null : gitBlobId(buf);
}

function showAt(repoRoot: string, ref: string, rel: string): Buffer | null {
  const id = git(["rev-parse", "--verify", "--quiet", `${ref}:${rel}`], { cwd: repoRoot });
  if (!id.ok || !id.stdout) return null;
  try {
    return Buffer.from(
      execFileSync("git", ["cat-file", "blob", id.stdout], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        maxBuffer: 256 * 1024 * 1024,
      }),
    );
  } catch {
    return null;
  }
}

function formsFor(ctx: ConfigSyncContext): Forms {
  const overrides = loadOverrides(ctx.roots.config);
  const cache = new Map<string, string | undefined>();
  return {
    overrides,
    head: (rel) => {
      if (!cache.has(rel)) {
        const shown = git(["show", `HEAD:${rel}`], { cwd: ctx.repoRoot });
        cache.set(rel, shown.ok ? shown.stdout : undefined);
      }
      return cache.get(rel);
    },
  };
}

function hasOverrides(forms: Forms): boolean {
  return Object.keys(forms.overrides).length > 0;
}

/** The shared form of a live file. */
function sharedForm(rel: string, local: Buffer, forms: Forms, current: Buffer | null): Buffer {
  if (CONFIG_FILES.has(rel) && hasOverrides(forms)) {
    try {
      const previous = forms.head(rel) ?? current?.toString("utf8");
      const text = repoTextFromEffective(local.toString("utf8"), forms.overrides, previous);
      if (text !== undefined) return Buffer.from(text);
    } catch {
      // Unparseable: share it as it is, like 3.x did.
    }
  }
  if (rel === "cli.json") {
    const text = cliJsonForRepo(local.toString("utf8"));
    if (text !== undefined) return Buffer.from(text);
  }
  return local;
}

/** The live form of a shared file. */
function liveForm(rel: string, shared: Buffer, forms: Forms): Buffer {
  if (CONFIG_FILES.has(rel) && hasOverrides(forms)) {
    try {
      const text = effectiveTextFromRepo(shared.toString("utf8"), forms.overrides);
      if (text !== undefined) return Buffer.from(text);
    } catch {
      // Unparseable shared config: write it as it is.
    }
  }
  return shared;
}

/** Whether a live file and a shared file hold the same thing. */
function inSync(rel: string, local: Buffer | null, shared: Buffer | null, forms: Forms): boolean {
  if (local === null || shared === null) return local === shared;
  const mine = sharedForm(rel, local, forms, shared);
  if (blob(mine) === blob(shared)) return true;
  if ((CONFIG_FILES.has(rel) && hasOverrides(forms)) || rel === "cli.json") {
    return sameConfigData(mine.toString("utf8"), shared.toString("utf8"));
  }
  return false;
}

function writeFile(file: string, content: Buffer, atomic: boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!atomic) {
    fs.writeFileSync(file, content);
    return;
  }
  // OpenCode may be reading the file right now: write aside, then swap.
  const tmp = `${file}.opencode-sync-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, content);
  }
}

/** Remove a file, then any folders it leaves empty, up to `root`. */
function removeFile(root: string, rel: string): void {
  fs.rmSync(path.join(root, rel), { force: true });
  let dir = path.dirname(path.join(root, rel));
  const top = path.resolve(root);
  while (path.resolve(dir).startsWith(top) && path.resolve(dir) !== top) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

function treeFiles(repoRoot: string, ref: string | undefined): Set<string> | undefined {
  if (!ref) return undefined;
  const listed = git(["ls-tree", "-r", "-z", "--name-only", ref], { cwd: repoRoot });
  if (!listed.ok) return undefined;
  return new Set(listed.stdout.split("\0").filter(Boolean));
}

/**
 * Copy the listed live files into the working copy, in their shared form.
 *
 * A listed file missing from the live folder is deleted from the working copy
 * only when it was written out before (it is in `mark`), which is what a local
 * deletion looks like, or in `mirror` mode (a forced push, or a first link
 * where this machine wins). Without a mark nothing is deleted.
 */
export function configStageIn(
  ctx: ConfigSyncContext,
  mode: StageInMode = "normal",
  mark?: string,
): ConfigSyncResult & { baseline: Baseline } {
  const rules = rulesFor(ctx);
  const forms = formsFor(ctx);
  const reporter = ctx.reporter ?? silentReporter;
  const baseline: Baseline = new Map();
  const result = { written: [] as string[], deleted: [] as string[], kept: [] as string[] };

  const local = listIncluded(ctx.roots.config, rules, skipDirs(ctx));
  const localSet = new Set(local);
  for (const rel of local) {
    const buf = read(path.join(ctx.roots.config, rel));
    if (buf === null) continue;
    baseline.set(rel, blob(buf));
    const target = path.join(ctx.repoRoot, rel);
    const current = read(target);
    if (inSync(rel, buf, current, forms)) continue;
    writeFile(target, sharedForm(rel, buf, forms, current), false);
    result.written.push(rel);
  }

  let marked: Set<string> | undefined;
  for (const rel of listIncluded(ctx.repoRoot, rules, skipDirs(ctx))) {
    if (localSet.has(rel)) continue;
    baseline.set(rel, null);
    if (mode !== "mirror") {
      marked ??= treeFiles(ctx.repoRoot, mark) ?? new Set();
      if (!marked.has(rel)) {
        result.kept.push(rel);
        continue;
      }
    }
    removeFile(ctx.repoRoot, rel);
    result.deleted.push(rel);
  }

  if (result.written.length + result.deleted.length > 0) {
    reporter.detail(
      `Config: ${result.written.length} changed, ${result.deleted.length} removed on this machine`,
    );
  }
  return { ...result, baseline };
}

/**
 * Write the working copy's listed files out to the live folder.
 *
 *   normal   after git integrated other machines' work in this run: a live
 *            file is replaced or removed only if it still has the content
 *            `configStageIn` read; a file that did not exist then is created.
 *   lagging  an earlier run stopped between integrating and writing out:
 *            only files that changed since `mark`, and only where the live
 *            file still equals its `mark` version.
 *   force    a forced pull: the live folder's listed files become exact
 *            copies; everything replaced or removed is saved to recovery.
 *   adopt    a first link that takes the repository's side: listed files
 *            are written, replaced ones saved to recovery, nothing removed.
 */
export function configStageOut(ctx: ConfigSyncContext, options: StageOutOptions): ConfigSyncResult {
  const rules = rulesFor(ctx);
  const forms = formsFor(ctx);
  const reporter = ctx.reporter ?? silentReporter;
  const { mode } = options;

  let candidates = new Set([
    ...listIncluded(ctx.repoRoot, rules, skipDirs(ctx)),
    ...listIncluded(ctx.roots.config, rules, skipDirs(ctx)),
  ]);
  if (mode === "lagging") {
    if (!options.mark) return { written: [], deleted: [], kept: [] };
    const diff = git(["diff", "--name-only", "-z", options.mark, "HEAD"], { cwd: ctx.repoRoot });
    const changed = new Set(diff.ok ? diff.stdout.split("\0").filter(Boolean) : []);
    candidates = new Set([...candidates].filter((rel) => changed.has(rel)));
  }

  const plan: { rel: string; content: Buffer | null; local: Buffer | null }[] = [];
  const kept: string[] = [];
  for (const rel of [...candidates].sort()) {
    const local = read(path.join(ctx.roots.config, rel));
    const shared = read(path.join(ctx.repoRoot, rel));
    if (inSync(rel, local, shared, forms)) continue;
    if (shared === null && mode === "adopt") continue;

    let allowed = mode === "force" || mode === "adopt";
    if (mode === "normal") {
      const seen = options.baseline?.get(rel);
      allowed = options.baseline?.has(rel) ? seen === blob(local) : local === null;
    } else if (mode === "lagging") {
      const before = showAt(ctx.repoRoot, options.mark as string, rel);
      allowed = inSync(rel, local, before, forms);
    }
    if (!allowed) {
      kept.push(rel);
      continue;
    }
    plan.push({ rel, content: shared === null ? null : liveForm(rel, shared, forms), local });
  }

  let recovery: string | undefined;
  if ((mode === "force" || mode === "adopt") && plan.some((p) => p.local !== null)) {
    recovery = saveToRecovery(
      ctx.roots,
      options.label ?? mode,
      plan
        .filter((p) => p.local !== null)
        .map((p) => ({ source: path.join(ctx.roots.config, p.rel), rel: p.rel })),
    );
    if (recovery) reporter.detail(`Saved the replaced config files to ${recovery}`);
  }

  const written: string[] = [];
  const deleted: string[] = [];
  for (const { rel, content } of plan) {
    if (content === null) {
      removeFile(ctx.roots.config, rel);
      deleted.push(rel);
    } else {
      writeFile(path.join(ctx.roots.config, rel), content, true);
      written.push(rel);
    }
  }
  for (const rel of kept) reporter.detail(`Kept the local edit of ${rel}; it is shared next push`);
  return { written, deleted, kept, recovery };
}

/** Listed live files whose content differs from the working copy. */
export function pendingConfigChanges(ctx: ConfigSyncContext): string[] {
  const rules = rulesFor(ctx);
  const forms = formsFor(ctx);
  const all = new Set([
    ...listIncluded(ctx.repoRoot, rules, skipDirs(ctx)),
    ...listIncluded(ctx.roots.config, rules, skipDirs(ctx)),
  ]);
  return [...all]
    .filter(
      (rel) =>
        !inSync(
          rel,
          read(path.join(ctx.roots.config, rel)),
          read(path.join(ctx.repoRoot, rel)),
          forms,
        ),
    )
    .sort();
}
