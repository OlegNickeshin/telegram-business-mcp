/**
 * Imports a Telegram Desktop export into the archive.
 *
 * The Bot API cannot reach messages sent before the bot was connected, and no
 * amount of polling will change that. The official export is the one supported
 * way to recover them, and it costs the server nothing: the owner produces the
 * file in their own client, so no user session ever exists here.
 *
 *   node --env-file=.env dist/import-export.js path/to/result.json
 *   node --env-file=.env dist/import-export.js path/to/result.json --dry-run
 *
 * Desktop numbers messages the same way the Bot API does, so imported rows land
 * in the same key space as live ones: the UNIQUE on
 * (business_connection_id, chat_id, message_id) merges the two histories and
 * makes re-running this harmless.
 */
import fs from "node:fs";
import type Database from "better-sqlite3";
import { migrate, openDb } from "./db.js";
import { saveBusinessMessage } from "./store.js";
import type { TgMessage } from "./telegram.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FILE = args.find((a) => !a.startsWith("--"));

const log = (...p: unknown[]) => console.log(new Date().toISOString(), ...p);

/** One message as Telegram Desktop writes it. */
interface ExportMessage {
  id: number;
  type: string;
  date_unixtime?: string;
  date?: string;
  from?: string | null;
  from_id?: string | number;
  text?: string | (string | { type: string; text: string })[];
  edited_unixtime?: string;
  reply_to_message_id?: number;
  forwarded_from?: string;
  media_type?: string;
  /** Service messages carry these: `topic_created` names a forum topic. */
  action?: string;
  title?: string;
  photo?: string;
  file?: string;
  file_name?: string;
  mime_type?: string;
  sticker_emoji?: string;
  [k: string]: unknown;
}

interface ExportChat {
  name?: string | null;
  type?: string;
  id?: number;
  messages?: ExportMessage[];
}

/** A single-chat export is the common case; a full export nests them. */
function chatsIn(doc: Record<string, unknown>): ExportChat[] {
  if (Array.isArray((doc as { messages?: unknown }).messages)) return [doc as ExportChat];
  const list = (doc as { chats?: { list?: ExportChat[] } }).chats?.list;
  if (Array.isArray(list)) return list;
  throw new Error("not a Telegram Desktop export: no messages and no chats.list");
}

/**
 * Text is a plain string, or an array mixing raw strings with entity objects
 * when the message carries links or formatting. Flattening keeps the words and
 * drops only the markup, which is all search needs.
 */
function flattenText(t: ExportMessage["text"]): string {
  if (typeof t === "string") return t;
  if (!Array.isArray(t)) return "";
  return t.map((p) => (typeof p === "string" ? p : p.text ?? "")).join("");
}

/** `"user123456789"` → `123456789`. Channels use `channel…`, groups `chat…`. */
function numericId(v: string | number | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return null;
  const m = v.match(/(-?\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Works out which forum topic each message belongs to.
 *
 * An export records no thread id at all. What it does record is a
 * `topic_created` service message per topic — whose own `id` *is* the thread id
 * Telegram uses — and a `reply_to_message_id` on everything posted inside one.
 * A message in a topic points at the message it answers, which points at the
 * next, and so on back to the topic root, so the thread is recovered by walking
 * that chain.
 *
 * A chain that ends without reaching a root means General, or a parent that
 * fell outside the export. Both are left without a thread rather than guessed
 * at: claiming the wrong topic is worse than claiming none.
 */
function topicIndex(messages: ExportMessage[]): {
  names: Map<number, string>;
  threadOf: Map<number, number>;
} {
  const names = new Map<number, string>();
  for (const m of messages) {
    if (m.action === "topic_created" && m.title) names.set(m.id, m.title);
  }

  const byId = new Map(messages.map((m) => [m.id, m]));
  const threadOf = new Map<number, number>();
  if (!names.size) return { names, threadOf };

  const resolve = (start: number | undefined): number | undefined => {
    const path: number[] = [];
    let id = start;
    // `seen` guards against a reply cycle, which should not exist but would
    // hang the import if it did.
    const seen = new Set<number>();
    while (id != null && !seen.has(id)) {
      seen.add(id);
      const cached = threadOf.get(id);
      if (cached != null) {
        for (const p of path) threadOf.set(p, cached);
        return cached;
      }
      if (names.has(id)) {
        for (const p of path) threadOf.set(p, id);
        return id;
      }
      path.push(id);
      id = byId.get(id)?.reply_to_message_id;
    }
    return undefined;
  };

  for (const m of messages) {
    if (m.reply_to_message_id == null) continue;
    const thread = resolve(m.reply_to_message_id);
    if (thread != null) threadOf.set(m.id, thread);
  }
  return { names, threadOf };
}

/**
 * Translates an export's chat id into the one the Bot API uses.
 *
 * Telegram Desktop writes the bare internal id; the Bot API prefixes it. A
 * supergroup exported as 4355964943 arrives live as -1004355964943, and a
 * legacy group as the plain negative. Importing the raw number splits one
 * conversation into two chats, and defeats the dedup that keeps an export and
 * the live feed from storing the same message twice — the export usually runs
 * to today, so the overlap is guaranteed rather than hypothetical.
 */
export function botApiChatId(id: number, type: string | undefined): number {
  // Already in Bot API form (some exports, and anything re-imported).
  if (id < 0) return id;
  switch (type) {
    case "private_supergroup":
    case "public_supergroup":
    case "private_channel":
    case "public_channel":
      return -1_000_000_000_000 - id;
    case "private_group":
    case "public_group":
      return -id;
    default:
      // personal_chat, bot_chat, saved_messages: the user id, unchanged.
      return id;
  }
}

/** Export vocabulary for chat kinds is not the Bot API's. */
function botApiChatType(type: string | undefined): string {
  switch (type) {
    case "personal_chat":
    case "bot_chat":
    case "saved_messages":
      return "private";
    case "private_group":
    case "public_group":
      return "group";
    case "private_supergroup":
    case "public_supergroup":
      return "supergroup";
    case "private_channel":
    case "public_channel":
      return "channel";
    default:
      return type ?? "private";
  }
}

/**
 * Rebuilds the shape the archive already knows how to store, so the import path
 * reuses the live one — direction, chat upsert, FTS indexing and dedup all come
 * for free instead of being re-implemented and drifting.
 */
function toTgMessage(
  m: ExportMessage,
  chat: ExportChat,
  chatId: number,
  connectionId: string,
  threadId?: number
): TgMessage {
  const text = flattenText(m.text);
  const media: Record<string, unknown> = {};

  // contentType() keys off the presence of these fields, so a marker is enough.
  if (m.photo != null) media.photo = [{}];
  else if (m.media_type === "voice_message") media.voice = {};
  else if (m.media_type === "video_message") media.video_note = {};
  else if (m.media_type === "sticker") media.sticker = {};
  else if (m.media_type === "animation") media.animation = {};
  else if (m.media_type === "video_file") media.video = {};
  else if (m.media_type === "audio_file") media.audio = {};
  else if (m.file != null) media.document = {};

  const hasMedia = Object.keys(media).length > 0;
  const fromId = numericId(m.from_id);

  return {
    message_id: m.id,
    business_connection_id: connectionId,
    from: fromId != null ? { id: fromId, first_name: m.from ?? undefined } : undefined,
    chat: {
      id: chatId,
      type: botApiChatType(chat.type),
      ...(botApiChatType(chat.type) === "private"
        ? { first_name: chat.name ?? undefined }
        : { title: chat.name ?? undefined }),
    },
    date: Number(m.date_unixtime ?? 0) || Math.floor(Date.parse(m.date ?? "") / 1000) || 0,
    ...(m.edited_unixtime ? { edit_date: Number(m.edited_unixtime) } : {}),
    // Media keeps its words in caption, matching how live messages are stored.
    ...(hasMedia ? { caption: text || undefined } : { text }),
    ...media,
    ...(m.reply_to_message_id ? { reply_to_message: { message_id: m.reply_to_message_id } } : {}),
    ...(threadId ? { message_thread_id: threadId } : {}),
    ...(m.forwarded_from ? { forward_origin: { sender_user_name: m.forwarded_from } } : {}),
    // The untouched export record, so nothing is lost to this translation.
    _export: m,
  } as TgMessage;
}

/**
 * Imported rows must carry the same connection id as live ones for that chat,
 * or the UNIQUE key differs and the same message is stored twice.
 */
function connectionFor(db: Database.Database, chatId: number, type: string): string {
  // A group can never have one: a business connection covers the owner's 1:1
  // chats, and Telegram refuses a send that carries the field into a group
  // ("chat must be a private chat"). Stamping one on during an import made
  // sending to that group impossible until the rows were repaired.
  if (botApiChatType(type) !== "private") return "";

  const fromChat = db
    .prepare(
      `SELECT business_connection_id AS bc FROM messages
        WHERE chat_id = ? AND business_connection_id <> '' LIMIT 1`
    )
    .get(chatId) as { bc: string } | undefined;
  if (fromChat?.bc) return fromChat.bc;

  const any = db
    .prepare("SELECT id FROM business_connections ORDER BY date DESC LIMIT 1")
    .get() as { id: string } | undefined;
  return any?.id ?? "";
}

function main(): void {
  if (!FILE) {
    console.error(
      "usage: node dist/import-export.js <result.json> [--dry-run]\n\n" +
        "Export it from Telegram Desktop: Settings -> Advanced -> Export Telegram data,\n" +
        "format 'Machine-readable JSON'. Media files are not needed."
    );
    process.exit(2);
  }
  if (!fs.existsSync(FILE)) {
    console.error(`no such file: ${FILE}`);
    process.exit(2);
  }

  const doc = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, unknown>;
  const chats = chatsIn(doc);

  const db = openDb();
  migrate(db);

  let seen = 0, imported = 0, skipped = 0, service = 0;

  for (const chat of chats) {
    if (chat.id == null) {
      log(`skipping a chat with no id ("${chat.name ?? "?"}")`);
      continue;
    }
    const chatId = botApiChatId(chat.id, chat.type);
    const messages = chat.messages ?? [];
    const connectionId = connectionFor(db, chatId, chat.type ?? "");
    const { names: topicNames, threadOf } = topicIndex(messages);

    // Names come from `topic_created`, which records the title a topic was
    // given — not the title it has now. A `topic_edit` carries the rename but
    // no reference to which topic it renamed, so a rename cannot be attributed
    // from an export at all. Live traffic knows the current name, so it wins:
    // these are only filled in where nothing is on record yet.
    if (topicNames.size) {
      const insertTopic = db.prepare(
        `INSERT INTO topics (chat_id, message_thread_id, name, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, message_thread_id) DO NOTHING`
      );
      const now = Math.floor(Date.now() / 1000);
      db.transaction(() => {
        for (const [threadId, name] of topicNames) {
          insertTopic.run(chatId, threadId, name, now);
        }
      })();
    }
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?")
      .get(chatId) as { n: number };

    log(
      `"${chat.name ?? chatId}" (${chat.type}, chat_id=${chatId}` +
        (chatId !== chat.id ? ` — remapped from export id ${chat.id}` : "") +
        (topicNames.size ? `, ${topicNames.size} forum topics` : "") +
        `): ` +
        `${messages.length} in the export, ${before.n} already archived` +
        (connectionId ? "" : " — no business connection known, importing with an empty one")
    );

    const run = db.transaction(() => {
      for (const m of messages) {
        seen++;
        // Joins, title changes and the like carry no conversation.
        if (m.type !== "message") { service++; continue; }

        const tg = toTgMessage(m, chat, chatId, connectionId, threadOf.get(m.id));
        if (DRY_RUN) {
          if (imported < 5) {
            const when = new Date(tg.date * 1000).toISOString().slice(0, 16).replace("T", " ");
            const body = (tg.text ?? tg.caption ?? "") as string;
            console.log(`  ${when}  #${tg.message_id}  ${body.slice(0, 70).replace(/\s+/g, " ")}`);
          }
          imported++;
          continue;
        }
        // update_id 0: these did not arrive as updates. Everything else — the
        // direction, the chat row, the FTS entry — is produced by the same code
        // that handles live messages.
        saveBusinessMessage(db, tg, 0).inserted ? imported++ : skipped++;
      }
    });
    run();
  }

  const total = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  log(
    DRY_RUN
      ? `--dry-run: ${imported} message(s) would be imported, ${service} service entries ignored. Nothing written.`
      : `imported ${imported}, already present ${skipped}, service entries ignored ${service}. ` +
        `Archive now holds ${total.n}.`
  );
  db.close();
}

try {
  main();
} catch (err) {
  console.error(`import failed: ${(err as Error).message}`);
  process.exit(1);
}
