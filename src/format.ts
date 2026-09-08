/**
 * Renders Telegram's `entities` back into markdown.
 *
 * Telegram sends formatting out of band: `text` is plain, and a parallel array
 * says "characters 5..12 are bold, 20..24 link to https://…". We stored the
 * text and dropped the array, which is fine for bold — the words survive — but
 * silently destructive for `text_link`, where the anchor text is shown and the
 * URL exists *only* in the entity. A reader sees "смотри тут" and cannot know
 * where "тут" pointed.
 *
 * Offsets are in UTF-16 code units, not characters. A JavaScript string is
 * already UTF-16, so `slice` with Telegram's numbers is correct as-is — but
 * only by coincidence of encoding, so never "fix" this to iterate code points.
 */

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  user?: { id: number; first_name?: string };
}

/**
 * Markers to wrap an entity in, or null to leave the text untouched.
 *
 * `url`, `mention`, `email`, `phone_number`, `hashtag` and friends are omitted
 * deliberately: the address *is* the visible text, so marking it up adds noise
 * and loses nothing by being skipped.
 */
function markers(e: TgEntity): [string, string] | null {
  switch (e.type) {
    case "bold":
      return ["**", "**"];
    case "italic":
      return ["*", "*"];
    case "underline":
      return ["__", "__"];
    case "strikethrough":
      return ["~~", "~~"];
    case "spoiler":
      return ["||", "||"];
    case "code":
      return ["`", "`"];
    case "pre":
      return [`\`\`\`${e.language ?? ""}\n`, "\n```"];
    case "text_link":
      // The whole reason this file exists.
      return e.url ? ["[", `](${e.url})`] : null;
    case "text_mention":
      // A mention of someone with no @username: the id is the only handle.
      return e.user ? ["[", `](tg://user?id=${e.user.id})`] : null;
    default:
      return null;
  }
}

interface Insert {
  at: number;
  text: string;
  closing: boolean;
  length: number;
}

/**
 * Text with formatting applied, or null when there was nothing to add.
 *
 * Returning null rather than a copy is what lets callers store this only for
 * the messages that actually carry formatting.
 */
export function renderEntities(text: string, entities: TgEntity[] | undefined): string | null {
  if (!text || !entities?.length) return null;

  const inserts: Insert[] = [];
  for (const e of entities) {
    if (!Number.isFinite(e.offset) || !Number.isFinite(e.length) || e.length <= 0) continue;
    const start = Math.max(0, e.offset);
    const end = Math.min(text.length, e.offset + e.length);
    if (end <= start) continue;

    // A blockquote is the one range-shaped type: every line inside it needs
    // the marker, not just the first.
    if (e.type === "blockquote" || e.type === "expandable_blockquote") {
      inserts.push({ at: start, text: "> ", closing: false, length: e.length });
      for (let i = start; i < end; i++) {
        if (text[i] === "\n") {
          inserts.push({ at: i + 1, text: "> ", closing: false, length: e.length });
        }
      }
      continue;
    }

    const m = markers(e);
    if (!m) continue;
    inserts.push({ at: start, text: m[0], closing: false, length: e.length });
    inserts.push({ at: end, text: m[1], closing: true, length: e.length });
  }

  if (!inserts.length) return null;

  inserts.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    // At one position, inner spans close before outer ones do, and outer spans
    // open before inner ones — otherwise nested markers interleave wrongly.
    if (a.closing !== b.closing) return a.closing ? -1 : 1;
    return a.closing ? a.length - b.length : b.length - a.length;
  });

  let out = "";
  let cursor = 0;
  for (const ins of inserts) {
    out += text.slice(cursor, ins.at) + ins.text;
    cursor = ins.at;
  }
  out += text.slice(cursor);

  // Nothing gained if the markers cancelled out to the original.
  return out === text ? null : out;
}

/**
 * Picks whichever of text/caption a message carries and renders it. Captions
 * keep their entities in a separate field, which is easy to forget.
 */
export function renderMessage(msg: {
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
}): string | null {
  if (msg.text) return renderEntities(msg.text, msg.entities);
  if (msg.caption) return renderEntities(msg.caption, msg.caption_entities);
  return null;
}
