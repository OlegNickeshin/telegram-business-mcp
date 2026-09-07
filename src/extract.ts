/**
 * Turns an attachment into text a model can actually read.
 *
 * A link is useless to ChatGPT — it does not fetch URLs that come out of a
 * tool — so "here is your spreadsheet" has to mean the cells, not an address.
 * Everything here runs on the bytes we already downloaded and adds no runtime
 * dependency: xlsx and docx are ZIP containers of XML, and `zlib` is built in.
 *
 * PDF is the exception. Extracting text from one means parsing content streams,
 * font maps and encodings; that is a library, not a helper. `pdftotext` from
 * poppler-utils is used when present and reported as missing when not.
 */
import { execFileSync } from "node:child_process";
import { inflateRawSync } from "node:zlib";

/**
 * Text budget for one file. A 900-row spreadsheet is roughly 200k characters,
 * which is ~50k tokens dropped into the conversation by a single tool call —
 * enough to crowd out everything else. Default to a readable slice and let a
 * caller that genuinely needs the whole thing ask for it.
 */
const DEFAULT_MAX_TEXT = Number(process.env.EXTRACT_MAX_CHARS ?? 60_000);
/** Ceiling on what a caller may ask for, whatever it passes. */
export const HARD_MAX_TEXT = Number(process.env.EXTRACT_HARD_MAX_CHARS ?? 400_000);
/** Downloading 20 MB to read three cells is not worth it. */
export const EXTRACT_MAX_BYTES = Number(process.env.EXTRACT_MAX_BYTES ?? 12_000_000);

export interface Extracted {
  text: string;
  engine: string;
  truncated: boolean;
  /** 1-based line range actually returned, and the document's total. */
  from_line: number;
  to_line: number;
  total_lines: number;
}

// ---------------------------------------------------------------- zip reader

/**
 * Minimal ZIP reader: enough for the Office formats, which use stored or
 * deflated entries and a normal central directory.
 *
 * Sizes come from the central directory rather than the local header on
 * purpose — a streamed entry writes zeros there and puts the real values in a
 * trailing data descriptor.
 */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // The EOCD sits at the end, behind a comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 65_557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip file");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localAt) !== 0x04034b50) continue;
    const dataAt =
      localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compressed);
    try {
      out.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    } catch {
      // A single unreadable entry should not lose the rest of the document.
    }
  }
  return out;
}

// ---------------------------------------------------------------- xml helpers

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** Concatenates every <t> in a fragment — a run of styled text is still one string. */
function textNodes(xml: string): string {
  const parts: string[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) {
    parts.push(decodeXml(m[1]));
  }
  return parts.join("");
}

const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

// ---------------------------------------------------------------- xlsx

/** "BC" -> 54. Needed to put blank cells back where they belong. */
function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/**
 * Which cell styles mean "this number is a date".
 *
 * Without this a deadline reads as 46023, which is worse than useless in a
 * table that is entirely about dates. Literals and locale prefixes are stripped
 * before looking for date letters so that a currency format like `#,##0.00 ₽`
 * is not mistaken for one.
 */
function dateStyles(styles: Buffer | undefined): Set<number> {
  const out = new Set<number>();
  if (!styles) return out;
  const xml = styles.toString("utf8");

  const custom = new Map<number, string>();
  for (const m of xml.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(attr(m[1], "numFmtId"));
    const code = attr(m[1], "formatCode");
    if (Number.isFinite(id) && code) custom.set(id, decodeXml(code));
  }

  const isDate = (id: number): boolean => {
    if (BUILTIN_DATE_FMTS.has(id)) return true;
    const code = custom.get(id);
    if (!code) return false;
    const bare = code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "").replace(/\\./g, "");
    return /[dy]/i.test(bare) || /h/i.test(bare);
  };

  // cellXfs is positional: the s="N" on a cell indexes into it.
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  let i = 0;
  for (const m of cellXfs.matchAll(/<xf\b([^>]*?)\/?>/g)) {
    const id = Number(attr(m[1], "numFmtId") ?? "0");
    if (Number.isFinite(id) && isDate(id)) out.add(i);
    i++;
  }
  return out;
}

/** Excel counts days from 1899-12-30, keeping Lotus's phantom 1900 leap day. */
function serialToDate(v: number): string {
  const ms = Math.round((v - 25569) * 86_400_000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(v);
  const iso = d.toISOString();
  // A whole number is a date; a fraction carries a time worth keeping.
  return Number.isInteger(v) ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

function xlsxToText(buf: Buffer): string {
  const zip = unzip(buf);

  const shared: string[] = [];
  const ss = zip.get("xl/sharedStrings.xml")?.toString("utf8");
  if (ss) {
    for (const m of ss.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) shared.push(textNodes(m[1]));
  }
  const dates = dateStyles(zip.get("xl/styles.xml"));

  // Sheet order and names live in workbook.xml; the file each one is in comes
  // from the rels. Fall back to whatever sheet files exist if that is missing.
  const wb = zip.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = zip.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)>/g)) {
    const id = attr(m[1], "Id");
    const t = attr(m[1], "Target");
    if (id && t) target.set(id, t.replace(/^\/?xl\//, "").replace(/^\.\//, ""));
  }

  const sheets: { name: string; path: string }[] = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(attr(m[1], "name") ?? `Sheet${sheets.length + 1}`);
    const rid = attr(m[1], "r:id") ?? attr(m[1], "id");
    const path = rid && target.get(rid);
    if (path) sheets.push({ name, path: `xl/${path}` });
  }
  if (!sheets.length) {
    for (const key of zip.keys()) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(key)) sheets.push({ name: key, path: key });
    }
  }

  const out: string[] = [];

  for (const sheet of sheets) {
    const xml = zip.get(sheet.path)?.toString("utf8");
    if (!xml) continue;

    const rows: string[] = [];
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const tag = cm[1];
        const body = cm[2] ?? "";
        const type = attr(tag, "t");
        const ref = attr(tag, "r");
        let value = "";

        if (type === "s") {
          const idx = Number(body.match(/<v>([\s\S]*?)<\/v>/)?.[1]);
          value = shared[idx] ?? "";
        } else if (type === "inlineStr") {
          value = textNodes(body);
        } else if (type === "str") {
          value = decodeXml(body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "");
        } else if (type === "b") {
          value = body.includes("<v>1</v>") ? "TRUE" : "FALSE";
        } else {
          const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          if (raw != null) {
            const num = Number(raw);
            const style = Number(attr(tag, "s") ?? "-1");
            value =
              Number.isFinite(num) && num > 0 && dates.has(style) ? serialToDate(num) : raw;
          }
        }

        // Pad the gaps so columns still line up after an empty cell.
        if (ref) {
          const at = colIndex(ref);
          while (cells.length < at) cells.push("");
          cells[at] = value;
        } else {
          cells.push(value);
        }
      }

      // Tabs and newlines inside a cell would break the row apart.
      const line = cells.map((c) => c.replace(/[\t\r\n]+/g, " ").trim()).join("\t").replace(/\t+$/, "");
      if (line.trim()) rows.push(line);
    }

    if (rows.length) out.push(`## ${sheet.name}\n${rows.join("\n")}`);
  }

  return out.join("\n\n");
}

// ---------------------------------------------------------------- docx

function docxToText(buf: Buffer): string {
  const zip = unzip(buf);
  const xml = zip.get("word/document.xml")?.toString("utf8");
  if (!xml) throw new Error("no word/document.xml — not a docx");

  const blocks: string[] = [];
  // A table cell is a paragraph too, so tabbing cells keeps rows readable.
  //
  // The self-closing form has to be part of the pattern: an empty `<w:p/>` has
  // no `</w:p>` of its own, so a pattern that insists on one runs forward and
  // takes the first closing tag inside the next table, after which every
  // following match is off by one element and the rows come out as loose lines.
  for (const m of xml.matchAll(/<w:(p|tr)\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:\1>)/g)) {
    const body = m[2] ?? "";
    if (m[1] === "tr") {
      const cells = [...body.matchAll(/<w:tc\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:tc>)/g)].map((c) =>
        textNodes(c[1] ?? "").replace(/\s+/g, " ").trim()
      );
      if (cells.some(Boolean)) blocks.push(cells.join("\t"));
    } else {
      const t = textNodes(body);
      if (t.trim()) blocks.push(t);
    }
  }
  return blocks.join("\n");
}

// ---------------------------------------------------------------- pdf

let pdftotext: boolean | null = null;

function havePdftotext(): boolean {
  if (pdftotext == null) {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      pdftotext = true;
    } catch {
      pdftotext = false;
    }
  }
  return pdftotext;
}

function pdfToText(buf: Buffer): string {
  if (!havePdftotext()) {
    throw new Error(
      "PDF text needs poppler-utils on the server: apt-get install -y poppler-utils"
    );
  }
  // -layout keeps columns apart, which matters for anything table-shaped.
  return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], {
    input: buf,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  }).toString("utf8");
}

// ---------------------------------------------------------------- dispatch

const PLAIN = /^text\/|^application\/(json|xml|x-yaml|yaml|csv|javascript)$/;
const PLAIN_EXT = new Set([
  "txt", "csv", "tsv", "md", "json", "xml", "yml", "yaml", "log", "srt", "vtt", "ini", "sql",
]);

/** Formats we could read if they were not the pre-2007 binary ones. */
const LEGACY: Record<string, string> = {
  doc: "old binary .doc — resave as .docx",
  xls: "old binary .xls — resave as .xlsx",
  ppt: "old binary .ppt — resave as .pptx",
};

/**
 * Best-effort text for one attachment. Returns null when the type simply has
 * no text in it (a photo, a video, an archive) and throws with something
 * actionable when the type should have worked but did not.
 */
export function extractText(
  buf: Buffer,
  mimeType: string,
  filename: string,
  maxChars?: number,
  offsetLines = 0
): Extracted | null {
  const ext = filename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "";
  const maxText = Math.min(
    Math.max(1_000, Math.trunc(maxChars ?? DEFAULT_MAX_TEXT)),
    HARD_MAX_TEXT
  );

  if (LEGACY[ext]) throw new Error(LEGACY[ext]);

  let whole: string;
  let engine: string;

  if (ext === "xlsx" || ext === "xlsm" || mimeType.includes("spreadsheetml")) {
    whole = xlsxToText(buf);
    engine = "xlsx";
  } else if (ext === "docx" || mimeType.includes("wordprocessingml")) {
    whole = docxToText(buf);
    engine = "docx";
  } else if (ext === "pdf" || mimeType === "application/pdf") {
    whole = pdfToText(buf);
    engine = "pdftotext";
  } else if (PLAIN.test(mimeType) || PLAIN_EXT.has(ext)) {
    whole = buf.toString("utf8");
    engine = "text";
  } else {
    return null;
  }

  whole = whole.replace(/\u0000/g, "").replace(/[ \t]+\n/g, "\n").trim();

  // Window on line boundaries. A spreadsheet of a few thousand rows does not
  // fit any context in one piece, and half a row of tab-separated cells is
  // unreadable — so cut between lines and say which ones these were, giving a
  // caller a way to walk the rest.
  const lines = whole.split("\n");
  const start = Math.min(Math.max(0, Math.trunc(offsetLines)), lines.length);
  const kept: string[] = [];
  let used = 0;
  for (let i = start; i < lines.length; i++) {
    const cost = lines[i].length + 1;
    // Always take one line, or a single over-long line would return nothing.
    if (used + cost > maxText && kept.length) break;
    kept.push(lines[i]);
    used += cost;
  }

  const to = start + kept.length;
  return {
    text: kept.join("\n"),
    engine,
    truncated: to < lines.length || start > 0,
    from_line: start + 1,
    to_line: to,
    total_lines: lines.length,
  };
}

/** Whether a download is worth doing at all, before spending the bandwidth. */
export function isExtractable(mimeType: string, filename: string): boolean {
  const ext = filename.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase() ?? "";
  if (LEGACY[ext]) return true; // so the caller can report why it failed
  return (
    ["xlsx", "xlsm", "docx", "pdf"].includes(ext) ||
    PLAIN_EXT.has(ext) ||
    PLAIN.test(mimeType) ||
    mimeType.includes("spreadsheetml") ||
    mimeType.includes("wordprocessingml") ||
    mimeType === "application/pdf"
  );
}
