import { TELEGRAM_BOT_TOKEN } from "./config.js";

const API = "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | undefined,
    readonly description: string,
    readonly retryAfter?: number
  ) {
    super(`${method} failed (${errorCode ?? "?"}): ${description}`);
  }
}

/** Calls the Bot API. The token is read from env here and never leaves this module. */
export async function call<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 60_000
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/bot${TELEGRAM_BOT_TOKEN()}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: ac.signal,
    });
    const body = (await res.json()) as {
      ok: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    if (!body.ok) {
      throw new TelegramError(
        method,
        body.error_code,
        body.description ?? "unknown error",
        body.parameters?.retry_after
      );
    }
    return body.result as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Update types we ask Telegram for. Business updates must be listed explicitly. */
export const ALLOWED_UPDATES = [
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
  // Groups arrive on a different channel: Business covers 1:1 only, so group
  // and forum-topic messages come as plain `message` updates, and only while
  // the bot is a member with privacy mode disabled.
  "message",
  "edited_message",
] as const;

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: string;
  title?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TgForumTopicCreated {
  name: string;
  icon_color?: number;
}

export interface TgMessage {
  message_id: number;
  business_connection_id?: string;
  /** Forum topic the message belongs to; absent outside forum supergroups. */
  message_thread_id?: number;
  is_topic_message?: boolean;
  forum_topic_created?: TgForumTopicCreated;
  from?: TgUser;
  chat: TgChat;
  date: number;
  edit_date?: number;
  text?: string;
  caption?: string;
  reply_to_message?: {
    message_id: number;
    /** Telegram repeats the topic's name here on replies inside it. */
    forum_topic_created?: TgForumTopicCreated;
  };
  forward_origin?: unknown;
  [k: string]: unknown;
}

export interface TgBusinessConnection {
  id: string;
  user: TgUser;
  user_chat_id: number;
  date: number;
  is_enabled?: boolean;
  can_reply?: boolean;
  rights?: Record<string, unknown>;
}

export interface TgDeletedBusinessMessages {
  business_connection_id: string;
  chat: TgChat;
  message_ids: number[];
}

export interface TgUpdate {
  update_id: number;
  business_connection?: TgBusinessConnection;
  business_message?: TgMessage;
  edited_business_message?: TgMessage;
  deleted_business_messages?: TgDeletedBusinessMessages;
  message?: TgMessage;
  edited_message?: TgMessage;
  [k: string]: unknown;
}

/** Order matters: the first match wins, so text/caption fall through last. */
const MEDIA_KEYS = [
  "photo", "video", "video_note", "voice", "audio", "document", "sticker",
  "animation", "contact", "location", "venue", "poll", "dice", "game",
  "story", "invoice", "successful_payment", "paid_media",
] as const;

export function contentType(msg: TgMessage): string {
  for (const key of MEDIA_KEYS) {
    if (msg[key] != null) return key;
  }
  if (typeof msg.text === "string") return "text";
  return "other";
}

export function updateType(u: TgUpdate): string {
  for (const k of ALLOWED_UPDATES) {
    if (u[k] != null) return k;
  }
  const known = Object.keys(u).find((k) => k !== "update_id");
  return known ?? "unknown";
}
