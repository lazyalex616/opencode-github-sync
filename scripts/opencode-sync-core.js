#!/usr/bin/env node
// opencode-sync-core — Unified sync entry point for OpenCode config & sessions.
// Cross-platform (macOS / Windows / Linux).
//
// Usage (called by wrapper scripts):
//   node opencode-sync-core.js pull              # Interactive: choose config/sessions/both
//   node opencode-sync-core.js push              # Interactive: choose config/sessions/both
//   node opencode-sync-core.js pull --force       # Force pull (discard local changes)
//   node opencode-sync-core.js push --force       # Force push on conflict
//   node opencode-sync-core.js status             # Show status for both
//
// Wrapper commands:
//   opencode-pull        → pull (interactive)
//   opencode-push        → push (interactive)
//   opencode-pull-force  → pull --force
//   opencode-push-force  → push --force

const path = require("node:path");
const { execSync } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const fs = require("node:fs");

// ── Paths ────────────────────────────────────────────────────────────

const SCRIPTS_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "opencode",
  "scripts"
);
const SYNC_CONFIG_SCRIPT = path.join(SCRIPTS_DIR, "sync-config.js");
const SYNC_SESSIONS_SCRIPT = path.join(SCRIPTS_DIR, "sync-sessions.js");

// ── Interactive prompt ───────────────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function chooseTarget(action, force) {
  const actionLabel = action === "push" ? "Push" : "Pull";
  const forceLabel = force ? " (force)" : "";
  console.log("");
  console.log(`  OpenCode ${actionLabel}${forceLabel}`);
  console.log("");
  console.log("    1. 📦 Config only");
  console.log("    2. 💾 Sessions only");
  console.log("    3. 📦💾 Both (config + sessions)");
  console.log("");

  const choice = await ask("  Choose [1-3]: ");
  switch (choice) {
    case "1": return "config";
    case "2": return "sessions";
    case "3": return "both";
    default:
      console.error(`  Invalid choice: ${choice}`);
      process.exit(1);
  }
}

// ── Runner ───────────────────────────────────────────────────────────

function runScript(scriptPath, args) {
  if (!fs.existsSync(scriptPath)) {
    console.error(`Script not found: ${scriptPath}`);
    process.exit(1);
  }

  // Use execSync so exit codes propagate correctly
  execSync(`node "${scriptPath}" ${args.join(" ")}`, {
    stdio: "inherit",
    env: process.env,
  });
}

function runConfigSync(action, force) {
  const args = [action];
  if (force) args.push("--force");
  runScript(SYNC_CONFIG_SCRIPT, args);
}

function runSessionSync(action, force) {
  const args = [action];
  if (force) args.push("--force");
  runScript(SYNC_SESSIONS_SCRIPT, args);
}

// ── Dispatch ─────────────────────────────────────────────────────────

function dispatch(action, target, force) {
  // For "both", order matters:
  //   pull: config first (ensures scripts are valid), then sessions
  //   push: config first, then sessions
  // If any step fails (execSync throws on non-zero exit), we abort immediately.

  switch (target) {
    case "config":
      runConfigSync(action, force);
      break;

    case "sessions":
      runSessionSync(action, force);
      break;

    case "both":
      runConfigSync(action, force);
      runSessionSync(action, force);
      break;
  }
}

// ── Status ───────────────────────────────────────────────────────────

function showStatus() {
  console.log("📦 Config:");
  runConfigSync("status", false);
  console.log("\n💾 Sessions:");
  runSessionSync("status", false);
}

// ── Help ─────────────────────────────────────────────────────────────

function showHelp() {
  console.log("OpenCode Sync — Push/pull config & sessions to GitHub\n");
  console.log("  opencode-push          Push (interactive)");
  console.log("  opencode-pull          Pull (interactive)");
  console.log("  opencode-push-force    Force push");
  console.log("  opencode-pull-force    Force pull");
  console.log("  opencode-push status   Show sync status");
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const positional = args.filter(a => !a.startsWith("-"));

  const action = positional[0];

  if (!action || action === "help") {
    showHelp();
    return;
  }

  if (action === "status") {
    showStatus();
    return;
  }

  if (action !== "push" && action !== "pull") {
    console.error(`Unknown action: ${action}`);
    showHelp();
    process.exit(1);
  }

  const target = await chooseTarget(action, force);
  dispatch(action, target, force);
}

main().catch(e => {
  console.error("Unexpected error:", e.message);
  process.exit(1);
});
