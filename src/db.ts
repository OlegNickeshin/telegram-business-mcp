import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { DB_PATH } from "./config.js";
import { fileInfo, type TgMessage } from "./telegram.js";
import { renderMessage } from "./format.js";

export function openDb(readonly = false): Database.Database {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH, { readonly, fileMustExist: readonly });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  if (!readonly) db.pragma("foreign_keys = ON");

  // SQLite's built-in LOWER() only folds ASCII, so a name in any non-Latin
  // alphabet never matches its own lowercase form. JS toLowerCase is
  // Unicode-aware; use it for name matching.
  db.function("ulower", { deterministic: true }, (v: unknown) =>
    typeof v === "string" ? v.toLowerCase() : v == null ? null : String(v).toLowerCase()
  );

  // Used by the FTS triggers so the indexed body is defined in exactly one place.
  // Arity is declared explicitly: better-sqlite3 infers it from the signature,
  // and a rest parameter reports zero.
  db.function(
    "fts_body",
    { deterministic: true },
    (text: unknown, caption: unknown, transcript: unknown) =>
      [text, caption, transcript]
        .map((p) => (typeof p === "string" ? p : ""))
        .filter(Boolean)
        .join(" ")
  );

  return db;
}

/** Idempotent ALTER: SQLite has no ADD COLUMN IF NOT EXISTS. */
/**
 * Fills file_name/file_size/text_formatted for messages stored before those
 * columns existed.
 *
 * The values were always in `raw`, so this is a re-read rather than a loss —
 * but parsing JSON for every row on every read is not, which is why they get
 * their own columns. Runs once: after this, only rows that still have no name
 * are considered, and a genuinely nameless attachment (a voice note, a sticker)
 * keeps a size, so it is not re-examined either.
 */
function backfillFromRaw(db: Database.Database): void {
  // Every caller opens for writing today, but a read-only one would otherwise
  // fail here rather than simply skipping a convenience.
  if (db.readonly) return;

  // A message with nothing renderable in it never gets `text_formatted` set,
  // so without a marker it is re-parsed on every start — and "entities"
  // appears in the raw of anything holding a URL, mention or hashtag, which is
  // most messages eventually. The version is part of the key so that adding a
  // column later re-runs the pass instead of being skipped by an old flag.
  const DONE = "backfill_raw_v2";
  const seen = db.prepare("SELECT value FROM state WHERE key = ?").get(DONE) as
    | { value: string }
    | undefined;
  if (seen) return;
  // Only rows that could still be missing something, and only those whose raw
  // even mentions the fields — `entities` in particular is rare, so the LIKE
  // keeps this from re-parsing every message on every start.
  const rows = db
    .prepare(
      `SELECT id, raw, content_type FROM messages
        WHERE (content_type NOT IN ('text', 'other') AND file_name IS NULL AND file_size IS NULL)
           OR (text_formatted IS NULL AND raw LIKE '%entities%')`
    )
    .all() as { id: number; raw: string; content_type: string }[];

  const update = db.prepare(
    `UPDATE messages
        SET file_name      = COALESCE(?, file_name),
            file_size      = COALESCE(?, file_size),
            text_formatted = COALESCE(?, text_formatted)
      WHERE id = ?`
  );
  let written = 0;
  let named = 0;
  let formatted = 0;
  db.transaction(() => {
    for (const r of rows) {
      let msg: TgMessage;
      try {
        msg = JSON.parse(r.raw) as TgMessage;
      } catch {
        // A row whose raw will not parse is not worth failing a startup over.
        // Deliberately narrow: a failing UPDATE must not be swallowed here.
        continue;
      }
      const info = fileInfo(msg);
      const rendered = renderMessage(msg);
      if (info.name == null && info.size == null && rendered == null) continue;
      written += update.run(info.name, info.size, rendered, r.id).changes;
      if (info.name) named++;
      if (rendered) formatted++;
    }
  })();
  // Report what was written, not what was looked at — the difference is the
  // whole signal when something is quietly not persisting.
  db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)").run(
    DONE,
    String(Math.floor(Date.now() / 1000))
  );
  console.log(
    `[db] backfill: ${written} of ${rows.length} rows updated ` +
      `(${named} named files, ${formatted} with formatting)`
  );
}

function addColumn(db: Database.Database, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

export function migrate(db: Database.Database): void {
  db.exec(`
    -- every update we ever accepted; PK gives us update_id dedup for free
    CREATE TABLE IF NOT EXISTS updates (
      update_id   INTEGER PRIMARY KEY,
      type        TEXT    NOT NULL,
      received_at INTEGER NOT NULL,
      raw         TEXT    NOT NULL
    );

    -- one row per business connection (Settings -> Business -> Chatbots)
    CREATE TABLE IF NOT EXISTS business_connections (
      id            TEXT PRIMARY KEY,
      user_id       INTEGER,
      user_chat_id  INTEGER,
      username      TEXT,
      first_name    TEXT,
      last_name     TEXT,
      date          INTEGER,
      is_enabled    INTEGER,
      can_reply     INTEGER,
      raw           TEXT,
      updated_at    INTEGER
    );

    -- one row per counterpart chat
    CREATE TABLE IF NOT EXISTS chats (
      chat_id                INTEGER PRIMARY KEY,
      business_connection_id TEXT,
      type                   TEXT,
      title                  TEXT,
      first_name             TEXT,
      last_name              TEXT,
      username               TEXT,
      first_message_at       INTEGER,
      last_message_at        INTEGER,
      last_message_id        INTEGER,
      message_count          INTEGER NOT NULL DEFAULT 0,
      updated_at             INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      business_connection_id TEXT    NOT NULL,
      chat_id                INTEGER NOT NULL,
      message_id             INTEGER NOT NULL,
      update_id              INTEGER,
      from_id                INTEGER,
      from_is_bot            INTEGER,
      from_first_name        TEXT,
      from_last_name         TEXT,
      from_username          TEXT,
      outgoing               INTEGER NOT NULL DEFAULT 0,
      date                   INTEGER NOT NULL,
      edit_date              INTEGER,
      text                   TEXT,
      caption                TEXT,
      content_type           TEXT    NOT NULL,
      reply_to_message_id    INTEGER,
      forward_origin         TEXT,
      is_deleted             INTEGER NOT NULL DEFAULT 0,
      deleted_at             INTEGER,
      edited_at              INTEGER,
      raw                    TEXT    NOT NULL,
      created_at             INTEGER NOT NULL,
      UNIQUE (business_connection_id, chat_id, message_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages (chat_id, date DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_date      ON messages (date DESC);

    -- key/value scratch: getUpdates offset lives here
    CREATE TABLE IF NOT EXISTS state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Linear mirror: one issue per Telegram chat, one comment per message.
    -- SQLite stays the source of truth; these tables only record what has
    -- already been pushed, so a restart never re-posts anything.
    CREATE TABLE IF NOT EXISTS linear_chats (
      chat_id          INTEGER PRIMARY KEY,
      issue_id         TEXT NOT NULL,
      issue_identifier TEXT,
      title            TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    -- Transcripts keyed by the file itself, not by the message. Telegram gives
    -- every copy of a forwarded file its own file_id but one file_unique_id, so
    -- without this a circle sent to three people is transcribed three times.
    CREATE TABLE IF NOT EXISTS media_transcripts (
      file_unique_id TEXT PRIMARY KEY,
      transcript     TEXT NOT NULL,
      engine         TEXT,
      created_at     INTEGER NOT NULL
    );

    -- Short opaque links to photos. The MCP secret must not appear in a URL
    -- handed to a chat client: a long high-entropy path is exactly the shape of
    -- a data-exfiltration link, and it puts the master credential into the
    -- conversation history. A per-photo token keeps the link short and cheap to
    -- revoke.
    CREATE TABLE IF NOT EXISTS photo_links (
      token      TEXT PRIMARY KEY,
      chat_id    INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_links_msg
      ON photo_links (chat_id, message_id);

    -- Photos already uploaded to Linear's asset storage, so a re-run reuses the
    -- URL instead of uploading the same picture again.
    CREATE TABLE IF NOT EXISTS linear_assets (
      chat_id     INTEGER NOT NULL,
      message_id  INTEGER NOT NULL,
      asset_url   TEXT    NOT NULL,
      bytes       INTEGER,
      uploaded_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );

    -- Outbound: Linear comments that asked for a Telegram message to be sent.
    -- Every comment is recorded here exactly once, whatever the outcome, so a
    -- restart or a re-poll can never deliver the same request twice.
    CREATE TABLE IF NOT EXISTS linear_outbox (
      comment_id TEXT PRIMARY KEY,
      issue_id   TEXT,
      chat_id    INTEGER,
      message_id INTEGER,
      status     TEXT NOT NULL,   -- sent | ignored | error
      detail     TEXT,
      body       TEXT,
      created_at INTEGER NOT NULL
    );

    -- The primary key is the idempotency guarantee the sync relies on.
    CREATE TABLE IF NOT EXISTS linear_comments (
      chat_id    INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      comment_id TEXT    NOT NULL,
      synced_at  INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
  `);

  // Added after the first release: ALTER so existing archives migrate in place.
  addColumn(db, "messages", "transcript", "TEXT");
  addColumn(db, "messages", "transcript_at", "INTEGER");
  addColumn(db, "messages", "transcript_engine", "TEXT");
  addColumn(db, "messages", "media_status", "TEXT"); // pending | done | skipped | error
  addColumn(db, "messages", "media_error", "TEXT");
  addColumn(db, "linear_comments", "transcript_synced", "INTEGER NOT NULL DEFAULT 0");
  // Group and forum support: Business messages have neither.
  // So the message list can name the attachment instead of just typing it.
  addColumn(db, "messages", "file_name", "TEXT");
  addColumn(db, "messages", "file_size", "INTEGER");
  // Formatting rendered from `entities`. Kept out of `text` so that the FTS
  // index stays on the plain words: searching for "тут" must not be defeated
  // by it having become "[тут](https://…)".
  addColumn(db, "messages", "text_formatted", "TEXT");
  backfillFromRaw(db);


  addColumn(db, "messages", "message_thread_id", "INTEGER");
  addColumn(db, "messages", "topic_name", "TEXT");

  db.exec(`
    -- Telegram names a forum topic only in the message that created it (and on
    -- replies into it), so the name is remembered the first time it is seen and
    -- reused for every later message in that thread.
    CREATE TABLE IF NOT EXISTS topics (
      chat_id           INTEGER NOT NULL,
      message_thread_id INTEGER NOT NULL,
      name              TEXT,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_thread_id)
    );
  `);

  // FTS5 index over text+caption+transcript, kept in sync by triggers.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      body,
      content='messages',
      content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    -- Recreated every start: CREATE TRIGGER IF NOT EXISTS would silently keep an
    -- older definition, so a schema change to the indexed body would never apply.
    DROP TRIGGER IF EXISTS messages_ai;
    DROP TRIGGER IF EXISTS messages_ad;
    DROP TRIGGER IF EXISTS messages_au;

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, body) VALUES (new.id, fts_body(new.text, new.caption, new.transcript));
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body)
      VALUES ('delete', old.id, fts_body(old.text, old.caption, old.transcript));
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, body)
      VALUES ('delete', old.id, fts_body(old.text, old.caption, old.transcript));
      INSERT INTO messages_fts(rowid, body) VALUES (new.id, fts_body(new.text, new.caption, new.transcript));
    END;
  `);
}

export function getState(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
