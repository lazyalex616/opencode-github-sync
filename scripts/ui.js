#!/usr/bin/env node
// ─────────────────────────────────────────────────────
// ui.js — Shared UI utilities for OpenCode sync scripts
// Tokyo Night Aesthetic
// ─────────────────────────────────────────────────────
"use strict";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  inverse: "\x1b[7m",

  // Basic colors (fallback)
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",

  // Tokyo Night palette (ANSI 256)
  tn: {
    cyan: "\x1b[38;5;117m",    // #7dcfff — titles, accents
    yellow: "\x1b[38;5;179m",  // #e0af68 — warnings
    red: "\x1b[38;5;204m",     // #f7768e — errors, force
    green: "\x1b[38;5;150m",   // #9ece6a — success, selected
    purple: "\x1b[38;5;140m",  // #9d7cd8 — icons, decorative
    gray: "\x1b[38;5;60m",     // #565f89 — borders, dim text
    text: "\x1b[38;5;146m",    // #a9b1d6 — body text
  },

  // Semantic aliases
  muted: "\x1b[38;5;60m",
  success: "\x1b[38;5;150m",
  highlight: "\x1b[38;5;117m",
};

function paint(text, ...styles) {
  return `${styles.join("")}${text}${c.reset}`;
}

// ── Status output helpers ───────────────────────────

function printLine(symbol, msg, color = c.gray) {
  console.log(`  ${color}${symbol}${c.reset}  ${msg}`);
}

function title(msg) {
  console.log(`\n  ${c.bold}${msg}${c.reset}\n`);
}

function logo(action = "push", force = false) {
  const BOX_W = 50;
  const border = c.tn.cyan;
  const brandText = "OpenCode Sync";
  const brandStyled = c.bold + c.white + brandText + c.reset;
  const sep = c.tn.gray + " — " + c.reset;
  const icon = c.tn.purple + "⚡" + c.reset;
  const actionText = action === "push" ? "Push to GitHub" : "Pull from GitHub";
  const actionStyled = c.tn.cyan + actionText + c.reset;
  const forceTag = force ? "  " + c.tn.red + c.bold + "⚠ FORCE" + c.reset : "";

  // Calculate padding (visible chars only)
  const visLen = 2 + brandText.length + " — ".length + 2 + actionText.length + (force ? "  ⚠ FORCE".length : 0);
  const pad = BOX_W - 4 - visLen; // 4 = "│  " + "│"

  console.log();
  console.log(`  ${border}┌${"─".repeat(BOX_W - 2)}┐${c.reset}`);
  console.log(`  ${border}│${c.reset}  ${brandStyled}${sep}${icon} ${actionStyled}${forceTag}${" ".repeat(Math.max(pad, 0))}${border}│${c.reset}`);
  console.log(`  ${border}└${"─".repeat(BOX_W - 2)}┘${c.reset}`);
  console.log();
}

function success(msg) {
  printLine("✔", msg, c.tn.green);
}

function error(msg) {
  printLine("✖", msg, c.tn.red);
}

function warn(msg) {
  printLine("⚠", msg, c.tn.yellow);
}

function info(msg) {
  printLine("ℹ", msg, c.tn.cyan);
}

function step(msg) {
  printLine("▸", msg, c.tn.gray);
}

function note(msg) {
  console.log(`     ${c.tn.gray}${msg}${c.reset}`);
}

function section(label, value = "") {
  console.log(`\n  ${c.tn.cyan}${c.bold}${label}${c.reset} ${value}`);
}

function done(msg) {
  console.log();
  printLine("✔", paint(msg, c.bold, c.tn.green), c.tn.green);
}

function separator() {
  console.log();
  console.log(`  ${c.tn.cyan}${c.bold}${"━".repeat(48)}${c.reset}`);
}

function completionBanner(action, target) {
  separator();
  console.log(`  ${c.tn.green}${c.bold}✨ 同步完成！${c.reset}`);
  const actionLabel = action === "push" ? "Push" : "Pull";
  const targetLabel = target === "config" ? "配置文件" : target === "sessions" ? "会话数据" : "配置文件和会话数据";
  const dest = action === "push" ? "到 GitHub" : "自 GitHub";
  console.log(`  ${c.tn.text}OpenCode ${targetLabel}已成功 ${actionLabel} ${dest}${c.reset}`);
  console.log();
}

// ── Stats formatting ────────────────────────────────

function formatStats(added, modified, deleted, renamed) {
  const parts = [];

  if (added > 0) parts.push(`${c.tn.green}📄+${added}${c.reset}`);
  if (modified > 0) parts.push(`${c.tn.yellow}📝~${modified}${c.reset}`);
  if (deleted > 0) parts.push(`${c.tn.red}🗑️-${deleted}${c.reset}`);
  if (renamed > 0) parts.push(`${c.tn.cyan}🔄${renamed}${c.reset}`);

  if (parts.length === 0) {
    return `${c.tn.gray}已是最新${c.reset}`;
  }

  return parts.join(` ${c.tn.gray}│${c.reset} `);
}

function formatDiffStats(diffOutput) {
  let added = 0, modified = 0, deleted = 0, renamed = 0;
  const lines = (diffOutput || "").split("\n").filter(Boolean);
  
  for (const line of lines) {
    const status = line.charAt(0).toUpperCase();
    switch (status) {
      case "A": added++; break;
      case "M": modified++; break;
      case "D": deleted++; break;
      case "R": renamed++; break;
    }
  }

  return formatStats(added, modified, deleted, renamed);
}

module.exports = {
  c,
  paint,
  logo,
  title,
  success,
  error,
  warn,
  info,
  step,
  note,
  section,
  done,
  separator,
  completionBanner,
  formatStats,
  formatDiffStats,
};
