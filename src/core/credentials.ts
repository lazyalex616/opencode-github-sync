import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readRows } from "./rows.js";
import { type SqliteDatabase, hasTable, openDatabase } from "./sqlite.js";

/**
 * Keep OpenCode 2's credential table and the synced `auth.json` in step.
 *
 * OpenCode 1 reads `auth.json` directly, so syncing the file was enough.
 * OpenCode 2 keeps accounts in the `credential` table of `opencode.db` and
 * reads `auth.json` at most once — and a database created fresh by 2.x marks
 * that import as done without running it, so on a new machine a synced
 * `auth.json` is never read at all. This bridge copies between the two around
 * every sync, only when credential sync is turned on:
 *
 *   - before a push, an account chosen or a token refreshed in OpenCode reaches
 *     `auth.json` and from there the other machines;
 *   - after a pull, what other machines published reaches the database. A
 *     running OpenCode sees the change on its next request.
 *
 * Which side changed is decided against a fingerprint of the last value
 * bridged per integration, kept in a machine-local file next to the database
 * (a hash, never the secret). When both changed, a later OAuth expiry wins;
 * otherwise the database wins before a push and the file wins after a pull.
 *
 * Logging out in OpenCode removes the entry from `auth.json`, as it did with
 * OpenCode 1. An entry missing from an incoming `auth.json` never logs this
 * machine out. Integrations OpenCode 2 manages itself (`external`) and
 * entries it cannot represent are left alone. Nothing here prints a secret.
 */

export const BRIDGE_STATE_FILE = "opencode-sync-credentials.json";

export type BridgePreference = "database" | "file";

export interface BridgeResult {
  /** Integrations whose value was written into `auth.json`. */
  toFile: string[];
  /** Integrations whose value was written into the database. */
  toDatabase: string[];
  /** Integrations removed from `auth.json` after a logout here. */
  removed: string[];
}

type Entry = Record<string, any>;

interface CredentialRow {
  id: string;
  value: Entry;
  active: number | null;
}

/** The method id OpenCode 2's own importer assigns. */
function methodFor(integration: string): string {
  if (integration === "openai") return "chatgpt-browser";
  if (["github-copilot", "opencode", "xai"].includes(integration)) return "device";
  return "oauth";
}

/** A legacy `auth.json` entry this bridge can carry, or undefined. */
function bridgeable(entry: unknown): Entry | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Entry;
  if (e.type === "oauth" && (typeof e.access === "string" || typeof e.refresh === "string")) {
    return e;
  }
  if (e.type === "api" && typeof e.key === "string") return e;
  return undefined;
}

/** OpenCode 2 value -> legacy `auth.json` entry. */
function toLegacy(value: Entry): Entry | undefined {
  if (value?.type === "oauth") {
    const out: Entry = {
      type: "oauth",
      refresh: value.refresh,
      access: value.access,
      expires: typeof value.expires === "number" ? value.expires : 0,
    };
    if (value.metadata?.accountID) out.accountId = value.metadata.accountID;
    if (value.metadata?.enterpriseUrl) out.enterpriseUrl = value.metadata.enterpriseUrl;
    return out;
  }
  if (value?.type === "key" && typeof value.key === "string") {
    const out: Entry = { type: "api", key: value.key };
    if (value.metadata && Object.keys(value.metadata).length > 0) out.metadata = value.metadata;
    return out;
  }
  return undefined;
}

/** Legacy entry -> OpenCode 2 value, keeping what the existing row already knew. */
function toV2(entry: Entry, integration: string, base?: Entry): Entry {
  if (entry.type === "oauth") {
    const metadata: Entry = { ...(base?.type === "oauth" ? (base.metadata ?? {}) : {}) };
    if (entry.accountId) metadata.accountID = entry.accountId;
    if (entry.enterpriseUrl) metadata.enterpriseUrl = entry.enterpriseUrl;
    const out: Entry = {
      type: "oauth",
      methodID: base?.type === "oauth" && base.methodID ? base.methodID : methodFor(integration),
      refresh: entry.refresh ?? entry.access,
      access: entry.access ?? entry.refresh,
      expires: typeof entry.expires === "number" ? entry.expires : 0,
    };
    if (Object.keys(metadata).length > 0) out.metadata = metadata;
    return out;
  }
  const out: Entry = { type: "key", key: entry.key };
  const metadata = entry.metadata ?? (base?.type === "key" ? base.metadata : undefined);
  if (metadata && Object.keys(metadata).length > 0) out.metadata = metadata;
  return out;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Entry)
        .sort()
        .map((k) => [k, sorted((value as Entry)[k])]),
    );
  }
  return value;
}

/** Fingerprint of the parts of an entry that matter; extra fields are ignored. */
function fingerprint(entry: Entry | undefined): string | undefined {
  if (!entry) return undefined;
  const core =
    entry.type === "oauth"
      ? {
          type: "oauth",
          access: entry.access ?? null,
          refresh: entry.refresh ?? null,
          expires: typeof entry.expires === "number" ? entry.expires : 0,
          accountId: entry.accountId ?? null,
          enterpriseUrl: entry.enterpriseUrl ?? null,
        }
      : { type: "api", key: entry.key, metadata: entry.metadata ?? null };
  return createHash("sha256")
    .update(JSON.stringify(sorted(core)))
    .digest("hex")
    .slice(0, 32);
}

function sameSecret(value: Entry, entry: Entry): boolean {
  if (value?.type === "oauth" && entry.type === "oauth") {
    return (
      (typeof entry.access === "string" && value.access === entry.access) ||
      (typeof entry.refresh === "string" && value.refresh === entry.refresh)
    );
  }
  if (value?.type === "key" && entry.type === "api") return value.key === entry.key;
  return false;
}

/** A newer token for the same OAuth account (the refresh token rotated). */
function isRotation(value: Entry, entry: Entry): boolean {
  if (value?.type !== "oauth" || entry.type !== "oauth") return false;
  if (typeof entry.expires !== "number" || typeof value.expires !== "number") return false;
  if (entry.expires <= 0 || entry.expires <= value.expires) return false;
  const a = value.metadata?.accountID;
  const b = entry.accountId;
  return !a || !b || a === b;
}

function newId(now: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const random = [...randomBytes(14)].map((b) => alphabet[b % alphabet.length]).join("");
  return `cred_${now.toString(16).padStart(12, "0")}${random}`;
}

function loadRows(db: SqliteDatabase): Map<string, CredentialRow[]> {
  const out = new Map<string, CredentialRow[]>();
  for (const row of readRows(
    db,
    "SELECT id, integration_id, value, active FROM credential ORDER BY time_updated DESC",
  )) {
    const integration = row.integration_id == null ? "" : String(row.integration_id);
    if (!integration) continue;
    let value: Entry = {};
    try {
      value = JSON.parse(String(row.value));
    } catch {
      // An unreadable row is treated as foreign and never matched.
    }
    const list = out.get(integration) ?? [];
    list.push({
      id: String(row.id),
      value,
      active: row.active == null ? null : Number(row.active),
    });
    out.set(integration, list);
  }
  return out;
}

type Chosen = { kind: "none" } | { kind: "ambiguous" } | { kind: "row"; row: CredentialRow };

/** The account OpenCode 2 uses for an integration. */
function chosen(rows: CredentialRow[] | undefined): Chosen {
  if (!rows || rows.length === 0) return { kind: "none" };
  const active = rows.filter((r) => r.active === 1);
  if (active.length === 1) return { kind: "row", row: active[0]! };
  if (active.length === 0 && rows.length === 1) return { kind: "row", row: rows[0]! };
  return { kind: "ambiguous" };
}

function applyToDatabase(
  db: SqliteDatabase,
  integration: string,
  entry: Entry,
  rows: CredentialRow[],
  now: number,
): void {
  const current = chosen(rows);
  let target = rows.find((r) => sameSecret(r.value, entry));
  if (!target && current.kind === "row" && isRotation(current.row.value, entry)) {
    target = current.row;
  }
  if (target) {
    const value = toV2(entry, integration, target.value);
    if (JSON.stringify(sorted(value)) !== JSON.stringify(sorted(target.value))) {
      db.prepare("UPDATE credential SET value = ?, time_updated = ? WHERE id = ?").run(
        JSON.stringify(value),
        now,
        target.id,
      );
    }
  } else {
    target = { id: newId(now), value: toV2(entry, integration), active: 1 };
    db.prepare(
      `INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      target.id,
      integration,
      entry.type === "oauth" ? "OAuth" : "API key",
      JSON.stringify(target.value),
      now,
      now,
    );
  }
  db.prepare(
    `UPDATE credential
        SET active = CASE WHEN id = ? THEN 1 ELSE 0 END,
            time_updated = CASE WHEN id = ? AND coalesce(active, 0) <> 1 THEN ? ELSE time_updated END
      WHERE integration_id = ?`,
  ).run(target.id, target.id, now, integration);
  // Copies of the same account, such as OpenCode's own first-start import
  // next to an account added later, would show up twice in the switcher.
  for (const other of rows) {
    if (other.id !== target.id && sameSecret(other.value, entry)) {
      db.prepare("DELETE FROM credential WHERE id = ?").run(other.id);
    }
  }
}

function readJson(file: string): { ok: boolean; value?: any } {
  if (!fs.existsSync(file)) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) };
  } catch {
    return { ok: false };
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temp = `${file}.bridge-${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** True when this database belongs to OpenCode 2 (has the credential table). */
export async function hasCredentialTable(databaseFile: string): Promise<boolean> {
  if (!fs.existsSync(databaseFile)) return false;
  const db = await openDatabase(databaseFile, { readOnly: true });
  try {
    return hasTable(db, "credential");
  } finally {
    db.close();
  }
}

/** Reconcile `auth.json` and the credential table of one data directory. */
export async function bridgeCredentials(
  dataRoot: string,
  prefer: BridgePreference,
  now = Date.now(),
): Promise<BridgeResult> {
  const result: BridgeResult = { toFile: [], toDatabase: [], removed: [] };
  const databaseFile = path.join(dataRoot, "opencode.db");
  if (!(await hasCredentialTable(databaseFile))) return result;

  const authFile = path.join(dataRoot, "auth.json");
  const authRead = readJson(authFile);
  // A half-written or hand-broken auth.json must never be overwritten.
  if (!authRead.ok) return result;
  const auth: Entry =
    authRead.value && typeof authRead.value === "object" && !Array.isArray(authRead.value)
      ? authRead.value
      : {};
  const stateFile = path.join(dataRoot, BRIDGE_STATE_FILE);
  const stateRead = readJson(stateFile);
  const last: Record<string, string> = { ...(stateRead.value?.fingerprints ?? {}) };
  const before = JSON.stringify(last);

  // auth.json keys may carry a trailing slash; OpenCode 2 strips it.
  const fileKey = new Map<string, string>();
  for (const key of Object.keys(auth)) fileKey.set(key.replace(/\/+$/, ""), key);

  const db = await openDatabase(databaseFile);
  let authChanged = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = loadRows(db);
      const integrations = new Set([...fileKey.keys(), ...rows.keys()]);
      for (const integration of [...integrations].sort()) {
        const key = fileKey.get(integration) ?? integration;
        const fileEntry = bridgeable(auth[key]);
        if (auth[key] !== undefined && !fileEntry) continue;
        const pick = chosen(rows.get(integration));
        if (pick.kind === "ambiguous") continue;
        const dbEntry = pick.kind === "row" ? toLegacy(pick.row.value) : undefined;
        if (pick.kind === "row" && !dbEntry) continue;

        const fa = fingerprint(fileEntry);
        const fd = fingerprint(dbEntry);
        const previous = last[integration];
        if (fa === fd) {
          if (fa) last[integration] = fa;
          // OpenCode 2's own import leaves `active` empty; make it explicit.
          if (pick.kind === "row" && pick.row.active !== 1 && fileEntry) {
            applyToDatabase(db, integration, fileEntry, rows.get(integration)!, now);
          }
          continue;
        }

        let winner: "file" | "database";
        if (!fd) {
          // A logout here is the only time the database has nothing and the
          // file still holds exactly what was bridged last.
          if (fa === previous && pick.kind === "none") {
            delete auth[key];
            delete last[integration];
            authChanged = true;
            result.removed.push(integration);
            continue;
          }
          winner = "file";
        } else if (!fa) {
          // Missing from an incoming file: never log this machine out.
          if (fd === previous) continue;
          winner = "database";
        } else {
          const fileMoved = fa !== previous;
          const dbMoved = fd !== previous;
          if (fileMoved && !dbMoved) winner = "file";
          else if (dbMoved && !fileMoved) winner = "database";
          else if (
            fileEntry!.type === "oauth" &&
            dbEntry!.type === "oauth" &&
            fileEntry!.expires !== dbEntry!.expires &&
            Number(fileEntry!.expires) > 0 &&
            Number(dbEntry!.expires) > 0
          ) {
            winner = Number(fileEntry!.expires) > Number(dbEntry!.expires) ? "file" : "database";
          } else {
            winner = prefer;
          }
        }

        if (winner === "file") {
          applyToDatabase(db, integration, fileEntry!, rows.get(integration) ?? [], now);
          last[integration] = fa!;
          result.toDatabase.push(integration);
        } else {
          const existing = auth[key];
          auth[key] = existing?.type === dbEntry!.type ? { ...existing, ...dbEntry } : dbEntry;
          last[integration] = fd!;
          authChanged = true;
          result.toFile.push(integration);
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } finally {
    db.close();
  }

  if (authChanged) writeJsonAtomic(authFile, auth);
  if (JSON.stringify(last) !== before) {
    writeJsonAtomic(stateFile, { version: 1, fingerprints: last });
  }
  return result;
}
