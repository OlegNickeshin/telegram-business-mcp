import type Database from "better-sqlite3";
import {
  ALLOW_FORGET,
  ALLOW_MEDIA,
  ALLOW_SEND,
  editMessage,
  fetchPhoto,
  forget,
  markRead,
  sendMessage,
} from "./actions.js";
import {
  clamp,
  displayName,
  findChat,
  getChat,
  getMessages,
  listChats,
  parseSince,
  requireSince,
  recentMessages,
  searchMessages,
  type ChatRow,
  type MessageRow,
} from "./queries.js";

const iso = (t: number | null | undefined) =>
  t == null ? null : new Date(t * 1000).toISOString();

function chatOut(c: ChatRow) {
  return {
    chat_id: c.chat_id,
    name: displayName(c),
    first_name: c.first_name,
    last_name: c.last_name,
    username: c.username ? `@${c.username}` : null,
    type: c.type,
    message_count: c.message_count,
    first_message_at: iso(c.first_message_at),
    last_message_at: iso(c.last_message_at),
  };
}

function msgOut(m: MessageRow) {
  return {
    chat_id: m.chat_id,
    chat_name: displayName({
      title: m.chat_title,
      first_name: m.chat_first_name,
      last_name: m.chat_last_name,
      username: m.chat_username,
    }),
    chat_username: m.chat_username ? `@${m.chat_username}` : null,
    message_id: m.message_id,
    business_connection_id: m.business_connection_id,
    date: iso(m.date),
    date_unix: m.date,
    direction: m.outgoing ? "outgoing" : "incoming",
    from: {
      user_id: m.from_id,
      first_name: m.from_first_name,
      last_name: m.from_last_name,
      username: m.from_username ? `@${m.from_username}` : null,
    },
    chat_type: m.chat_type,
    // Forum topic, when the chat is a forum supergroup. Null in private chats.
    topic: m.message_thread_id
      ? { thread_id: m.message_thread_id, name: m.topic_name }
      : null,
    message_type: m.content_type,
    text: m.text ?? m.caption ?? null,
    // Speech recognised locally from voice/video. Null until transcribed.
    transcript: m.transcript,
    transcript_engine: m.transcript_engine,
    media_status: m.media_status,
    reply_to_message_id: m.reply_to_message_id,
    edited: m.edit_date != null,
    edited_at: iso(m.edit_date),
    deleted: m.is_deleted === 1,
  };
}

export type ToolName =
  | "telegram_list_chats"
  | "telegram_recent_messages"
  | "telegram_get_messages"
  | "telegram_search_messages"
  | "telegram_find_chat";

/** The read-only surface. The read API exposes exactly these and nothing else. */
export const TOOL_NAMES: ToolName[] = [
  "telegram_list_chats",
  "telegram_recent_messages",
  "telegram_get_messages",
  "telegram_search_messages",
  "telegram_find_chat",
];

/** Extra tools the MCP server may expose, each behind its own env switch. */
export const MEDIA_TOOL = "telegram_get_photo";
export const SEND_TOOL = "telegram_send_message";
export const EDIT_TOOL = "telegram_edit_message";
export const READ_TOOL = "telegram_mark_read";
export const FORGET_TOOL = "telegram_forget";

export function enabledToolNames(): string[] {
  return [
    ...TOOL_NAMES,
    ...(ALLOW_MEDIA ? [MEDIA_TOOL] : []),
    ...(ALLOW_SEND ? [SEND_TOOL, EDIT_TOOL, READ_TOOL] : []),
    ...(ALLOW_FORGET ? [FORGET_TOOL] : []),
  ];
}

type Args = Record<string, unknown>;

function requireChatId(args: Args): number {
  const raw = args.chat_id;
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error("chat_id is required and must be a number");
  }
  return Math.trunc(n);
}

/**
 * Single implementation of every tool, shared by the HTTP read API and the MCP
 * server. The five read tools touch only SQLite. The two optional ones reach
 * the Bot API and are refused unless their env switch is on.
 */
export async function runTool(
  db: Database.Database,
  name: string,
  args: Args = {}
): Promise<unknown> {
  switch (name) {
    case "telegram_list_chats": {
      const limit = clamp(args.limit, 20, 200);
      const chats = listChats(db, limit);
      return { count: chats.length, chats: chats.map(chatOut) };
    }

    case "telegram_recent_messages": {
      const limit = clamp(args.limit, 20, 200);
      const since = requireSince(args.since, "since");
      const rows = recentMessages(db, limit, since);
      return {
        count: rows.length,
        since: iso(since ?? null),
        messages: rows.map(msgOut),
      };
    }

    case "telegram_get_messages": {
      const chatId = requireChatId(args);
      const limit = clamp(args.limit, 50, 200);
      const before = requireSince(args.before, "before");
      const since = requireSince(args.since, "since");
      const chat = getChat(db, chatId);
      if (!chat) return { error: `No chat with chat_id=${chatId} in the local archive.` };
      const rows = getMessages(db, chatId, limit, before, since);
      return {
        chat: chatOut(chat),
        count: rows.length,
        messages: rows.map(msgOut), // oldest first, reads as a transcript
      };
    }

    case "telegram_search_messages": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const limit = clamp(args.limit, 30, 200);
      const since = requireSince(args.since, "since");
      const chatId = args.chat_id != null ? requireChatId(args) : undefined;
      const rows = searchMessages(db, query, limit, chatId, since);
      return {
        query,
        count: rows.length,
        since: iso(since ?? null),
        messages: rows.map(msgOut),
      };
    }

    case "telegram_find_chat": {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const chats = findChat(db, query, clamp(args.limit, 20, 100));
      return { query, count: chats.length, chats: chats.map(chatOut) };
    }

    case MEDIA_TOOL: {
      if (!ALLOW_MEDIA) throw new Error(`${MEDIA_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const messageId = Number(args.message_id);
      if (!Number.isFinite(messageId)) throw new Error("message_id is required");
      return fetchPhoto(db, chatId, Math.trunc(messageId));
    }

    case SEND_TOOL: {
      if (!ALLOW_SEND) throw new Error(`${SEND_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const replyTo =
        args.reply_to_message_id != null ? Number(args.reply_to_message_id) : undefined;
      return sendMessage(db, chatId, String(args.text ?? ""), replyTo);
    }

    case EDIT_TOOL: {
      if (!ALLOW_SEND) throw new Error(`${EDIT_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const messageId = Number(args.message_id);
      if (!Number.isFinite(messageId)) throw new Error("message_id is required");
      return editMessage(db, chatId, Math.trunc(messageId), String(args.text ?? ""));
    }

    case READ_TOOL: {
      if (!ALLOW_SEND) throw new Error(`${READ_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const messageId = args.message_id != null ? Number(args.message_id) : undefined;
      return markRead(db, chatId, messageId != null ? Math.trunc(messageId) : undefined);
    }

    case FORGET_TOOL: {
      if (!ALLOW_FORGET) throw new Error(`${FORGET_TOOL} is disabled on this server`);
      const chatId = args.chat_id != null ? requireChatId(args) : undefined;
      // Fail closed: an unparseable bound here would silently widen a delete
      // from "before X" to "everything in this chat".
      const before = requireSince(args.before, "before");
      return forget(db, { chatId, before });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
