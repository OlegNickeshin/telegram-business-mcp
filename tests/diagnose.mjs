#!/usr/bin/env node
/**
 * End-to-end check of the remote read-only Telegram MCP.
 *
 *   node tests/diagnose.mjs 'https://example.com/tg-mcp?k=<secret>'
 *   TELEGRAM_MCP_URL='https://…?k=…' node tests/diagnose.mjs
 *
 * Exits 0 only when every check passes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const raw = process.argv[2] ?? process.env.TELEGRAM_MCP_URL;
if (!raw) {
  console.error("usage: node tests/diagnose.mjs 'https://your.host/tg-mcp?k=<secret>'");
  process.exit(2);
}
const url = new URL(raw);
const bare = new URL(url); // same endpoint, secret stripped
bare.search = "";

const TOOLS = [
  "telegram_list_chats",
  "telegram_recent_messages",
  "telegram_get_messages",
  "telegram_search_messages",
  "telegram_find_chat",
];

let failures = 0;
const ok = (m) => console.log(`  \x1b[32mOK\x1b[0m   ${m}`);
const bad = (m) => { failures++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };

console.log(`endpoint: ${bare}\n`);

const newSession = async () => {
  const c = new Client({ name: "telegram-mcp-diagnostic", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
};

// --- the endpoint must not be usable without the secret ---------------------
const probe = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } };
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

for (const [label, target] of [["no secret", bare], ["wrong secret", new URL(`${bare}?k=definitely-not-the-secret`)]]) {
  const res = await fetch(target, { method: "POST", headers, body: JSON.stringify(probe) });
  res.status === 401
    ? ok(`${label} rejected with 401`)
    : bad(`${label} returned HTTP ${res.status}, endpoint is not protected`);
}

// --- the browser extension is cross-origin, so preflight must pass ----------
const pre = await fetch(bare, {
  method: "OPTIONS",
  headers: {
    origin: "https://chatgpt.com",
    "access-control-request-method": "POST",
    "access-control-request-headers": "content-type,mcp-session-id",
  },
});
pre.ok && pre.headers.get("access-control-allow-origin")
  ? ok(`CORS preflight from chatgpt.com allowed (${pre.status})`)
  : bad(`CORS preflight failed: HTTP ${pre.status}, allow-origin=${pre.headers.get("access-control-allow-origin")}`);

// --- tool surface -----------------------------------------------------------
let client;
try {
  client = await newSession();
  ok("authenticated session established");
} catch (e) {
  bad(`cannot connect with the secret: ${e.message}`);
  process.exit(1);
}

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
for (const want of TOOLS) {
  names.includes(want) ? ok(`tool exposed: ${want}`) : bad(`tool MISSING: ${want}`);
}
// Optional tools are allowed, but only the two we know about, and the health
// endpoint must agree with what the server actually exposes.
const OPTIONAL = [
  "telegram_get_photo",
  "telegram_get_photos",
  "telegram_show_photo",
  "telegram_get_file",
  "telegram_send_message",
  "telegram_send_media",
  "telegram_set_reaction",
  "telegram_edit_message",
  "telegram_mark_read",
  "telegram_forget",
];
// Tools that legitimately change something. Anything else matching /send|delete|…/
// is unexpected and must be reported.
const WRITERS = [
  "telegram_send_message",
  "telegram_send_media",
  "telegram_set_reaction",
  "telegram_edit_message",
  "telegram_mark_read",
  "telegram_forget",
];
const extra = names.filter((n) => !TOOLS.includes(n) && !OPTIONAL.includes(n));
extra.length === 0 ? ok("no unexpected tools") : bad(`unexpected tools: ${extra.join(", ")}`);

// Behind Caddy the /tg-mcp prefix is stripped before it reaches the server, so
// the probe has to work with and without it — otherwise a direct run against
// 127.0.0.1 gets a 404 body and no health check at all.
const health = await (async () => {
  for (const path of ["/tg-mcp/healthz", "/healthz"]) {
    const r = await fetch(new URL(path, bare)).then((x) => x.json()).catch(() => null);
    if (r && Array.isArray(r.tools)) return r;
  }
  return null;
})();
if (health) {
  const same = JSON.stringify([...health.tools].sort()) === JSON.stringify([...names].sort());
  same ? ok(`healthz agrees with tools/list (${names.length} tools)`)
       : bad(`healthz lists ${health.tools.join(",")} but tools/list has ${names.join(",")}`);
  ok(`send=${health.can_send ? "ENABLED" : "off"} media=${health.can_fetch_media ? "on" : "off"}`);
} else {
  bad("healthz did not answer with a tool list");
}

const writey = names.filter((n) => /send|delete|edit|write|post|reply|forget|mark/i.test(n));
const rogue = writey.filter((n) => !WRITERS.includes(n));
if (rogue.length) {
  bad(`unexpected write tools: ${rogue.join(", ")}`);
} else if (writey.length === 0) {
  ok("no write tools exposed (read-only)");
} else {
  const mislabelled = writey.filter(
    (n) => tools.find((t) => t.name === n)?.annotations?.readOnlyHint !== false
  );
  mislabelled.length === 0
    ? ok(`write tools present and all marked readOnlyHint:false — ${writey.join(", ")}`)
    : bad(`write tools not marked as such: ${mislabelled.join(", ")}`);
  const purge = tools.find((t) => t.name === "telegram_forget");
  if (purge) {
    purge.annotations?.destructiveHint === true
      ? ok("telegram_forget is marked destructive")
      : bad("telegram_forget is not marked destructiveHint:true");
  }
}

const readers = tools.filter((t) => !WRITERS.includes(t.name));
readers.every((t) => t.annotations?.readOnlyHint === true)
  ? ok("every non-sending tool is annotated readOnlyHint")
  : bad("some read tools lack readOnlyHint");

// The guardrail that matters most: a chat we never saw must be refused.
if (names.includes("telegram_send_message")) {
  try {
    const r = await client.callTool({
      name: "telegram_send_message",
      arguments: { chat_id: 999999999, text: "diagnostic probe, must not be delivered" },
    });
    const text = JSON.stringify(r);
    /not in the archive/i.test(text)
      ? ok("send to an unknown chat_id is refused before reaching Telegram")
      : bad(`send guardrail did not refuse an unknown chat_id: ${text.slice(0, 200)}`);
  } catch (e) {
    /not in the archive/i.test(e.message)
      ? ok("send to an unknown chat_id is refused before reaching Telegram")
      : bad(`send guardrail error was unexpected: ${e.message}`);
  }
}

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { throw new Error(`non-JSON reply: ${text.slice(0, 200)}`); }
};

try {
  const chats = await call("telegram_list_chats", { limit: 5 });
  chats.count > 0
    ? ok(`telegram_list_chats -> ${chats.count}: ${chats.chats.map((c) => c.name).join(", ")}`)
    : bad("telegram_list_chats -> 0 chats (is tgbiz-collector running?)");

  const recent = await call("telegram_recent_messages", { limit: 5 });
  if (recent.count > 0) {
    const m = recent.messages[0];
    ok(`telegram_recent_messages -> ${recent.count}; newest ${m.date} ${m.direction} ${m.chat_name} (${m.message_type})`);
  } else bad("telegram_recent_messages -> 0 messages");

  const withText = recent.messages?.find((m) => m.text);
  if (withText) {
    const word = withText.text.split(/\s+/).find((w) => w.length > 3) ?? withText.text;
    const found = await call("telegram_search_messages", { query: word });
    found.count > 0
      ? ok(`telegram_search_messages("${word}") -> ${found.count}`)
      : bad(`telegram_search_messages("${word}") -> 0, though that word is archived`);
  }

  const first = chats.chats?.[0];
  if (first) {
    const byName = await call("telegram_find_chat", { query: first.name });
    byName.count > 0
      ? ok(`telegram_find_chat("${first.name}") -> chat_id ${byName.chats[0].chat_id}`)
      : bad(`telegram_find_chat("${first.name}") -> nothing`);
    const hist = await call("telegram_get_messages", { chat_id: first.chat_id, limit: 3 });
    hist.count > 0
      ? ok(`telegram_get_messages(chat_id=${first.chat_id}) -> ${hist.count}`)
      : bad(`telegram_get_messages(chat_id=${first.chat_id}) -> nothing`);
  }
} catch (e) {
  bad(`tool call failed: ${e.message}`);
}
await client.close();

// --- every page reload is a brand new session ------------------------------
try {
  for (let i = 2; i <= 4; i++) {
    const c = await newSession();
    const { tools: t } = await c.listTools();
    await c.callTool({ name: "telegram_list_chats", arguments: { limit: 1 } });
    if (t.length !== names.length) throw new Error(`session ${i} saw ${t.length} tools, first session saw ${names.length}`);
    await c.close();
  }
  ok("3 further sessions (page reloads) each connected and called a tool");
} catch (e) {
  bad(`reconnect failed: ${e.message}`);
}

// --- two clients at once, as when a second tab is open ---------------------
try {
  const [a, b] = await Promise.all([newSession(), newSession()]);
  const [ra, rb] = await Promise.all([
    a.callTool({ name: "telegram_recent_messages", arguments: { limit: 1 } }),
    b.callTool({ name: "telegram_list_chats", arguments: { limit: 1 } }),
  ]);
  await Promise.all([a.close(), b.close()]);
  ra.content && rb.content
    ? ok("two concurrent sessions both served")
    : bad("concurrent sessions returned empty content");
} catch (e) {
  bad(`concurrent sessions failed: ${e.message}`);
}

console.log(
  failures === 0
    ? `\n\x1b[32mAll checks passed.\x1b[0m Remote MCP is live, protected and reload-safe` +
      `${names.includes("telegram_send_message") ? ", with sending ENABLED." : ", read-only."}`
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`
);
process.exit(failures === 0 ? 0 : 1);
