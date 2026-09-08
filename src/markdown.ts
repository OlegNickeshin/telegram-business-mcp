/**
 * Converts the markdown a model writes into Telegram's HTML.
 *
 * A model asked to reply in a chat writes markdown whether or not anyone asked
 * it to, so `**жирный**` arrives at a real person as four literal asterisks.
 * Sending the text untouched was the safe default, not a correct one.
 *
 * HTML rather than MarkdownV2 deliberately: MarkdownV2 requires escaping
 * eighteen characters, and one unescaped `_` or `.` fails the whole send — a
 * message lost to formatting is worse than a message with asterisks in it.
 * Telegram's HTML mode needs exactly three characters escaped and covers every
 * construct that matters here.
 */

/** The only characters Telegram's HTML parser cares about. */
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, "&quot;");

/** Code, already converted; or prose still to be converted. */
type Segment = { code: string } | { prose: string };

/**
 * Splits code out of the text before anything else runs.
 *
 * Segments rather than placeholder tokens: a placeholder is a string that must
 * never occur in real input, and there is no such string. Splitting removes the
 * question entirely.
 */
function segment(input: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([A-Za-z0-9+#._-]*)\n?([\s\S]*?)```|`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(input)) !== null) {
    if (m.index > last) out.push({ prose: input.slice(last, m.index) });
    if (m[3] !== undefined) {
      out.push({ code: `<code>${escapeHtml(m[3])}</code>` });
    } else {
      const cls = m[1] ? ` class="language-${escapeAttr(m[1])}"` : "";
      out.push({ code: `<pre><code${cls}>${escapeHtml(m[2].replace(/\n$/, ""))}</code></pre>` });
    }
    last = re.lastIndex;
  }
  if (last < input.length) out.push({ prose: input.slice(last) });
  return out;
}

/**
 * `_italic_` is **not** handled, on purpose. Underscores inside words are
 * ordinary in filenames and identifiers — this archive is full of things like
 * `Podrobno_ISK_NE_PODAN` — and treating them as markup would mangle real text
 * far more often than it would italicise anything. Models write `*` for
 * emphasis anyway.
 */
export function toTelegramHtml(input: string): { html: string; formatted: boolean } {
  let hits = 0;
  const count = <T,>(v: T): T => (hits++, v);

  const html = segment(input)
    .map((seg) => {
      if ("code" in seg) {
        hits++;
        return seg.code;
      }
      let t = escapeHtml(seg.prose);

      // Links before emphasis, so `**[a](b)**` nests rather than interleaves.
      // The URL comes out of text that escapeHtml has already been over, so
      // only the quote still needs handling — running escapeAttr here would
      // turn a query string's &amp; into &amp;amp;.
      t = t.replace(
        /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
        (_m, label: string, url: string) =>
          count(`<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`)
      );

      // Emphasis may not open or close on whitespace — the standard markdown
      // rule, and what keeps "2 * 3 * 4" from becoming "2 <i> 3 </i> 4".
      t = t.replace(/\*\*(?!\s)([^\n]+?)(?<!\s)\*\*/g, (_m, b: string) => count(`<b>${b}</b>`));
      t = t.replace(/__(?!\s)([^\n]+?)(?<!\s)__/g, (_m, b: string) => count(`<u>${b}</u>`));
      t = t.replace(/~~(?!\s)([^\n]+?)(?<!\s)~~/g, (_m, b: string) => count(`<s>${b}</s>`));
      // Single asterisk last, and only where it is not part of a `**` pair.
      t = t.replace(
        /(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g,
        (_m, b: string) => count(`<i>${b}</i>`)
      );
      t = t.replace(
        /\|\|(?!\s)([^\n]+?)(?<!\s)\|\|/g,
        (_m, b: string) => count(`<tg-spoiler>${b}</tg-spoiler>`)
      );

      // Telegram has no headings; bold is the closest thing that survives.
      t = t.replace(/^#{1,6}[ \t]+(.+)$/gm, (_m, b: string) => count(`<b>${b}</b>`));
      // ...and no lists, so a bullet becomes a bullet character.
      t = t.replace(/^[ \t]*[-*+][ \t]+(?=\S)/gm, () => count("• "));

      // A run of quoted lines is one blockquote, not one per line. The marker
      // is already escaped to &gt; by this point.
      t = t.replace(/(?:^&gt;[ \t]?.*(?:\n|$))+/gm, (block: string) =>
        count(
          `<blockquote>${block
            .replace(/\n$/, "")
            .split("\n")
            .map((line) => line.replace(/^&gt;[ \t]?/, ""))
            .join("\n")}</blockquote>\n`
        )
      );

      return t;
    })
    .join("");

  // Nothing found: hand back the original so the caller sends it as plain text.
  // Otherwise the escaping alone would reach the reader as "&amp;".
  return hits > 0 ? { html: html.trimEnd(), formatted: true } : { html: input, formatted: false };
}

/**
 * Markdown removed rather than converted — the last resort for when Telegram
 * refuses the HTML, so that a send never fails because of formatting.
 */
export function stripMarkdown(input: string): string {
  return segment(input)
    .map((seg) =>
      "code" in seg
        ? seg.code.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
        : seg.prose
            .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
            .replace(/\*\*([^\n]+?)\*\*/g, "$1")
            .replace(/__([^\n]+?)__/g, "$1")
            .replace(/~~([^\n]+?)~~/g, "$1")
            .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "$1")
            .replace(/\|\|([^\n]+?)\|\|/g, "$1")
            .replace(/^#{1,6}[ \t]+/gm, "")
            .replace(/^[ \t]*[-*+][ \t]+(?=\S)/gm, "• ")
            .replace(/^>[ \t]?/gm, "")
    )
    .join("");
}
