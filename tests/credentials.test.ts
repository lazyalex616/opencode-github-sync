import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BRIDGE_STATE_FILE, bridgeCredentials } from "../src/core/credentials.js";
import { type SqliteDatabase, openDatabase, sqliteAvailable } from "../src/core/sqlite.js";

/**
 * auth.json <-> OpenCode 2 credential table. Every token here is fake.
 */

const SCHEMA = fs.readFileSync(path.join(__dirname, "fixtures", "opencode-2.2.5.sql"), "utf8");

let data: string;
let available = false;

beforeEach(async () => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-cred-"));
  available = await sqliteAvailable();
  if (!available) return;
  const db = await openDatabase(path.join(data, "opencode.db"));
  db.exec(SCHEMA);
  db.close();
});

afterEach(() => {
  fs.rmSync(data, { recursive: true, force: true });
});

const authFile = (): string => path.join(data, "auth.json");
const writeAuth = (value: unknown): void =>
  fs.writeFileSync(authFile(), `${JSON.stringify(value, null, 2)}\n`);
const readAuth = (): any => JSON.parse(fs.readFileSync(authFile(), "utf8"));

async function withDb<T>(fn: (db: SqliteDatabase) => T): Promise<T> {
  const db = await openDatabase(path.join(data, "opencode.db"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function rows(integration: string): Promise<any[]> {
  return withDb((db) =>
    (
      db
        .prepare(
          "SELECT id, label, value, active FROM credential WHERE integration_id = ? ORDER BY id",
        )
        .all(integration) as any[]
    ).map((r) => ({ ...r, value: JSON.parse(r.value) })),
  );
}

async function insert(id: string, integration: string, value: unknown, active: number | null) {
  await withDb((db) =>
    db
      .prepare(
        `INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, 1, 1)`,
      )
      .run(id, integration, id, JSON.stringify(value), active),
  );
}

const copilot = (token: string) => ({
  type: "oauth",
  access: token,
  refresh: token,
  expires: 0,
});
const openai = (n: number, expires: number) => ({
  type: "oauth",
  access: `FAKE_ACCESS_${n}`,
  refresh: `FAKE_REFRESH_${n}`,
  expires,
  accountId: "acct_fake",
});

describe("credential bridge", () => {
  it("brings a synced auth.json into a fresh OpenCode 2 database", async () => {
    if (!available) return;
    writeAuth({
      "github-copilot": copilot("gho_FAKE_ONE"),
      openai: openai(1, 2_000_000_000_000),
      openlux: { type: "api", key: "sk-FAKE" },
    });

    const result = await bridgeCredentials(data, "file");
    expect(result.toDatabase.sort()).toEqual(["github-copilot", "openai", "openlux"]);

    const [cp] = await rows("github-copilot");
    expect(cp.active).toBe(1);
    expect(cp.value).toMatchObject({ type: "oauth", methodID: "device", access: "gho_FAKE_ONE" });
    const [oa] = await rows("openai");
    expect(oa.value).toMatchObject({
      methodID: "chatgpt-browser",
      refresh: "FAKE_REFRESH_1",
      metadata: { accountID: "acct_fake" },
    });
    const [key] = await rows("openlux");
    expect(key.value).toEqual({ type: "key", key: "sk-FAKE" });

    const state = fs.readFileSync(path.join(data, BRIDGE_STATE_FILE), "utf8");
    expect(state).not.toMatch(/FAKE/);

    // Nothing changed since: a second run is a no-op on both sides.
    const again = await bridgeCredentials(data, "file");
    expect(again).toEqual({ toFile: [], toDatabase: [], removed: [] });
  });

  it("records an account switched in OpenCode before a push", async () => {
    if (!available) return;
    writeAuth({ "github-copilot": copilot("gho_FAKE_ONE") });
    await bridgeCredentials(data, "file");
    await insert(
      "cred_two",
      "github-copilot",
      { ...copilot("gho_FAKE_TWO"), methodID: "device" },
      0,
    );
    await withDb((db) =>
      db
        .prepare(
          "UPDATE credential SET active = CASE WHEN id = 'cred_two' THEN 1 ELSE 0 END WHERE integration_id = 'github-copilot'",
        )
        .run(),
    );

    const result = await bridgeCredentials(data, "database");
    expect(result.toFile).toEqual(["github-copilot"]);
    expect(readAuth()["github-copilot"].access).toBe("gho_FAKE_TWO");
  });

  it("switches to the account another machine chose, without duplicating it", async () => {
    if (!available) return;
    await insert(
      "cred_one",
      "github-copilot",
      { ...copilot("gho_FAKE_ONE"), methodID: "device" },
      1,
    );
    await insert(
      "cred_two",
      "github-copilot",
      { ...copilot("gho_FAKE_TWO"), methodID: "device" },
      0,
    );
    writeAuth({ "github-copilot": copilot("gho_FAKE_ONE") });
    await bridgeCredentials(data, "file");

    writeAuth({ "github-copilot": copilot("gho_FAKE_TWO") });
    const result = await bridgeCredentials(data, "file");
    expect(result.toDatabase).toEqual(["github-copilot"]);

    const list = await rows("github-copilot");
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.id === "cred_two").active).toBe(1);
    expect(list.find((r) => r.id === "cred_one").active).toBe(0);
  });

  it("updates a rotated OpenAI token in place and keeps the newer expiry on conflict", async () => {
    if (!available) return;
    writeAuth({ openai: openai(1, 1_000) });
    await bridgeCredentials(data, "file");

    // Another machine refreshed: new tokens, later expiry.
    writeAuth({ openai: openai(2, 5_000) });
    await bridgeCredentials(data, "file");
    let list = await rows("openai");
    expect(list).toHaveLength(1);
    expect(list[0].value.refresh).toBe("FAKE_REFRESH_2");

    // Both sides moved; the database holds the later expiry and must win
    // even though this is a pull.
    await withDb((db) =>
      db.prepare("UPDATE credential SET value = ? WHERE integration_id = 'openai'").run(
        JSON.stringify({
          type: "oauth",
          methodID: "chatgpt-browser",
          access: "FAKE_ACCESS_3",
          refresh: "FAKE_REFRESH_3",
          expires: 9_000,
          metadata: { accountID: "acct_fake" },
        }),
      ),
    );
    writeAuth({ openai: openai(4, 7_000) });
    const result = await bridgeCredentials(data, "file");
    expect(result.toFile).toEqual(["openai"]);
    expect(readAuth().openai.refresh).toBe("FAKE_REFRESH_3");
    list = await rows("openai");
    expect(list).toHaveLength(1);
  });

  it("never logs this machine out when an entry is missing from an incoming file", async () => {
    if (!available) return;
    writeAuth({ openlux: { type: "api", key: "sk-FAKE" } });
    await bridgeCredentials(data, "file");

    writeAuth({});
    await bridgeCredentials(data, "file");
    expect(await rows("openlux")).toHaveLength(1);
  });

  it("removes an account from auth.json after a logout in OpenCode", async () => {
    if (!available) return;
    writeAuth({ openlux: { type: "api", key: "sk-FAKE" }, other: { type: "api", key: "sk-KEEP" } });
    await bridgeCredentials(data, "file");
    await withDb((db) =>
      db.prepare("DELETE FROM credential WHERE integration_id = 'openlux'").run(),
    );

    const result = await bridgeCredentials(data, "database");
    expect(result.removed).toEqual(["openlux"]);
    expect(readAuth()).toEqual({ other: { type: "api", key: "sk-KEEP" } });
  });

  it("activates OpenCode's own first-start import and leaves an ambiguous pair alone", async () => {
    if (!available) return;
    await insert(
      "cred_a",
      "openai",
      {
        type: "oauth",
        methodID: "chatgpt-browser",
        access: "FAKE_ACCESS_1",
        refresh: "FAKE_REFRESH_1",
        expires: 1_000,
      },
      null,
    );
    await insert(
      "cred_b",
      "openai",
      {
        type: "oauth",
        methodID: "chatgpt-browser",
        access: "FAKE_ACCESS_1",
        refresh: "FAKE_REFRESH_1",
        expires: 1_000,
      },
      null,
    );
    writeAuth({
      openai: { type: "oauth", access: "FAKE_ACCESS_1", refresh: "FAKE_REFRESH_1", expires: 1_000 },
    });

    await bridgeCredentials(data, "file");
    // Two rows and no active one: OpenCode would not know which to use.
    // The bridge leaves that case alone rather than guess.
    expect(await rows("openai")).toHaveLength(2);

    await withDb((db) => db.prepare("DELETE FROM credential WHERE id = 'cred_b'").run());
    await bridgeCredentials(data, "file");
    const list = await rows("openai");
    expect(list).toHaveLength(1);
    expect(list[0].active).toBe(1);
  });

  it("leaves a broken auth.json untouched", async () => {
    if (!available) return;
    fs.writeFileSync(authFile(), "{ not json");
    await insert("cred_one", "openlux", { type: "key", key: "sk-FAKE" }, 1);
    const result = await bridgeCredentials(data, "database");
    expect(result).toEqual({ toFile: [], toDatabase: [], removed: [] });
    expect(fs.readFileSync(authFile(), "utf8")).toBe("{ not json");
  });

  it("does nothing on an OpenCode 1 data directory", async () => {
    if (!available) return;
    const v1 = fs.mkdtempSync(path.join(os.tmpdir(), "ogs-cred-v1-"));
    try {
      fs.writeFileSync(path.join(v1, "auth.json"), "{}");
      const db = await openDatabase(path.join(v1, "opencode.db"));
      db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
      db.close();
      expect(await bridgeCredentials(v1, "file")).toEqual({
        toFile: [],
        toDatabase: [],
        removed: [],
      });
      expect(fs.existsSync(path.join(v1, BRIDGE_STATE_FILE))).toBe(false);
    } finally {
      fs.rmSync(v1, { recursive: true, force: true });
    }
  });
});
