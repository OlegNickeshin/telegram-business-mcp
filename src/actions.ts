/**
 * Operations that need the Telegram Bot API rather than just the archive:
 * sending a message as the business account, and fetching a photo's bytes.
 *
 * Each capability sits behind its own switch, and the two that reach outside
 * this server default to off. A fresh install is a read-only archive: the
 * endpoint URL is effectively the credential, and a default that lets whoever
 * holds it write to the owner's contacts is not a default to ship.
 */
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { EXTRACT_MAX_BYTES, extractText, isExtractable } from "./extract.js";
import { stripMarkdown, toTelegramHtml } from "./markdown.js";
import { call, contentType, type TgMessage } from "./telegram.js";
import { saveBusinessMessage } from "./store.js";
import { displayName } from "./queries.js";

export const ALLOW_SEND = (process.env.ALLOW_SEND ?? "0") === "1";
export const ALLOW_MEDIA = (process.env.ALLOW_MEDIA ?? "1") === "1";
/** Purging rows from the local archive. Kept as its own switch so it can be
 *  turned off without giving up replies. */
export const ALLOW_FORGET = (process.env.ALLOW_FORGET ?? "0") === "1";
/** Telegram's own cap. */
const MAX_TEXT = 4096;

interface ChatRow {
  chat_id: number;
  type: string | null;
  business_connection_id: string | null;
  title: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
}

/**
 * Only chats already in the archive can be messaged. A model that invents or
 * mistypes a chat_id would otherwise reach a stranger; this makes that
 * impossible without touching the send path itself.
 */
function knownChat(db: Database.Database, chatId: number): ChatRow {
  const row = db
    .prepare(
      `SELECT c.chat_id, c.type, c.title, c.first_name, c.last_name, c.username,
              (SELECT business_connection_id FROM messages
                WHERE chat_id = c.chat_id AND business_connection_id <> ''
                ORDER BY date DESC LIMIT 1) AS business_connection_id
         FROM chats c WHERE c.chat_id = ?`
    )
    .get(chatId) as ChatRow | undefined;
  if (!row) {
    throw new Error(
      `chat_id ${chatId} is not in the archive. Resolve the person with ` +
        `telegram_find_chat first; messages can only go to existing conversations.`
    );
  }
  // A private chat goes out through the business connection so it appears from
  // the user. A group has none — the bot posts there as itself.
  if (row.type === "private" && !row.business_connection_id) {
    throw new Error(`chat_id ${chatId} has no business connection recorded`);
  }
  // Ignore one that should not be there. Rows can arrive from an import, and a
  // connection id on a group turns every send into a 400 from Telegram.
  if (row.type !== "private" && row.business_connection_id) {
    return { ...row, business_connection_id: null };
  }
  return row;
}

/**
 * Sends text as Telegram HTML when it carries markdown, and as plain text when
 * it does not.
 *
 * The fallback matters more than the conversion. Formatting is a nicety; a
 * message that never arrives because a bracket confused a parser is a real
 * failure in someone's actual conversation. So a parse rejection retries once
 * with the markup stripped, and only a second failure is an error.
 */
async function sendWithFormatting(
  base: Record<string, unknown>,
  body: string,
  method = "sendMessage"
): Promise<TgMessage> {
  const { html, formatted } = toTelegramHtml(body);
  if (!formatted) return call<TgMessage>(method, { ...base, text: body });

  try {
    return await call<TgMessage>(method, { ...base, text: html, parse_mode: "HTML" });
  } catch (err) {
    const msg = (err as Error).message;
    // Telegram reports a bad parse as a 400 naming entities or the parse mode.
    if (!/can't parse|entit|parse_mode|unsupported start tag/i.test(msg)) throw err;
    const plain = stripMarkdown(body);
    console.warn(
      `${new Date().toISOString()} HTML rejected (${msg}); resending without formatting`
    );
    return call<TgMessage>(method, { ...base, text: plain });
  }
}

export async function sendMessage(
  db: Database.Database,
  chatId: number,
  text: string,
  replyTo?: number,
  threadId?: number
): Promise<unknown> {
  if (!ALLOW_SEND) throw new Error("Sending is disabled on this server (ALLOW_SEND=0)");

  const body = String(text ?? "").trim();
  if (!body) throw new Error("text is empty");
  if (body.length > MAX_TEXT) {
    throw new Error(`text is ${body.length} characters, Telegram allows ${MAX_TEXT}`);
  }

  const chat = knownChat(db, chatId);
  const base = {
    // Omitted for groups: the field is only valid for business chats.
    ...(chat.business_connection_id
      ? { business_connection_id: chat.business_connection_id }
      : {}),
    chat_id: chatId,
    ...(threadId ? { message_thread_id: threadId } : {}),
    ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
  };
  const sent = await sendWithFormatting(base, body);

  // Record it ourselves so history and the Linear mirror stay complete even if
  // Telegram does not echo our own send back as an update. The unique index on
  // (connection, chat, message_id) makes a later echo a no-op.
  try {
    saveBusinessMessage(
      db,
      { ...sent, business_connection_id: chat.business_connection_id ?? "" },
      0
    );
  } catch {
    /* archiving is best-effort; the message was already delivered */
  }

  console.log(
    `${new Date().toISOString()} SENT to chat_id=${chatId} (${displayName(chat)}) ` +
      `message_id=${sent.message_id} ${body.length} chars`
  );

  return {
    sent: true,
    chat_id: chatId,
    chat_name: displayName(chat),
    message_id: sent.message_id,
    date: new Date((sent.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    text: body,
  };
}

/**
 * Total byte budget for one batch of photos, shared between them.
 *
 * Six photos at the single-photo budget came to ~270 KB of base64 in one turn,
 * and a client that copes with one image block drops six. Dividing a fixed
 * total is what makes "show me the last six" work at all: each picture gets
 * smaller as the batch grows, rather than the batch getting heavier.
 */
const MCP_PHOTOS_TOTAL_BYTES = Number(process.env.MCP_PHOTOS_TOTAL_BYTES ?? 150_000);
/** Below this a Telegram variant is a thumbnail, so stop dividing. */
const MCP_PHOTO_FLOOR_BYTES = 18_000;
/** More than this in one answer is not a reading task any more. */
const MAX_PHOTOS_PER_BATCH = 10;

/**
 * Several photos at once, sized to fit one shared budget.
 *
 * A failure on one is reported in place rather than failing the batch: asking
 * for six pictures and getting five plus a reason beats getting an error.
 */
export async function fetchPhotos(
  db: Database.Database,
  chatId: number,
  messageIds: number[]
): Promise<{
  count: number;
  bytes_per_photo: number;
  photos: {
    message_id: number;
    data?: string;
    mimeType?: string;
    bytes?: number;
    caption: string | null;
    url: string | null;
    error?: string;
  }[];
}> {
  if (!ALLOW_MEDIA) throw new Error("Media fetching is disabled on this server (ALLOW_MEDIA=0)");
  const ids = [...new Set(messageIds.map((n) => Math.trunc(n)))].slice(0, MAX_PHOTOS_PER_BATCH);
  if (!ids.length) throw new Error("message_ids is required");

  const each = Math.max(MCP_PHOTO_FLOOR_BYTES, Math.floor(MCP_PHOTOS_TOTAL_BYTES / ids.length));

  const photos = await Promise.all(
    ids.map(async (messageId) => {
      try {
        const r = await fetchPhotoRaw(db, chatId, messageId, each);
        return {
          message_id: messageId,
          data: r.buf.toString("base64"),
          mimeType: r.mimeType,
          bytes: r.buf.length,
          caption: r.caption,
          url: photoUrl(db, chatId, messageId),
        };
      } catch (err) {
        return {
          message_id: messageId,
          caption: null,
          url: photoUrl(db, chatId, messageId),
          error: (err as Error).message,
        };
      }
    })
  );

  return { count: photos.length, bytes_per_photo: each, photos };
}

/** Bot API method and the field the file goes in, per kind of media. */
const SEND_METHOD: Record<string, [method: string, field: string]> = {
  photo: ["sendPhoto", "photo"],
  document: ["sendDocument", "document"],
  video: ["sendVideo", "video"],
  audio: ["sendAudio", "audio"],
  voice: ["sendVoice", "voice"],
  video_note: ["sendVideoNote", "video_note"],
  animation: ["sendAnimation", "animation"],
  sticker: ["sendSticker", "sticker"],
};

/** Best guess at what a URL points to, when there is no archived message. */
function kindFromUrl(url: string): string {
  const ext = url.split(/[?#]/)[0].match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "webp", "bmp"].includes(ext)) return "photo";
  if (["gif"].includes(ext)) return "animation";
  if (["mp4", "mov", "webm", "m4v"].includes(ext)) return "video";
  if (["mp3", "m4a", "flac", "wav"].includes(ext)) return "audio";
  if (["oga", "ogg", "opus"].includes(ext)) return "voice";
  // Anything unrecognised goes as a document, which is also the only kind
  // Telegram passes through without re-encoding.
  return "document";
}

/**
 * Sends media: a file already in the archive, or one at a public URL.
 *
 * Resending from the archive costs no bandwidth in either direction — the
 * `file_id` is a handle to a file Telegram already stores, so it is quoted back
 * rather than uploaded. That also means it works for anything the archive saw
 * live, however large, without the 20 MB download cap applying.
 *
 * A URL is fetched by Telegram, not by this server. Imported history has no
 * `file_id` at all, so those messages say so instead of failing obscurely.
 */
export async function sendMedia(
  db: Database.Database,
  opts: {
    chatId: number;
    fromChatId?: number;
    fromMessageId?: number;
    url?: string;
    caption?: string;
    asDocument?: boolean;
    replyTo?: number;
    threadId?: number;
  }
): Promise<unknown> {
  if (!ALLOW_SEND) throw new Error("Sending is disabled on this server (ALLOW_SEND=0)");

  const hasSource = opts.fromChatId != null && opts.fromMessageId != null;
  if (hasSource === (opts.url != null)) {
    throw new Error(
      "give exactly one source: from_chat_id + from_message_id (a message in the " +
        "archive), or url (a public link Telegram can fetch)"
    );
  }

  let kind: string;
  let file: string;
  let sourceName: string | null = null;

  if (hasSource) {
    const found = locateFile(db, opts.fromChatId!, opts.fromMessageId!);
    if (!found.fileId) {
      throw new Error(
        `message ${opts.fromMessageId} carries no file. Imported history has no ` +
          `file_id — only messages the collector saw live can be resent.`
      );
    }
    kind = found.contentType;
    file = found.fileId;
    sourceName = found.name ?? null;
  } else {
    kind = kindFromUrl(opts.url!);
    file = opts.url!;
  }

  // Forcing a document keeps a photo at full resolution and stops Telegram
  // re-encoding anything.
  if (opts.asDocument) kind = "document";

  const entry = SEND_METHOD[kind];
  if (!entry) throw new Error(`cannot send a ${kind}`);
  const [method, field] = entry;

  const chat = knownChat(db, opts.chatId);
  const caption = String(opts.caption ?? "").trim();
  const { html, formatted } = caption ? toTelegramHtml(caption) : { html: "", formatted: false };

  const params: Record<string, unknown> = {
    ...(chat.business_connection_id
      ? { business_connection_id: chat.business_connection_id }
      : {}),
    chat_id: opts.chatId,
    [field]: file,
    // A sticker or a video note has no caption field at all.
    ...(caption && kind !== "sticker" && kind !== "video_note"
      ? { caption: html, ...(formatted ? { parse_mode: "HTML" } : {}) }
      : {}),
    ...(opts.threadId ? { message_thread_id: opts.threadId } : {}),
    ...(opts.replyTo ? { reply_parameters: { message_id: opts.replyTo } } : {}),
  };

  let sent: TgMessage;
  try {
    sent = await call<TgMessage>(method, params);
  } catch (err) {
    const msg = (err as Error).message;
    // Same reasoning as for text: a caption is a nicety, delivery is not.
    if (formatted && /can't parse|entit|parse_mode|unsupported start tag/i.test(msg)) {
      console.warn(
        `${new Date().toISOString()} caption HTML rejected (${msg}); resending plain`
      );
      sent = await call<TgMessage>(method, {
        ...params,
        caption: stripMarkdown(caption),
        parse_mode: undefined,
      });
    } else {
      throw err;
    }
  }

  try {
    saveBusinessMessage(
      db,
      { ...sent, business_connection_id: chat.business_connection_id ?? "" },
      0
    );
  } catch {
    /* archiving is best-effort; the media was already delivered */
  }

  console.log(
    `${new Date().toISOString()} SENT ${kind} to chat_id=${opts.chatId} ` +
      `(${displayName(chat)}) message_id=${sent.message_id}` +
      (hasSource ? ` from ${opts.fromChatId}/${opts.fromMessageId}` : ` from url`)
  );

  return {
    sent: true,
    kind,
    chat_id: opts.chatId,
    chat_name: displayName(chat),
    message_id: sent.message_id,
    filename: sourceName,
    caption: caption || null,
    // A group send goes out as the bot: a business connection covers 1:1 chats
    // only, so there is no way to post as the owner there.
    sent_as: chat.business_connection_id ? "you" : "the bot",
  };
}

/**
 * Puts a reaction on a message, or takes ours off.
 *
 * The set of emoji Telegram accepts is not hardcoded here. It changes, it is
 * per-chat configurable, and a stale copy would refuse something valid — so the
 * emoji goes through and Telegram's own refusal is passed back intact.
 *
 * Behind ALLOW_SEND rather than ALLOW_MEDIA: a reaction is visible to the other
 * person and notifies them, which makes it a write, not a read.
 */
export async function setReaction(
  db: Database.Database,
  chatId: number,
  messageId: number,
  emoji?: string | null,
  big = false
): Promise<unknown> {
  if (!ALLOW_SEND) throw new Error("Sending is disabled on this server (ALLOW_SEND=0)");

  const chat = knownChat(db, chatId);
  const known = db
    .prepare("SELECT 1 AS ok FROM messages WHERE chat_id = ? AND message_id = ?")
    .get(chatId, messageId) as { ok: number } | undefined;
  if (!known) {
    throw new Error(
      `no message ${messageId} in chat ${chatId}. React only to messages in the archive.`
    );
  }

  const wanted = (emoji ?? "").trim();
  try {
    await call("setMessageReaction", {
      ...(chat.business_connection_id
        ? { business_connection_id: chat.business_connection_id }
        : {}),
      chat_id: chatId,
      message_id: messageId,
      reaction: wanted ? [{ type: "emoji", emoji: wanted }] : [],
      ...(big && wanted ? { is_big: true } : {}),
    });
  } catch (err) {
    const msg = (err as Error).message;
    // Telegram names a rejected emoji rather than explaining it; say what to do.
    if (/REACTION_INVALID/i.test(msg)) {
      throw new Error(
        `Telegram does not accept "${wanted}" as a reaction here. Use one of its standard ` +
          `reaction emoji (👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🎉 🤩 🙏 👌 💯 🤣 ⚡ 🤝 🫡 and similar).`
      );
    }
    throw err;
  }

  console.log(
    `${new Date().toISOString()} REACTION ${wanted || "(removed)"} on chat_id=${chatId} ` +
      `message_id=${messageId}`
  );

  return {
    ok: true,
    chat_id: chatId,
    chat_name: displayName(chat),
    message_id: messageId,
    reaction: wanted || null,
    removed: !wanted,
    // A group has no business connection, so the reaction is the bot's own.
    reacted_as: chat.business_connection_id ? "you" : "the bot",
  };
}

/**
 * Marks a message, and everything before it in that chat, as read. Invisible to
 * the other side beyond the read receipt they would have seen anyway.
 */
export async function markRead(
  db: Database.Database,
  chatId: number,
  messageId?: number
): Promise<unknown> {
  if (!ALLOW_SEND) throw new Error("Sending is disabled on this server (ALLOW_SEND=0)");

  const chat = knownChat(db, chatId);
  if (!chat.business_connection_id) {
    throw new Error(`chat_id ${chatId} is not a business chat; only those can be marked read`);
  }

  // Default to the newest message we know of in that chat.
  const target =
    messageId ??
    (db
      .prepare("SELECT MAX(message_id) AS m FROM messages WHERE chat_id = ?")
      .get(chatId) as { m: number | null }).m;
  if (target == null) throw new Error(`no messages known in chat ${chatId}`);

  await call("readBusinessMessage", {
    business_connection_id: chat.business_connection_id,
    chat_id: chatId,
    message_id: target,
  });

  return { marked_read: true, chat_id: chatId, chat_name: displayName(chat), up_to_message_id: target };
}

/** Edits a message the user sent. Incoming messages cannot be edited by anyone. */
export async function editMessage(
  db: Database.Database,
  chatId: number,
  messageId: number,
  text: string
): Promise<unknown> {
  if (!ALLOW_SEND) throw new Error("Sending is disabled on this server (ALLOW_SEND=0)");

  const body = String(text ?? "").trim();
  if (!body) throw new Error("text is empty");
  if (body.length > MAX_TEXT) {
    throw new Error(`text is ${body.length} characters, Telegram allows ${MAX_TEXT}`);
  }

  const row = db
    .prepare("SELECT outgoing, business_connection_id FROM messages WHERE chat_id = ? AND message_id = ?")
    .get(chatId, messageId) as { outgoing: number; business_connection_id: string } | undefined;
  if (!row) throw new Error(`no message ${messageId} in chat ${chatId}`);
  if (!row.outgoing) {
    throw new Error(`message ${messageId} was received, not sent — only your own messages can be edited`);
  }

  await sendWithFormatting(
    {
      ...(row.business_connection_id
        ? { business_connection_id: row.business_connection_id }
        : {}),
      chat_id: chatId,
      message_id: messageId,
    },
    body,
    "editMessageText"
  );

  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE messages SET text = ?, edit_date = ?, edited_at = ? WHERE chat_id = ? AND message_id = ?")
    .run(body, now, now, chatId, messageId);

  console.log(`${new Date().toISOString()} EDITED chat_id=${chatId} message_id=${messageId}`);
  return { edited: true, chat_id: chatId, message_id: messageId, text: body };
}

/**
 * Removes rows from the local archive. Telegram is not touched: the messages
 * stay where they are for both people, this only forgets our copy.
 *
 * Logical deletion, not secure erasure. A SQLite DELETE frees pages for reuse;
 * the old bytes can survive in the database file, the WAL and the FTS index
 * until they are overwritten. Treat this as "no longer searchable or
 * retrievable through this service", not as "gone from the disk".
 */
export function forget(
  db: Database.Database,
  opts: { chatId?: number; before?: number }
): unknown {
  if (!ALLOW_FORGET) throw new Error("Purging is disabled on this server (ALLOW_FORGET=0)");
  if (opts.chatId == null && opts.before == null) {
    throw new Error("give chat_id, before, or both — refusing to wipe the whole archive by accident");
  }

  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.chatId != null) {
    where.push("chat_id = @chatId");
    params.chatId = opts.chatId;
  }
  if (opts.before != null) {
    where.push("date < @before");
    params.before = opts.before;
  }
  const clause = where.join(" AND ");

  const doomed = db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE ${clause}`)
    .get(params) as { n: number };

  const run = db.transaction(() => {
    // The raw update carries the full message text. Deleting only the parsed
    // row would leave the words on disk and make this function a lie.
    db.prepare(
      `DELETE FROM updates WHERE update_id IN
         (SELECT update_id FROM messages WHERE ${clause} AND update_id IS NOT NULL)`
    ).run(params);
    // Linear bookkeeping goes too, or a re-mirror would think it already ran.
    db.prepare(
      `DELETE FROM linear_comments WHERE (chat_id, message_id) IN
         (SELECT chat_id, message_id FROM messages WHERE ${clause})`
    ).run(params);
    db.prepare(
      `DELETE FROM linear_assets WHERE (chat_id, message_id) IN
         (SELECT chat_id, message_id FROM messages WHERE ${clause})`
    ).run(params);
    db.prepare(`DELETE FROM messages WHERE ${clause}`).run(params);
    // A chat with nothing left in it should not linger in the chat list.
    db.prepare(
      "DELETE FROM chats WHERE chat_id NOT IN (SELECT DISTINCT chat_id FROM messages)"
    ).run();
  });
  run();

  console.log(
    `${new Date().toISOString()} FORGOT ${doomed.n} message(s) ` +
      `chat_id=${opts.chatId ?? "any"} before=${opts.before ?? "any"}`
  );
  return {
    forgotten: doomed.n,
    chat_id: opts.chatId ?? null,
    before: opts.before ? new Date(opts.before * 1000).toISOString() : null,
    note:
      "Removed from the local archive, raw updates included. This is a logical " +
      "delete: freed SQLite pages may still hold the old bytes until reused. " +
      "Telegram still has these messages, and any copy already pushed to Linear " +
      "stays there.",
  };
}

/**
 * Smallest photo worth handing to a model. Telegram's first variant is a ~2 KB
 * preview meant for a chat list, not for reading anything off.
 */
const USABLE_PHOTO_BYTES = Number(process.env.MCP_PHOTO_MIN_BYTES ?? 15_000);

/** Telegram's own download cap. Anything larger cannot be fetched at all. */
export const TELEGRAM_FILE_LIMIT = 20 * 1024 * 1024;

export interface FetchedFile {
  buf: Buffer;
  mimeType: string;
  filename: string;
  caption: string | null;
  contentType: string;
}

/** Media fields that carry a single file, unlike `photo` which carries sizes. */
const SINGLE_FILE_KEYS = [
  "document", "video", "audio", "voice", "video_note", "animation", "sticker",
] as const;

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/zip": "zip",
  "text/csv": "csv",
  "text/plain": "txt",
  "audio/ogg": "oga",
  "video/mp4": "mp4",
  "image/png": "png",
  "image/jpeg": "jpg",
};

function extFor(filename: string | undefined, mime: string, filePath: string): string {
  const fromName = filename?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  const fromPath = filePath.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  return EXT_BY_MIME[mime] ?? fromPath?.toLowerCase() ?? "bin";
}

/**
 * Telegram declares `mime_type` for documents, audio and voice, but not for
 * video notes or stickers — those would otherwise be served as
 * application/octet-stream, which makes a browser download a file it could
 * simply play. The extension on `file_path` is the only hint available, so fall
 * back to it.
 */
const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  pdf: "application/pdf",
  tgs: "application/gzip",
};

function mimeFor(declared: string | undefined, filename: string | undefined, filePath: string): string {
  if (declared) return declared;
  const ext =
    filename?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ??
    filePath.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase();
  return (ext && MIME_BY_EXT[ext]) || "application/octet-stream";
}

/**
 * Downloads whatever file a stored message carries — document, video, audio,
 * voice, sticker or photo.
 *
 * Photos are the one type Telegram sends in several ready-made sizes, so a byte
 * budget is met there by choosing a smaller variant rather than re-encoding: no
 * image library, no quality loss beyond what Telegram already produced.
 * `maxBytes` picks the largest variant that fits; if none does, the smallest is
 * used. For every other type there is a single file and the budget can only
 * refuse it.
 */
interface PickedFile {
  fileId: string;
  name?: string;
  mime?: string;
  size?: number;
  caption: string | null;
  contentType: string;
}

/**
 * Works out which file a stored message carries, without touching the network.
 *
 * Photos are the one type Telegram sends in several ready-made sizes, so a byte
 * budget is met there by choosing a smaller variant rather than re-encoding: no
 * image library, no quality loss beyond what Telegram already produced.
 * `maxBytes` picks the largest variant that fits; if none does, the smallest is
 * used. For every other type there is a single file and the budget can only
 * refuse it.
 */
function pickFile(
  db: Database.Database,
  chatId: number,
  messageId: number,
  maxBytes?: number
): PickedFile {
  if (!ALLOW_MEDIA) throw new Error("Media fetching is disabled on this server (ALLOW_MEDIA=0)");
  return locateFile(db, chatId, messageId, maxBytes);
}

/**
 * The same lookup without the ALLOW_MEDIA gate, for callers that never read the
 * bytes.
 *
 * Resending an archived file quotes its `file_id` back to Telegram, which
 * already holds the file — nothing is downloaded, and nothing leaves this
 * server. That is a send, governed by ALLOW_SEND, not a media read.
 */
function locateFile(
  db: Database.Database,
  chatId: number,
  messageId: number,
  maxBytes?: number
): PickedFile {
  const row = db
    .prepare("SELECT raw, caption, content_type FROM messages WHERE chat_id = ? AND message_id = ?")
    .get(chatId, messageId) as
    | { raw: string; caption: string | null; content_type: string }
    | undefined;
  if (!row) throw new Error(`no message ${messageId} in chat ${chatId}`);

  const msg = JSON.parse(row.raw) as TgMessage & {
    photo?: { file_id: string; file_size?: number }[];
  } & Record<string, { file_id?: string; file_size?: number; file_name?: string; mime_type?: string }>;

  let fileId: string | undefined;
  let name: string | undefined;
  let mime: string | undefined;
  let size: number | undefined;

  if (msg.photo?.length) {
    // Variants come smallest-first from Telegram.
    const variants = msg.photo;
    let pick = variants[variants.length - 1];
    if (maxBytes && maxBytes > 0) {
      const fits = variants.filter((v) => (v.file_size ?? Infinity) <= maxBytes);
      pick = fits.length ? fits[fits.length - 1] : variants[0];
      // Telegram's sizes jump, so a budget can land between them and leave
      // only the 2 KB preview — which is useless to look at, while the variant
      // just above it would have been fine. Overshooting a byte budget by a
      // little beats returning something unreadable.
      if ((pick.file_size ?? 0) < USABLE_PHOTO_BYTES) {
        const usable = variants.find((v) => (v.file_size ?? 0) >= USABLE_PHOTO_BYTES);
        if (usable) pick = usable;
      }
    }
    fileId = pick.file_id;
    size = pick.file_size;
    mime = "image/jpeg";
  } else {
    for (const key of SINGLE_FILE_KEYS) {
      const v = msg[key];
      if (v?.file_id) {
        fileId = v.file_id;
        name = v.file_name;
        mime = v.mime_type;
        size = v.file_size;
        break;
      }
    }
  }

  if (!fileId) {
    // Distinguish "no media at all" from "media the archive knows about but
    // cannot address" — the second is imported history, and saying so is the
    // difference between an actionable answer and a shrug.
    const isMedia = row.content_type !== "text" && row.content_type !== "other";
    throw new Error(
      isMedia
        ? `message ${messageId} is a ${row.content_type}, but carries no file_id: it came ` +
          `from a Telegram Desktop import, and an export does not include one. Only ` +
          `messages the collector saw live can be fetched or resent.`
        : `message ${messageId} is a ${row.content_type} and carries no file`
    );
  }
  // Refuse before spending a round trip on something Telegram will not serve.
  if (size != null && size > TELEGRAM_FILE_LIMIT) {
    throw new Error(
      `file is ${(size / 1e6).toFixed(1)}MB; the Bot API will not serve anything over 20MB`
    );
  }

  return { fileId, name, mime, size, caption: row.caption, contentType: row.content_type };
}

/** Downloads whatever file a stored message carries. */
export async function fetchFileRaw(
  db: Database.Database,
  chatId: number,
  messageId: number,
  maxBytes?: number
): Promise<FetchedFile> {
  const p = pickFile(db, chatId, messageId, maxBytes);

  const file = await call<{ file_path: string }>("getFile", { file_id: p.fileId });
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`download returned HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const mimeType = mimeFor(p.mime, p.name, file.file_path);
  const ext = extFor(p.name, mimeType, file.file_path);

  return {
    buf,
    mimeType,
    filename: p.name ?? `tg-${chatId}-${messageId}.${ext}`,
    caption: p.caption,
    contentType: p.contentType,
  };
}

/** Photos only, for callers that must not be handed a spreadsheet by surprise. */
export async function fetchPhotoRaw(
  db: Database.Database,
  chatId: number,
  messageId: number,
  maxBytes?: number
): Promise<FetchedFile> {
  const r = await fetchFileRaw(db, chatId, messageId, maxBytes);
  if (!r.mimeType.startsWith("image/")) {
    throw new Error(`message ${messageId} is a ${r.contentType}, not a photo`);
  }
  return r;
}

/**
 * Budget for a photo handed to a model. base64 inflates bytes by a third, and
 * a client asked for ten pictures at once has to carry all of them in one
 * response, so the full-size variant is rarely worth its weight: Telegram's
 * ~780px variant reads just as well at a fraction of the size.
 */
const MCP_PHOTO_MAX_BYTES = Number(process.env.MCP_PHOTO_MAX_BYTES ?? 200_000);

/**
 * Public link to the same photo, served by this server. Some clients — ChatGPT
 * among them — ignore MCP image blocks entirely, so a URL is the only way the
 * picture reaches the conversation. The secret already in the path is what
 * guards it.
 */
export function fileUrl(
  db: Database.Database,
  chatId: number,
  messageId: number,
  ext = "jpg"
): string | null {
  const base = (process.env.MCP_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!base) return null;

  const existing = db
    .prepare("SELECT token FROM photo_links WHERE chat_id = ? AND message_id = ?")
    .get(chatId, messageId) as { token: string } | undefined;
  const token = existing?.token ?? randomBytes(6).toString("hex");
  if (!existing) {
    db.prepare(
      `INSERT INTO photo_links (token, chat_id, message_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, message_id) DO NOTHING`
    ).run(token, chatId, messageId, Math.floor(Date.now() / 1000));
  }
  // The extension is cosmetic — the endpoint resolves the token and serves the
  // real type — but it makes the link recognisable and saves with a sane name.
  return `${base}/p/${token}.${ext}`;
}

export const photoUrl = (db: Database.Database, chatId: number, messageId: number) =>
  fileUrl(db, chatId, messageId, "jpg");

/**
 * Everything about one attachment: what it is, where to get it, and — for the
 * formats that have text in them — the text itself.
 *
 * The text is the point. A link is no use to a model that cannot fetch URLs, so
 * "here is the spreadsheet someone sent" has to mean the cells. Bytes are
 * downloaded only when there is something to read in them: a video note still
 * costs one metadata round trip.
 *
 * Extraction failing is not the call failing. The file is still there and the
 * link still works, so the reason is reported alongside the metadata rather
 * than thrown.
 */
export async function fetchFile(
  db: Database.Database,
  chatId: number,
  messageId: number,
  includeText = true,
  maxChars?: number,
  offsetLines = 0
): Promise<{
  filename: string;
  mimeType: string;
  bytes: number;
  message_type: string;
  caption: string | null;
  url: string | null;
  text: string | null;
  text_engine: string | null;
  text_truncated: boolean;
  text_error: string | null;
  from_line: number | null;
  to_line: number | null;
  total_lines: number | null;
}> {
  const p = pickFile(db, chatId, messageId);
  const file = await call<{ file_path?: string; file_size?: number }>("getFile", {
    file_id: p.fileId,
  });

  const mimeType = mimeFor(p.mime, p.name, file.file_path ?? "");
  const ext = extFor(p.name, mimeType, file.file_path ?? "");
  const filename = p.name ?? `tg-${chatId}-${messageId}.${ext}`;
  // getFile is authoritative; the size in the update can be absent.
  const bytes = file.file_size ?? p.size ?? 0;

  const base = {
    filename,
    mimeType,
    bytes,
    message_type: p.contentType,
    caption: p.caption,
    url: fileUrl(db, chatId, messageId, ext),
    text: null as string | null,
    text_engine: null as string | null,
    text_truncated: false,
    text_error: null as string | null,
    from_line: null as number | null,
    to_line: null as number | null,
    total_lines: null as number | null,
  };

  if (!includeText || !isExtractable(mimeType, filename)) return base;
  if (bytes > EXTRACT_MAX_BYTES) {
    return {
      ...base,
      text_error: `file is ${(bytes / 1e6).toFixed(1)}MB; too large to read as text ` +
        `(limit ${(EXTRACT_MAX_BYTES / 1e6).toFixed(0)}MB) — use the link`,
    };
  }

  try {
    const raw = await fetchFileRaw(db, chatId, messageId);
    const got = extractText(raw.buf, mimeType, filename, maxChars, offsetLines);
    if (!got) return base;
    return {
      ...base,
      text: got.text,
      text_engine: got.engine,
      text_truncated: got.truncated,
      from_line: got.from_line,
      to_line: got.to_line,
      total_lines: got.total_lines,
    };
  } catch (err) {
    return { ...base, text_error: (err as Error).message };
  }
}

/** Resolves a short photo token back to the message it points at. */
export function photoByToken(
  db: Database.Database,
  token: string
): { chatId: number; messageId: number } | null {
  const row = db
    .prepare("SELECT chat_id, message_id FROM photo_links WHERE token = ?")
    .get(token) as { chat_id: number; message_id: number } | undefined;
  return row ? { chatId: row.chat_id, messageId: row.message_id } : null;
}

/** The same photo as base64 for an MCP image block, plus a link as a fallback. */
export async function fetchPhoto(
  db: Database.Database,
  chatId: number,
  messageId: number
): Promise<{
  data: string;
  mimeType: string;
  bytes: number;
  caption: string | null;
  url: string | null;
}> {
  const r = await fetchPhotoRaw(db, chatId, messageId, MCP_PHOTO_MAX_BYTES);
  return {
    data: r.buf.toString("base64"),
    mimeType: r.mimeType,
    bytes: r.buf.length,
    caption: r.caption,
    url: photoUrl(db, chatId, messageId),
  };
}
