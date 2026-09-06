/**
 * Mirrors the SQLite archive into Linear: one issue per Telegram chat, one
 * comment per message. SQLite stays the source of truth — Linear is a view
 * that ChatGPT's Linear connector can read from any device.
 *
 *   node --env-file=.env dist/linear-sync.js            # daemon, polls forever
 *   node --env-file=.env dist/linear-sync.js --once     # one pass, then exit
 *   node --env-file=.env dist/linear-sync.js --backfill # everything, no cap
 *   node --env-file=.env dist/linear-sync.js --dry-run  # print, call nothing
 *   node --env-file=.env dist/linear-sync.js --check    # verify key + team
 *
 * Deliberately a separate process from the collector: if Linear is down or the
 * plan's issue cap is hit, Telegram archiving keeps working untouched.
 */
import type Database from "better-sqlite3";
import { getState, migrate, openDb, setState } from "./db.js";
import { displayName } from "./queries.js";
import { LinearClient, LinearError } from "./linear.js";
import { ALLOW_MEDIA, ALLOW_SEND, fetchPhotoRaw, sendMessage } from "./actions.js";

const API_KEY = (process.env.LINEAR_API_KEY ?? "").trim();
const TEAM_KEY = (process.env.LINEAR_TEAM_KEY ?? "").trim();
const TZ = (process.env.LINEAR_TIMEZONE ?? "UTC").trim();
const POLL_SECONDS = Number(process.env.LINEAR_POLL_SECONDS ?? 20);
const BATCH = Number(process.env.LINEAR_BATCH ?? 50);
const TITLE_PREFIX = (process.env.LINEAR_TITLE_PREFIX ?? "TG ·").trim();
/**
 * A comment must start with one of these to be sent to Telegram. Without an
 * explicit marker every note typed into these issues would reach the contact.
 *
 * `tg:` is the default because it has no meaning in markdown. A `>` marker
 * would be eaten by Linear's editor, which turns a leading `>` into a
 * blockquote and never stores the character.
 */
const SEND_PREFIXES = (process.env.LINEAR_SEND_PREFIX ?? "tg:,[SEND],>>")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

/** Returns the message text if the body is a send request, else null. */
function sendRequestText(body: string): string | null {
  for (const p of SEND_PREFIXES) {
    if (body.toLowerCase().startsWith(p.toLowerCase())) {
      return body.slice(p.length).trim();
    }
  }
  return null;
}
const OUTBOX_CURSOR = "linear_outbox_cursor";
/** How far behind the cursor to re-scan, to survive out-of-order indexing. */
const OUTBOX_OVERLAP_MS = 120_000;
/** Mirror photos into Linear so they can be looked at from a phone. */
const MIRROR_PHOTOS = (process.env.LINEAR_MIRROR_PHOTOS ?? "1") === "1";
/**
 * Byte budget per photo. Telegram already provides several sizes, so this
 * selects a variant rather than re-encoding anything.
 */
const PHOTO_MAX_BYTES = Number(process.env.LINEAR_PHOTO_MAX_BYTES ?? 400_000);

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const ONCE = args.has("--once") || args.has("--backfill") || DRY_RUN;
const BACKFILL = args.has("--backfill");
const CHECK = args.has("--check");

const log = (...p: unknown[]) => console.log(new Date().toISOString(), ...p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PendingRow {
  chat_id: number;
  message_id: number;
  date: number;
  outgoing: number;
  content_type: string;
  message_thread_id: number | null;
  topic_name: string | null;
  text: string | null;
  caption: string | null;
  transcript: string | null;
  is_deleted: number;
  edit_date: number | null;
  chat_title: string | null;
  chat_first_name: string | null;
  chat_last_name: string | null;
  chat_username: string | null;
}

const stamp = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

/**
 * Uploads a photo to Linear once and remembers the URL, so re-runs and comment
 * rewrites reuse the same asset instead of uploading the picture again.
 */
async function ensureAsset(
  db: Database.Database,
  linear: LinearClient,
  m: PendingRow
): Promise<string | null> {
  if (!MIRROR_PHOTOS || !ALLOW_MEDIA || m.content_type !== "photo") return null;

  const known = db
    .prepare("SELECT asset_url FROM linear_assets WHERE chat_id = ? AND message_id = ?")
    .get(m.chat_id, m.message_id) as { asset_url: string } | undefined;
  if (known) return known.asset_url;

  try {
    const photo = await fetchPhotoRaw(db, m.chat_id, m.message_id, PHOTO_MAX_BYTES);
    const url = await linear.uploadAsset(photo.filename, photo.mimeType, photo.buf);
    db.prepare(
      `INSERT INTO linear_assets (chat_id, message_id, asset_url, bytes, uploaded_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO NOTHING`
    ).run(m.chat_id, m.message_id, url, photo.buf.length, Math.floor(Date.now() / 1000));
    log(`uploaded photo #${m.message_id} (${Math.round(photo.buf.length / 1024)} KB) to Linear`);
    return url;
  } catch (err) {
    // A picture that will not upload must not block the text of the message.
    log(`photo #${m.message_id} not uploaded: ${(err as Error).message}`);
    return null;
  }
}

/** `[2026-09-06 12:02 IN #323075] text` — greppable, and readable to a model. */
function commentBody(m: PendingRow, assetUrl?: string | null): string {
  const when = stamp.format(new Date(m.date * 1000));
  const dir = m.outgoing ? "OUT" : "IN";
  const flags = [m.is_deleted ? "deleted" : "", m.edit_date ? "edited" : ""].filter(Boolean);
  // In a group the topic and the author matter; in a 1:1 chat both are noise.
  const topic = m.message_thread_id
    ? ` {${m.topic_name ?? "thread " + m.message_thread_id}}`
    : "";
  const head = `[${when} ${dir} #${m.message_id}${flags.length ? " " + flags.join(",") : ""}]${topic}`;
  const said = m.text ?? m.caption ?? null;
  // Media with a caption should still say what it was.
  const kind = m.content_type !== "text" ? ` <${m.content_type}>` : "";
  const parts = [said, m.transcript ? `🗣 ${m.transcript}` : null].filter(Boolean);
  const line = `${head}${kind}${parts.length ? " " + parts.join("\n") : ""}`;
  // Markdown image on its own line, so Linear renders it and the connector can
  // hand the picture to a model rather than the word "<photo>".
  return assetUrl ? `${line}\n\n![photo](${assetUrl})` : line;
}

function pending(db: Database.Database, limit: number | null): PendingRow[] {
  const sql = `
    SELECT m.chat_id, m.message_id, m.date, m.outgoing, m.content_type, m.text, m.caption,
           m.transcript, m.message_thread_id, m.topic_name, m.is_deleted, m.edit_date,
           c.title AS chat_title, c.first_name AS chat_first_name,
           c.last_name AS chat_last_name, c.username AS chat_username
      FROM messages m
      JOIN chats c ON c.chat_id = m.chat_id
      LEFT JOIN linear_comments lc
             ON lc.chat_id = m.chat_id AND lc.message_id = m.message_id
     WHERE lc.comment_id IS NULL
     ORDER BY m.date ASC, m.message_id ASC
     ${limit == null ? "" : "LIMIT " + limit}`;
  return db.prepare(sql).all() as PendingRow[];
}

function chatTitle(m: PendingRow): string {
  const name = displayName({
    title: m.chat_title,
    first_name: m.chat_first_name,
    last_name: m.chat_last_name,
    username: m.chat_username,
  });
  // Joined explicitly: env parsers strip a trailing space off the prefix.
  return [TITLE_PREFIX, name].filter(Boolean).join(" ");
}

async function ensureIssue(
  db: Database.Database,
  linear: LinearClient,
  teamId: string,
  m: PendingRow
): Promise<string> {
  const known = db
    .prepare("SELECT issue_id FROM linear_chats WHERE chat_id = ?")
    .get(m.chat_id) as { issue_id: string } | undefined;
  if (known) return known.issue_id;

  const title = chatTitle(m);

  // Look before creating: if the local mapping was lost but the issue exists,
  // reusing it beats making a duplicate.
  let issue = await linear.findIssueByTitle(teamId, title);
  if (issue) {
    log(`reusing existing issue ${issue.identifier} for chat_id=${m.chat_id}`);
  } else {
    const handle = m.chat_username ? `@${m.chat_username}` : "no username";
    issue = await linear.createIssue(
      teamId,
      title,
      `Telegram Business conversation.\n\n` +
        `- chat_id: \`${m.chat_id}\`\n- username: ${handle}\n\n` +
        `Messages are mirrored as comments, oldest first. ` +
        `The source of truth is the SQLite archive on the server; this issue is a read-only view.`
    );
    log(`created issue ${issue.identifier} "${title}" for chat_id=${m.chat_id}`);
  }

  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO linear_chats (chat_id, issue_id, issue_identifier, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       issue_id = excluded.issue_id, issue_identifier = excluded.issue_identifier,
       title = excluded.title, updated_at = excluded.updated_at`
  ).run(m.chat_id, issue.id, issue.identifier, title, now, now);

  return issue.id;
}

async function syncPass(db: Database.Database, linear: LinearClient, teamId: string): Promise<number> {
  const rows = pending(db, BACKFILL ? null : BATCH);
  if (rows.length === 0) return 0;

  const record = db.prepare(
    `INSERT INTO linear_comments (chat_id, message_id, comment_id, synced_at, transcript_synced)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO NOTHING`
  );

  let done = 0;
  for (const m of rows) {
    if (DRY_RUN) {
      console.log(`${chatTitle(m)}  ${commentBody(m)}`);
      done++;
      continue;
    }
    try {
      const issueId = await ensureIssue(db, linear, teamId, m);
      const assetUrl = await ensureAsset(db, linear, m);
      const commentId = await linear.createComment(issueId, commentBody(m, assetUrl));
      record.run(m.chat_id, m.message_id, commentId, Math.floor(Date.now() / 1000), m.transcript ? 1 : 0);
      done++;
    } catch (err) {
      const e = err as LinearError;
      if (e.retryable) {
        log(`transient Linear error, pausing this pass: ${e.message}`);
        break; // unsynced rows stay pending, next pass retries them
      }
      // A permanent error on one message must not wedge the whole queue,
      // but it also must not be silently dropped.
      log(`PERMANENT error on chat_id=${m.chat_id} message_id=${m.message_id}: ${e.message}`);
      break;
    }
  }
  return done;
}

/**
 * Photos mirrored before uploading was switched on are still just "<photo>".
 * This uploads them and rewrites those comments to carry the actual picture.
 */
async function backfillPhotos(db: Database.Database, linear: LinearClient): Promise<number> {
  if (!MIRROR_PHOTOS || !ALLOW_MEDIA) return 0;

  const rows = db
    .prepare(
      `SELECT lc.comment_id, m.chat_id, m.message_id, m.date, m.outgoing, m.content_type,
              m.text, m.caption, m.transcript, m.message_thread_id, m.topic_name,
              m.is_deleted, m.edit_date,
              c.title AS chat_title, c.first_name AS chat_first_name,
              c.last_name AS chat_last_name, c.username AS chat_username
         FROM linear_comments lc
         JOIN messages m ON m.chat_id = lc.chat_id AND m.message_id = lc.message_id
         JOIN chats c ON c.chat_id = m.chat_id
         LEFT JOIN linear_assets a ON a.chat_id = m.chat_id AND a.message_id = m.message_id
        WHERE m.content_type = 'photo' AND a.asset_url IS NULL
        LIMIT 20`
    )
    .all() as (PendingRow & { comment_id: string })[];

  let n = 0;
  for (const r of rows) {
    const url = await ensureAsset(db, linear, r);
    if (!url) continue; // already logged; do not rewrite with nothing to show
    try {
      await linear.updateComment(r.comment_id, commentBody(r, url));
      n++;
    } catch (err) {
      log(`could not attach photo to comment for #${r.message_id}: ${(err as Error).message}`);
      break;
    }
  }
  return n;
}

/**
 * Transcription finishes well after the comment is posted, so comments written
 * before their transcript existed are rewritten once it does.
 */
async function syncTranscripts(db: Database.Database, linear: LinearClient): Promise<number> {
  const rows = db
    .prepare(
      `SELECT lc.comment_id, m.chat_id, m.message_id, m.date, m.outgoing, m.content_type,
              m.text, m.caption, m.transcript, m.message_thread_id, m.topic_name,
              m.is_deleted, m.edit_date,
              c.title AS chat_title, c.first_name AS chat_first_name,
              c.last_name AS chat_last_name, c.username AS chat_username
         FROM linear_comments lc
         JOIN messages m ON m.chat_id = lc.chat_id AND m.message_id = lc.message_id
         JOIN chats c ON c.chat_id = m.chat_id
        WHERE lc.transcript_synced = 0 AND m.transcript IS NOT NULL
        LIMIT 50`
    )
    .all() as (PendingRow & { comment_id: string })[];

  let n = 0;
  for (const r of rows) {
    if (DRY_RUN) {
      console.log(`UPDATE ${r.comment_id}  ${commentBody(r)}`);
      n++;
      continue;
    }
    try {
      await linear.updateComment(r.comment_id, commentBody(r));
      db.prepare(
        "UPDATE linear_comments SET transcript_synced = 1 WHERE chat_id = ? AND message_id = ?"
      ).run(r.chat_id, r.message_id);
      n++;
    } catch (err) {
      log(`could not update comment for #${r.message_id}: ${(err as LinearError).message}`);
      break;
    }
  }
  return n;
}

/**
 * The other direction: a comment written in Linear becomes a real Telegram
 * message. Only comments that start with SEND_PREFIX, and only inside issues
 * this sync created, so ordinary notes stay ordinary notes.
 *
 * A request is recorded before it can be retried, and the cursor advances past
 * failures too: re-delivering a message nobody meant to send twice is worse
 * than reporting the failure in the thread.
 */
async function pollOutbox(db: Database.Database, linear: LinearClient): Promise<number> {
  if (!ALLOW_SEND) return 0;

  // First run starts at "now": historical comments were never send requests.
  let cursor = getState(db, OUTBOX_CURSOR);
  if (!cursor) {
    cursor = new Date().toISOString();
    setState(db, OUTBOX_CURSOR, cursor);
    log(`outbox cursor initialised at ${cursor}; earlier comments are ignored`);
    return 0;
  }

  // Re-scan a short window behind the cursor. Linear can index two comments
  // written a second apart in the other order, and advancing straight to the
  // newest would skip the laggard forever. Rescanning is free: a request that
  // already went out is caught by linear_outbox, and a plain note is simply
  // skipped again.
  const from = new Date(Date.parse(cursor) - OUTBOX_OVERLAP_MS).toISOString();
  const comments = await linear.commentsSince(from, 100);
  if (comments.length === 0) return 0;

  const issueToChat = new Map<string, number>(
    (db.prepare("SELECT issue_id, chat_id FROM linear_chats").all() as
      { issue_id: string; chat_id: number }[]).map((r) => [r.issue_id, r.chat_id])
  );
  const seen = db.prepare("SELECT 1 FROM linear_outbox WHERE comment_id = ?");
  const remember = db.prepare(
    `INSERT INTO linear_outbox (comment_id, issue_id, chat_id, message_id, status, detail, body, created_at)
     VALUES (@comment_id, @issue_id, @chat_id, @message_id, @status, @detail, @body, @created_at)
     ON CONFLICT(comment_id) DO NOTHING`
  );

  let sent = 0;
  for (const c of comments) {
    cursor = c.createdAt > cursor ? c.createdAt : cursor;

    const body = (c.body ?? "").trim();
    const text = sendRequestText(body);
    if (text === null) continue;                            // an ordinary note
    if (!c.issue || !issueToChat.has(c.issue.id)) continue; // not one of ours
    if (seen.get(c.id)) continue;                           // already handled

    const chatId = issueToChat.get(c.issue.id)!;
    const base = {
      comment_id: c.id,
      issue_id: c.issue.id,
      chat_id: chatId,
      body: text,
      created_at: Math.floor(Date.now() / 1000),
    };

    if (!text) {
      remember.run({ ...base, message_id: null, status: "ignored", detail: "empty after the prefix" });
      continue;
    }

    try {
      const res = (await sendMessage(db, chatId, text)) as { message_id: number };
      remember.run({ ...base, message_id: res.message_id, status: "sent", detail: null });

      // Claim the mirror slot for the message we just sent, so the forward pass
      // does not add a second comment for it when it lands in the archive.
      db.prepare(
        `INSERT INTO linear_comments (chat_id, message_id, comment_id, synced_at, transcript_synced)
         VALUES (?, ?, ?, ?, 1) ON CONFLICT(chat_id, message_id) DO NOTHING`
      ).run(chatId, res.message_id, c.id, Math.floor(Date.now() / 1000));

      // Rewrite the request so the thread reads like the rest of the history.
      const when = stamp.format(new Date());
      await linear.updateComment(c.id, `[${when} OUT #${res.message_id}] ${text}`);

      log(`sent from Linear comment ${c.id} -> chat_id=${chatId} message_id=${res.message_id}`);
      sent++;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 300);
      remember.run({ ...base, message_id: null, status: "error", detail: msg });
      log(`outbox FAILED for comment ${c.id}: ${msg}`);
      // Say so in the thread rather than failing silently.
      await linear
        .updateComment(c.id, `${body}\n\n⚠️ not delivered: ${msg}`)
        .catch(() => {});
    }
  }

  setState(db, OUTBOX_CURSOR, cursor);
  return sent;
}

async function main(): Promise<void> {
  const db = openDb();
  migrate(db);

  const total = db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number };
  const unsynced = pending(db, null).length;
  log(`archive: ${total.n} messages, ${unsynced} not yet mirrored to Linear`);

  if (DRY_RUN) {
    log(`--dry-run: printing what would be posted, calling nothing. timezone=${TZ}`);
    const chats = db
      .prepare("SELECT COUNT(DISTINCT chat_id) AS n FROM messages")
      .get() as { n: number };
    log(`would need ${chats.n} issue(s) and ${unsynced} comment(s)`);
    await syncPass(db, null as unknown as LinearClient, "");
    return;
  }

  if (!API_KEY) {
    console.error(
      "LINEAR_API_KEY is not set. Create a personal API key at\n" +
        "  Linear -> Settings -> Security & access -> Personal API keys\n" +
        "then add LINEAR_API_KEY and LINEAR_TEAM_KEY to the env file.\n" +
        "Run with --dry-run to preview without a key."
    );
    process.exit(1);
  }

  const linear = new LinearClient(API_KEY);
  const me = await linear.viewer();
  const teams = await linear.teams();
  log(`authenticated to Linear as ${me.name} <${me.email}>`);
  log(`teams: ${teams.map((t) => `${t.key} (${t.name})`).join(", ") || "none"}`);

  const team = TEAM_KEY
    ? teams.find((t) => t.key.toLowerCase() === TEAM_KEY.toLowerCase())
    : teams[0];
  if (!team) {
    console.error(
      `No team matching LINEAR_TEAM_KEY="${TEAM_KEY}". Available: ${teams.map((t) => t.key).join(", ")}`
    );
    process.exit(1);
  }
  log(`target team: ${team.key} (${team.name}) id=${team.id}`);

  if (CHECK) {
    log("--check passed: key works, team resolved. Nothing was written.");
    return;
  }

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received, finishing current pass`);
      stopping = true;
    });
  }

  do {
    const n = await syncPass(db, linear, team.id);
    if (n > 0) log(`mirrored ${n} message(s) to Linear`);
    const u = await syncTranscripts(db, linear);
    if (u > 0) log(`updated ${u} comment(s) with a transcript`);
    const ph = await backfillPhotos(db, linear);
    if (ph > 0) log(`attached ${ph} photo(s) to existing comments`);
    try {
      const s = await pollOutbox(db, linear);
      if (s > 0) log(`sent ${s} message(s) requested from Linear`);
    } catch (err) {
      // Never let the outbound path stall the mirror.
      log(`outbox poll failed: ${(err as Error).message}`);
    }
    if (ONCE || stopping) break;
    await sleep(POLL_SECONDS * 1000);
  } while (!stopping);

  const left = pending(db, null).length;
  log(`done. ${left} message(s) still pending`);
  db.close();
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
