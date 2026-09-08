/**
 * Builds the MCP server and registers its tools.
 *
 * The five read tools are always present. Sending, editing, marking read and
 * purging appear only when their switch is on, so a default deployment exposes
 * a read-only surface and nothing else.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ALLOW_FORGET, ALLOW_MEDIA, ALLOW_SEND } from "./actions.js";
import {
  EDIT_TOOL,
  FILE_TOOL,
  FORGET_TOOL,
  MEDIA_TOOL,
  READ_TOOL,
  SEND_MEDIA_TOOL,
  SEND_TOOL,
} from "./tools.js";

export type ToolArgs = Record<string, unknown>;
export type ToolCaller = (name: string, args: ToolArgs) => Promise<unknown>;
type Args = ToolArgs;

/**
 * Whether to put raw image bytes in the tool result. Correct MCP, and Claude
 * renders it — but ChatGPT ignores such blocks and has returned an empty answer
 * when one was present, so it is opt-in.
 */
const INLINE_IMAGE = (process.env.MCP_INLINE_IMAGE ?? "0") === "1";

/**
 * ChatGPT refuses to render images that come out of a tool — neither base64
 * blocks nor markdown links — because a tool-supplied image URL is a data
 * exfiltration channel the browser fetches silently. The sanctioned way to show
 * anything visual is an Apps SDK widget: HTML served as a resource and rendered
 * in a sandboxed iframe, which the tool points at through `_meta`.
 *
 * Experimental. Clients that do not implement the Apps SDK ignore both the
 * resource and the `_meta` key and fall back to the text content.
 */
const PHOTO_WIDGET_URI = "ui://widget/telegram-photo.html";
/** OpenAI's troubleshooting names this exact type; `text/html+skybridge`, which
 *  appears in older write-ups, is not what the client looks for. */
const WIDGET_MIME = "text/html;profile=mcp-app";

const PHOTO_WIDGET_HTML = `<!DOCTYPE html>
<meta charset="utf-8">
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; color: #ddd; background: transparent; }
  figure { margin: 0; }
  img { max-width: 100%; height: auto; border-radius: 10px; display: block; }
  figcaption { padding: 6px 2px 0; opacity: .75; }
  .empty { padding: 12px; opacity: .7; }
</style>
<div id="root" class="empty">Loading photo…</div>
<script>
  function render() {
    var out = (window.openai && window.openai.toolOutput) || {};
    var root = document.getElementById("root");
    if (!out.url) { root.textContent = "No photo URL in the tool result."; return; }
    root.className = "";
    var cap = out.caption
      ? '<figcaption>' + String(out.caption).replace(/[<&>]/g, "") + '</figcaption>'
      : "";
    root.innerHTML = '<figure><img alt="Telegram photo" src="' + out.url + '">' + cap + '</figure>';
  }
  render();
  // The host may deliver the payload after first paint.
  window.addEventListener("openai:set_globals", render);
</script>`;

/**
 * The origin this server hands out photo links on.
 *
 * A widget runs in a sandboxed iframe under a default Content-Security-Policy,
 * so it may only load assets from origins it declares. Declaring nothing was
 * why the picture never appeared: the iframe was refusing to fetch it, which is
 * also why switching CSP off in the browser made it work. Naming the origin
 * here is the fix that needs no such trade.
 */
function publicOrigin(): string | null {
  const raw = (process.env.MCP_PUBLIC_URL ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Widget metadata for the resource that serves the HTML.
 *
 * Both spellings go out: `_meta.ui.csp` is the standard one and
 * `openai/widgetCSP` is ChatGPT's compatibility key, and which a given client
 * reads is not worth guessing. `ui.domain` is deliberately left unset — it
 * assigns a dedicated origin and is required only to submit an app to OpenAI's
 * directory; a private connector runs fine on the shared sandbox.
 */
function widgetMeta(): Record<string, unknown> {
  const origin = publicOrigin();
  if (!origin) return {};
  return {
    ui: { csp: { connectDomains: [origin], resourceDomains: [origin] } },
    "openai/widgetCSP": { connect_domains: [origin], resource_domains: [origin] },
  };
}

const DATE_HINT =
  "Accepts an ISO 8601 timestamp, unix seconds, 'today', 'yesterday', or a relative window like '24h' / '7d'.";

export function createMcpServer(call: ToolCaller): McpServer {
  const server = new McpServer(
    { name: "telegram-business", version: "1.0.0" },
    {
      instructions:
        "Access to the user's own Telegram Business conversations, archived since the bot was " +
        "connected. To answer questions about a person ('what did Yulia write today'), first " +
        "call telegram_find_chat to resolve the name to a chat_id, then telegram_get_messages " +
        "with that chat_id. Voice messages carry a `transcript` field. " +
        (ALLOW_SEND
          ? "telegram_send_message and telegram_send_media reach real people as the user — " +
            "always show the exact text or what is being sent, and the recipient's name, and " +
            "get explicit confirmation before calling either, and never call one twice for a " +
            "single request. In a group there is no business connection, so a send goes out " +
            "as the bot rather than as the user; say so when it matters. Nothing else mutates."
          : "This server cannot send, edit or delete anything."),
    }
  );

  const json = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  // Every tool is annotated readOnlyHint so clients know nothing here mutates.
  const readOnly = (title: string) => ({
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });

  server.registerTool(
    "telegram_list_chats",
    {
      title: "List Telegram chats",
      description:
        "List the most recent Telegram Business conversations, newest activity first. " +
        "Returns chat_id, display name, username, message count and last message time.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional()
          .describe("How many chats to return. Default 20."),
      },
      annotations: readOnly("List Telegram chats"),
    },
    async (args) => json(await call("telegram_list_chats", args as Args))
  );

  server.registerTool(
    "telegram_recent_messages",
    {
      title: "Recent Telegram messages",
      description:
        "Most recent messages across all Telegram Business chats, newest first. " +
        "Use it for 'what came in today' style questions.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional()
          .describe("How many messages to return. Default 20."),
        since: z.string().optional()
          .describe(`Only messages at or after this time. ${DATE_HINT}`),
      },
      annotations: readOnly("Recent Telegram messages"),
    },
    async (args) => json(await call("telegram_recent_messages", args as Args))
  );

  server.registerTool(
    "telegram_get_messages",
    {
      title: "Get one chat's history",
      description:
        "Message history of one conversation, oldest first so it reads as a transcript. " +
        "Resolve a person's name to chat_id with telegram_find_chat first.",
      inputSchema: {
        chat_id: z.number().int().describe("Chat id, from telegram_find_chat or telegram_list_chats."),
        limit: z.number().int().min(1).max(200).optional()
          .describe("How many messages to return. Default 50."),
        before: z.string().optional()
          .describe(`Only messages strictly older than this time, for paging back. ${DATE_HINT}`),
        since: z.string().optional()
          .describe(`Only messages at or after this time. ${DATE_HINT}`),
      },
      annotations: readOnly("Get one chat's history"),
    },
    async (args) => json(await call("telegram_get_messages", args as Args))
  );

  server.registerTool(
    "telegram_search_messages",
    {
      title: "Search Telegram messages",
      description:
        "Full-text search over archived message text and captions. The last word is " +
        "prefix-matched. Optionally restrict to one chat or to a time window.",
      inputSchema: {
        query: z.string().min(1).describe("Words to search for."),
        chat_id: z.number().int().optional().describe("Restrict the search to this chat."),
        since: z.string().optional()
          .describe(`Only messages at or after this time. ${DATE_HINT}`),
        limit: z.number().int().min(1).max(200).optional()
          .describe("How many matches to return. Default 30."),
      },
      annotations: readOnly("Search Telegram messages"),
    },
    async (args) => json(await call("telegram_search_messages", args as Args))
  );

  server.registerTool(
    "telegram_find_chat",
    {
      title: "Find a Telegram contact",
      description:
        "Resolve a person to their chat_id by first name, last name, @username or numeric id. " +
        "Substring match and case-insensitive in any alphabet, so a partial name works. " +
        "Call this before telegram_get_messages.",
      inputSchema: {
        query: z.string().min(1).describe("Name, @username, or numeric chat id."),
        limit: z.number().int().min(1).max(100).optional()
          .describe("How many candidates to return. Default 20."),
      },
      annotations: readOnly("Find a Telegram contact"),
    },
    async (args) => json(await call("telegram_find_chat", args as Args))
  );

  if (ALLOW_MEDIA) {
    server.registerResource(
      "telegram-photo-widget",
      PHOTO_WIDGET_URI,
      { mimeType: WIDGET_MIME, _meta: widgetMeta() },
      async () => ({
        contents: [
          {
            uri: PHOTO_WIDGET_URI,
            mimeType: WIDGET_MIME,
            text: PHOTO_WIDGET_HTML,
            // Repeated on the content: clients differ over which they read.
            _meta: widgetMeta(),
          },
        ],
      })
    );

    server.registerTool(
      MEDIA_TOOL,
      {
        title: "View a Telegram photo",
        description:
          "Get a Telegram photo. Use the chat_id and message_id of a message whose " +
          "message_type is 'photo'. Returns a direct link — always include that link in your " +
          "reply as a clickable link, so the picture is reachable whether or not the client " +
          "renders the widget that accompanies this tool.",
        inputSchema: {
          chat_id: z.number().int().describe("Chat the photo is in."),
          message_id: z.number().int().describe("message_id of the photo message."),
        },
        outputSchema: {
          url: z.string().describe("Direct link to the image."),
          caption: z.string().nullable().describe("Caption, if the message had one."),
        },
        annotations: readOnly("View a Telegram photo"),
        _meta: {
          // The documented key is _meta.ui.resourceUri; openai/outputTemplate is
          // only a compatibility alias, so send both.
          ui: { resourceUri: PHOTO_WIDGET_URI },
          "openai/outputTemplate": PHOTO_WIDGET_URI,
        },
      },
      async (args) => {
        const r = (await call(MEDIA_TOOL, args as Args)) as {
          data: string;
          mimeType: string;
          bytes: number;
          caption: string | null;
          url: string | null;
        };
        // The inline image block is correct MCP and Claude renders it, but
        // ChatGPT does not — and a few hundred KB of base64 in a tool result
        // has been enough to make it return nothing at all. Off by default:
        // the link is what actually reaches the conversation.
        // A markdown *image* is stripped by ChatGPT's exfiltration guard; a
        // plain link survives. Give the link, and say so, rather than emitting
        // something the client will silently drop.
        const lines = [
          r.url ? `[Open photo](${r.url})` : null,
          r.caption ? `Caption: ${r.caption}` : null,
          r.url ? r.url : null,
        ].filter(Boolean) as string[];
        if (!lines.length) {
          // No public URL configured, so bytes are the only thing we can offer.
          return { content: [{ type: "image" as const, data: r.data, mimeType: r.mimeType }] };
        }
        return {
          content: [
            ...(INLINE_IMAGE
              ? [{ type: "image" as const, data: r.data, mimeType: r.mimeType }]
              : []),
            { type: "text" as const, text: lines.join("\n") },
          ],
          // What the Apps SDK widget reads; ignored by clients without it.
          structuredContent: { url: r.url!, caption: r.caption },
        };
      }
    );

    server.registerTool(
      FILE_TOOL,
      {
        title: "Read a Telegram attachment",
        description:
          "Read a file someone sent. For a spreadsheet (.xlsx), Word document (.docx), PDF " +
          "or any text format this returns the actual contents — cells, paragraphs, rows — " +
          "so you can answer questions about what is inside it. Spreadsheet rows come back " +
          "tab-separated, one sheet per '## name' heading. For a video, audio or image there " +
          "is no text to read and you get the filename, type, size and a link instead. " +
          "Use the chat_id and message_id of a message whose message_type is not 'text'. " +
          "Telegram refuses to serve files over 20 MB to a bot, so those cannot be fetched.",
        inputSchema: {
          chat_id: z.number().int().describe("Chat the file is in."),
          message_id: z.number().int().describe("message_id of the message carrying the file."),
          include_text: z
            .boolean()
            .optional()
            .describe("Default true. Set false to get only metadata and skip reading contents."),
          max_chars: z
            .number()
            .int()
            .optional()
            .describe("How much text to return at once. Defaults to a readable slice."),
          offset_lines: z
            .number()
            .int()
            .optional()
            .describe(
              "Skip this many lines before reading. A big spreadsheet does not fit in one " +
                "response, so page through it: the result says which lines you got and how " +
                "many there are in total."
            ),
        },
        annotations: readOnly("Read a Telegram attachment"),
      },
      async (args) => {
        const r = (await call(FILE_TOOL, args as Args)) as {
          filename: string;
          mimeType: string;
          bytes: number;
          message_type: string;
          caption: string | null;
          url: string | null;
          text: string | null;
          text_engine: string | null;
          text_truncated: boolean;
          text_error: string | null;
          from_line: number | null;
          to_line: number | null;
          total_lines: number | null;
        };
        const lines = [
          `${r.filename} — ${r.mimeType}, ${Math.round(r.bytes / 1024)} KB (${r.message_type})`,
          r.caption ? `Caption: ${r.caption}` : null,
          r.url ? `[Open ${r.filename}](${r.url})` : null,
          r.url,
        ].filter(Boolean) as string[];

        if (r.text_error) lines.push(`Could not read the contents: ${r.text_error}`);
        if (r.text != null) {
          const where = `lines ${r.from_line}-${r.to_line} of ${r.total_lines}`;
          lines.push(
            "",
            r.text_truncated
              ? `--- contents (${r.text_engine}, ${where}) — for the next part call again ` +
                `with offset_lines=${r.to_line} ---`
              : `--- contents (${r.text_engine}, ${where}) ---`,
            r.text
          );
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      }
    );
  }

  if (ALLOW_SEND) {
    server.registerTool(
      SEND_TOOL,
      {
        title: "Send a Telegram message",
        description:
          "Send a message to a real person from the user's own Telegram account. This is " +
          "irreversible and visible to the recipient immediately. Confirm the exact wording " +
          "and the recipient with the user before calling. Only chats already in the archive " +
          "can be messaged; resolve the person with telegram_find_chat first.",
        inputSchema: {
          chat_id: z.number().int().describe("Recipient, from telegram_find_chat."),
          text: z.string().min(1).max(4096).describe("Exactly the text to send."),
          reply_to_message_id: z.number().int().optional()
            .describe("Quote this message_id in the reply."),
        },
        annotations: {
          title: "Send a Telegram message",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args) => json(await call(SEND_TOOL, args as Args))
    );

    server.registerTool(
      SEND_MEDIA_TOOL,
      {
        title: "Send a photo or file to Telegram",
        description:
          "Send a photo, document, video, audio or voice message to a real person or group " +
          "from the user's Telegram. Irreversible and immediately visible — confirm the " +
          "recipient and what is being sent before calling.\n\n" +
          "Give exactly one source:\n" +
          "• from_chat_id + from_message_id — forward a file that is already in the archive. " +
          "Costs no upload and has no size limit, because Telegram already holds the file. " +
          "Works only for messages the collector saw live; imported history has no file id.\n" +
          "• url — a public http(s) link that Telegram fetches itself.\n\n" +
          "In a private chat this is sent as the user. In a group there is no business " +
          "connection, so it is sent as the bot — say so if that matters.",
        inputSchema: {
          chat_id: z.number().int().describe("Where to send it, from telegram_find_chat."),
          from_chat_id: z.number().int().optional()
            .describe("Chat holding the file to resend."),
          from_message_id: z.number().int().optional()
            .describe("message_id of the message holding the file."),
          url: z.string().optional()
            .describe("Public http(s) link for Telegram to fetch, instead of from_*."),
          caption: z.string().max(1024).optional()
            .describe("Text under the media. Markdown is converted."),
          as_document: z.boolean().optional()
            .describe("Send as a file rather than a photo/video, keeping full quality."),
          reply_to_message_id: z.number().int().optional()
            .describe("Quote this message_id."),
          message_thread_id: z.number().int().optional()
            .describe("Forum topic to post into, in a group that has them."),
        },
        annotations: {
          title: "Send a photo or file to Telegram",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args) => json(await call(SEND_MEDIA_TOOL, args as Args))
    );

    server.registerTool(
      EDIT_TOOL,
      {
        title: "Edit a message you sent",
        description:
          "Rewrite one of the user's own already-sent messages. The recipient sees it change " +
          "and Telegram marks it edited. Incoming messages cannot be edited.",
        inputSchema: {
          chat_id: z.number().int().describe("Chat the message is in."),
          message_id: z.number().int().describe("message_id of a message the user sent."),
          text: z.string().min(1).max(4096).describe("The new full text."),
        },
        annotations: {
          title: "Edit a message you sent",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => json(await call(EDIT_TOOL, args as Args))
    );

    server.registerTool(
      READ_TOOL,
      {
        title: "Mark a chat as read",
        description:
          "Clear the unread badge on a conversation by marking a message, and everything " +
          "before it, as read. Defaults to the newest message. Nothing is sent.",
        inputSchema: {
          chat_id: z.number().int().describe("Chat to mark read."),
          message_id: z.number().int().optional()
            .describe("Read up to this message. Defaults to the newest one known."),
        },
        annotations: {
          title: "Mark a chat as read",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => json(await call(READ_TOOL, args as Args))
    );
  }

  if (ALLOW_FORGET) {
    server.registerTool(
      FORGET_TOOL,
      {
        title: "Forget archived messages",
        description:
          "Delete messages from the local archive. Telegram is untouched — the messages stay " +
          "there for both people; this only discards our stored copy, so they stop appearing " +
          "in search and history. Give chat_id, before, or both. This cannot be undone.",
        inputSchema: {
          chat_id: z.number().int().optional().describe("Limit to one chat."),
          before: z.string().optional()
            .describe(`Only messages older than this. ${DATE_HINT}`),
        },
        annotations: {
          title: "Forget archived messages",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async (args) => json(await call(FORGET_TOOL, args as Args))
    );
  }

  return server;
}
