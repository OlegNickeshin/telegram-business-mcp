/**
 * Assist mode: draft-a-reply, approve-in-DM.
 *
 * When someone writes to the owner, a Claude Code agent — scheduled outside
 * this process — reads the thread through the MCP tools, drafts a reply, and
 * submits it here. The bot then DMs the owner the draft with buttons; on
 * approval the reply goes out through the business connection, as the owner.
 *
 * The connector stays a plain tool provider and the bot's plumbing. It holds no
 * model: the drafting is entirely the agent's, so there is no API key here and
 * no autonomous send — nothing reaches a real person without the owner tapping
 * Send.
 *
 * Off by default, behind ALLOW_ASSIST. The queue's whole cleverness is one
 * rule: a chat needs a draft only when its newest message is incoming — i.e.
 * the ball is in the owner's court. That collapses a burst of messages into one
 * draft and never drafts for a thread already answered.
 */
import type Database from "better-sqlite3";
import { call } from "./telegram.js";
import { sendMessage } from "./actions.js";
import { displayName } from "./queries.js";

export const ALLOW_ASSIST = (process.env.ALLOW_ASSIST ?? "0") === "1";
/** Where the bot DMs drafts. The owner must have pressed Start on the bot. */
export const OWNER_CHAT_ID = Number(process.env.ASSIST_OWNER_CHAT_ID ?? 0) || null;
/** Let a burst settle before drafting: only surface incoming older than this. */
const DEBOUNCE = Number(process.env.ASSIST_DEBOUNCE_SECONDS ?? 30);

const now = () => Math.floor(Date.now() / 1000);

export function migrateAssist(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS assist_drafts (
      chat_id      INTEGER NOT NULL,
      message_id   INTEGER NOT NULL,   -- the incoming message being answered
      draft        TEXT,               -- the agent's reply; null while queued
      status       TEXT NOT NULL,      -- queued | pending_approval | sent | skipped
      owner_msg_id INTEGER,            -- the bot's DM message, for the callback
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
  `);
}

interface PendingRow {
  chat_id: number;
  message_id: number;
  date: number;
  text: string | null;
  from_first_name: string | null;
  from_last_name: string | null;
  from_username: string | null;
  chat_title: string | null;
  chat_first_name: string | null;
  chat_last_name: string | null;
  chat_username: string | null;
  chat_type: string | null;
}

export type PendingScope = "all" | "private" | "group";

/** Groups have no business connection; private DMs arrive through one. */
const SCOPE_CONDITION: Record<PendingScope, string> = {
  all: "(m.business_connection_id <> '' OR c.type IN ('group', 'supergroup'))",
  private: "m.business_connection_id <> ''",
  group: "c.type IN ('group', 'supergroup')",
};

/**
 * Chats whose newest message is an incoming one the owner has not answered and
 * for which no draft has been made or skipped yet. One row per chat — the
 * message to reply to is that newest incoming.
 *
 * `scope` picks private DMs (business connection), groups, or both — a draft
 * in a group goes out as the bot, never as the owner, so callers usually keep
 * the two apart (different cadence, different prompt framing).
 */
export function pendingForDraft(
  db: Database.Database,
  limit = 20,
  scope: PendingScope = "all"
): PendingRow[] {
  const cutoff = now() - DEBOUNCE;
  return db
    .prepare(
      `SELECT m.chat_id, m.message_id, m.date, m.text,
              m.from_first_name, m.from_last_name, m.from_username,
              c.title AS chat_title, c.first_name AS chat_first_name,
              c.last_name AS chat_last_name, c.username AS chat_username,
              c.type AS chat_type
         FROM messages m
         JOIN chats c ON c.chat_id = m.chat_id
         -- m must be the newest message in its chat
        WHERE ${SCOPE_CONDITION[scope]}
          AND m.outgoing = 0
          AND m.is_deleted = 0
          -- Bots and notification services flood the queue and never want a
          -- human reply; the owner drafts to people, not to Shazam.
          AND m.from_is_bot = 0
          AND m.date <= @cutoff
          AND m.id = (
            SELECT id FROM messages m2
             WHERE m2.chat_id = m.chat_id
             ORDER BY m2.date DESC, m2.message_id DESC LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM assist_drafts d
             WHERE d.chat_id = m.chat_id AND d.message_id = m.message_id
          )
        ORDER BY m.date DESC LIMIT @limit`
    )
    .all({ cutoff, limit }) as PendingRow[];
}

function whoFrom(r: PendingRow): string {
  return displayName({
    first_name: r.from_first_name,
    last_name: r.from_last_name,
    username: r.from_username,
  });
}

function chatName(r: PendingRow): string {
  return displayName({
    title: r.chat_title,
    first_name: r.chat_first_name,
    last_name: r.chat_last_name,
    username: r.chat_username,
  });
}

/** What the agent gets: who wrote, what they said, where. */
export function listPending(db: Database.Database, limit = 20, scope: PendingScope = "all"): unknown {
  const rows = pendingForDraft(db, limit, scope);
  return {
    count: rows.length,
    debounce_seconds: DEBOUNCE,
    owner_dm_configured: OWNER_CHAT_ID != null,
    pending: rows.map((r) => ({
      chat_id: r.chat_id,
      message_id: r.message_id,
      chat_name: chatName(r),
      chat_type: r.chat_type,
      from: whoFrom(r),
      date: new Date(r.date * 1000).toISOString(),
      text: r.text,
      // A group draft posts as the bot, never as the owner — a different
      // voice and stakes than a DM in the owner's name.
      reply_as: r.chat_type === "group" || r.chat_type === "supergroup" ? "bot" : "owner",
      // The agent should pull fuller context with telegram_get_messages before
      // drafting, and telegram_search_messages / kb_search_notes for facts.
      hint: "Read the thread with telegram_get_messages before drafting.",
    })),
  };
}

interface DirectMessageRow {
  chat_id: number;
  message_id: number;
  from_id: number | null;
  from_first_name: string | null;
  from_last_name: string | null;
  from_username: string | null;
  text: string | null;
  date: number;
}

/**
 * Someone messaged the bot's own account directly — a different chat than the
 * owner's Business line. Recorded in its own table rather than `messages`:
 * chat_id is the other party's user id either way, so the same person's
 * business chat and bot-direct chat share a chat_id, but message_id is a
 * separate counter per line — merging them would misattribute one
 * conversation's messages into the other's transcript.
 *
 * Also relayed to the owner as a live notification (unless it is the owner's
 * own chat with the bot) so it is not missed; the bot does not reply on the
 * owner's behalf here.
 */
export async function recordDirectMessage(
  db: Database.Database,
  m: {
    chat: { id: number };
    from?: { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean };
    message_id: number;
    date: number;
    text?: string;
    caption?: string;
  }
): Promise<void> {
  if (m.from?.is_bot) return;
  const isOwnerChat = m.chat.id === OWNER_CHAT_ID;
  const body = m.text ?? m.caption ?? null;

  if (!isOwnerChat) {
    db.prepare(
      `INSERT OR IGNORE INTO bot_direct_messages
         (chat_id, message_id, from_id, from_first_name, from_last_name, from_username, text, date, created_at)
       VALUES (@chat_id, @message_id, @from_id, @from_first_name, @from_last_name, @from_username, @text, @date, @created_at)`
    ).run({
      chat_id: m.chat.id,
      message_id: m.message_id,
      from_id: m.from?.id ?? null,
      from_first_name: m.from?.first_name ?? null,
      from_last_name: m.from?.last_name ?? null,
      from_username: m.from?.username ?? null,
      text: body,
      date: m.date,
      created_at: now(),
    });
  }

  if (OWNER_CHAT_ID == null || isOwnerChat) return;
  if (!body || !body.trim()) return; // media-only: archived above, nothing to relay yet

  const who = displayName({
    first_name: m.from?.first_name ?? null,
    last_name: m.from?.last_name ?? null,
    username: m.from?.username ?? null,
  });

  await call("sendMessage", {
    chat_id: OWNER_CHAT_ID,
    text: `📨 <b>${escapeHtml(who)}</b> wrote to the bot directly:\n\n${escapeHtml(body)}`,
    parse_mode: "HTML",
  });
}

/** Read-only view of `bot_direct_messages`, newest first. */
export function listDirectMessages(db: Database.Database, limit = 20): unknown {
  const rows = db
    .prepare(
      `SELECT chat_id, message_id, from_id, from_first_name, from_last_name, from_username, text, date
         FROM bot_direct_messages
        ORDER BY date DESC LIMIT @limit`
    )
    .all({ limit }) as DirectMessageRow[];
  return {
    count: rows.length,
    messages: rows.map((r) => ({
      chat_id: r.chat_id,
      message_id: r.message_id,
      from: displayName({
        first_name: r.from_first_name,
        last_name: r.from_last_name,
        username: r.from_username,
      }),
      date: new Date(r.date * 1000).toISOString(),
      text: r.text,
    })),
  };
}

/**
 * The agent's drafted reply, stored and pushed to the owner for approval.
 *
 * Never sends to the person being replied to — only DMs the owner. The reply
 * leaves the server only when the owner taps Send, handled in the collector.
 */
export async function submitDraft(
  db: Database.Database,
  chatId: number,
  messageId: number,
  draft: string
): Promise<unknown> {
  const body = String(draft ?? "").trim();
  if (!body) throw new Error("draft is empty");

  const target = db
    .prepare(
      `SELECT m.outgoing, m.is_deleted, c.title, c.first_name, c.last_name, c.username
         FROM messages m JOIN chats c ON c.chat_id = m.chat_id
        WHERE m.chat_id = ? AND m.message_id = ?`
    )
    .get(chatId, messageId) as
    | { outgoing: number; is_deleted: number; title: string | null; first_name: string | null; last_name: string | null; username: string | null }
    | undefined;
  if (!target) throw new Error(`no message ${messageId} in chat ${chatId}`);
  if (target.outgoing) throw new Error("that message is the owner's own; nothing to reply to");

  const ts = now();
  db.prepare(
    `INSERT INTO assist_drafts (chat_id, message_id, draft, status, created_at, updated_at)
     VALUES (?, ?, ?, 'pending_approval', ?, ?)
     ON CONFLICT(chat_id, message_id) DO UPDATE SET
       draft = excluded.draft, status = 'pending_approval', updated_at = excluded.updated_at`
  ).run(chatId, messageId, body, ts, ts);

  const who = displayName(target);
  if (OWNER_CHAT_ID == null) {
    // No DM target configured: the draft is stored but the owner is not pinged.
    return { queued: true, owner_notified: false, note: "ASSIST_OWNER_CHAT_ID is not set", chat_id: chatId, message_id: messageId, to: who };
  }

  const sent = (await call<{ message_id: number }>("sendMessage", {
    chat_id: OWNER_CHAT_ID,
    text: `✍️ Черновик ответа для <b>${escapeHtml(who)}</b>:\n\n${escapeHtml(body)}`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Отправить", callback_data: `as:send:${chatId}:${messageId}` },
          { text: "🚫 Пропустить", callback_data: `as:skip:${chatId}:${messageId}` },
        ],
      ],
    },
  })) as { message_id: number };

  db.prepare("UPDATE assist_drafts SET owner_msg_id = ? WHERE chat_id = ? AND message_id = ?")
    .run(sent.message_id, chatId, messageId);

  return { queued: true, owner_notified: true, chat_id: chatId, message_id: messageId, to: who };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The owner tapped a button under a draft. Approve → the reply is sent as the
 * owner, quoting the message it answers; skip → the draft is dropped. Either
 * way the DM is edited so its buttons cannot be tapped twice.
 */
export async function handleAssistCallback(
  db: Database.Database,
  cb: { id: string; data?: string; message?: { message_id: number; chat: { id: number } }; from?: { id: number } }
): Promise<boolean> {
  const data = cb.data ?? "";
  if (!data.startsWith("as:")) return false; // not ours
  const [, action, chatStr, msgStr] = data.split(":");
  const chatId = Number(chatStr);
  const messageId = Number(msgStr);

  const row = db
    .prepare("SELECT status FROM assist_drafts WHERE chat_id = ? AND message_id = ? AND draft IS NOT NULL")
    .get(chatId, messageId) as { status: string } | undefined;

  const answer = (text: string) => call("answerCallbackQuery", { callback_query_id: cb.id, text }).catch(() => {});
  const disarm = (suffix: string) =>
    cb.message
      ? call("editMessageReplyMarkup", {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [] },
        })
          .then(() =>
            call("sendMessage", { chat_id: cb.message!.chat.id, reply_to_message_id: cb.message!.message_id, text: suffix })
          )
          .catch(() => {})
      : Promise.resolve();

  if (!row || row.status === "sent" || row.status === "skipped") {
    await answer("Этот черновик уже обработан.");
    return true;
  }

  if (action === "skip") {
    db.prepare("UPDATE assist_drafts SET status = 'skipped', updated_at = ? WHERE chat_id = ? AND message_id = ?")
      .run(now(), chatId, messageId);
    await answer("Пропущено.");
    await disarm("🚫 Пропущено.");
    return true;
  }

  if (action === "send") {
    const draft = db
      .prepare("SELECT draft FROM assist_drafts WHERE chat_id = ? AND message_id = ?")
      .get(chatId, messageId) as { draft: string } | undefined;
    try {
      await sendMessage(db, chatId, draft!.draft, messageId);
      db.prepare("UPDATE assist_drafts SET status = 'sent', updated_at = ? WHERE chat_id = ? AND message_id = ?")
        .run(now(), chatId, messageId);
      await answer("Отправлено.");
      await disarm("✅ Отправлено.");
    } catch (err) {
      await answer(`Не удалось отправить: ${(err as Error).message}`.slice(0, 190));
    }
    return true;
  }

  return true;
}
