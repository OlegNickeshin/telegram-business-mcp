import type Database from "better-sqlite3";
import {
  contentType,
  type TgBusinessConnection,
  type TgDeletedBusinessMessages,
  type TgMessage,
} from "./telegram.js";

const now = () => Math.floor(Date.now() / 1000);

/** Whether this update_id has already been handled. */
export function alreadySeen(db: Database.Database, updateId: number): boolean {
  return (
    db.prepare("SELECT 1 FROM updates WHERE update_id = ?").get(updateId) !== undefined
  );
}

/** Returns false when this update_id was already stored (dedup). */
export function claimUpdate(
  db: Database.Database,
  updateId: number,
  type: string,
  raw: unknown
): boolean {
  const info = db
    .prepare(
      "INSERT OR IGNORE INTO updates (update_id, type, received_at, raw) VALUES (?, ?, ?, ?)"
    )
    .run(updateId, type, now(), JSON.stringify(raw));
  return info.changes > 0;
}

export function saveBusinessConnection(
  db: Database.Database,
  bc: TgBusinessConnection
): void {
  db.prepare(
    `INSERT INTO business_connections
       (id, user_id, user_chat_id, username, first_name, last_name, date, is_enabled, can_reply, raw, updated_at)
     VALUES (@id, @user_id, @user_chat_id, @username, @first_name, @last_name, @date, @is_enabled, @can_reply, @raw, @updated_at)
     ON CONFLICT(id) DO UPDATE SET
       user_id=excluded.user_id, user_chat_id=excluded.user_chat_id, username=excluded.username,
       first_name=excluded.first_name, last_name=excluded.last_name, date=excluded.date,
       is_enabled=excluded.is_enabled, can_reply=excluded.can_reply, raw=excluded.raw,
       updated_at=excluded.updated_at`
  ).run({
    id: bc.id,
    user_id: bc.user?.id ?? null,
    user_chat_id: bc.user_chat_id ?? null,
    username: bc.user?.username ?? null,
    first_name: bc.user?.first_name ?? null,
    last_name: bc.user?.last_name ?? null,
    date: bc.date ?? null,
    is_enabled: bc.is_enabled === false ? 0 : 1,
    // Bot API 9.x moved can_reply into `rights`; keep both shapes working.
    can_reply:
      bc.can_reply != null
        ? bc.can_reply ? 1 : 0
        : bc.rights && (bc.rights as Record<string, unknown>).can_reply ? 1 : 0,
    raw: JSON.stringify(bc),
    updated_at: now(),
  });
}

/**
 * The account owner's user id, used to tell outgoing from incoming.
 *
 * Group messages carry no connection id, so fall back to the single business
 * connection: it is the same human either way.
 */
function ownerId(db: Database.Database, connectionId: string): number | null {
  if (connectionId) {
    const row = db
      .prepare("SELECT user_id FROM business_connections WHERE id = ?")
      .get(connectionId) as { user_id: number | null } | undefined;
    if (row?.user_id != null) return row.user_id;
  }
  const any = db
    .prepare("SELECT user_id FROM business_connections ORDER BY date DESC LIMIT 1")
    .get() as { user_id: number | null } | undefined;
  return any?.user_id ?? null;
}

/**
 * Remembers a forum topic's name. Telegram supplies it only on the message that
 * created the topic and on replies into it, so later messages are matched by
 * thread id against what was learned earlier.
 */
export function rememberTopic(db: Database.Database, msg: TgMessage): string | null {
  const thread = msg.message_thread_id;
  if (thread == null) return null;

  const named = msg.forum_topic_created?.name ?? msg.reply_to_message?.forum_topic_created?.name;
  if (named) {
    db.prepare(
      `INSERT INTO topics (chat_id, message_thread_id, name, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, message_thread_id) DO UPDATE SET
         name = excluded.name, updated_at = excluded.updated_at`
    ).run(msg.chat.id, thread, named, Math.floor(Date.now() / 1000));
    return named;
  }

  const known = db
    .prepare("SELECT name FROM topics WHERE chat_id = ? AND message_thread_id = ?")
    .get(msg.chat.id, thread) as { name: string | null } | undefined;
  return known?.name ?? null;
}

function upsertChat(db: Database.Database, msg: TgMessage, connectionId: string): void {
  const c = msg.chat;
  db.prepare(
    `INSERT INTO chats
       (chat_id, business_connection_id, type, title, first_name, last_name, username,
        first_message_at, last_message_at, last_message_id, message_count, updated_at)
     VALUES (@chat_id, @bc, @type, @title, @first_name, @last_name, @username,
             @date, @date, @message_id, 1, @updated_at)
     ON CONFLICT(chat_id) DO UPDATE SET
       business_connection_id = excluded.business_connection_id,
       type       = excluded.type,
       title      = excluded.title,
       first_name = excluded.first_name,
       last_name  = excluded.last_name,
       username   = excluded.username,
       first_message_at = MIN(COALESCE(chats.first_message_at, excluded.first_message_at), excluded.first_message_at),
       last_message_at  = MAX(COALESCE(chats.last_message_at, 0), excluded.last_message_at),
       last_message_id  = CASE WHEN excluded.last_message_at >= COALESCE(chats.last_message_at, 0)
                               THEN excluded.last_message_id ELSE chats.last_message_id END,
       message_count = chats.message_count + 1,
       updated_at = excluded.updated_at`
  ).run({
    chat_id: c.id,
    bc: connectionId,
    type: c.type ?? null,
    title: c.title ?? null,
    first_name: c.first_name ?? null,
    last_name: c.last_name ?? null,
    username: c.username ?? null,
    date: msg.date,
    message_id: msg.message_id,
    updated_at: now(),
  });
}

export interface SavedMessage {
  inserted: boolean;
  connectionId: string;
  chatId: number;
  messageId: number;
  outgoing: boolean;
  contentType: string;
}

export function saveBusinessMessage(
  db: Database.Database,
  msg: TgMessage,
  updateId: number
): SavedMessage {
  const connectionId = msg.business_connection_id ?? "";
  const owner = ownerId(db, connectionId);
  const outgoing = owner != null && msg.from?.id === owner;
  const topicName = rememberTopic(db, msg);

  const info = db
    .prepare(
      `INSERT INTO messages
         (business_connection_id, chat_id, message_id, update_id, from_id, from_is_bot,
          from_first_name, from_last_name, from_username, outgoing, date, edit_date,
          text, caption, content_type, reply_to_message_id, forward_origin, raw, created_at,
          message_thread_id, topic_name)
       VALUES
         (@bc, @chat_id, @message_id, @update_id, @from_id, @from_is_bot,
          @from_first_name, @from_last_name, @from_username, @outgoing, @date, @edit_date,
          @text, @caption, @content_type, @reply_to, @forward_origin, @raw, @created_at,
          @thread_id, @topic_name)
       ON CONFLICT (business_connection_id, chat_id, message_id) DO NOTHING`
    )
    .run({
      bc: connectionId,
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      update_id: updateId,
      from_id: msg.from?.id ?? null,
      from_is_bot: msg.from?.is_bot ? 1 : 0,
      from_first_name: msg.from?.first_name ?? null,
      from_last_name: msg.from?.last_name ?? null,
      from_username: msg.from?.username ?? null,
      outgoing: outgoing ? 1 : 0,
      date: msg.date,
      edit_date: msg.edit_date ?? null,
      text: msg.text ?? null,
      caption: msg.caption ?? null,
      content_type: contentType(msg),
      thread_id: msg.message_thread_id ?? null,
      topic_name: topicName,
      reply_to: msg.reply_to_message?.message_id ?? null,
      forward_origin: msg.forward_origin ? JSON.stringify(msg.forward_origin) : null,
      raw: JSON.stringify(msg),
      created_at: now(),
    });

  // Only count the chat when the message is genuinely new.
  if (info.changes > 0) upsertChat(db, msg, connectionId);

  return {
    inserted: info.changes > 0,
    connectionId,
    chatId: msg.chat.id,
    messageId: msg.message_id,
    outgoing,
    contentType: contentType(msg),
  };
}

/** Edits keep the original row and overwrite the body; FTS follows via trigger. */
export function saveEditedBusinessMessage(
  db: Database.Database,
  msg: TgMessage,
  updateId: number
): SavedMessage {
  const connectionId = msg.business_connection_id ?? "";
  const info = db
    .prepare(
      `UPDATE messages
          SET text = @text, caption = @caption, edit_date = @edit_date,
              content_type = @content_type, edited_at = @edited_at, raw = @raw
        WHERE business_connection_id = @bc AND chat_id = @chat_id AND message_id = @message_id`
    )
    .run({
      bc: connectionId,
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      text: msg.text ?? null,
      caption: msg.caption ?? null,
      edit_date: msg.edit_date ?? null,
      content_type: contentType(msg),
      edited_at: now(),
      raw: JSON.stringify(msg),
    });

  // An edit for a message we never saw (collector was down) still deserves a row.
  if (info.changes === 0) return saveBusinessMessage(db, msg, updateId);

  return {
    inserted: false,
    connectionId,
    chatId: msg.chat.id,
    messageId: msg.message_id,
    outgoing: false,
    contentType: contentType(msg),
  };
}

/** Deletions are soft: we keep the text and flag the row. */
export function markDeleted(
  db: Database.Database,
  ev: TgDeletedBusinessMessages
): number {
  const stmt = db.prepare(
    `UPDATE messages SET is_deleted = 1, deleted_at = ?
      WHERE business_connection_id = ? AND chat_id = ? AND message_id = ?`
  );
  let n = 0;
  const ts = now();
  for (const id of ev.message_ids ?? []) {
    n += stmt.run(ts, ev.business_connection_id, ev.chat.id, id).changes;
  }
  return n;
}
