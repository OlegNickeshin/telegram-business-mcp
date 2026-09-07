import type Database from "better-sqlite3";

export interface ChatRow {
  chat_id: number;
  type: string | null;
  title: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  first_message_at: number | null;
  last_message_at: number | null;
  last_message_id: number | null;
  message_count: number;
}

export interface MessageRow {
  id: number;
  chat_id: number;
  message_id: number;
  business_connection_id: string;
  from_id: number | null;
  from_first_name: string | null;
  from_last_name: string | null;
  from_username: string | null;
  outgoing: number;
  date: number;
  edit_date: number | null;
  text: string | null;
  caption: string | null;
  content_type: string;
  file_name: string | null;
  file_size: number | null;
  message_thread_id: number | null;
  topic_name: string | null;
  chat_type: string | null;
  transcript: string | null;
  transcript_engine: string | null;
  media_status: string | null;
  reply_to_message_id: number | null;
  is_deleted: number;
  chat_title: string | null;
  chat_first_name: string | null;
  chat_last_name: string | null;
  chat_username: string | null;
}

const MSG_COLS = `
  m.id, m.chat_id, m.message_id, m.business_connection_id,
  m.from_id, m.from_first_name, m.from_last_name, m.from_username,
  m.outgoing, m.date, m.edit_date, m.text, m.caption, m.content_type,
  m.file_name, m.file_size,
  m.transcript, m.transcript_engine, m.media_status,
  m.message_thread_id, m.topic_name, c.type AS chat_type,
  m.reply_to_message_id, m.is_deleted,
  c.title AS chat_title, c.first_name AS chat_first_name,
  c.last_name AS chat_last_name, c.username AS chat_username
`;

export function displayName(o: {
  title?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
}): string {
  const n = o.title ?? [o.first_name, o.last_name].filter(Boolean).join(" ");
  return n || (o.username ? `@${o.username}` : "(unknown)");
}

export function clamp(v: unknown, def: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * Same, but fails on anything it cannot parse. Use wherever a misread bound
 * would do damage rather than just return too much.
 */
export function requireSince(v: unknown, field: string): number | undefined {
  if (v == null || v === "") return undefined;
  const parsed = parseSince(v);
  if (parsed === undefined) {
    throw new Error(
      `could not understand ${field}=${JSON.stringify(v)}. Use an ISO 8601 timestamp, ` +
        `unix seconds, "today", "yesterday", or a window like "24h" / "7d".`
    );
  }
  return parsed;
}

export function listChats(db: Database.Database, limit: number): ChatRow[] {
  return db
    .prepare(
      `SELECT chat_id, type, title, first_name, last_name, username,
              first_message_at, last_message_at, last_message_id, message_count
         FROM chats
        ORDER BY COALESCE(last_message_at, 0) DESC
        LIMIT ?`
    )
    .all(limit) as ChatRow[];
}

export function getChat(db: Database.Database, chatId: number): ChatRow | undefined {
  return db
    .prepare(
      `SELECT chat_id, type, title, first_name, last_name, username,
              first_message_at, last_message_at, last_message_id, message_count
         FROM chats WHERE chat_id = ?`
    )
    .get(chatId) as ChatRow | undefined;
}

/** `before` is a unix timestamp; messages strictly older than it are returned. */
export function getMessages(
  db: Database.Database,
  chatId: number,
  limit: number,
  before?: number,
  since?: number
): MessageRow[] {
  const rows = db
    .prepare(
      `SELECT ${MSG_COLS}
         FROM messages m JOIN chats c ON c.chat_id = m.chat_id
        WHERE m.chat_id = @chatId
          AND (@before IS NULL OR m.date < @before)
          AND (@since IS NULL OR m.date >= @since)
        ORDER BY m.date DESC, m.message_id DESC
        LIMIT @limit`
    )
    .all({ chatId, before: before ?? null, since: since ?? null, limit }) as MessageRow[];
  return rows.reverse(); // oldest first reads better as a transcript
}

export function recentMessages(
  db: Database.Database,
  limit: number,
  since?: number
): MessageRow[] {
  return db
    .prepare(
      `SELECT ${MSG_COLS}
         FROM messages m JOIN chats c ON c.chat_id = m.chat_id
        WHERE (@since IS NULL OR m.date >= @since)
        ORDER BY m.date DESC, m.id DESC
        LIMIT @limit`
    )
    .all({ since: since ?? null, limit }) as MessageRow[];
}

/**
 * FTS5 match. User input is quoted so that punctuation like ? or - cannot
 * blow up the FTS parser or be used to inject operators.
 */
export function searchMessages(
  db: Database.Database,
  query: string,
  limit: number,
  chatId?: number,
  since?: number
): MessageRow[] {
  const terms = query.match(/[\p{L}\p{N}_]+/gu);
  if (!terms || terms.length === 0) return [];
  // Prefix-match the last term so a partial name still finds the full one.
  const match = terms.map((t, i) => (i === terms.length - 1 ? `"${t}"*` : `"${t}"`)).join(" ");
  return db
    .prepare(
      `SELECT ${MSG_COLS}
         FROM messages_fts f
         JOIN messages m ON m.id = f.rowid
         JOIN chats c ON c.chat_id = m.chat_id
        WHERE messages_fts MATCH @match
          AND (@chatId IS NULL OR m.chat_id = @chatId)
          AND (@since IS NULL OR m.date >= @since)
        ORDER BY m.date DESC
        LIMIT @limit`
    )
    .all({ match, chatId: chatId ?? null, since: since ?? null, limit }) as MessageRow[];
}

/**
 * Resolves a human reference ("Anna", "@anna", or a numeric id) to chats.
 * Substring match on name/username, exact match on chat_id.
 */
export function findChat(db: Database.Database, query: string, limit = 20): ChatRow[] {
  const q = query.trim().replace(/^@/, "");
  const asId = /^-?\d+$/.test(q) ? Number(q) : null;
  const like = `%${q.toLowerCase()}%`; // ulower() folds the column side
  return db
    .prepare(
      `SELECT chat_id, type, title, first_name, last_name, username,
              first_message_at, last_message_at, last_message_id, message_count
         FROM chats
        WHERE (@asId IS NOT NULL AND chat_id = @asId)
           OR ulower(COALESCE(first_name, '')) LIKE @like
           OR ulower(COALESCE(last_name, '')) LIKE @like
           OR ulower(COALESCE(title, '')) LIKE @like
           OR ulower(COALESCE(username, '')) LIKE @like
           OR ulower(TRIM(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))) LIKE @like
        ORDER BY COALESCE(last_message_at, 0) DESC
        LIMIT @limit`
    )
    .all({ asId, like, limit }) as ChatRow[];
}

/**
 * Accepts unix seconds, ISO 8601, "today", "yesterday", or "24h" / "7d" / "30m".
 * Returns unix seconds, or undefined when the input is empty/unparseable.
 *
 * Callers that treat undefined as "no filter" must reject unparseable input
 * themselves — see requireSince. Silently dropping a time bound widens the
 * query, which is merely noisy when reading and catastrophic when deleting.
 */
export function parseSince(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  const s = String(v).trim();
  if (/^\d{9,}$/.test(s)) return Number(s);

  const nowSec = Math.floor(Date.now() / 1000);
  const lower = s.toLowerCase();
  if (lower === "today") return Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
  if (lower === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return Math.floor(d.setHours(0, 0, 0, 0) / 1000);
  }
  const rel = lower.match(/^(\d+)\s*(m|h|d|w)$/);
  if (rel) {
    const n = Number(rel[1]);
    const mult = { m: 60, h: 3600, d: 86400, w: 604800 }[rel[2] as "m" | "h" | "d" | "w"];
    return nowSec - n * mult;
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}
