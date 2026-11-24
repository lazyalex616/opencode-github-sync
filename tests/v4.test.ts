import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/core/git.js";
import {
  DEFAULT_MANIFEST,
  MANIFEST_FILE,
  isIncluded,
  legacyExtras,
  listUnlisted,
  parseRules,
} from "../src/core/manifest.js";
import { migrateFrom3x, needsMigration } from "../src/core/migrate.js";
import { type Roots, repoDir, toolRoot } from "../src/core/paths.js";
import { listRecovery } from "../src/core/recovery.js";
import { DEFAULT_GITATTRIBUTES } from "../src/core/repo.js";
import { CollectingReporter } from "../src/core/reporter.js";
import {
  type Settings,
  defaultSettings,
  loadSettings,
  overridesPath,
  saveSettings,
  settingsPath,
} from "../src/core/settings.js";
import { pull, push, status } from "../src/core/sync.js";
import { compareVersions } from "../src/core/update.js";

/**
 * 4.0: the working copy lives in the tool's own home, and only files the
 * manifest lists move between it and `~/.config/opencode` (#14).
 */

let sandbox: string;
let remote: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-v4-"));
  remote = path.join(sandbox, "remote.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" });
  process.env.OPENCODE_SYNC_NO_STAGGER = "1";
});

afterEach(() => {
  delete process.env.OPENCODE_SYNC_NO_STAGGER;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const read = (file: string): string => fs.readFileSync(file, "utf8");

interface Machine {
  roots: Roots;
  settings: Settings;
}

function machine(name: string, patch: (s: Settings) => void = () => {}): Machine {
  const base = path.join(sandbox, name);
  const roots: Roots = {
    config: path.join(base, ".config", "opencode"),
    data: path.join(base, "data"),
    state: path.join(base, "state"),
    agents: path.join(base, "agents", "skills"),
    cache: path.join(base, "cache"),
  };
  for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true });
  const settings = defaultSettings();
  settings.repo = { url: remote, branch: "main" };
  settings.machineAlias = name;
  patch(settings);
  saveSettings(settings, roots.config);
  return { roots, settings };
}

const opts = (m: Machine, extra = {}) => ({
  settings: m.settings,
  roots: m.roots,
  reporter: new CollectingReporter(),
  ...extra,
});
const tracked = (m: Machine): string => git(["ls-files"], { cwd: repoDir(m.roots) }).stdout;

describe("manifest rules", () => {
  const rules = parseRules(DEFAULT_MANIFEST);

  it("lists what OpenCode reads and nothing else", () => {
    expect(isIncluded(rules, "opencode.jsonc")).toBe(true);
    expect(isIncluded(rules, "AGENTS.md")).toBe(true);
    expect(isIncluded(rules, "agents/review.md")).toBe(true);
    expect(isIncluded(rules, "plugins/x/index.ts")).toBe(true);
    expect(isIncluded(rules, "notes/AGENTS.md")).toBe(false);
    expect(isIncluded(rules, "scripts/helper.py")).toBe(false);
    expect(isIncluded(rules, "service.json")).toBe(false);
    expect(isIncluded(rules, "plugins/node_modules/x/index.js")).toBe(false);
  });

  it("lets a later rule win, and anchors every pattern at the root", () => {
    const r = parseRules([...DEFAULT_MANIFEST, "-agents/scratch/", "+lab/**/*.py", "scripts/"]);
    expect(isIncluded(r, "agents/scratch/x.md")).toBe(false);
    expect(isIncluded(r, "agents/keep.md")).toBe(true);
    expect(isIncluded(r, "lab/a/b/c.py")).toBe(true);
    expect(isIncluded(r, "lab/a/b/c.js")).toBe(false);
    expect(isIncluded(r, "scripts/run.sh")).toBe(true);
    expect(isIncluded(r, "x/scripts/run.sh")).toBe(false);
  });

  it("reports unlisted root entries, not excluded ones", () => {
    const root = path.join(sandbox, "cfg");
    write(path.join(root, "opencode.jsonc"), "{}");
    write(path.join(root, "scripts", "helper.py"), "x");
    write(path.join(root, "notes.txt"), "x");
    write(path.join(root, "agents", "scratch", "x.md"), "x");
    const r = parseRules([...DEFAULT_MANIFEST, "-agents/scratch/"]);
    expect(listUnlisted(root, r)).toEqual(["notes.txt", "scripts/"]);
  });

  it("keeps what a 3.x repository shared beyond the default", () => {
    expect(
      legacyExtras(["opencode.jsonc", "AGENTS.md", "agents/", "scripts/", "notes.txt"]),
    ).toEqual(["+notes.txt", "+scripts/"]);
  });
});

describe("separate working copy", () => {
  it("never makes the config folder a repository, and leaves unlisted files alone", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "a" }\n');
    write(path.join(a.roots.config, "agents", "review.md"), "review\n");
    write(path.join(a.roots.config, "scripts", "helper.py"), "local tool\n");
    await push(opts(a));

    expect(fs.existsSync(path.join(a.roots.config, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(a.roots.config, ".gitignore"))).toBe(false);
    const files = tracked(a);
    expect(files).toContain("opencode.jsonc");
    expect(files).toContain("agents/review.md");
    expect(files).not.toContain("scripts/helper.py");
    expect(status(opts(a)).unlisted).toEqual(["scripts/"]);

    const b = machine("beta");
    write(path.join(b.roots.config, "scripts", "helper.py"), "b's own tool\n");
    await pull(opts(b));
    expect(read(path.join(b.roots.config, "agents", "review.md"))).toBe("review\n");
    expect(read(path.join(b.roots.config, "scripts", "helper.py"))).toBe("b's own tool\n");
  });

  it("shares a path once the manifest lists it", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.roots.config, "scripts", "helper.py"), "shared tool\n");
    await push(opts(a));
    write(
      path.join(repoDir(a.roots), MANIFEST_FILE),
      [...DEFAULT_MANIFEST, "+scripts/", ""].join("\n"),
    );
    await push(opts(a));
    expect(tracked(a)).toContain("scripts/helper.py");
    expect(tracked(a)).toContain(MANIFEST_FILE);

    const b = machine("beta");
    await pull(opts(b));
    expect(read(path.join(b.roots.config, "scripts", "helper.py"))).toBe("shared tool\n");
  });

  it("keeps overrides out of the repository and in the live file", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "shared" }\n');
    await push(opts(a));

    const b = machine("beta");
    write(overridesPath(b.roots.config), '{ "model": "mine" }\n');
    await pull(opts(b));
    expect(JSON.parse(read(path.join(b.roots.config, "opencode.jsonc"))).model).toBe("mine");
    await push(opts(b));
    const shared = git(["show", "origin/main:opencode.jsonc"], { cwd: repoDir(b.roots) }).stdout;
    expect(JSON.parse(shared).model).toBe("shared");
    expect(status(opts(b)).dirty).toBe(0);
  });

  it("deletes a listed file that was removed locally, and never one it never wrote", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.roots.config, "agents", "old.md"), "old\n");
    await push(opts(a));

    fs.rmSync(path.join(a.roots.config, "agents", "old.md"));
    await push(opts(a));
    expect(tracked(a)).not.toContain("agents/old.md");

    const b = machine("beta");
    write(path.join(b.roots.config, "agents", "mine.md"), "mine\n");
    await pull(opts(b));
    expect(read(path.join(b.roots.config, "agents", "mine.md"))).toBe("mine\n");
  });

  it("keeps a local edit made while another machine changed the same file", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), "{}\n");
    write(path.join(a.roots.config, "AGENTS.md"), "base\n");
    await push(opts(a));
    const b = machine("beta");
    await pull(opts(b));

    write(path.join(a.roots.config, "agents", "a.md"), "from a\n");
    await push(opts(a));
    write(path.join(b.roots.config, "AGENTS.md"), "edited on b\n");
    await push(opts(b));
    expect(read(path.join(b.roots.config, "AGENTS.md"))).toBe("edited on b\n");
    expect(read(path.join(b.roots.config, "agents", "a.md"))).toBe("from a\n");
  });
});

describe("upgrade from 3.x", () => {
  /** A 3.x machine: the config folder is the worktree and holds the settings. */
  function make3x(name: string): Roots {
    const base = path.join(sandbox, name);
    const roots: Roots = {
      config: path.join(base, ".config", "opencode"),
      data: path.join(base, "data"),
      state: path.join(base, "state"),
      agents: path.join(base, "agents", "skills"),
      cache: path.join(base, "cache"),
    };
    for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true });
    const c = roots.config;
    const run = (...args: string[]) => execFileSync("git", args, { cwd: c, stdio: "pipe" });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@t");
    run("config", "user.name", "t");
    write(path.join(c, "opencode.jsonc"), '{ "model": "x" }\n');
    write(path.join(c, "AGENTS.md"), "rules\n");
    write(path.join(c, "scripts", "run.sh"), "echo\n");
    write(path.join(c, "_agents", "s1", "SKILL.md"), "skill\n");
    write(path.join(c, ".gitignore"), "opencode-sync.jsonc\n");
    // 3.x always wrote this, so checkouts are LF on every platform.
    write(path.join(c, ".gitattributes"), DEFAULT_GITATTRIBUTES);
    run("add", "-A");
    run("commit", "-qm", "3.x");
    write(
      path.join(c, "opencode-sync.jsonc"),
      JSON.stringify({ repo: { url: remote }, machineAlias: name }),
    );
    write(path.join(c, "opencode-sync.overrides.jsonc"), '{ "model": "local" }\n');
    write(path.join(c, "notes.txt"), "never shared\n");
    return roots;
  }

  it("moves the repository and settings, keeps what 3.x shared, and touches no config", () => {
    const roots = make3x("old");
    expect(needsMigration(roots)).toBe(true);
    const result = migrateFrom3x(roots);

    expect(result?.movedRepository).toBe(true);
    expect(result?.manifestWritten).toEqual(["+scripts/"]);
    const repo = repoDir(roots);
    expect(fs.existsSync(path.join(repo, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(roots.config, ".git"))).toBe(false);
    expect(read(path.join(repo, "_agents", "s1", "SKILL.md"))).toBe("skill\n");
    expect(read(path.join(repo, "AGENTS.md"))).toBe("rules\n");
    expect(read(path.join(repo, MANIFEST_FILE))).toContain("+scripts/");
    // The live config is untouched.
    expect(read(path.join(roots.config, "AGENTS.md"))).toBe("rules\n");
    expect(read(path.join(roots.config, "notes.txt"))).toBe("never shared\n");
    // Settings moved; the 3.x files are kept in recovery, not lost.
    expect(fs.existsSync(path.join(roots.config, "opencode-sync.jsonc"))).toBe(false);
    expect(loadSettings(roots.config).machineAlias).toBe("old");
    expect(read(overridesPath(roots.config))).toContain("local");
    expect(
      listRecovery(roots).some((d) => fs.existsSync(path.join(d, "opencode-sync.jsonc"))),
    ).toBe(true);
    expect(needsMigration(roots)).toBe(false);
  });

  it("undoes everything when the move cannot finish", () => {
    const roots = make3x("stuck");
    // Something else already occupies the new working copy.
    write(path.join(repoDir(roots), "keep.txt"), "x");
    expect(() => migrateFrom3x(roots)).toThrow(/undone/);
    expect(fs.existsSync(path.join(roots.config, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(roots.config, "opencode-sync.jsonc"))).toBe(true);
    expect(fs.existsSync(settingsPath(roots.config))).toBe(false);
    expect(fs.existsSync(path.join(toolRoot(roots), ".migrating"))).toBe(false);
  });

  it("syncs normally right after the upgrade", async () => {
    const a = machine("alpha");
    write(path.join(a.roots.config, "opencode.jsonc"), '{ "model": "x" }\n');
    await push(opts(a));
    const roots = make3x("old");
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: roots.config, stdio: "pipe" });
    execFileSync("git", ["fetch", "-q", "origin"], { cwd: roots.config, stdio: "pipe" });
    const result = await pull({ roots, reporter: new CollectingReporter(), force: true });
    expect(result.action).toBe("pull");
    expect(fs.existsSync(path.join(repoDir(roots), ".git"))).toBe(true);
    expect(read(path.join(roots.config, "notes.txt"))).toBe("never shared\n");
  });
});

describe("preview releases", () => {
  it("orders a preview before its stable release", () => {
    expect(compareVersions("4.0.0-beta.1", "3.4.0")).toBe(1);
    expect(compareVersions("4.0.0", "4.0.0-beta.2")).toBe(1);
    expect(compareVersions("4.0.0-beta.2", "4.0.0-beta.1")).toBe(1);
  });
});
