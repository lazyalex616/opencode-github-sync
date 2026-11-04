import type { SqliteDatabase } from "./sqlite.js";
import { tableColumns, tablePrimaryKey } from "./sqlite.js";

/**
 * Row-level helpers shared by the session exporters and importers.
 *
 * Shards are JSON, so binary columns (OpenCode 2 stores attachments in
 * `blob.data`) are written as `{ "$base64": "..." }` and turned back into
 * bytes on import.
 */

export type Row = Record<string, unknown>;

export interface TableInfo {
  columns: Set<string>;
  primaryKey: string[];
}

export function readRows(db: SqliteDatabase, sql: string, params: unknown[] = []): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

/** Cached column and key information per table for one connection. */
export function tableInfoCache(db: SqliteDatabase): (table: string) => TableInfo {
  const cache = new Map<string, TableInfo>();
  return (table) => {
    let info = cache.get(table);
    if (!info) {
      info = { columns: new Set(tableColumns(db, table)), primaryKey: tablePrimaryKey(db, table) };
      cache.set(table, info);
    }
    return info;
  };
}

/** Make a row JSON-safe: binary values become `{ $base64 }`. */
export function encodeRow(row: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      value instanceof Uint8Array ? { $base64: Buffer.from(value).toString("base64") } : value;
  }
  return out;
}

/** SQLite drivers accept null/number/string/bigint/Buffer only. */
export function normalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    const encoded = (value as { $base64?: unknown }).$base64;
    if (typeof encoded === "string" && Object.keys(value).length === 1) {
      return Buffer.from(encoded, "base64");
    }
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Insert a row, or update the existing one in place.
 *
 * This must be a true UPSERT, never `INSERT OR REPLACE`: REPLACE deletes the
 * conflicting row before inserting, and with foreign keys enforced (node:sqlite
 * enables them) deleting the shared `project` row cascades through
 * `session.project_id ON DELETE CASCADE` and silently removes every session
 * imported before it (#2).
 *
 * Primary-key columns are never rewritten, so composite keys such as
 * `todo (session_id, position)` stay intact. A row that is newer locally, by
 * `time_updated`, is left alone. `keepExisting` turns the update into a no-op
 * for rows that must stay machine-local once they exist.
 */
export function upsert(
  db: SqliteDatabase,
  table: string,
  row: Row,
  info: TableInfo,
  keepExisting = false,
): void {
  const columns = Object.keys(row).filter((column) => info.columns.has(column));
  if (columns.length === 0) return;
  const placeholders = columns.map(() => "?").join(", ");
  const quoted = columns.map((column) => `"${column}"`).join(", ");
  // No conflict target: the update applies to whichever uniqueness constraint
  // fired (primary key, composite key or a secondary UNIQUE index), matching
  // what REPLACE used to cover. Needs SQLite 3.35+, which both drivers bundle.
  const updates = columns.filter((column) => !info.primaryKey.includes(column));

  let action = "DO NOTHING";
  if (!keepExisting && updates.length > 0) {
    const assignments = updates.map((column) => `"${column}" = excluded."${column}"`).join(", ");
    const newerWins = columns.includes("time_updated")
      ? ` WHERE "${table}"."time_updated" IS NULL OR excluded."time_updated" >= "${table}"."time_updated"`
      : "";
    action = `DO UPDATE SET ${assignments}${newerWins}`;
  }

  db.prepare(
    `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders}) ON CONFLICT ${action}`,
  ).run(...columns.map((column) => normalize(row[column])));
}
