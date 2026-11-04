import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directoryProjectId, storedPath } from "../src/core/projects.js";
import { repairSessions } from "../src/core/repair.js";
import { type SqliteDatabase, openDatabase, sqliteAvailable } from "../src/core/sqlite.js";

const SCHEMA = fs.readFileSync(path.join(__dirname, "fixtures", "opencode-2.2.5.sql"), "utf8");

let root: string;
let available = false;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-repair-"));
  available = await sqliteAvailable();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function project(db: SqliteDatabase, id: string, worktree: string, created: number, vcs?: string) {
  db.prepare(
    `INSERT INTO project (id, worktree, vcs, sandboxes, time_created, time_updated)
     VALUES (?, ?, ?, '[]', ?, ?)`,
  ).run(id, storedPath(worktree), vcs ?? null, created, created);
}

function session(db: SqliteDatabase, id: string, projectId: string, directory: string) {
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, slug, directory, path, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, NULL, '1.18.0', 1, 1)`,
  ).run(id, projectId, id, storedPath(directory));
}

function placement(db: SqliteDatabase, id: string): any {
  return db.prepare("SELECT project_id, directory, path FROM session_v2 WHERE id = ?").all(id)[0];
}

async function fixture() {
  const home = path.join(root, "home");
  const plain = path.join(home, "notes");
  const repo = path.join(root, "repo");
  for (const d of [plain, path.join(repo, "src")]) fs.mkdirSync(d, { recursive: true });
  const file = path.join(root, "opencode.db");
  const db = await openDatabase(file);
  db.exec(SCHEMA);
  project(db, "global", "/", 1);
  project(db, directoryProjectId(home), home, 5);
  project(db, directoryProjectId(plain), plain, 5);
  project(db, "old-root", repo, 2, "git");
  project(db, "new-root", repo, 9, "git");
  // Migrated from OpenCode 1: a plain directory under `global`.
  session(db, "ses_global", "global", plain);
  // A repository whose project id changed: still on the old row.
  session(db, "ses_stale", "old-root", path.join(repo, "src"));
  // Already right.
  session(db, "ses_ok", "new-root", repo);
  // Another machine's path: no project here, parked in home.
  session(db, "ses_foreign", "global", "/Users/someone/elsewhere");
  db.close();
  return { file, home, plain, repo };
}

describe("repair-sessions", () => {
  it("reports without changing anything by default", async () => {
    if (!available) return;
    const { file, home } = await fixture();
    const result = await repairSessions(file, { apply: false, home });
    expect(result.supported).toBe(true);
    expect(result.moves.map((m) => m.id).sort()).toEqual([
      "ses_foreign",
      "ses_global",
      "ses_stale",
    ]);
    expect(result.applied).toBe(0);

    const db = await openDatabase(file, { readOnly: true });
    expect(placement(db, "ses_global").project_id).toBe("global");
    db.close();
  });

  it("moves each session into the project OpenCode 2 resolves for it", async () => {
    if (!available) return;
    const { file, home, plain, repo } = await fixture();
    const result = await repairSessions(file, { apply: true, home });
    expect(result.applied).toBe(3);

    const db = await openDatabase(file, { readOnly: true });
    expect(placement(db, "ses_global")).toEqual({
      project_id: directoryProjectId(plain),
      directory: storedPath(plain),
      path: "",
    });
    expect(placement(db, "ses_stale")).toEqual({
      project_id: "new-root",
      directory: storedPath(path.join(repo, "src")),
      path: "src",
    });
    expect(placement(db, "ses_ok").project_id).toBe("new-root");
    expect(placement(db, "ses_foreign")).toEqual({
      project_id: directoryProjectId(home),
      directory: storedPath(home),
      path: "",
    });
    db.close();

    const again = await repairSessions(file, { apply: true, home });
    expect(again.moves).toEqual([]);
  });

  it("does nothing on an OpenCode 1 database", async () => {
    if (!available) return;
    const file = path.join(root, "v1.db");
    const db = await openDatabase(file);
    db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    db.close();
    const result = await repairSessions(file, { apply: true, home: root });
    expect(result.supported).toBe(false);
  });
});
