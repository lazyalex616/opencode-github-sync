#!/usr/bin/env node
/**
 * opencode-launcher.js — Bootstrap launcher for the OpenCode sync system.
 *
 * This is the entry point that wrapper scripts (opencode-push, opencode-pull,
 * etc.) call. It lives at ~/.config/opencode/scripts/opencode-launcher.js at
 * runtime and handles two things before delegating to the real sync logic:
 *
 *   1. Self-update: fetch remote, check if scripts/ changed on remote,
 *      and pull just those files (never touches user config).
 *   2. Dependency bootstrap: ensure node_modules/ exists when scripts/package.json does.
 *
 * After that it execs opencode-sync-core.js with all original arguments.
 *
 * Design goals: minimal, stable, cross-platform (macOS + Windows), Node 18+.
 */

"use strict";

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const configRoot =
  process.env.SYNC_CONFIG_ROOT ||
  path.join(os.homedir(), ".config", "opencode");

const scriptsDir = path.join(configRoot, "scripts");
const coreScript = path.join(scriptsDir, "opencode-sync-core.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git command in the config repo. Returns stdout (trimmed). */
function git(args) {
  return execSync(`git ${args}`, {
    cwd: configRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

/** Check whether the config root is a git repository. */
function isGitRepo() {
  return fs.existsSync(path.join(configRoot, ".git"));
}

function normalizeArgs(argv) {
  const args = [...argv];
  const command = args[0];
  const subcommand = args[1];

  if (
    (command === "push" || command === "pull") &&
    (subcommand === "help" || subcommand === "status")
  ) {
    return [subcommand, ...args.slice(2)];
  }

  return args;
}

// ---------------------------------------------------------------------------
// 1. Self-update check
// ---------------------------------------------------------------------------

// Runtime-critical paths inside the git repo that the launcher manages.
// If any of these change on remote, we pull them before running sync logic.
const RUNTIME_PATHS = ["scripts/"];

/**
 * Fetch remote and update runtime-critical files if they changed.
 * Returns the list of updated file paths (empty array if nothing changed).
 */
function selfUpdate() {
  // Not a git repo yet — first-time use; skip entirely.
  if (!isGitRepo()) return [];

  // Fetch remote. Failure is non-fatal (offline is fine).
  try {
    git("fetch origin main");
  } catch {
    console.warn("⚠️  Fetch failed (offline?), skipping self-update");
    return [];
  }

  // Check if remote HEAD differs from local for runtime-critical files.
  let diff;
  try {
    diff = git(
      `diff --name-only HEAD origin/main -- ${RUNTIME_PATHS.join(" ")}`
    );
  } catch {
    // diff fails if HEAD doesn't exist yet (fresh repo). Skip.
    return [];
  }
  if (!diff) return [];

  const changed = diff.split("\n").filter(Boolean);

  // Pull ONLY the runtime files — never overwrite user config.
  try {
    git(`checkout origin/main -- ${RUNTIME_PATHS.join(" ")}`);
    console.log("🔄 Scripts updated from remote");
  } catch (err) {
    console.warn("⚠️  Failed to update scripts:", err.message);
    return [];
  }

  return changed;
}

// ---------------------------------------------------------------------------
// 2. Dependency check
// ---------------------------------------------------------------------------

/**
 * Ensure node_modules/ is present when scripts/package.json exists.
 * Also re-installs if package.json or package-lock.json changed.
 */
function ensureDependencies(updatedFiles) {
  const pkgPath = path.join(scriptsDir, "package.json");
  if (!fs.existsSync(pkgPath)) return;

  const modulesDir = path.join(scriptsDir, "node_modules");
  const needInstall =
    !fs.existsSync(modulesDir) ||
    updatedFiles.some(
      (f) =>
        f === "scripts/package.json" || f === "scripts/package-lock.json"
    );

  if (!needInstall) return;

  console.log("📦 Installing dependencies...");
  try {
    execSync("npm install", {
      cwd: scriptsDir,
      encoding: "utf8",
      stdio: "pipe",
    });
    console.log("✅ Dependencies installed");
  } catch (err) {
    console.error("❌ npm install failed:", (err.stderr || err.message).trim());
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 3. Delegate to opencode-sync-core.js
// ---------------------------------------------------------------------------

function delegate() {
  if (!fs.existsSync(coreScript)) {
    console.error(`❌ Core script not found: ${coreScript}`);
    console.error("   Run a pull first, or reinstall the sync scripts.");
    process.exit(1);
  }

  const args = normalizeArgs(process.argv.slice(2)).join(" ");
  try {
    execSync(`node "${coreScript}" ${args}`, {
      cwd: configRoot,
      stdio: "inherit",
      env: process.env,
    });
  } catch (err) {
    // execSync throws on non-zero exit. The child already printed its output
    // via stdio: "inherit", so just propagate the exit code.
    process.exit(err.status || 1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const updatedFiles = selfUpdate();
ensureDependencies(updatedFiles);
delegate();
