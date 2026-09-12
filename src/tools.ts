import type Database from "better-sqlite3";
import { forwardOrigin } from "./forwarding.js";
import {
  ALLOW_FORGET,
  ALLOW_MEDIA,
  ALLOW_SEND,
  editMessage,
  fetchFile,
  fetchPhoto,
  fetchPhotos,
  forget,
  markRead,
  sendMedia,
  setReaction,
  sendMessage,
} from "./actions.js";
import { ALLOW_ASSIST, listDirectMessages, listOwnerInbox, listPending, notifyOwner, submitDraft, type PendingScope } from "./assist.js";
import {
  ALLOW_NOTES,
  createNote,
  updateNote,
  getNote,
  listNotes,
  searchNotes,
  deleteNote,
} from "./notes.js";
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
  // Where the words came from, and whether markdown was reconstructed from
  // Telegram's entities. Captions carry formatting as often as text does, so
  // this has to be worked out once rather than branched per field.
  const origin =
    m.text != null
      ? "written"
      : m.caption != null
        ? "caption"
        : m.transcript != null
          ? `speech transcribed from ${m.content_type}`
          : null;

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
    // `from` is the sender in this chat, not necessarily the original author.
    // False means no stored forwarding metadata, not proof of authorship.
    is_forwarded: m.forward_origin != null,
    forward_origin: forwardOrigin(m.forward_origin),
    chat_type: m.chat_type,
    // Forum topic, when the chat is a forum supergroup. Null in private chats.
    topic: m.message_thread_id
      ? { thread_id: m.message_thread_id, name: m.topic_name }
      : null,
    message_type: m.content_type,
    // Named so a reader can tell which document is being discussed, and told
    // where the contents are — otherwise "message_type: document" is a dead end.
    file:
      m.content_type === "text" || (m.file_name == null && m.file_size == null)
        ? null
        : {
            name: m.file_name,
            size_bytes: m.file_size,
            read_with: `${m.content_type === "photo" ? MEDIA_TOOL : FILE_TOOL} ` +
              `(chat_id=${m.chat_id}, message_id=${m.message_id})`,
          },
    // A voice message or round video has no written text at all, so `text` was
    // null while the words sat in `transcript` — and a reader that checks one
    // field concludes nothing was said. Fall back, and say where it came from
    // so speech is never quoted as if it had been typed.
    text: m.text_formatted ?? m.text ?? m.caption ?? m.transcript ?? null,
    text_source:
      origin && m.text_formatted != null
        ? `${origin}, markdown rendered from Telegram formatting`
        : origin,
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
export const PHOTOS_TOOL = "telegram_get_photos";
/** Displays a photo through the widget; the reading tools cannot, see mcp-factory. */
export const SHOW_PHOTO_TOOL = "telegram_show_photo";
export const FILE_TOOL = "telegram_get_file";
export const SEND_TOOL = "telegram_send_message";
export const SEND_MEDIA_TOOL = "telegram_send_media";
export const EDIT_TOOL = "telegram_edit_message";
export const READ_TOOL = "telegram_mark_read";
export const REACT_TOOL = "telegram_set_reaction";
export const FORGET_TOOL = "telegram_forget";

export const NOTE_SEARCH_TOOL = "kb_search_notes";
export const NOTE_GET_TOOL = "kb_get_note";
export const NOTE_LIST_TOOL = "kb_list_notes";
export const NOTE_CREATE_TOOL = "kb_create_note";
export const NOTE_UPDATE_TOOL = "kb_update_note";
export const NOTE_DELETE_TOOL = "kb_delete_note";

export const ASSIST_PENDING_TOOL = "assist_pending";
export const ASSIST_DRAFT_TOOL = "assist_draft";
export const BOT_DIRECT_MESSAGES_TOOL = "telegram_bot_direct_messages";
export const ASSIST_INBOX_TOOL = "assist_owner_inbox";
export const ASSIST_NOTIFY_TOOL = "assist_notify";

export function enabledToolNames(): string[] {
  return [
    ...TOOL_NAMES,
    ...(ALLOW_MEDIA ? [MEDIA_TOOL, PHOTOS_TOOL, SHOW_PHOTO_TOOL, FILE_TOOL] : []),
    ...(ALLOW_SEND ? [SEND_TOOL, SEND_MEDIA_TOOL, REACT_TOOL, EDIT_TOOL, READ_TOOL] : []),
    ...(ALLOW_FORGET ? [FORGET_TOOL] : []),
    ...(ALLOW_NOTES
      ? [NOTE_SEARCH_TOOL, NOTE_GET_TOOL, NOTE_LIST_TOOL, NOTE_CREATE_TOOL, NOTE_UPDATE_TOOL, NOTE_DELETE_TOOL]
      : []),
    ...(ALLOW_ASSIST ? [ASSIST_PENDING_TOOL, ASSIST_DRAFT_TOOL, BOT_DIRECT_MESSAGES_TOOL, ASSIST_INBOX_TOOL, ASSIST_NOTIFY_TOOL] : []),
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
/** A note is addressed by numeric id or by exact title. */
function noteRef(args: Args): { id?: number; title?: string } {
  const id = args.id != null ? Number(args.id) : undefined;
  if (id != null && Number.isFinite(id)) return { id: Math.trunc(id) };
  const title = args.title != null ? String(args.title) : undefined;
  if (title) return { title };
  throw new Error("give the note's id or its exact title");
}

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

    case PHOTOS_TOOL: {
      if (!ALLOW_MEDIA) throw new Error(`${PHOTOS_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const raw = args.message_ids;
      const ids = (Array.isArray(raw) ? raw : [])
        .map((v) => (typeof v === "string" ? Number(v) : v))
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      if (!ids.length) throw new Error("message_ids must be a non-empty array of message ids");
      return fetchPhotos(db, chatId, ids);
    }

    case FILE_TOOL: {
      if (!ALLOW_MEDIA) throw new Error(`${FILE_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const messageId = Number(args.message_id);
      if (!Number.isFinite(messageId)) throw new Error("message_id is required");
      const maxChars = args.max_chars != null ? Number(args.max_chars) : undefined;
      const offset = Number(args.offset_lines ?? 0);
      return fetchFile(
        db,
        chatId,
        Math.trunc(messageId),
        args.include_text !== false,
        Number.isFinite(maxChars) ? maxChars : undefined,
        Number.isFinite(offset) ? offset : 0
      );
    }

    case SEND_TOOL: {
      if (!ALLOW_SEND) throw new Error(`${SEND_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const replyTo =
        args.reply_to_message_id != null ? Number(args.reply_to_message_id) : undefined;
      return sendMessage(db, chatId, String(args.text ?? ""), replyTo);
    }

    case SEND_MEDIA_TOOL: {
      if (!ALLOW_SEND) throw new Error(`${SEND_MEDIA_TOOL} is disabled on this server`);
      const num = (v: unknown) => {
        const n = typeof v === "string" ? Number(v) : v;
        return typeof n === "number" && Number.isFinite(n) ? Math.trunc(n) : undefined;
      };
      const url = args.url != null ? String(args.url).trim() : undefined;
      if (url && !/^https?:\/\//i.test(url)) {
        throw new Error("url must be an http(s) link Telegram can fetch");
      }
      return sendMedia(db, {
        chatId: requireChatId(args),
        fromChatId: num(args.from_chat_id),
        fromMessageId: num(args.from_message_id),
        url,
        caption: args.caption != null ? String(args.caption) : undefined,
        asDocument: args.as_document === true,
        replyTo: num(args.reply_to_message_id),
        threadId: num(args.message_thread_id),
      });
    }

    case REACT_TOOL: {
      if (!ALLOW_SEND) throw new Error(`${REACT_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const messageId = Number(args.message_id);
      if (!Number.isFinite(messageId)) throw new Error("message_id is required");
      return setReaction(
        db,
        chatId,
        Math.trunc(messageId),
        args.emoji != null ? String(args.emoji) : null,
        args.big === true
      );
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

    case NOTE_SEARCH_TOOL: {
      if (!ALLOW_NOTES) throw new Error(`${NOTE_SEARCH_TOOL} is disabled on this server`);
      const tag = args.tag != null ? String(args.tag) : undefined;
      return searchNotes(db, String(args.query ?? ""), tag, clamp(args.limit, 20, 100));
    }

    case NOTE_GET_TOOL: {
      if (!ALLOW_NOTES) throw new Error(`${NOTE_GET_TOOL} is disabled on this server`);
      return getNote(db, noteRef(args));
    }

    case NOTE_LIST_TOOL: {
      if (!ALLOW_NOTES) throw new Error(`${NOTE_LIST_TOOL} is disabled on this server`);
      const tag = args.tag != null ? String(args.tag) : undefined;
      return listNotes(db, tag, clamp(args.limit, 30, 200));
    }

    case NOTE_CREATE_TOOL: {
      if (!ALLOW_NOTES) throw new Error(`${NOTE_CREATE_TOOL} is disabled on this server`);
      const title = String(args.title ?? "").trim();
      if (!title) throw new Error("title is required");
      return createNote(db, title, String(args.body ?? ""), args.tags);
    }

    case NOTE_UPDATE_TOOL: {
      if (!ALLOW_NOTES) throw new Error(`${NOTE_UPDATE_TOOL} is disabled on this server`);
      return updateNote(db, noteRef(args), {
        title: args.title != null ? String(args.title) : undefined,
        body: args.body != null ? String(args.body) : undefined,
        tags: args.tags,
        append: args.append === true,
      });
    }

    case NOTE_DELETE_TOOL: {
      if (!ALLOW_NOTES) throw new Error(`${NOTE_DELETE_TOOL} is disabled on this server`);
      return deleteNote(db, noteRef(args));
    }

    case ASSIST_PENDING_TOOL: {
      if (!ALLOW_ASSIST) throw new Error(`${ASSIST_PENDING_TOOL} is disabled on this server`);
      const scope = ["all", "private", "group"].includes(String(args.scope))
        ? (args.scope as PendingScope)
        : "all";
      return listPending(db, clamp(args.limit, 20, 50), scope, args.digest === true);
    }

    case ASSIST_DRAFT_TOOL: {
      if (!ALLOW_ASSIST) throw new Error(`${ASSIST_DRAFT_TOOL} is disabled on this server`);
      const chatId = requireChatId(args);
      const messageId = Number(args.message_id);
      if (!Number.isFinite(messageId)) throw new Error("message_id is required");
      return submitDraft(db, chatId, Math.trunc(messageId), String(args.draft ?? ""));
    }

    case BOT_DIRECT_MESSAGES_TOOL: {
      if (!ALLOW_ASSIST) throw new Error(`${BOT_DIRECT_MESSAGES_TOOL} is disabled on this server`);
      return listDirectMessages(db, clamp(args.limit, 20, 100));
    }

    case ASSIST_INBOX_TOOL: {
      if (!ALLOW_ASSIST) throw new Error(`${ASSIST_INBOX_TOOL} is disabled on this server`);
      return listOwnerInbox(db, clamp(args.limit, 20, 50));
    }

    case ASSIST_NOTIFY_TOOL: {
      if (!ALLOW_ASSIST) throw new Error(`${ASSIST_NOTIFY_TOOL} is disabled on this server`);
      const ids = Array.isArray(args.handled_ids)
        ? args.handled_ids.map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : undefined;
      const reported = Array.isArray(args.reported)
        ? (args.reported as Record<string, unknown>[])
            .map((x) => ({ chat_id: Number(x.chat_id), message_id: Number(x.message_id) }))
            .filter((x) => Number.isFinite(x.chat_id) && Number.isFinite(x.message_id))
        : undefined;
      return notifyOwner(db, String(args.text ?? ""), ids, reported);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
