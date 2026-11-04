import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directoryProjectId, storedPath } from "../src/core/projects.js";
import { silentReporter } from "../src/core/reporter.js";
import { exportSessions, importSessions, listSessions } from "../src/core/sessions.js";
import type { SessionSettings } from "../src/core/settings.js";
import { type SqliteDatabase, openDatabase, sqliteAvailable } from "../src/core/sqlite.js";

/**
 * OpenCode 2 session sync, against the schema of a real 2.2.5 database
 * (`fixtures/opencode-2.2.5.sql`), so NOT NULL columns and foreign keys behave
 * exactly as they do on a user's machine. All values are fake.
 */

const SCHEMA = fs.readFileSync(path.join(__dirname, "fixtures", "opencode-2.2.5.sql"), "utf8");
const DAY = 24 * 60 * 60 * 1000;

const settings = (patch: Partial<SessionSettings> = {}): SessionSettings & { now?: number } => ({
  enabled: true,
  days: 7,
  maxSessions: 50,
  maxSessionBytes: 5 * 1024 * 1024,
  include: [],
  exclude: [],
  directories: [],
  ...patch,
});

let root: string;
let available = false;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-v2-"));
  available = await sqliteAvailable();
});

afterEach(() => {
  delete process.env.SYNC_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

async function createDb(file: string): Promise<SqliteDatabase> {
  const db = await openDatabase(file);
  db.exec(SCHEMA);
  return db;
}

function addProject(db: SqliteDatabase, id: string, worktree: string, created = 1): void {
  db.prepare(
    `INSERT INTO project (id, worktree, vcs, sandboxes, time_created, time_updated)
     VALUES (?, ?, NULL, '[]', ?, ?)`,
  ).run(id, storedPath(worktree), created, created);
}

interface SessionSpec {
  id: string;
  project: string;
  directory: string;
  updated: number;
  messages?: number;
  busy?: boolean;
}

function addSession(db: SqliteDatabase, spec: SessionSpec): void {
  db.prepare(
    `INSERT INTO session_v2 (id, project_id, slug, directory, path, title, version,
       time_created, time_updated, time_busy, resume_attempts)
     VALUES (?, ?, ?, ?, '', ?, '2.2.5', ?, ?, ?, ?)`,
  ).run(
    spec.id,
    spec.project,
    spec.id,
    storedPath(spec.directory),
    `title ${spec.id}`,
    spec.updated - 1000,
    spec.updated,
    spec.busy ? spec.updated : null,
    spec.busy ? 2 : 0,
  );
  const count = spec.messages ?? 2;
  for (let seq = 1; seq <= count; seq++) {
    db.prepare(
      `INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `msg_${spec.id}_${seq}`,
      spec.id,
      seq % 2 ? "user" : "assistant",
      seq,
      seq,
      seq,
      JSON.stringify({ text: `message ${seq} of ${spec.id}` }),
    );
  }
  db.prepare(
    `INSERT INTO session_part (message_id, session_id, ordinal, type, time_created, time_updated, data)
     VALUES (?, ?, 0, 'text', 1, 1, '{}')`,
  ).run(`msg_${spec.id}_1`, spec.id);
  db.prepare("INSERT INTO event_sequence (aggregate_id, seq, owner_id) VALUES (?, ?, ?)").run(
    spec.id,
    count,
    "owner-on-this-machine",
  );
  const hash = "a".repeat(64);
  db.prepare("INSERT INTO instruction_blob (hash, value) VALUES (?, ?) ON CONFLICT DO NOTHING").run(
    hash,
    "system prompt text",
  );
  db.prepare(
    `INSERT INTO instruction_state (session_id, epoch_start, through_seq, initial_values, current_values)
     VALUES (?, 1, 1, ?, ?)`,
  ).run(spec.id, JSON.stringify({ "core/date": hash }), JSON.stringify({ "core/date": hash }));
}

function readShard(repo: string, id: string): any {
  return JSON.parse(
    gunzipSync(fs.readFileSync(path.join(repo, "_sessions", `${id}.json.gz`))).toString(),
  );
}

function rows(db: SqliteDatabase, sql: string, ...params: unknown[]): any[] {
  return db.prepare(sql).all(...params) as any[];
}

/** Machine A with one recent session in a project directory that exists on both machines. */
async function machineA(now: number, work: string, extra?: (db: SqliteDatabase) => void) {
  const source = path.join(root, "a.db");
  const db = await createDb(source);
  addProject(db, directoryProjectId(work), work);
  addSession(db, {
    id: "ses_one",
    project: directoryProjectId(work),
    directory: work,
    updated: now - DAY,
  });
  extra?.(db);
  db.close();
  return source;
}

describe("OpenCode 2 sessions", () => {
  it("exports from session_v2 and round-trips into a fresh OpenCode 2 database", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const source = await machineA(now, work);
    const repo = path.join(root, "repo");

    const exported = await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    expect(exported.written).toEqual(["ses_one"]);
    const shard = readShard(repo, "ses_one");
    expect(shard.formatVersion).toBe(2);
    expect(shard.schema).toBe("v2");
    expect(shard.tables.session_message).toHaveLength(2);
    expect(shard.tables.event_sequence[0].owner_id).toBeNull();
    expect(shard.blobs.instruction_blob).toHaveLength(1);

    const target = path.join(root, "b.db");
    (await createDb(target)).close();
    const result = await importSessions(target, repo, silentReporter, { home: root, now });
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(1);

    const db = await openDatabase(target, { readOnly: true });
    const session = rows(db, "SELECT * FROM session_v2 WHERE id = 'ses_one'")[0];
    expect(session.project_id).toBe(directoryProjectId(work));
    expect(session.directory).toBe(storedPath(work));
    expect(session.path).toBe("");
    expect(rows(db, "SELECT seq FROM session_message ORDER BY seq").map((r) => r.seq)).toEqual([
      1, 2,
    ]);
    expect(rows(db, "SELECT count(*) AS n FROM session_part")[0].n).toBe(1);
    expect(rows(db, "SELECT seq FROM event_sequence")[0].seq).toBe(2);
    expect(rows(db, "SELECT value FROM instruction_blob")[0].value).toBe("system prompt text");
    db.close();

    expect((await listSessions(target, 10)).map((s) => s.id)).toEqual(["ses_one"]);
  });

  it("never carries a running conversation's runtime state to another machine", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const source = await machineA(now, work, (db) => {
      addSession(db, {
        id: "ses_busy",
        project: directoryProjectId(work),
        directory: work,
        updated: now,
        busy: true,
      });
    });
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);

    const shard = readShard(repo, "ses_busy");
    expect(shard.session.time_busy).toBeNull();
    expect(shard.session.resume_attempts).toBe(0);
  });

  it("creates the project OpenCode 2 would create for a directory it has not opened yet", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const source = await machineA(now, work);
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);

    const target = path.join(root, "b.db");
    (await createDb(target)).close();
    await importSessions(target, repo, silentReporter, { home: root, now });

    const db = await openDatabase(target, { readOnly: true });
    const project = rows(db, "SELECT * FROM project")[0];
    db.close();
    expect(project.id).toBe(directoryProjectId(work));
    expect(project.worktree).toBe(storedPath(path.resolve(work)));
  });

  it("parks a session whose directory this machine does not have in the home project", async () => {
    if (!available) return;
    const now = Date.now();
    const elsewhere = path.join(root, "only-on-a");
    fs.mkdirSync(elsewhere);
    const source = await machineA(now, elsewhere);
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    fs.rmSync(elsewhere, { recursive: true });

    const home = path.join(root, "home-b");
    fs.mkdirSync(home);
    const target = path.join(root, "b.db");
    (await createDb(target)).close();
    const result = await importSessions(target, repo, silentReporter, { home, now });
    expect(result.failed).toEqual([]);

    const db = await openDatabase(target, { readOnly: true });
    const session = rows(db, "SELECT project_id, directory, path FROM session_v2")[0];
    db.close();
    expect(session.project_id).toBe(directoryProjectId(home));
    expect(session.directory).toBe(storedPath(path.resolve(home)));
    expect(session.path).toBe("");
  });

  it("maps a directory under the exporting machine's home onto this machine's home", async () => {
    if (!available) return;
    const now = Date.now();
    const homeA = path.join(root, "home-a");
    const homeB = path.join(root, "home-b");
    fs.mkdirSync(path.join(homeA, "proj"), { recursive: true });
    fs.mkdirSync(path.join(homeB, "proj"), { recursive: true });
    process.env.SYNC_HOME = homeA;
    const source = await machineA(now, path.join(homeA, "proj"));
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    fs.rmSync(homeA, { recursive: true });

    const target = path.join(root, "b.db");
    (await createDb(target)).close();
    await importSessions(target, repo, silentReporter, { home: homeB, now });

    const db = await openDatabase(target, { readOnly: true });
    const session = rows(db, "SELECT project_id, directory FROM session_v2")[0];
    db.close();
    expect(session.directory).toBe(storedPath(path.join(homeB, "proj")));
    expect(session.project_id).toBe(directoryProjectId(path.join(homeB, "proj")));
  });

  it("replaces an older local copy and keeps a diverged one in recovery", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const source = await machineA(now, work);
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);

    // B continued the same conversation earlier, with a message A never saw.
    const target = path.join(root, "b.db");
    const b = await createDb(target);
    addProject(b, directoryProjectId(work), work);
    addSession(b, {
      id: "ses_one",
      project: directoryProjectId(work),
      directory: work,
      updated: now - 2 * DAY,
      messages: 3,
    });
    b.prepare("UPDATE session_message SET id = 'msg_only_on_b' WHERE seq = 3").run();
    b.close();

    const recovery = path.join(root, "recovery");
    const result = await importSessions(target, repo, silentReporter, {
      home: root,
      now,
      recoveryRoot: recovery,
    });
    expect(result.failed).toEqual([]);
    expect(result.imported).toBe(1);

    const db = await openDatabase(target, { readOnly: true });
    expect(rows(db, "SELECT count(*) AS n FROM session_message")[0].n).toBe(2);
    expect(rows(db, "SELECT seq FROM event_sequence")[0].seq).toBe(2);
    db.close();
    const saved = fs.readdirSync(recovery);
    expect(saved).toHaveLength(1);
    expect(fs.readdirSync(path.join(recovery, saved[0]!))).toEqual(["ses_one.json.gz"]);
  });

  it("leaves a session that is running on this machine alone", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const source = await machineA(now, work);
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);

    const target = path.join(root, "b.db");
    const b = await createDb(target);
    addProject(b, directoryProjectId(work), work);
    addSession(b, {
      id: "ses_one",
      project: directoryProjectId(work),
      directory: work,
      updated: now - 3 * DAY,
      busy: true,
    });
    b.close();

    const result = await importSessions(target, repo, silentReporter, { home: root, now });
    expect(result.imported).toBe(0);
    expect(result.skippedOlder).toBe(1);
  });

  it("skips shards of the other OpenCode major version and keeps them in the repository", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const repo = path.join(root, "repo");
    const dir = path.join(repo, "_sessions");
    fs.mkdirSync(dir, { recursive: true });
    const { gzipSync } = await import("node:zlib");
    const v1 = {
      formatVersion: 1,
      session: { id: "ses_v1", time_updated: now - DAY, directory: "/x" },
      tables: {},
      exportedAt: now - DAY,
    };
    fs.writeFileSync(path.join(dir, "ses_v1.json.gz"), gzipSync(Buffer.from(JSON.stringify(v1))));

    const source = await machineA(now, work);
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    expect(fs.existsSync(path.join(dir, "ses_v1.json.gz"))).toBe(true);

    const target = path.join(root, "b.db");
    (await createDb(target)).close();
    const result = await importSessions(target, repo, silentReporter, { home: root, now });
    expect(result.skippedOtherSchema).toBe(1);
    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it("writes byte-identical v2 shards on a repeat export", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const source = await machineA(now, work);
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    const file = path.join(repo, "_sessions", "ses_one.json.gz");
    const before = fs.readFileSync(file);
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("leaves a shard alone that is already as new as this machine's copy", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const source = await machineA(now, work);
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    const file = path.join(repo, "_sessions", "ses_one.json.gz");

    // Another machine wrote the same session: same time, different bytes.
    const { gzipSync } = await import("node:zlib");
    const theirs = readShard(repo, "ses_one");
    theirs.origin.home = "/home/someone-else";
    const bytes = gzipSync(Buffer.from(JSON.stringify(theirs)));
    fs.writeFileSync(file, bytes);

    const result = await exportSessions(source, repo, { ...settings(), now }, silentReporter);
    expect(result.written).toEqual(["ses_one"]);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it("round-trips binary attachments", async () => {
    if (!available) return;
    const now = Date.now();
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const hash = "b".repeat(64);
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    const source = await machineA(now, work, (db) => {
      db.prepare(
        "INSERT INTO blob (hash, mime, bytes, data, time_created) VALUES (?, 'image/png', 5, ?, 1)",
      ).run(hash, bytes);
      db.prepare(
        "INSERT INTO blob_ref (session_id, message_id, hash, seq) VALUES ('ses_one', 'msg_ses_one_1', ?, 1)",
      ).run(hash);
    });
    const repo = path.join(root, "repo");
    await exportSessions(source, repo, { ...settings(), now }, silentReporter);

    const target = path.join(root, "b.db");
    (await createDb(target)).close();
    const result = await importSessions(target, repo, silentReporter, { home: root, now });
    expect(result.failed).toEqual([]);

    const db = await openDatabase(target, { readOnly: true });
    const blob = rows(db, "SELECT data FROM blob WHERE hash = ?", hash)[0];
    db.close();
    expect(Buffer.from(blob.data).equals(bytes)).toBe(true);
  });
});
