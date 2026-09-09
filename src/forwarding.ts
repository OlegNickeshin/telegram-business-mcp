type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : null;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/** Expose only origin identity fields, never arbitrary raw user/chat metadata. */
function actor(value: unknown, fields: string[]): ObjectValue | undefined {
  const source = object(value);
  if (!source) return undefined;
  const out: ObjectValue = {};
  if (integer(source.id)) out.id = source.id;
  for (const key of fields) {
    if (typeof source[key] === "string") out[key] = source[key];
  }
  return out;
}

/**
 * Telegram MessageOrigin fields with their original names and Unix date.
 * Old Desktop imports contain only sender_user_name: it could name a channel,
 * so do not invent a user type, ID or original date. Corrupt/unknown origins
 * must not break an entire history response or silently look like originals.
 */
export function forwardOrigin(raw: string | null): ObjectValue | null {
  if (raw == null) return null;
  let source: ObjectValue | null;
  try {
    source = object(JSON.parse(raw));
  } catch {
    source = null;
  }
  if (!source) return { type: "unknown" };

  const known = typeof source.type === "string" && ["user", "hidden_user", "chat", "channel"].includes(source.type);
  const out: ObjectValue = { type: known ? source.type : "unknown" };
  if (integer(source.date) && source.date > 0) out.date = source.date;
  switch (out.type) {
    case "user":
      out.sender_user = actor(source.sender_user, ["first_name", "last_name", "username"]);
      break;
    case "chat":
      out.sender_chat = actor(source.sender_chat, ["type", "title", "username"]);
      break;
    case "channel":
      out.chat = actor(source.chat, ["type", "title", "username"]);
      if (integer(source.message_id) && source.message_id > 0) out.message_id = source.message_id;
      break;
    default:
      // hidden_user or a name-only Desktop import; never infer a hidden ID.
      if (typeof source.sender_user_name === "string") out.sender_user_name = source.sender_user_name;
  }
  if ((out.type === "chat" || out.type === "channel") && typeof source.author_signature === "string") {
    out.author_signature = source.author_signature;
  }
  return out;
}
