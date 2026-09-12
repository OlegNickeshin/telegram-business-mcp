/**
 * A small knowledge base — a self-hosted, Notion-shaped notes store — living in
 * the same SQLite file and served over the same MCP endpoint as the Telegram
 * archive.
 *
 * Optional, behind ALLOW_NOTES, and off by default: the published product is a
 * Telegram connector, and a personal notes store is an extra a given deployment
 * turns on. Same switch discipline as ALLOW_SEND.
 *
 * Read-write on purpose, unlike the archive. A knowledge base the model can read
 * but not add to is half a tool — the whole point is "remember this" and "what
 * did I note about X". Delete is the one destructive operation and is annotated
 * as such.
 *
 * Its own tables (kb_*) and its own FTS whose triggers use only built-in SQL, so
 * nothing here depends on the application-defined functions the messages FTS
 * needs — the notes schema stays writable by any process that opens the file.
 */
import type Database from "better-sqlite3";

export const ALLOW_NOTES = (process.env.ALLOW_NOTES ?? "0") === "1";

const now = () => Math.floor(Date.now() / 1000);

export function migrateNotes(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      title_lc   TEXT NOT NULL UNIQUE,   -- lowercased: case-insensitive lookup and wikilink resolution
      body       TEXT NOT NULL DEFAULT '',
      tags       TEXT NOT NULL DEFAULT '',  -- ' a b c ', space-wrapped for LIKE '% x %'
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kb_notes_updated ON kb_notes (updated_at DESC);

    -- [[Title]] references, so "what links here" works like a wiki.
    CREATE TABLE IF NOT EXISTS kb_links (
      from_id     INTEGER NOT NULL,
      to_title_lc TEXT    NOT NULL,
      PRIMARY KEY (from_id, to_title_lc)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS kb_notes_fts USING fts5(
      title, body, tags,
      content='kb_notes', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2'
    );

    -- Recreated each start; built-in SQL only, no fts_body dependency.
    DROP TRIGGER IF EXISTS kb_notes_ai;
    DROP TRIGGER IF EXISTS kb_notes_ad;
    DROP TRIGGER IF EXISTS kb_notes_au;
    CREATE TRIGGER kb_notes_ai AFTER INSERT ON kb_notes BEGIN
      INSERT INTO kb_notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
    END;
    CREATE TRIGGER kb_notes_ad AFTER DELETE ON kb_notes BEGIN
      INSERT INTO kb_notes_fts(kb_notes_fts, rowid, title, body, tags)
      VALUES ('delete', old.id, old.title, old.body, old.tags);
    END;
    CREATE TRIGGER kb_notes_au AFTER UPDATE ON kb_notes BEGIN
      INSERT INTO kb_notes_fts(kb_notes_fts, rowid, title, body, tags)
      VALUES ('delete', old.id, old.title, old.body, old.tags);
      INSERT INTO kb_notes_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
    END;
  `);
}

// ---------------------------------------------------------------- helpers

interface NoteRow {
  id: number;
  title: string;
  title_lc: string;
  body: string;
  tags: string;
  created_at: number;
  updated_at: number;
}

/** Tags in as an array or a "a, b c" string; out as a clean lowercased list. */
function normalizeTags(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input.map(String)
    : String(input ?? "").split(/[,\s]+/);
  const seen = new Set<string>();
  for (const t of raw) {
    const tag = t.trim().replace(/^#/, "").toLowerCase();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/** Stored space-wrapped so `tags LIKE '% work %'` is an exact-tag match. */
const packTags = (tags: string[]) => (tags.length ? ` ${tags.join(" ")} ` : "");
const unpackTags = (packed: string) => packed.trim().split(/\s+/).filter(Boolean);

/** [[Wiki Links]] in the body → the titles they point at. */
function extractLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const t = m[1].trim();
    if (t) out.add(t.toLowerCase());
  }
  return [...out];
}

function rewriteLinks(db: Database.Database, id: number, body: string): void {
  db.prepare("DELETE FROM kb_links WHERE from_id = ?").run(id);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO kb_links (from_id, to_title_lc) VALUES (?, ?)"
  );
  for (const target of extractLinks(body)) ins.run(id, target);
}

function findRow(db: Database.Database, ref: { id?: number; title?: string }): NoteRow | undefined {
  if (ref.id != null) {
    return db.prepare("SELECT * FROM kb_notes WHERE id = ?").get(ref.id) as NoteRow | undefined;
  }
  if (ref.title != null) {
    return db
      .prepare("SELECT * FROM kb_notes WHERE title_lc = ?")
      .get(ref.title.trim().toLowerCase()) as NoteRow | undefined;
  }
  return undefined;
}

const iso = (t: number) => new Date(t * 1000).toISOString();

function noteOut(db: Database.Database, r: NoteRow, withBody = true) {
  const base = {
    id: r.id,
    title: r.title,
    tags: unpackTags(r.tags),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
  if (!withBody) return base;
  // Outgoing links, split into resolved (a note exists) and dangling.
  const targets = db
    .prepare("SELECT to_title_lc FROM kb_links WHERE from_id = ?")
    .all(r.id) as { to_title_lc: string }[];
  const links = targets.map((t) => {
    const hit = db
      .prepare("SELECT id, title FROM kb_notes WHERE title_lc = ?")
      .get(t.to_title_lc) as { id: number; title: string } | undefined;
    return hit ? { title: hit.title, id: hit.id } : { title: t.to_title_lc, id: null };
  });
  // Backlinks: notes whose body links to this one by title.
  const back = db
    .prepare(
      `SELECT n.id, n.title FROM kb_links l JOIN kb_notes n ON n.id = l.from_id
        WHERE l.to_title_lc = ? ORDER BY n.updated_at DESC`
    )
    .all(r.title_lc) as { id: number; title: string }[];
  return { ...base, body: r.body, links, backlinks: back };
}

// ---------------------------------------------------------------- operations

export function createNote(
  db: Database.Database,
  title: string,
  body = "",
  tags?: unknown
): unknown {
  const t = title.trim();
  if (!t) throw new Error("title is required");
  const title_lc = t.toLowerCase();
  const exists = db.prepare("SELECT id FROM kb_notes WHERE title_lc = ?").get(title_lc) as
    | { id: number }
    | undefined;
  if (exists) {
    throw new Error(
      `a note titled "${t}" already exists (id ${exists.id}). Use kb_update_note to change it.`
    );
  }
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO kb_notes (title, title_lc, body, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(t, title_lc, body ?? "", packTags(normalizeTags(tags)), ts, ts);
  const id = Number(info.lastInsertRowid);
  rewriteLinks(db, id, body ?? "");
  return noteOut(db, findRow(db, { id })!);
}

export function updateNote(
  db: Database.Database,
  ref: { id?: number; title?: string },
  changes: { title?: string; body?: string; tags?: unknown; append?: boolean }
): unknown {
  const row = findRow(db, ref);
  if (!row) throw new Error("no such note");

  let title = row.title;
  let title_lc = row.title_lc;
  if (changes.title != null && changes.title.trim() && changes.title.trim() !== row.title) {
    title = changes.title.trim();
    title_lc = title.toLowerCase();
    const clash = db.prepare("SELECT id FROM kb_notes WHERE title_lc = ? AND id <> ?").get(title_lc, row.id);
    if (clash) throw new Error(`another note is already titled "${title}"`);
  }

  let body = row.body;
  if (changes.body != null) {
    // append is the "add to my notes" path: keep what's there, add below.
    body = changes.append ? `${row.body}\n\n${changes.body}`.trim() : changes.body;
  }

  const tags = changes.tags !== undefined ? packTags(normalizeTags(changes.tags)) : row.tags;

  db.prepare(
    `UPDATE kb_notes SET title = ?, title_lc = ?, body = ?, tags = ?, updated_at = ? WHERE id = ?`
  ).run(title, title_lc, body, tags, now(), row.id);
  rewriteLinks(db, row.id, body);
  return noteOut(db, findRow(db, { id: row.id })!);
}

export function getNote(db: Database.Database, ref: { id?: number; title?: string }): unknown {
  const row = findRow(db, ref);
  if (!row) return { error: "no such note" };
  return noteOut(db, row);
}

export function listNotes(db: Database.Database, tag: string | undefined, limit: number): unknown {
  const rows = tag
    ? (db
        .prepare(
          "SELECT * FROM kb_notes WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT ?"
        )
        .all(`% ${tag.trim().toLowerCase()} %`, limit) as NoteRow[])
    : (db.prepare("SELECT * FROM kb_notes ORDER BY updated_at DESC LIMIT ?").all(limit) as NoteRow[]);
  return { count: rows.length, notes: rows.map((r) => noteOut(db, r, false)) };
}

export function searchNotes(
  db: Database.Database,
  query: string,
  tag: string | undefined,
  limit: number
): unknown {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return listNotes(db, tag, limit);
  const match = words
    .map((w, i) => `"${w.replace(/"/g, '""')}"` + (i === words.length - 1 ? "*" : ""))
    .join(" ");
  const rows = db
    .prepare(
      `SELECT n.* FROM kb_notes_fts f JOIN kb_notes n ON n.id = f.rowid
        WHERE kb_notes_fts MATCH @match
          AND (@tag IS NULL OR n.tags LIKE @taglike)
        ORDER BY rank LIMIT @limit`
    )
    .all({
      match,
      tag: tag ?? null,
      taglike: tag ? `% ${tag.trim().toLowerCase()} %` : null,
      limit,
    }) as NoteRow[];
  return { query, count: rows.length, notes: rows.map((r) => noteOut(db, r, false)) };
}

export function deleteNote(db: Database.Database, ref: { id?: number; title?: string }): unknown {
  const row = findRow(db, ref);
  if (!row) throw new Error("no such note");
  db.prepare("DELETE FROM kb_links WHERE from_id = ?").run(row.id);
  db.prepare("DELETE FROM kb_notes WHERE id = ?").run(row.id);
  return { deleted: true, id: row.id, title: row.title };
}
