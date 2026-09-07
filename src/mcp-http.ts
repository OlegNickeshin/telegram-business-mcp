/**
 * Remote read-only MCP server over Streamable HTTP.
 *
 * Runs on the VPS next to the collector and reads the SQLite archive directly,
 * so nothing has to be installed on a laptop. Caddy terminates TLS in front of
 * it and forwards /tg-mcp* here.
 *
 * Stateless by design: every POST builds a fresh McpServer and transport, so a
 * page reload or a dropped connection simply starts a new one. There is no
 * session state to go stale and no single shared Server object to collide.
 */
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { migrate, openDb } from "./db.js";
import { enabledToolNames, runTool } from "./tools.js";
import { ALLOW_MEDIA, ALLOW_SEND, fetchFileRaw, photoByToken } from "./actions.js";
import { createMcpServer } from "./mcp-factory.js";

const PORT = Number(process.env.MCP_HTTP_PORT ?? 8124);
const HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const SECRET = (process.env.MCP_HTTP_SECRET ?? "").trim();
const PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? "";
/** Served over a link rather than base64, so a bigger variant is affordable. */
const IMG_MAX_BYTES = Number(process.env.MCP_IMG_MAX_BYTES ?? 600_000);

if (!SECRET || SECRET.length < 24) {
  console.error("MCP_HTTP_SECRET must be set and at least 24 chars. Generate: openssl rand -hex 32");
  process.exit(1);
}

const db = openDb();
migrate(db);
const call = async (name: string, args: Record<string, unknown>) => runTool(db, name, args);

function secretOk(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The secret may arrive three ways, because MCP clients differ in what they can
 * send. A browser extension that only takes a URL uses the query form.
 *   Authorization: Bearer <secret>
 *   /tg-mcp?k=<secret>
 *   /tg-mcp/<secret>
 */
function authorize(req: http.IncomingMessage, url: URL): boolean {
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (secretOk(bearer)) return true;
  if (secretOk(url.searchParams.get("k"))) return true;
  const seg = url.pathname.replace(/^\/+|\/+$/g, "");
  return seg.length > 0 && secretOk(seg);
}

/**
 * The extension runs inside the chatgpt.com page, so every request is
 * cross-origin. Credentials are never cookies here (always a token), so a
 * wildcard origin is safe and avoids maintaining an allowlist.
 */
function setCors(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type, authorization, accept, last-event-id, mcp-session-id, mcp-protocol-version"
  );
  res.setHeader("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  res.setHeader("access-control-max-age", "86400");
}

/**
 * A Content-Disposition a browser will honour for a non-ASCII filename.
 *
 * The bare `filename=` parameter is ASCII-only, and JS `\w` is ASCII-only too,
 * so sanitising a Cyrillic name against it leaves a row of underscores. RFC 5987
 * `filename*` carries the real name; the plain parameter stays as a fallback for
 * anything that ignores it.
 */
function contentDisposition(filename: string, inline: boolean): string {
  const cleaned = filename
    .replace(/[^\x20-\x7e]+/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_\s]+/, "");
  // A name that was entirely non-ASCII leaves nothing but the extension.
  const ascii = /^[^.]/.test(cleaned) ? cleaned : `file${cleaned}`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  setCors(res);

  // Preflight cannot carry the Authorization header, so answer it before auth.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Liveness probe: counts only, never message content, and no secret needed.
  if (req.method === "GET" && url.pathname.replace(/\/+$/, "") === "/healthz") {
    const stats = db
      .prepare("SELECT COUNT(*) AS messages, MAX(date) AS newest FROM messages")
      .get() as { messages: number; newest: number | null };
    return send(res, 200, {
      ok: true,
      transport: "streamable-http",
      tools: enabledToolNames(),
      can_send: ALLOW_SEND,
      can_fetch_media: ALLOW_MEDIA,
      messages: stats.messages,
      newest_message_at: stats.newest ? new Date(stats.newest * 1000).toISOString() : null,
    });
  }

  // File bytes over plain HTTPS, addressed by a short opaque token. The master
  // secret deliberately stays out of this URL: it ends up in a chat client's
  // history, and a long high-entropy path is the exact shape of an
  // exfiltration link that such clients suppress.
  const link = url.pathname.match(/^\/p\/([0-9a-f]{8,32})(?:\.\w+)?$/);
  if (req.method === "GET" && link) {
    const ref = photoByToken(db, link[1]);
    if (!ref) return send(res, 404, { error: "unknown file token" });
    try {
      // Photos get a byte budget because Telegram offers sizes to choose from;
      // every other attachment is a single file and is served as it is.
      const f = await fetchFileRaw(db, ref.chatId, ref.messageId, IMG_MAX_BYTES);
      // Anything a browser can render or play opens in place; the rest saves.
      const inline =
        /^(image|video|audio)\//.test(f.mimeType) ||
        f.mimeType === "application/pdf" ||
        f.mimeType === "text/plain";
      res.writeHead(200, {
        "content-type": f.mimeType,
        "content-length": f.buf.length,
        // Let a browser show what it can and save the rest under its real name.
        "content-disposition": contentDisposition(f.filename, inline),
        // Immutable: the file behind a Telegram message never changes.
        "cache-control": "private, max-age=86400",
      });
      return res.end(f.buf);
    } catch (err) {
      return send(res, 404, { error: (err as Error).message });
    }
  }

  if (!authorize(req, url)) {
    // 401 + WWW-Authenticate is what MCP clients expect for a missing token.
    res.setHeader("www-authenticate", 'Bearer realm="telegram-mcp"');
    return send(res, 401, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or wrong secret" },
      id: null,
    });
  }

  let body: unknown;
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 1_000_000) throw new Error("request body too large");
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw.trim() ? JSON.parse(raw) : undefined;
    } catch (err) {
      return send(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: `Parse error: ${(err as Error).message}` },
        id: null,
      });
    }
  }

  // A fresh server+transport per request: no cross-request state to corrupt.
  const mcp: McpServer = createMcpServer(call);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    mcp.close().catch(() => {});
  });

  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] request failed:`, (err as Error).message);
    if (!res.headersSent) {
      send(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `telegram MCP (streamable http, ${enabledToolNames().length} tools, ` +
      `send=${ALLOW_SEND ? "ON" : "off"}, media=${ALLOW_MEDIA ? "on" : "off"}) ` +
      `on http://${HOST}:${PORT}\n` +
      `public endpoint: ${PUBLIC_URL}?k=<secret>`
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
