/**
 * Transcribes voice, video notes, audio and video from the archive with a
 * local whisper.cpp. Nothing leaves the server.
 *
 *   node --env-file=.env dist/transcribe.js           # daemon
 *   node --env-file=.env dist/transcribe.js --once    # drain the queue, exit
 *   node --env-file=.env dist/transcribe.js --retry   # re-queue previous errors
 *
 * Media files are deleted as soon as the text is stored: the transcript is what
 * we need, and the VPS has little disk. Telegram keeps the file reachable by
 * file_id if it is ever needed again.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { migrate, openDb } from "./db.js";

const run = promisify(execFile);

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const WHISPER_BIN = process.env.WHISPER_BIN ?? "/opt/whisper.cpp/build/bin/whisper-cli";
const WHISPER_MODEL = process.env.WHISPER_MODEL ?? "/opt/whisper.cpp/models/ggml-small.bin";
const WHISPER_LANG = process.env.WHISPER_LANG ?? "auto";
const WHISPER_THREADS = process.env.WHISPER_THREADS ?? "2";
const POLL_SECONDS = Number(process.env.TRANSCRIBE_POLL_SECONDS ?? 30);
/** Bot API refuses to hand over files larger than this. */
const TELEGRAM_MAX_BYTES = 20 * 1024 * 1024;

const args = new Set(process.argv.slice(2));
const ONCE = args.has("--once");
const RETRY = args.has("--retry");

const log = (...p: unknown[]) => console.log(new Date().toISOString(), ...p);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Which message types go through whisper. Voice only by default: video on this
 * two-core box takes minutes per clip and is rarely worth it. Widen with
 * TRANSCRIBE_TYPES=voice,video_note,audio,video if that changes.
 */
const AUDIO_TYPES = (process.env.TRANSCRIBE_TYPES ?? "voice")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Media we can carry a file_id for, whether or not we transcribe it. */
const MEDIA_KEYS = ["voice", "video_note", "audio", "video"] as const;

interface Job {
  id: number;
  chat_id: number;
  message_id: number;
  content_type: string;
  raw: string;
}

const PARKED = "type not in TRANSCRIBE_TYPES";

/**
 * Keeps the queue in step with TRANSCRIBE_TYPES in both directions: types no
 * longer wanted are parked so they stop being scanned, and types that were
 * parked but are wanted again come back.
 *
 * The second half matters because widening the list is the normal way to add a
 * media type, and without it everything already parked would stay invisible —
 * the setting would appear to work while quietly ignoring the backlog.
 */
function syncQueueWithTypes(db: Database.Database): { parked: number; revived: number } {
  const wanted = AUDIO_TYPES.map((t) => `'${t}'`).join(",");
  const parked = db
    .prepare(
      `UPDATE messages SET media_status = 'skipped', media_error = ?
        WHERE content_type IN ('voice','video_note','audio','video')
          AND content_type NOT IN (${wanted})
          AND transcript IS NULL
          AND (media_status IS NULL OR media_status = 'pending')`
    )
    .run(PARKED).changes;

  // Only rows parked for this reason: a genuine error or an oversized file
  // must stay where it is.
  const revived = db
    .prepare(
      `UPDATE messages SET media_status = 'pending', media_error = NULL
        WHERE content_type IN (${wanted})
          AND transcript IS NULL
          AND media_status = 'skipped'
          AND media_error = ?`
    )
    .run(PARKED).changes;

  return { parked, revived };
}

function queue(db: Database.Database, limit = 20): Job[] {
  const types = AUDIO_TYPES.map((t) => `'${t}'`).join(",");
  return db
    .prepare(
      `SELECT id, chat_id, message_id, content_type, raw
         FROM messages
        WHERE content_type IN (${types})
          AND transcript IS NULL
          AND (media_status IS NULL OR media_status = 'pending')
        ORDER BY date ASC
        LIMIT ?`
    )
    .all(limit) as Job[];
}

/** Pulls the file_id and size out of whichever media field this message carries. */
function mediaRef(
  job: Job
): { fileId: string; uniqueId: string | null; size: number | null } | null {
  const m = JSON.parse(job.raw) as Record<
    string,
    { file_id?: string; file_unique_id?: string; file_size?: number }
  >;
  for (const key of MEDIA_KEYS) {
    const v = m[key];
    if (v?.file_id) {
      return {
        fileId: v.file_id,
        uniqueId: v.file_unique_id ?? null,
        size: v.file_size ?? null,
      };
    }
  }
  return null;
}

async function tg<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) throw new Error(`${method}: ${body.description ?? "unknown error"}`);
  return body.result as T;
}

function mark(
  db: Database.Database,
  id: number,
  status: string,
  error: string | null = null
): void {
  db.prepare("UPDATE messages SET media_status = ?, media_error = ? WHERE id = ?")
    .run(status, error, id);
}

function store(
  db: Database.Database,
  id: number,
  text: string,
  engine: string
): void {
  db.prepare(
    `UPDATE messages
        SET transcript = ?, transcript_at = ?, transcript_engine = ?,
            media_status = 'done', media_error = NULL
      WHERE id = ?`
  ).run(text, Math.floor(Date.now() / 1000), engine, id);
}

/**
 * The same file forwarded or resent arrives as several messages with distinct
 * file_ids but one file_unique_id. Transcribing it once per copy is pure waste —
 * a minute of video costs about a minute of CPU here.
 */
function cachedTranscript(
  db: Database.Database,
  uniqueId: string | null
): { transcript: string; engine: string } | null {
  if (!uniqueId) return null;
  return (
    (db
      .prepare("SELECT transcript, engine FROM media_transcripts WHERE file_unique_id = ?")
      .get(uniqueId) as { transcript: string; engine: string } | undefined) ?? null
  );
}

/**
 * Seeds the cache from transcripts produced before it existed, so an archive
 * that already holds work benefits on the first run rather than the second.
 */
function backfillCache(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT m.raw, m.transcript, m.transcript_engine AS engine
         FROM messages m
        WHERE m.transcript IS NOT NULL AND m.content_type <> 'text'`
    )
    .all() as { raw: string; transcript: string; engine: string | null }[];

  let n = 0;
  const insert = db.prepare(
    `INSERT INTO media_transcripts (file_unique_id, transcript, engine, created_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(file_unique_id) DO NOTHING`
  );
  const now = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    let unique: string | null = null;
    try {
      const m = JSON.parse(r.raw) as Record<string, { file_unique_id?: string }>;
      for (const key of MEDIA_KEYS) {
        if (m[key]?.file_unique_id) { unique = m[key]!.file_unique_id!; break; }
      }
    } catch {
      continue; // an unparseable payload is not worth failing startup over
    }
    if (unique) n += insert.run(unique, r.transcript, r.engine, now).changes;
  }
  return n;
}

function cacheTranscript(
  db: Database.Database,
  uniqueId: string | null,
  text: string,
  engine: string
): void {
  if (!uniqueId) return;
  db.prepare(
    `INSERT INTO media_transcripts (file_unique_id, transcript, engine, created_at)
     VALUES (?, ?, ?, ?) ON CONFLICT(file_unique_id) DO NOTHING`
  ).run(uniqueId, text, engine, Math.floor(Date.now() / 1000));
}

async function transcribeOne(db: Database.Database, job: Job): Promise<boolean> {
  const ref = mediaRef(job);
  if (!ref) {
    mark(db, job.id, "skipped", "no file_id in the update");
    return false;
  }
  if (ref.size != null && ref.size > TELEGRAM_MAX_BYTES) {
    mark(db, job.id, "skipped", `file is ${(ref.size / 1e6).toFixed(1)}MB, over the Bot API 20MB limit`);
    log(`#${job.message_id} ${job.content_type}: skipped, ${(ref.size / 1e6).toFixed(1)}MB > 20MB`);
    return false;
  }

  const cached = cachedTranscript(db, ref.uniqueId);
  if (cached) {
    store(db, job.id, cached.transcript, cached.engine);
    log(`#${job.message_id} ${job.content_type}: reused a transcript of the same file`);
    return true;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tgbiz-"));
  try {
    const file = await tg<{ file_path: string; file_size?: number }>("getFile", {
      file_id: ref.fileId,
    });
    const dl = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!dl.ok) throw new Error(`download returned HTTP ${dl.status}`);
    const media = path.join(dir, path.basename(file.file_path));
    await fs.writeFile(media, Buffer.from(await dl.arrayBuffer()));

    // whisper.cpp wants 16 kHz mono PCM; ffmpeg also strips the video track.
    const wav = path.join(dir, "audio.wav");
    await run("ffmpeg", ["-nostdin", "-y", "-i", media, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
      { timeout: 300_000, maxBuffer: 8 << 20 });

    const outPrefix = path.join(dir, "out");
    const started = Date.now();
    await run(
      WHISPER_BIN,
      ["-m", WHISPER_MODEL, "-f", wav, "-l", WHISPER_LANG, "-t", WHISPER_THREADS,
       "--no-timestamps", "-otxt", "-of", outPrefix],
      { timeout: 1_800_000, maxBuffer: 32 << 20 }
    );
    const text = (await fs.readFile(`${outPrefix}.txt`, "utf8")).trim();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (!text) {
      mark(db, job.id, "done", "whisper produced no text (silence?)");
      log(`#${job.message_id} ${job.content_type}: empty transcript after ${seconds}s`);
      return false;
    }

    const engine = `whisper.cpp ${path.basename(WHISPER_MODEL)}`;
    store(db, job.id, text, engine);
    cacheTranscript(db, ref.uniqueId, text, engine);

    log(`#${job.message_id} ${job.content_type}: ${text.length} chars in ${seconds}s — "${text.slice(0, 90).replace(/\s+/g, " ")}"`);
    return true;
  } catch (err) {
    const msg = (err as Error).message.slice(0, 400);
    mark(db, job.id, "error", msg);
    log(`#${job.message_id} ${job.content_type}: ERROR ${msg}`);
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error("TELEGRAM_BOT_TOKEN is required to download media");
    process.exit(1);
  }
  for (const p of [WHISPER_BIN, WHISPER_MODEL]) {
    try {
      await fs.access(p);
    } catch {
      console.error(`missing: ${p} — build whisper.cpp and fetch the model first (see README)`);
      process.exit(1);
    }
  }

  const db = openDb();
  migrate(db);

  if (RETRY) {
    const n = db.prepare("UPDATE messages SET media_status = 'pending' WHERE media_status = 'error'").run().changes;
    log(`re-queued ${n} previously failed item(s)`);
  }

  const { parked, revived } = syncQueueWithTypes(db);
  if (parked > 0) log(`parked ${parked} item(s) whose type is not transcribed`);
  if (revived > 0) log(`re-queued ${revived} item(s) whose type is now transcribed`);

  const seeded = backfillCache(db);
  if (seeded > 0) log(`seeded the file cache with ${seeded} existing transcript(s)`);

  const pending = queue(db, 10_000).length;
  log(`transcriber up. types=${AUDIO_TYPES.join(",")} model=${path.basename(WHISPER_MODEL)} lang=${WHISPER_LANG} threads=${WHISPER_THREADS}`);
  log(`${pending} item(s) waiting`);

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received, finishing the current item`);
      stopping = true;
    });
  }

  do {
    const jobs = queue(db);
    // One at a time on purpose: two cores, and whisper wants both.
    for (const job of jobs) {
      if (stopping) break;
      await transcribeOne(db, job);
    }
    if (ONCE || stopping) break;
    await sleep(POLL_SECONDS * 1000);
  } while (!stopping);

  db.close();
  log("stopped");
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).message}`);
  process.exit(1);
});
