import { migrate, openDb } from "./db.js";
import { clamp, displayName, recentMessages } from "./queries.js";

const limit = clamp(process.argv[2], 20, 500);

const db = openDb();
migrate(db); // harmless if already applied; makes a fresh checkout runnable

const rows = recentMessages(db, limit);
if (rows.length === 0) {
  console.log("No messages stored yet. Run the collector and write to the business account.");
} else {
  console.log(`Last ${rows.length} message(s), newest first:\n`);
  for (const m of rows) {
    const when = new Date(m.date * 1000).toISOString().replace("T", " ").slice(0, 19);
    const who = displayName({
      title: m.chat_title,
      first_name: m.chat_first_name,
      last_name: m.chat_last_name,
      username: m.chat_username,
    });
    const dir = m.outgoing ? "→" : "←";
    const flags = [m.is_deleted ? "deleted" : "", m.edit_date ? "edited" : ""].filter(Boolean);
    const body = m.text ?? m.caption ?? `<${m.content_type}>`;
    console.log(
      `${when}  ${dir} ${who} [chat_id=${m.chat_id} msg=${m.message_id} ${m.content_type}` +
        (flags.length ? ` ${flags.join(",")}` : "") +
        `]\n    ${body.replace(/\n/g, "\n    ")}\n`
    );
  }
}
db.close();
