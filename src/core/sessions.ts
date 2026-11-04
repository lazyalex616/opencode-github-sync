import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { ensureDir } from "./fsx.js";
import { SESSIONS_DIR } from "./paths.js";
import {
  GLOBAL_PROJECT_ID,
  type Placement,
  ProjectResolver,
  homeDir,
  storedPath,
} from "./projects.js";
import type { Reporter } from "./reporter.js";
import { type Row, type TableInfo, encodeRow, readRows, tableInfoCache, upsert } from "./rows.js";
import type { SessionSettings } from "./settings.js";
import {
  type SqliteDatabase,
  existingTables,
  hasTable,
  openDatabase,
  tableColumns,
} from "./sqlite.js";

/**
 * Selective session sync.
 *
 * The naive approach — commit `opencode.db` — stops working almost immediately.
 * A real database reaches several gigabytes, dominated by tool output stored in
 * `part.data`, and Git has no way to delta-compress it. Worse, copying a live
 * database together with its write-ahead log can capture a torn state that only
 * reveals itself much later.
 *
 * So sessions are exported one at a time. Each session becomes an independent,
 * gzipped JSON shard containing its own rows plus the project and workspace
 * rows it depends on. That buys three things:
 *
 *   - **No large files.** Shards are individually small and compress well.
 *   - **Conflict isolation.** Two machines editing different sessions touch
 *     different files, so Git merges them without any special handling. The
 *     only true conflict is the same session edited in two places, where the
 *     newer `time_updated` wins.
 *   - **Selectivity.** A time window, an explicit include list, a project
 *     filter and a per-session size cap decide what travels. Ancient sessions
 *     stay on the machine that created them.
 *
 * Import is an upsert inside a transaction, so a failure leaves the local
 * database exactly as it was.
 *
 * Two database layouts exist. OpenCode 1 keeps sessions in `session` with
 * `message`/`part`; OpenCode 2 keeps them in `session_v2` with
 * `session_message`/`session_part` and never writes the old tables again (a
 * fresh OpenCode 2 database does not even have them). The layout is detected
 * per database: `session_v2` present means OpenCode 2. Each layout has its own
 * shard format; a machine skips shards of the other one and never deletes them
 * while they are inside the time window, so a mixed fleet keeps working.
 */

/** OpenCode 1: tables whose rows belong to exactly one session. */
const SESSION_TABLES = [
  "session_message",
  "message",
  "part",
  "todo",
  "session_share",
  "session_context_epoch",
  "session_input",
] as const;

/**
 * OpenCode 2: tables whose rows belong to exactly one session, in insert
 * order. `event_sequence` (keyed by `aggregate_id`) carries the session's
 * message counter; without it a continued conversation restarts numbering and
 * collides with its own history.
 *
 * Never exported: `session_inbox` (queued input would be delivered on the
 * receiving machine), `job` and `schedule` (they would run there), `event`
 * and `permission`.
 */
const V2_TABLES = [
  "session_message",
  "session_part",
  "instruction_state",
  "instruction_entry",
  "blob_ref",
] as const;

/**
 * Columns describing what the session is doing right now on the machine that
 * exported it. Copied as they are, they would make the receiving machine
 * resume the conversation — and call a model — on its own.
 */
const V2_RUNTIME_COLUMNS: Record<string, unknown> = {
  time_busy: null,
  time_compacting: null,
  time_suspended: null,
  resume_attempts: 0,
};

/**
 * `event` and `event_sequence` are deliberately excluded from OpenCode 1
 * shards. They are an internal append-only runtime log, they dwarf everything
 * else in row count, and nothing about resuming a conversation on another
 * machine depends on them.
 */

export type SessionSchema = "v1" | "v2";

export interface SessionRecord {
  id: string;
  title: string;
  directory: string;
  timeUpdated: number;
  timeCreated: number;
  projectId: string;
}

export interface SessionShard {
  formatVersion: 1;
  session: Record<string, unknown>;
  project?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
  exportedAt: number;
}

export interface SessionShardV2 {
  formatVersion: 2;
  schema: "v2";
  /** The exporting machine's home, to map paths under it onto this machine. */
  origin: { home: string };
  session: Row;
  project?: Row;
  tables: Record<string, Row[]>;
  /** Content-addressed rows the session references. */
  blobs: Record<string, Row[]>;
  exportedAt: number;
}

type AnyShard = SessionShard | SessionShardV2;

export interface SelectOptions extends SessionSettings {
  now?: number;
}

export interface ExportResult {
  written: string[];
  skippedTooLarge: { id: string; title: string; bytes: number }[];
  considered: number;
}

export interface ImportResult {
  imported: number;
  skippedOlder: number;
  /** Shards written by a machine on the other OpenCode major version. */
  skippedOtherSchema: number;
  failed: { file: string; reason: string }[];
}

export interface ImportOptions {
  /** Where a local version replaced by an incoming one is saved. */
  recoveryRoot?: string;
  /** This machine's home directory. */
  home?: string;
  now?: number;
}

function shardPath(repoRoot: string, sessionId: string): string {
  return path.join(repoRoot, SESSIONS_DIR, `${sanitizeId(sessionId)}.json.gz`);
}

/** Session ids are opaque; keep them filesystem-safe without losing identity. */
export function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Which layout a database uses. */
export function sessionSchema(db: SqliteDatabase): SessionSchema {
  return hasTable(db, "session_v2") ? "v2" : "v1";
}

function sessionTable(schema: SessionSchema): string {
  return schema === "v2" ? "session_v2" : "session";
}

/**
 * Choose which sessions to export.
 *
 * Explicitly included ids always win, even when they fall outside the window.
 * Everything else must be inside the time window, pass the directory filter and
 * survive the count cap, which keeps the newest sessions.
 */
export function selectSessions(db: SqliteDatabase, options: SelectOptions): SessionRecord[] {
  const now = options.now ?? Date.now();
  const cutoff = now - options.days * 24 * 60 * 60 * 1000;

  const rows = readRows(
    db,
    `SELECT id, title, directory, time_updated, time_created, project_id
       FROM ${sessionTable(sessionSchema(db))}
      ORDER BY time_updated DESC`,
  ) as any[];

  const exclude = new Set(options.exclude);
  const include = new Set(options.include);
  const directories = options.directories.map((d) => path.resolve(d));

  const matchesDirectory = (directory: string): boolean => {
    if (directories.length === 0) return true;
    const resolved = path.resolve(String(directory ?? ""));
    return directories.some((d) => resolved === d || resolved.startsWith(`${d}${path.sep}`));
  };

  const selected: SessionRecord[] = [];
  let windowCount = 0;

  for (const row of rows) {
    const id = String(row.id);
    if (exclude.has(id)) continue;

    const record: SessionRecord = {
      id,
      title: String(row.title ?? ""),
      directory: String(row.directory ?? ""),
      timeUpdated: Number(row.time_updated ?? 0),
      timeCreated: Number(row.time_created ?? 0),
      projectId: String(row.project_id ?? ""),
    };

    if (include.has(id)) {
      selected.push(record);
      continue;
    }
    if (record.timeUpdated < cutoff) continue;
    if (!matchesDirectory(record.directory)) continue;
    if (windowCount >= options.maxSessions) continue;

    windowCount++;
    selected.push(record);
  }

  return selected;
}

function buildShard(db: SqliteDatabase, sessionId: string, tables: string[]): SessionShard {
  const sessionRow = readRows(db, "SELECT * FROM session WHERE id = ?", [sessionId])[0];
  if (!sessionRow) throw new Error(`Session ${sessionId} disappeared while exporting`);

  const shard: SessionShard = {
    formatVersion: 1,
    session: sessionRow,
    tables: {},
    // Derived from the session itself, never wall-clock time. A repeat export
    // of an unchanged session must produce identical bytes, otherwise every
    // push rewrites every shard and import/pull churn is unavoidable.
    exportedAt: Number(sessionRow.time_updated ?? 0),
  };

  const projectId = sessionRow.project_id;
  // The synthetic global project is machine-specific (worktree, vcs) and every
  // OpenCode install has its own, so it never travels (#4).
  if (projectId && projectId !== GLOBAL_PROJECT_ID) {
    shard.project = readRows(db, "SELECT * FROM project WHERE id = ?", [projectId])[0];
  }
  const workspaceId = (sessionRow as any).workspace_id;
  if (workspaceId) {
    const rows = readRows(db, "SELECT * FROM workspace WHERE id = ?", [workspaceId]);
    if (rows[0]) shard.workspace = rows[0];
  }

  for (const table of tables) {
    shard.tables[table] = readRows(db, `SELECT * FROM "${table}" WHERE session_id = ?`, [
      sessionId,
    ]);
  }

  return shard;
}

const HASH = /^[0-9a-f]{64}$/;

/** Every instruction-blob hash a session's instruction rows refer to. */
function instructionHashes(rows: Row[]): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (HASH.test(value)) found.add(value);
      else if (value.startsWith("{") || value.startsWith("[")) {
        try {
          visit(JSON.parse(value));
        } catch {
          // Not JSON — nothing to follow.
        }
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  for (const row of rows) for (const value of Object.values(row)) visit(value);
  return [...found].sort();
}

function buildShardV2(db: SqliteDatabase, sessionId: string, tables: string[]): SessionShardV2 {
  const raw = readRows(db, "SELECT * FROM session_v2 WHERE id = ?", [sessionId])[0];
  if (!raw) throw new Error(`Session ${sessionId} disappeared while exporting`);
  const session: Row = { ...raw };
  for (const [column, value] of Object.entries(V2_RUNTIME_COLUMNS)) {
    if (column in session) session[column] = value;
  }

  const shard: SessionShardV2 = {
    formatVersion: 2,
    schema: "v2",
    origin: { home: storedPath(homeDir()) },
    session,
    tables: {},
    blobs: {},
    exportedAt: Number(raw.time_updated ?? 0),
  };

  const projectId = raw.project_id;
  if (projectId && projectId !== GLOBAL_PROJECT_ID) {
    const project = readRows(db, "SELECT * FROM project WHERE id = ?", [projectId])[0];
    if (project) shard.project = project;
  }

  for (const table of tables) {
    shard.tables[table] = readRows(
      db,
      `SELECT * FROM "${table}" WHERE session_id = ? ORDER BY rowid`,
      [sessionId],
    ).map(encodeRow);
  }
  if (hasTable(db, "event_sequence")) {
    shard.tables.event_sequence = readRows(
      db,
      "SELECT * FROM event_sequence WHERE aggregate_id = ?",
      [sessionId],
    ).map((row) => ({ ...row, owner_id: null }));
  }

  const instructionRows = [
    ...(shard.tables.instruction_state ?? []),
    ...(shard.tables.instruction_entry ?? []),
  ];
  const hashes = instructionHashes(instructionRows);
  if (hashes.length > 0 && hasTable(db, "instruction_blob")) {
    shard.blobs.instruction_blob = hashes.flatMap((hash) =>
      readRows(db, "SELECT * FROM instruction_blob WHERE hash = ?", [hash]),
    );
  }
  const blobHashes = [...new Set((shard.tables.blob_ref ?? []).map((r) => String(r.hash)))].sort();
  if (blobHashes.length > 0 && hasTable(db, "blob")) {
    shard.blobs.blob = blobHashes.flatMap((hash) =>
      readRows(db, "SELECT * FROM blob WHERE hash = ?", [hash]).map(encodeRow),
    );
  }

  return shard;
}

/** Export the selected sessions into `<repo>/_sessions`. */
export async function exportSessions(
  databaseFile: string,
  repoRoot: string,
  options: SelectOptions,
  reporter: Reporter,
): Promise<ExportResult> {
  const result: ExportResult = { written: [], skippedTooLarge: [], considered: 0 };
  if (!fs.existsSync(databaseFile)) return result;

  const db = await openDatabase(databaseFile, { readOnly: true });
  try {
    const schema = sessionSchema(db);
    const tables =
      schema === "v2"
        ? existingTables(db, [...V2_TABLES])
        : existingTables(db, [...SESSION_TABLES]).filter((table) =>
            tableColumns(db, table).includes("session_id"),
          );
    const sessions = selectSessions(db, options);
    result.considered = sessions.length;

    const outDir = path.join(repoRoot, SESSIONS_DIR);
    ensureDir(outDir);

    const keep = new Set<string>();

    for (const session of sessions) {
      const file = shardPath(repoRoot, session.id);
      // A shard that is already at least as new as this machine's copy stays
      // as it is. It may differ in bytes only because another machine wrote it
      // (its home, its placement); rewriting it would make every machine
      // re-export every session it received, and could replace a newer copy
      // this machine skipped on import with an older one.
      if (existingShardTime(file) >= session.timeUpdated) {
        keep.add(path.basename(file));
        result.written.push(session.id);
        continue;
      }

      const shard =
        schema === "v2" ? buildShardV2(db, session.id, tables) : buildShard(db, session.id, tables);
      const payload = gzipSync(Buffer.from(JSON.stringify(shard)), { level: 9 });

      if (payload.byteLength > options.maxSessionBytes) {
        result.skippedTooLarge.push({
          id: session.id,
          title: session.title,
          bytes: payload.byteLength,
        });
        continue;
      }

      keep.add(path.basename(file));
      // Only rewrite when the payload actually changed, otherwise every push
      // would produce a diff for every session purely from the gzip timestamp.
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(payload)) {
        fs.writeFileSync(file, payload);
      }
      result.written.push(session.id);
    }

    pruneShards(outDir, keep, schema, options, reporter);
  } finally {
    db.close();
  }

  return result;
}

/**
 * Delete shards that no longer qualify.
 *
 * A shard is removed when it is outside the retention window, so the repository
 * does not accumulate every session ever synced. Shards for explicitly included
 * sessions are always kept, and so are recent shards of the other OpenCode
 * major version: this machine cannot judge them, a machine still on that
 * version exported them on purpose.
 */
function pruneShards(
  outDir: string,
  keep: Set<string>,
  schema: SessionSchema,
  options: SelectOptions,
  reporter: Reporter,
): void {
  const cutoff = (options.now ?? Date.now()) - options.days * 24 * 60 * 60 * 1000;
  let removed = 0;
  const includeFiles = new Set(options.include.map((id) => `${sanitizeId(id)}.json.gz`));
  for (const entry of fs.readdirSync(outDir)) {
    if (!entry.endsWith(".json.gz")) continue;
    if (keep.has(entry) || includeFiles.has(entry)) continue;
    const full = path.join(outDir, entry);
    const other = otherSchemaShard(full, schema);
    if (other && Number(other.session.time_updated ?? 0) >= cutoff) continue;
    fs.rmSync(full, { force: true });
    removed++;
  }
  if (removed > 0)
    reporter.detail(`Removed ${removed} session shard(s) outside the retention window`);
}

/** `time_updated` of the session in an existing shard file, or -1 when there is none. */
function existingShardTime(file: string): number {
  if (!fs.existsSync(file)) return -1;
  try {
    return Number(parseShard(file).session.time_updated ?? -1);
  } catch {
    return -1;
  }
}

function otherSchemaShard(file: string, schema: SessionSchema): AnyShard | undefined {
  try {
    const shard = parseShard(file);
    return shardSchema(shard) === schema ? undefined : shard;
  } catch {
    return undefined;
  }
}

function parseShard(file: string): AnyShard {
  const raw = gunzipSync(fs.readFileSync(file));
  return JSON.parse(raw.toString("utf8")) as AnyShard;
}

function shardSchema(shard: AnyShard): SessionSchema | undefined {
  if (shard.formatVersion === 1) return "v1";
  if (shard.formatVersion === 2 && (shard as SessionShardV2).schema === "v2") return "v2";
  return undefined;
}

function readShard(file: string): AnyShard {
  const shard = parseShard(file);
  if (!shardSchema(shard)) {
    throw new Error(`Unsupported shard format v${(shard as any).formatVersion}`);
  }
  return shard;
}

/** Import every shard from `<repo>/_sessions` into the local database. */
export async function importSessions(
  databaseFile: string,
  repoRoot: string,
  reporter: Reporter,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, skippedOlder: 0, skippedOtherSchema: 0, failed: [] };
  const shardDir = path.join(repoRoot, SESSIONS_DIR);
  if (!fs.existsSync(shardDir)) return result;

  const files = fs.readdirSync(shardDir).filter((f) => f.endsWith(".json.gz"));
  if (files.length === 0) return result;
  if (!fs.existsSync(databaseFile)) {
    reporter.warn("No local OpenCode database yet — start OpenCode once, then pull again.");
    return result;
  }

  const db = await openDatabase(databaseFile);
  try {
    const schema = sessionSchema(db);
    const columns = tableInfoCache(db);
    const table = sessionTable(schema);

    const localTimes = new Map<string, number>();
    const localBusy = new Set<string>();
    const busyColumn = schema === "v2" && columns(table).columns.has("time_busy");
    for (const row of readRows(
      db,
      `SELECT id, time_updated${busyColumn ? ", time_busy" : ""} FROM ${table}`,
    ) as any[]) {
      localTimes.set(String(row.id), Number(row.time_updated ?? 0));
      if (row.time_busy != null) localBusy.add(String(row.id));
    }

    const resolver =
      schema === "v2"
        ? new ProjectResolver(db, {
            home: options.home ?? homeDir(),
            createProjects: true,
            now: options.now ?? Date.now(),
          })
        : undefined;

    for (const file of files) {
      const full = path.join(shardDir, file);
      try {
        const shard = readShard(full);
        if (shardSchema(shard) !== schema) {
          result.skippedOtherSchema++;
          continue;
        }
        const sessionId = String(shard.session.id);
        const incoming = Number(shard.session.time_updated ?? 0);
        const local = localTimes.get(sessionId);

        // Last-writer-wins at session granularity. A session that is newer
        // locally — or running right now — is left completely alone, so an
        // in-progress conversation is never clobbered by a stale copy.
        if ((local !== undefined && local >= incoming) || localBusy.has(sessionId)) {
          result.skippedOlder++;
          continue;
        }

        db.exec("BEGIN IMMEDIATE");
        try {
          if (schema === "v2") {
            importShardV2(db, shard as SessionShardV2, columns, resolver!, local !== undefined, {
              recoveryRoot: options.recoveryRoot,
              file,
            });
          } else {
            importShardV1(db, shard as SessionShard, columns);
          }
          db.exec("COMMIT");
          result.imported++;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      } catch (err) {
        result.failed.push({ file, reason: (err as Error).message });
      }
    }
  } finally {
    db.close();
  }

  return result;
}

function importShardV1(
  db: SqliteDatabase,
  shard: SessionShard,
  columns: (table: string) => TableInfo,
): void {
  if (shard.project) {
    // Shards written before #4 still carry the synthetic global project.
    // Create it if missing, but never overwrite this machine's own row.
    const local = String(shard.project.id) === GLOBAL_PROJECT_ID;
    upsert(db, "project", shard.project, columns("project"), local);
  }
  if (shard.workspace) upsert(db, "workspace", shard.workspace, columns("workspace"));
  upsert(db, "session", shard.session, columns("session"));

  for (const [table, rows] of Object.entries(shard.tables)) {
    if (rows.length === 0) continue;
    if (!hasTable(db, table)) continue; // Table does not exist in this OpenCode version.
    const allowed = columns(table);
    if (allowed.columns.size === 0) continue;
    for (const row of rows) upsert(db, table, row, allowed);
  }
}

/** Child rows of one session, in an order that satisfies the foreign keys. */
function v2ChildTables(db: SqliteDatabase): string[] {
  return existingTables(db, [...V2_TABLES]);
}

function deleteV2Children(db: SqliteDatabase, sessionId: string): void {
  // session_part cascades from session_message; the rest are deleted directly.
  for (const table of [...v2ChildTables(db)].reverse()) {
    db.prepare(`DELETE FROM "${table}" WHERE session_id = ?`).run(sessionId);
  }
  if (hasTable(db, "event_sequence")) {
    db.prepare("DELETE FROM event_sequence WHERE aggregate_id = ?").run(sessionId);
  }
}

/**
 * Save the local copy of a session that an incoming one is about to replace,
 * when the local copy has messages the incoming one lacks — the conversation
 * was continued on both machines. Nothing is lost, the newer copy still wins.
 */
function saveDivergedLocal(
  db: SqliteDatabase,
  shard: SessionShardV2,
  recoveryRoot: string | undefined,
  file: string,
): void {
  if (!recoveryRoot) return;
  const sessionId = String(shard.session.id);
  const incoming = new Set((shard.tables.session_message ?? []).map((r) => String(r.id)));
  const localIds = readRows(db, "SELECT id FROM session_message WHERE session_id = ?", [
    sessionId,
  ]).map((r) => String(r.id));
  if (localIds.every((id) => incoming.has(id))) return;
  const local = buildShardV2(db, sessionId, v2ChildTables(db));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  const dir = path.join(recoveryRoot, `${stamp}-session-conflict`);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, file), gzipSync(Buffer.from(JSON.stringify(local))));
}

function importShardV2(
  db: SqliteDatabase,
  shard: SessionShardV2,
  columns: (table: string) => TableInfo,
  resolver: ProjectResolver,
  existsLocally: boolean,
  context: { recoveryRoot?: string; file: string },
): void {
  const sessionId = String(shard.session.id);

  resolver.adopt(shard.project, (row) =>
    upsert(db, "project", { ...row, time_archived: null }, columns("project"), true),
  );
  const placement: Placement = resolver.place({
    directory: String(shard.session.directory ?? ""),
    projectId: String(shard.session.project_id ?? ""),
    path: shard.session.path == null ? null : String(shard.session.path),
    originHome: shard.origin?.home,
  });
  // `place` may have created a project row.
  if (!hasRow(db, "project", placement.projectId)) {
    throw new Error(`no project for ${String(shard.session.directory)} on this machine`);
  }

  if (existsLocally) {
    saveDivergedLocal(db, shard, context.recoveryRoot, context.file);
    deleteV2Children(db, sessionId);
  }

  const session: Row = {
    ...shard.session,
    project_id: placement.projectId,
    directory: placement.directory,
    path: placement.path,
    // Workspaces describe this machine's remote environments; a foreign id
    // would point at nothing here.
    workspace_id: null,
  };
  upsert(db, "session_v2", session, columns("session_v2"));

  for (const [table, rows] of Object.entries(shard.blobs ?? {})) {
    if (rows.length === 0 || !hasTable(db, table)) continue;
    // Content-addressed: an existing row with the same hash is identical.
    for (const row of rows) upsert(db, table, row, columns(table), true);
  }
  for (const table of [...v2ChildTables(db), "event_sequence"]) {
    const rows = shard.tables[table] ?? [];
    if (rows.length === 0 || !hasTable(db, table)) continue;
    const info = columns(table);
    for (const row of rows) upsert(db, table, row, info);
  }
}

function hasRow(db: SqliteDatabase, table: string, id: string): boolean {
  return readRows(db, `SELECT 1 AS x FROM "${table}" WHERE id = ?`, [id]).length > 0;
}

/** List sessions available locally, newest first — powers `sessions list`. */
export async function listSessions(databaseFile: string, limit: number): Promise<SessionRecord[]> {
  if (!fs.existsSync(databaseFile)) return [];
  const db = await openDatabase(databaseFile, { readOnly: true });
  try {
    const rows = readRows(
      db,
      `SELECT id, title, directory, time_updated, time_created, project_id
         FROM ${sessionTable(sessionSchema(db))} ORDER BY time_updated DESC LIMIT ?`,
      [limit],
    ) as any[];
    return rows.map((row) => ({
      id: String(row.id),
      title: String(row.title ?? ""),
      directory: String(row.directory ?? ""),
      timeUpdated: Number(row.time_updated ?? 0),
      timeCreated: Number(row.time_created ?? 0),
      projectId: String(row.project_id ?? ""),
    }));
  } finally {
    db.close();
  }
}
