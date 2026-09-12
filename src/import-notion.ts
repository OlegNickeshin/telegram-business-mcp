/**
 * Imports a Notion "Markdown & CSV" export into the knowledge base.
 *
 * A Notion export is, at bottom, just text: every page is a .md file whose
 * name ends in the page's 32-hex id, nested folders hold sub-pages, and a
 * database is a .csv plus a folder of one .md per row. So the import is a walk
 * over the .md files, one note each.
 *
 * What crosses over: title (filename with the id stripped, or the leading H1),
 * the markdown body, and internal page links rewritten to [[wikilinks]] so the
 * backlink graph survives. What does not: databases' typed columns become
 * plain tags at best, nested hierarchy flattens (this store is flat), and
 * images/attachments stay as markdown references — the bytes are not imported,
 * this is a text store.
 *
 *   node --env-file=.env dist/import-notion.js <export-dir> [--dry-run] [--tag <t>]
 */
import fs from "node:fs";
import path from "node:path";
import { openDb, migrate } from "./db.js";
import { createNote, getNote, updateNote } from "./notes.js";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const DIR = args.find((a) => !a.startsWith("--"));
const EXTRA_TAG = (() => {
  const i = args.indexOf("--tag");
  return i >= 0 ? args[i + 1] : undefined;
})();

const log = (...p: unknown[]) => console.log(new Date().toISOString(), ...p);

/** Notion appends " 1a2b3c…" — a space then 32 hex — to every name. Strip it. */
function cleanName(name: string): string {
  return name
    .replace(/\.md$/i, "")
    .replace(/\s+[0-9a-f]{32}$/i, "")
    .replace(/\s+[0-9a-f]{32}(?=\/)/gi, "")
    .trim();
}

/** All .md files under the export, recursively. */
function walkMd(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(full));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Notion links look like `[Label](Other%20Page%20<hash>.md)` for internal pages
 * and `![alt](Some%20Image.png)` for media. Turn internal page links into
 * `[[Label]]` so they resolve against imported titles; leave media as-is (the
 * file is not imported, but the reference is not lost).
 */
function rewriteBody(md: string): string {
  return md.replace(
    /(!?)\[([^\]]*)\]\(([^)]+)\)/g,
    (whole, bang: string, label: string, target: string) => {
      if (bang === "!") return whole; // image/attachment: keep the reference
      const decoded = decodeURIComponent(target);
      // An internal page link points at a local .md; external URLs are left alone.
      if (/\.md(#.*)?$/i.test(decoded) && !/^https?:\/\//i.test(decoded)) {
        const title = cleanName(path.basename(decoded));
        return label && label !== title ? `[[${title}|${label}]]` : `[[${title}]]`;
      }
      return whole;
    }
  );
}

/** Title from the first H1 if present, else the cleaned filename. */
function titleAndBody(file: string): { title: string; body: string } {
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n");
  let title = cleanName(path.basename(file));
  let body = raw;
  // Notion puts the page title as a leading "# Title"; drop it so it is not
  // duplicated once inside the body and once as the note title.
  const h1 = lines.findIndex((l) => l.startsWith("# "));
  if (h1 !== -1 && lines.slice(0, h1).every((l) => l.trim() === "")) {
    title = lines[h1].slice(2).trim() || title;
    body = lines.slice(h1 + 1).join("\n").trim();
  }
  return { title, body: rewriteBody(body) };
}

function main(): void {
  if (!DIR || !fs.existsSync(DIR)) {
    console.error("usage: node dist/import-notion.js <export-dir> [--dry-run] [--tag <t>]");
    process.exit(2);
  }

  const files = walkMd(DIR);
  log(`Notion export: ${files.length} markdown files under ${DIR}`);

  const db = openDb();
  migrate(db);

  // Titles are unique here, but a Notion export can hold two pages with the
  // same name in different folders. Keep a claimed-title set and disambiguate
  // with a numeric suffix rather than colliding.
  const claimed = new Set<string>();
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    let { title, body } = titleAndBody(file);
    if (!title) {
      skipped++;
      continue;
    }
    let unique = title;
    let n = 2;
    while (claimed.has(unique.toLowerCase())) unique = `${title} (${n++})`;
    claimed.add(unique.toLowerCase());
    title = unique;

    const tags = EXTRA_TAG ? [EXTRA_TAG] : undefined;

    if (DRY) {
      log(`  would import "${title}" (${body.length} chars)`);
      created++;
      continue;
    }

    // Upsert: re-running the import must not throw on notes already there.
    const existing = getNote(db, { title }) as { error?: string };
    if (existing && !("error" in existing && existing.error)) {
      updateNote(db, { title }, { body, tags });
      updated++;
    } else {
      createNote(db, title, body, tags);
      created++;
    }
  }

  log(
    DRY
      ? `--dry-run: ${created} notes would be imported, ${skipped} skipped. Nothing written.`
      : `imported ${created} new, updated ${updated}, skipped ${skipped}.`
  );
}

main();
