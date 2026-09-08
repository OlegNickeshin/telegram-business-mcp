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
    throw new Error(`message ${messageId} is a ${row.content_type} and carries no file`);
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
