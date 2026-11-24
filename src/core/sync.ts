import fs from "node:fs";
import path from "node:path";
import { type CategoryKey, disabledCategories, isDisabledPath } from "./categories.js";
import {
  type Baseline,
  type ConfigSyncContext,
  type StageOutMode,
  configStageIn,
  configStageOut,
  pendingConfigChanges,
} from "./configsync.js";
import { type BridgePreference, bridgeCredentials } from "./credentials.js";
import {
  type GitResult,
  git,
  isGitRepo,
  parseNameStatus,
  parsePorcelainPaths,
  parsePorcelainZ,
  toGitError,
} from "./git.js";
import { type GuardReport, LargeChangeError, evaluateGuard, writeLocalExcludes } from "./guard.js";
import { commitMessage, hostAlias } from "./host.js";
import { effectiveRules, listUnlisted } from "./manifest.js";
import { ensureMigrated } from "./migrate.js";
import { loadOverrides } from "./overrides.js";
import {
  type Roots,
  SESSIONS_DIR,
  STATE_DIR,
  getDatabasePath,
  getRoots,
  repoDir,
} from "./paths.js";
import { recoveryRoot } from "./recovery.js";
import {
  LOCAL_RUNTIME_PATHS,
  type RepoState,
  assertPushLanded,
  assertRemoteReachable,
  ensureRepo,
  excludePathspecs,
  headCommit,
  isLocalRuntimePath,
  readStageOutMark,
  unstageLocalRuntimePaths,
  untrackMachineFiles,
  writeRepoMetadata,
  writeStageOutMark,
} from "./repo.js";
import {
  type ChangedFile,
  type Reporter,
  emptySummary,
  silentReporter,
  summarize,
  totalChanges,
} from "./reporter.js";
import { exportSessions, importSessions } from "./sessions.js";
import {
  DEFAULT_SETTINGS,
  type Settings,
  loadPolicy,
  loadSettings,
  repoBranch,
  repoUrl,
} from "./settings.js";
import { sqliteAvailable } from "./sqlite.js";
import { createStageContext, prunePluginCache, stageIn, stageOut } from "./stage.js";

export interface SyncOptions {
  settings?: Settings;
  roots?: Roots;
  reporter?: Reporter;
  /** Overwrite the other side on conflict. */
  force?: boolean;
  /** Compute the result without writing anything to the remote. */
  dryRun?: boolean;
  /**
   * Called when a push exceeds the large-change limits. Return true to send it
   * anyway. Without a callback an oversized push is refused.
   */
  confirmLarge?: (report: GuardReport) => boolean | Promise<boolean>;
  /** Skip the large-change guard entirely. */
  allowLarge?: boolean;
  /**
   * First push from a directory that is not a repository yet, against a
   * remote that already has history: `remote` (default) takes the remote
   * files first, `local` keeps every local file and records it on top.
   */
  adopt?: "remote" | "local";
}

export interface SyncResult {
  action: "push" | "pull";
  changed: boolean;
  summary: ReturnType<typeof emptySummary>;
  files: ChangedFile[];
  sessions?: { exported?: number; imported?: number; skipped?: number };
  message: string;
  /** True when OpenCode must restart for the pulled config to take effect. */
  restartRequired: boolean;
  /** Present on a dry-run push that would trip the large-change guard. */
  guard?: GuardReport;
}

class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncError";
  }
}

/**
 * Another machine published between our rebase and our push, every time we
 * retried. That is contention, not an outage: the next run simply tries again.
 */
export class PushRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushRaceError";
  }
}

/** Commit trailer naming the machine that produced a sync commit. */
export const DEVICE_TRAILER = "Opencode-Sync-Device";

const PUSH_RACE_RETRIES = 3;

interface Context {
  root: string;
  branch: string;
  remote: string;
  settings: Settings;
  roots: Roots;
  reporter: Reporter;
  force: boolean;
  dryRun: boolean;
  confirmLarge?: SyncOptions["confirmLarge"];
  allowLarge: boolean;
  disabled: CategoryKey[];
  /** Live config files as this run read them, for a safe write-out. */
  baseline?: Baseline;
}

function configCtx(ctx: Context): ConfigSyncContext {
  return { roots: ctx.roots, repoRoot: ctx.root, settings: ctx.settings, reporter: ctx.reporter };
}

/** Bring the live config files into the working copy before git runs. */
function configIn(ctx: Context, mirror: boolean): void {
  const staged = configStageIn(
    configCtx(ctx),
    mirror ? "mirror" : "normal",
    readStageOutMark(ctx.root),
  );
  ctx.baseline = staged.baseline;
}

/** Write the working copy's config files out to the live folder. */
function configOut(ctx: Context, mode: StageOutMode, label?: string): void {
  const result = configStageOut(configCtx(ctx), {
    mode,
    baseline: ctx.baseline,
    mark: readStageOutMark(ctx.root),
    label,
  });
  if (result.written.length + result.deleted.length > 0) {
    ctx.reporter.detail(
      `Config: wrote ${result.written.length}, removed ${result.deleted.length} file(s) here`,
    );
  }
}

function prepare(options: SyncOptions): Context {
  const roots = options.roots ?? getRoots();
  ensureMigrated(roots);
  const settings = options.settings ?? loadSettings(roots.config);
  const remote = repoUrl(settings);
  if (!remote) {
    throw new SyncError(
      "No sync repository configured.\n" +
        "Run `opencode-sync init` to create one, or `opencode-sync link <owner/repo>` to use an existing one.",
    );
  }
  return {
    root: repoDir(roots),
    branch: repoBranch(settings),
    remote,
    settings,
    roots,
    reporter: options.reporter ?? silentReporter,
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
    confirmLarge: options.confirmLarge,
    allowLarge: options.allowLarge ?? false,
    disabled: disabledCategories(settings.categories),
  };
}

function toChangedFiles(result: GitResult, excludeRuntime: boolean): ChangedFile[] {
  return parseNameStatus(result.ok ? result.stdout : "")
    .filter((entry) => !excludeRuntime || !isLocalRuntimePath(entry.path))
    .map((entry) => ({ kind: entry.kind, path: entry.path }));
}

// ── Push ────────────────────────────────────────────────────────────────────

export async function push(options: SyncOptions = {}): Promise<SyncResult> {
  const ctx = prepare(options);
  const { root, branch, reporter } = ctx;

  if (!fs.existsSync(ctx.roots.config)) {
    throw new SyncError(`Config directory not found: ${ctx.roots.config}`);
  }
  fs.mkdirSync(root, { recursive: true });

  const adopt = options.adopt ?? "remote";
  const state = adoptRepo(ctx);
  let mirror = false;
  if (state === "adopted" && !ctx.dryRun) {
    if (adopt === "remote") {
      // The repository's files win the first link. Listed config files are
      // written out (the replaced ones saved to recovery first), and the
      // mirrored trees too: staging this machine's old trees in would
      // otherwise publish every skill it lacks as a deletion.
      configOut(ctx, "adopt", "first-push");
      stageOut(createStageContext(root, ctx.settings, reporter, false, ctx.roots));
      writeStageOutMark(root);
    } else {
      // This machine wins: its listed files replace the repository's.
      mirror = true;
    }
  }
  assertRemoteReachable(root, branch, "Push", true);
  writeRepoMetadata(root);
  writeLocalExcludes(root, ctx.settings.guard?.skipDirs ?? []);

  return await runPush(ctx, mirror);
}

async function runPush(ctx: Context, mirror = false): Promise<SyncResult> {
  const { root, branch, reporter } = ctx;

  // A previous run that integrated remote commits but stopped before writing
  // them out leaves the real directories behind HEAD. Staging that stale tree
  // in would publish the gap as deletions, so settle it first. Without a mark
  // nothing is known, and writing out here would resurrect local deletions.
  const mark = readStageOutMark(root);
  const head = headCommit(root);
  if (!ctx.dryRun && mark && head && mark !== head) {
    reporter.step("Writing out changes from an earlier sync");
    configOut(ctx, "lagging");
    stageOut(createStageContext(root, ctx.settings, reporter, false, ctx.roots));
    writeStageOutMark(root);
  }

  reporter.step("Staging local files");
  await bridge(ctx, "database");
  configIn(ctx, mirror || ctx.force);
  stageIn(createStageContext(root, ctx.settings, reporter, ctx.force, ctx.roots));

  const sessions = await maybeExportSessions(ctx);

  git(["add", "-A"], { cwd: root });
  unstageLocalRuntimePaths(root);
  untrackMachineFiles(root);
  untrackPolicyDisabled(ctx);

  const staged = git(["diff", "--cached", "--name-status"], { cwd: root });
  const files = toChangedFiles(staged, true);
  const summary = summarize(files);

  if (files.length === 0) {
    // No file changes, but a previous push may have failed after committing.
    git(["fetch", "origin", branch], { cwd: root });
    const ahead = countCommits(root, `origin/${branch}..HEAD`);
    const behind = countCommits(root, `HEAD..origin/${branch}`);
    if (ahead > 0) {
      if (ctx.dryRun) {
        return done(
          "push",
          false,
          summary,
          files,
          `${ahead} local commit(s) waiting to be pushed`,
          sessions,
        );
      }
      reporter.step(`Pushing ${ahead} pending commit(s)`);
      const integrated = pushBranch(ctx);
      await finishPush(ctx, integrated);
      return done(
        "push",
        true,
        summary,
        files,
        `Pushed ${ahead} pending commit(s)`,
        sessions,
        integrated,
      );
    }
    if (behind > 0 && !ctx.dryRun) {
      // Nothing of ours to send, but other machines have published. HEAD is an
      // ancestor of the remote, so this is a fast-forward that cannot rewrite
      // anything — and the result must reach the real directories, or the next
      // push would read everything new as deleted on this machine.
      reporter.step(`Fast-forwarding ${behind} remote commit(s)`);
      const ff = git(["merge", "--ff-only", `origin/${branch}`], { cwd: root });
      if (!ff.ok) throw toGitError("Fast-forward", ff);
      await finishPush(ctx, true);
      return done(
        "push",
        true,
        summary,
        files,
        `Nothing to push; received ${behind} remote commit(s)`,
        sessions,
        true,
      );
    }
    if (!ctx.dryRun) writeStageOutMark(root);
    return done("push", false, summary, files, "Already up to date", sessions);
  }

  reporter.changes(summary, files);
  const guard = ctx.allowLarge
    ? undefined
    : firstPushGuard(
        root,
        branch,
        evaluateGuard(root, files, ctx.settings.guard ?? DEFAULT_SETTINGS.guard),
      );
  if (ctx.dryRun) {
    const result = done(
      "push",
      true,
      summary,
      files,
      `${totalChanges(summary)} change(s) would be pushed`,
      sessions,
    );
    if (guard && guard.reasons.length > 0) result.guard = guard;
    return result;
  }

  if (guard && guard.reasons.length > 0) {
    const allowed = ctx.confirmLarge ? await ctx.confirmLarge(guard) : false;
    if (!allowed) {
      // Leave nothing staged: the next attempt must re-evaluate from scratch.
      git(["reset", "-q"], { cwd: root });
      throw new LargeChangeError(guard);
    }
  }

  const alias = hostAlias(ctx.settings.machineAlias);
  const commit = git(
    ["commit", "-m", commitMessage("sync", alias), "-m", `${DEVICE_TRAILER}: ${alias}`],
    { cwd: root },
  );
  if (!commit.ok) throw toGitError("Commit", commit);
  // The commit was built from this machine's directories, so they match it.
  // If the rebase or the network push below fails, the next run sees the mark
  // trailing HEAD and writes the integrated tree out before staging again.
  writeStageOutMark(root);

  const integrated = pushBranch(ctx);
  await finishPush(ctx, integrated);
  return done(
    "push",
    true,
    summary,
    files,
    `Pushed ${totalChanges(summary)} change(s)`,
    sessions,
    integrated,
  );
}

/**
 * Settle the real directories after a successful push.
 *
 * When the push integrated other machines' commits, the merged tree is written
 * out. Local work is already committed at this point (stage in → commit →
 * rebase), so this only adds what arrived; skills are never deleted here.
 * Overrides are re-applied by `push()` itself once this returns.
 */
async function finishPush(ctx: Context, integrated: boolean): Promise<void> {
  if (integrated) {
    ctx.reporter.step("Writing out changes from other machines");
    configOut(ctx, "normal");
    stageOut(createStageContext(ctx.root, ctx.settings, ctx.reporter, false, ctx.roots));
    await bridge(ctx, "file");
    await maybeImportSessions(ctx);
  }
  writeStageOutMark(ctx.root);
}

/**
 * Bring `origin/<branch>` into HEAD.
 *
 * A rebase comes first, for a linear history. When it stops on a conflict the
 * push falls back to a plain merge: a rebase replays every local commit and
 * drops merge commits, so a conflict already resolved by hand in a local
 * merge would be hit again on every run and the machine would never recover.
 * A merge applies both sides once and keeps that resolution. Only a conflict
 * the merge cannot settle either is reported, by file name. A rebase that
 * failed for another reason (network, a dirty tree) reports git's own words.
 */
export function integrateRemote(
  root: string,
  branch: string,
  reporter: Reporter = silentReporter,
): void {
  const rebase = git(["pull", "--rebase", "origin", branch], { cwd: root });
  if (rebase.ok) return;
  if (!rebaseInProgress(root)) {
    git(["rebase", "--abort"], { cwd: root });
    throw toGitError("Pull before push", rebase);
  }
  const rebasePaths = conflictedPaths(root);
  git(["rebase", "--abort"], { cwd: root });
  const merge = git(["merge", "--no-edit", `origin/${branch}`], { cwd: root });
  if (merge.ok) {
    reporter.step(
      `Rebase stopped on ${rebasePaths.join(", ") || "a conflict"}; merged instead and resolved it`,
    );
    return;
  }
  const mergePaths = conflictedPaths(root);
  git(["merge", "--abort"], { cwd: root });
  const paths = mergePaths.length > 0 ? mergePaths : rebasePaths;
  throw new SyncError(
    `The remote has changes that conflict with this machine${paths.length ? `: ${paths.join(", ")}` : ""}.\n` +
      "Run `opencode-sync pull` to take the remote version, or `opencode-sync push --force` to overwrite it.",
  );
}

function rebaseInProgress(root: string): boolean {
  const dir = git(["rev-parse", "--git-dir"], { cwd: root });
  if (!dir.ok) return false;
  const gitDir = path.resolve(root, dir.stdout);
  return (
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply"))
  );
}

/** Paths a stopped rebase or merge is stuck on. Read before aborting. */
function conflictedPaths(root: string): string[] {
  const result = git(["diff", "--name-only", "--diff-filter=U"], { cwd: root });
  return result.ok
    ? result.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
}

/** Push the branch. Returns true when a rebase integrated remote commits. */
function pushBranch(ctx: Context): boolean {
  const { root, branch, force, reporter } = ctx;

  const hasRemoteBranch = git(["rev-parse", `origin/${branch}`], { cwd: root }).ok;
  if (!hasRemoteBranch) {
    const result = git(["push", "-u", "origin", branch], { cwd: root });
    if (!result.ok) {
      if (isRejected(result)) {
        throw new PushRaceError(
          "Another machine created the branch at the same moment. The next sync will retry.",
        );
      }
      throw toGitError("Push", result);
    }
    assertPushLanded(root, branch, "Push");
    return false;
  }

  if (force) {
    // Refresh the tracking ref first. `--force-with-lease` compares against the
    // local idea of the remote, so a stale ref makes it refuse the very
    // overwrite the user explicitly asked for.
    if (git(["fetch", "origin", branch], { cwd: root }).ok) {
      const behind = countCommits(root, `HEAD..origin/${branch}`);
      if (behind > 0) {
        reporter.warn(`Overwriting ${behind} remote commit(s) that this machine does not have`);
      }
    }
    const result = git(["push", "--force-with-lease", "origin", branch], { cwd: root });
    if (!result.ok) throw toGitError("Force push", result);
    assertPushLanded(root, branch, "Force push");
    return false;
  }

  // Another machine can publish between our rebase and our push. Losing that
  // race is contention, not failure: rebase onto the newcomer and try again.
  let integrated = false;
  for (let attempt = 1; ; attempt++) {
    const before = headCommit(root);
    integrateRemote(root, branch, reporter);
    // The rebase moves HEAD only when it replayed local commits onto new
    // remote ones; an unchanged HEAD means nothing arrived.
    if (headCommit(root) !== before) integrated = true;

    const result = git(["push", "origin", branch], { cwd: root });
    if (result.ok) break;
    if (!isRejected(result)) throw toGitError("Push", result);
    if (attempt >= PUSH_RACE_RETRIES) {
      throw new PushRaceError(
        `Another machine kept publishing first (${attempt} attempts). The next sync will retry.`,
      );
    }
    reporter.step("Another machine pushed first; rebasing and retrying");
  }
  assertPushLanded(root, branch, "Push");
  return integrated;
}

/**
 * The first push into an empty repository sends the whole existing setup, so
 * a high file count or total size is expected there. Only the single-file
 * limit still applies: a multi-megabyte file is suspicious on any push.
 */
function firstPushGuard(root: string, branch: string, report: GuardReport): GuardReport {
  if (git(["rev-parse", "--verify", `origin/${branch}`], { cwd: root }).ok) return report;
  return { ...report, reasons: report.reasons.filter((r) => r === "file") };
}

/**
 * True only when the push lost a race: the remote moved under us, either
 * before the push (`fetch first`, `non-fast-forward`) or during the ref update
 * itself (`cannot lock ref ... but expected`). A protected branch or a
 * declined hook also prints "failed to push some refs", and must surface as a
 * real failure rather than be retried for ever.
 */
function isRejected(result: GitResult): boolean {
  return /\((fetch first|non-fast-forward)\)|cannot lock ref .* but expected/i.test(
    `${result.stderr}\n${result.stdout}`,
  );
}

// ── Disabled categories ─────────────────────────────────────────────────────

/**
 * Drop the state and session mirrors from the index when the shared policy
 * turns them off and this machine follows it (#14). Only a policy-backed
 * "off" counts: when every machine agrees the folder is not shared, removing
 * it stops stale copies from churning; one machine opting out on its own
 * would just ping-pong with a machine that keeps adding it back. A machine
 * that deliberately overrides the policy keeps publishing. Files on disk are
 * never touched.
 */
function untrackPolicyDisabled(ctx: Context): void {
  const policy = loadPolicy(ctx.roots.config);
  const specs: string[] = [];
  if (policy.includeState === false && !ctx.settings.includeState) {
    specs.push(`:(top,literal)${STATE_DIR}`);
  }
  if (policy.sessions?.enabled === false && !ctx.settings.sessions.enabled) {
    specs.push(`:(top,literal)${SESSIONS_DIR}`);
  }
  if (specs.length === 0) return;
  git(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...specs], { cwd: ctx.root });
}

// ── Pull ────────────────────────────────────────────────────────────────────

export async function pull(options: SyncOptions = {}): Promise<SyncResult> {
  const ctx = prepare(options);
  fs.mkdirSync(ctx.root, { recursive: true });
  return await runPull(ctx);
}

async function runPull(ctx: Context): Promise<SyncResult> {
  const { root, branch, reporter, force } = ctx;

  if (!isGitRepo(root)) {
    const state = adoptRepo(ctx);
    if (state === "fresh") {
      return done(
        "pull",
        false,
        emptySummary(),
        [],
        "The sync repository is empty — push from another machine first.",
      );
    }
    configOut(ctx, force ? "force" : "adopt", "first-pull");
    stageOut(createStageContext(root, ctx.settings, reporter, force, ctx.roots));
    await bridge(ctx, "file");
    const sessions = await maybeImportSessions(ctx);
    const count = git(["ls-files"], { cwd: root }).stdout.split("\n").filter(Boolean).length;
    finishPull(ctx);
    return done(
      "pull",
      true,
      emptySummary(),
      [],
      `First pull complete — ${count} file(s)`,
      sessions,
      true,
    );
  }

  ensureRepo({ root, remote: ctx.remote, branch });

  reporter.step("Fetching from GitHub");
  const fetched = git(["fetch", "origin", branch], { cwd: root });
  if (!fetched.ok) throw toGitError("Fetch", fetched);

  const ahead = countCommits(root, `origin/${branch}..HEAD`);
  if (!force && ahead > 0) {
    throw new SyncError(
      `This machine has ${ahead} commit(s) that were never pushed.\n` +
        "Run `opencode-sync push` first, or `opencode-sync pull --force` to discard them.",
    );
  }

  const behind = countCommits(root, `HEAD..origin/${branch}`);
  if (!force && behind === 0) {
    // Nothing incoming. HEAD can still be ahead of what was last written out,
    // when a push integrated remote commits and stopped before writing them.
    // Settle that here; without a recorded mark nothing is known.
    const mark = readStageOutMark(root);
    const head = headCommit(root);
    if (!ctx.dryRun && mark && head && mark !== head) {
      reporter.step("Writing out changes from an earlier sync");
      configOut(ctx, "lagging");
      stageOut(createStageContext(root, ctx.settings, reporter, false, ctx.roots));
      await bridge(ctx, "file");
      const sessions = await maybeImportSessions(ctx);
      finishPull(ctx);
      return done(
        "pull",
        true,
        emptySummary(),
        [],
        "Wrote out changes from an earlier sync",
        sessions,
        true,
      );
    }
    return done("pull", false, emptySummary(), [], "Already up to date", undefined, false);
  }

  // Local config edits go into the working copy first, so the stash below
  // carries them across the reset exactly like 3.x carried worktree edits.
  if (!ctx.dryRun) configIn(ctx, false);

  let files: ChangedFile[] = [];
  let summary = emptySummary();
  const stashed = ctx.dryRun ? false : prepareWorktree(ctx);
  const nameStatus = git(["diff", "--name-status", "HEAD", `origin/${branch}`], { cwd: root });
  files = toChangedFiles(nameStatus, true).filter((f) => !isDisabledPath(f.path, ctx.disabled));
  summary = summarize(files);

  if (ctx.dryRun) {
    return done(
      "pull",
      files.length > 0,
      summary,
      files,
      `${totalChanges(summary)} change(s) would be pulled`,
    );
  }

  const reset = git(["reset", "--hard", `origin/${branch}`], { cwd: root });
  if (!reset.ok) {
    if (stashed) restoreStash(ctx);
    throw toGitError("Reset", reset);
  }
  if (stashed) restoreStash(ctx);

  configOut(ctx, force ? "force" : "normal", "force-pull");
  stageOut(createStageContext(root, ctx.settings, reporter, force, ctx.roots));
  await bridge(ctx, "file");
  const sessions = await maybeImportSessions(ctx);
  finishPull(ctx);

  reporter.changes(summary, files);
  return done(
    "pull",
    files.length > 0,
    summary,
    files,
    files.length > 0 ? `Pulled ${totalChanges(summary)} change(s)` : "Already up to date",
    sessions,
    true,
  );
}

/** Record the write-out and clean up caches after a pull. */
function finishPull(ctx: Context): void {
  writeStageOutMark(ctx.root);
  const pruned = prunePluginCache(ctx.roots.config, ctx.roots.cache);
  if (pruned > 0) ctx.reporter.detail(`Removed ${pruned} stale plugin package(s) from the cache`);
}

/**
 * Get the worktree into a state where a hard reset is safe.
 *
 * Without `force` local edits are stashed and restored afterwards. With
 * `force` they are discarded — but the runtime paths are still protected,
 * because `git clean` would otherwise happily delete the user's database.
 */
function prepareWorktree(ctx: Context): boolean {
  const { root, force } = ctx;

  git(["add", "-A"], { cwd: root });
  unstageLocalRuntimePaths(root);

  const hasStaged = git(["diff", "--cached", "--stat"], { cwd: root }).stdout.length > 0;
  const untracked = git(
    ["ls-files", "--others", "--exclude-standard", "--", ".", ...excludePathspecs()],
    { cwd: root },
  );
  const hasUntracked = untracked.ok && untracked.stdout.length > 0;
  if (!hasStaged && !hasUntracked) return false;

  git(["reset", "HEAD"], { cwd: root });

  if (force) {
    git(["checkout", "--", "."], { cwd: root });
    // `-e` takes gitignore-style patterns and *keeps* the matches. Using
    // `:(exclude)` pathspecs here would invert the meaning and delete
    // everything except the runtime paths.
    git(["clean", "-fd", ...LOCAL_RUNTIME_PATHS.flatMap((p) => ["-e", p])], { cwd: root });
    return false;
  }

  git(["add", "-A"], { cwd: root });
  unstageLocalRuntimePaths(root);
  const stash = git(
    [
      "stash",
      "push",
      "--include-untracked",
      "-m",
      "opencode-sync auto-stash",
      "--",
      ".",
      ...excludePathspecs(),
    ],
    { cwd: root },
  );
  if (!stash.ok) throw toGitError("Stash", stash);
  return !/No local changes to save/i.test(stash.stdout);
}

function restoreStash(ctx: Context): void {
  const { root } = ctx;
  const pop = git(["stash", "pop"], { cwd: root });
  if (pop.ok) return;

  // A conflicting pop leaves the stash in place and the worktree half-merged.
  // A half-merged opencode.jsonc stops OpenCode from starting, so reset to a
  // known-good tree and tell the user exactly where their work still is.
  git(["reset", "--hard", "HEAD"], { cwd: root });
  throw new SyncError(
    "Local changes conflicted with the incoming version.\n" +
      "The worktree was rolled back to a clean state and your changes are still saved in the stash:\n" +
      `  cd "${root}"\n` +
      "  git stash list\n" +
      "  git stash show -p stash@{0}     # inspect\n" +
      "  git stash apply --index stash@{0}  # restore manually\n" +
      "  git stash drop stash@{0}        # discard\n" +
      "Or re-run with --force to take the remote version.",
  );
}

// ── Credentials ─────────────────────────────────────────────────────────────

/**
 * Reconcile `auth.json` with OpenCode 2's credential table (no-op on
 * OpenCode 1 and when credential sync is off). A failure is reported and the
 * sync carries on: the file sync itself must never depend on it.
 */
async function bridge(ctx: Context, prefer: BridgePreference): Promise<void> {
  if (!ctx.settings.includeCredentials || ctx.dryRun) return;
  if (!(await sqliteAvailable())) return;
  try {
    const result = await bridgeCredentials(ctx.roots.data, prefer);
    if (result.toFile.length > 0) {
      ctx.reporter.detail(`Accounts from OpenCode recorded: ${result.toFile.join(", ")}`);
    }
    if (result.toDatabase.length > 0) {
      ctx.reporter.detail(`Accounts applied to OpenCode: ${result.toDatabase.join(", ")}`);
    }
    if (result.removed.length > 0) {
      ctx.reporter.detail(`Logged-out accounts removed: ${result.removed.join(", ")}`);
    }
  } catch (error) {
    ctx.reporter.warn(`Could not bridge credentials: ${(error as Error).message}`);
  }
}

// ── Sessions ────────────────────────────────────────────────────────────────

async function maybeExportSessions(ctx: Context): Promise<SyncResult["sessions"]> {
  if (!ctx.settings.sessions.enabled) return undefined;
  if (!(await sqliteAvailable())) {
    ctx.reporter.warn("Session sync is enabled but no SQLite driver is available — skipping.");
    return undefined;
  }

  const database = getDatabasePath(ctx.roots);
  ctx.reporter.step("Exporting sessions");
  const result = await exportSessions(database, ctx.root, ctx.settings.sessions, ctx.reporter);

  for (const skipped of result.skippedTooLarge) {
    ctx.reporter.warn(
      `Skipped "${skipped.title || skipped.id}" — ${formatBytes(skipped.bytes)} exceeds maxSessionBytes`,
    );
  }
  if (result.written.length > 0) {
    ctx.reporter.detail(`Exported ${result.written.length} session(s)`);
  }
  return { exported: result.written.length, skipped: result.skippedTooLarge.length };
}

async function maybeImportSessions(ctx: Context): Promise<SyncResult["sessions"]> {
  if (!ctx.settings.sessions.enabled) return undefined;
  if (!fs.existsSync(path.join(ctx.root, "_sessions"))) return undefined;
  if (!(await sqliteAvailable())) {
    ctx.reporter.warn(
      "Session shards were pulled but no SQLite driver is available to import them.",
    );
    return undefined;
  }

  ctx.reporter.step("Importing sessions");
  const result = await importSessions(getDatabasePath(ctx.roots), ctx.root, ctx.reporter, {
    recoveryRoot: recoveryRoot(ctx.roots),
  });
  for (const failure of result.failed) {
    ctx.reporter.warn(`Could not import ${failure.file}: ${failure.reason}`);
  }
  if (result.skippedOtherSchema > 0) {
    ctx.reporter.detail(
      `Left ${result.skippedOtherSchema} session(s) from machines on another OpenCode major version`,
    );
  }
  if (result.imported > 0) ctx.reporter.detail(`Imported ${result.imported} session(s)`);
  if (result.moved > 0) {
    ctx.reporter.detail(`Moved ${result.moved} session(s) from the home project into their own`);
  }
  return { imported: result.imported, skipped: result.skippedOlder };
}

// ── Status ──────────────────────────────────────────────────────────────────

export interface StatusResult {
  configured: boolean;
  remote?: string;
  branch: string;
  initialized: boolean;
  ahead: number;
  behind: number;
  dirty: number;
  lastCommit?: string;
  lastCommitDate?: string;
  sessionsEnabled: boolean;
  sessionShards: number;
  overridesActive: boolean;
  machineAlias: string;
  /** Root entries of the config folder that no manifest rule mentions. */
  unlisted: string[];
}

export function status(options: SyncOptions = {}): StatusResult {
  const roots = options.roots ?? getRoots();
  ensureMigrated(roots);
  const settings = options.settings ?? loadSettings(roots.config);
  const branch = repoBranch(settings);
  const remote = repoUrl(settings);
  const root = repoDir(roots);

  const base: StatusResult = {
    configured: Boolean(remote),
    remote,
    branch,
    initialized: false,
    ahead: 0,
    behind: 0,
    dirty: 0,
    sessionsEnabled: settings.sessions.enabled,
    sessionShards: countShards(root),
    overridesActive: Object.keys(loadOverrides(roots.config)).length > 0,
    machineAlias: hostAlias(settings.machineAlias),
    unlisted: listUnlisted(
      roots.config,
      effectiveRules(root, settings),
      settings.guard?.skipDirs ?? [],
    ),
  };

  if (!remote || !isGitRepo(root)) return base;
  base.initialized = true;

  git(["fetch", "origin", branch], { cwd: root });
  base.ahead = countCommits(root, `origin/${branch}..HEAD`);
  base.behind = countCommits(root, `HEAD..origin/${branch}`);

  // Pending work is what a push would publish: listed config files that
  // differ from the working copy, plus anything uncommitted in it.
  const dirty = git(["status", "--porcelain", "--", ".", ...excludePathspecs()], { cwd: root });
  const changed = new Set([
    ...(dirty.ok ? parsePorcelainPaths(dirty.stdout) : []),
    ...pendingConfigChanges({ roots, repoRoot: root, settings }),
  ]);
  base.dirty = changed.size;

  const log = git(["log", "-1", "--format=%s%n%cI"], { cwd: root });
  if (log.ok) {
    const [subject, date] = log.stdout.split("\n");
    base.lastCommit = subject;
    base.lastCommitDate = date;
  }
  return base;
}

function countShards(root: string): number {
  const dir = path.join(root, "_sessions");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json.gz")).length;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Make the tool's working copy a clone of the remote. The working copy holds
 * nothing of the user's, so adopting the remote never overwrites user bytes
 * here; the config folder is written separately, with recovery copies.
 */
function adoptRepo(ctx: Context): RepoState {
  return ensureRepo({ root: ctx.root, remote: ctx.remote, branch: ctx.branch, adopt: "remote" });
}

function countCommits(root: string, range: string): number {
  const result = git(["rev-list", "--count", range], { cwd: root });
  return result.ok ? Number(result.stdout) || 0 : 0;
}

function done(
  action: "push" | "pull",
  changed: boolean,
  summary: ReturnType<typeof emptySummary>,
  files: ChangedFile[],
  message: string,
  sessions?: SyncResult["sessions"],
  restartRequired = false,
): SyncResult {
  return { action, changed, summary, files, message, sessions, restartRequired };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export { SyncError };
