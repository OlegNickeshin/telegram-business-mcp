# telegram-business-mcp

**Use your personal Telegram directly from ChatGPT Web and Claude Web.**

Remote MCP over HTTPS — no browser extension, no local proxy, no MTProto user
session.

Read the story and the architecture notes:
[I connected my Telegram to ChatGPT. Then Claude connected to the same thing](https://nikeshin.space/en/entry/telegram-to-chatgpt/)

```
ChatGPT Web / Claude Web  →  remote HTTPS MCP  →  SQLite archive  →  Telegram Business Bot API
```

* Search and read your Telegram conversations from the chat you already use.
* A growing local archive, full-text searchable, on your own server.
* Reply as yourself through the official Telegram Business API.
* Self-hosted end to end — your machine, your SQLite file.
* Groups and forum topics.
* Optional local voice transcription, so search finds words that were spoken.

## Why this exists

Reading your own Telegram from an assistant normally means logging in as
yourself over MTProto, which leaves a session file on the host. That file is
the account: whoever copies it can read everything, message anyone, and change
your settings, and revoking it means invalidating your own sessions.

This uses a bot token and a Telegram Business connection instead. If the server
is compromised, the attacker gets the archive — not the account — and the token
dies with one command in @BotFather.

The cost is real and worth knowing before you start: a bot cannot read history
from before it was connected. The archive begins empty and grows from the
moment the collector runs. Telegram's Bot API offers no backfill, and nothing
here can invent one.

## Setting it up in ChatGPT Web

Nothing is installed locally. The whole client side is one URL.

1. Enable **Developer mode** in ChatGPT settings.
2. Open the plugins list and choose **New Plugin**.
3. Paste the remote MCP URL.
4. Set **Authentication: None** — the secret is part of the URL.
5. Ask it something about a real chat and check the tool card shows real data.

Field-by-field walkthrough, including the two settings that make it fail
silently: [SETUP.md](SETUP.md).

## Setting it up in Claude Web

Shorter, because there is no developer mode to find first.

1. **Customize → Connectors → + → Add custom connector**.
2. Paste the same URL. Leave *Advanced settings* alone — no OAuth here.
3. Enable the connector per conversation: **+** in the composer → **Connectors**.

## Compatibility

Any MCP client that accepts a remote HTTPS URL works — Claude Desktop and
others included. ChatGPT's mobile app has no Developer Mode, so custom
connectors do not appear there; the mobile browser does work, since it loads
the same web client.

Claude renders inline images, so `MCP_INLINE_IMAGE=1` shows photos in the
conversation rather than a link. ChatGPT ignores those blocks — leave the flag
off if one server serves both.

## Tools

| Tool | Switch | Effect |
|---|---|---|
| `telegram_list_chats` | always | recent conversations |
| `telegram_recent_messages` | always | newest messages across all chats |
| `telegram_get_messages` | always | one conversation, oldest first |
| `telegram_search_messages` | always | full-text, including transcripts |
| `telegram_find_chat` | always | resolve a name to a `chat_id` |
| `telegram_get_photo` | `ALLOW_MEDIA=1` | a photo, as a link and/or bytes |
| `telegram_send_message` | `ALLOW_SEND=1` | **sends as you** |
| `telegram_edit_message` | `ALLOW_SEND=1` | rewrites one of your own |
| `telegram_mark_read` | `ALLOW_SEND=1` | clears an unread badge |
| `telegram_forget` | `ALLOW_FORGET=1` | **deletes from the local archive** |

Times accept ISO 8601, unix seconds, `today`, `yesterday`, or a window like
`24h` / `7d`.

A fresh install is a **read-only archive**. `ALLOW_SEND=1` enables the
"tell ChatGPT to reply and it replies" mode; `ALLOW_FORGET=1` allows purging.
Both are off by default because the endpoint URL is effectively the credential,
and a leaked read-only URL is a very different incident from one that can write
to your contacts.

### Sending

`telegram_send_message` posts through the business connection, so the recipient
sees it from you, not from a bot.

* **Only chats already in the archive.** An invented or mistyped `chat_id` is
  refused before any Bot API call, so a model cannot reach a stranger.
* Every send is logged and written back into the archive.
* Annotated `readOnlyHint: false`, and the server's instructions tell the model
  to confirm wording and recipient first.

This changes what the endpoint secret is worth. Read-only, a leaked URL means
someone read the archive; with sending on it means someone writes to your
contacts as you. Rotate `MCP_HTTP_SECRET` if the URL ever escapes.

The guard against a misread request is currently the model confirming first,
which is a soft one. If you want a hard gate, a two-phase
`prepare_send` → `confirm_send` is the shape to add — deliberately not built
yet, because it changes the product from "reply for me" into "draft for me".

`telegram_forget` removes our stored copy only — Telegram keeps the messages for
both people. It refuses to
run without a `chat_id` or a `before`, so a single vague call cannot wipe
everything, and it drops the raw updates too rather than leaving the text
behind in a table nobody looks at.

It is a **logical** delete. SQLite frees the pages for reuse; the old bytes can
survive in the database file, the WAL and the FTS index until something
overwrites them. Read it as "no longer reachable through this service", not as
"erased from the disk".

Deliberately **not** implemented: `deleteBusinessMessages`. Telegram offers it
and it works, but it is the one irreversible operation in reach — a single wrong
`message_id` destroys someone else's message for both sides. That should cost a
code change, not a flag flip.

## Importing your existing history

The Bot API cannot reach messages sent before the bot was connected. Telegram's
own export can, and it costs the server nothing: you produce the file in your
own client, so no user session ever exists here.

1. Telegram Desktop → **Settings → Advanced → Export Telegram data**.
2. Format **Machine-readable JSON**. Media files are not needed — only the text
   and metadata are imported.
3. Copy `result.json` to the server and run:

```bash
npm run import -- path/to/result.json --dry-run   # show what would land
npm run import -- path/to/result.json
```

Desktop numbers messages the same way the Bot API does, so imported rows share
a key space with live ones: the two histories merge on
`(business_connection_id, chat_id, message_id)`, overlapping messages are
recognised rather than duplicated, and re-running the import changes nothing.

Everything downstream comes along — direction, media type, replies, edits, and
full-text search over the imported text.

## Where this runs

**On a server, not a laptop.** Two things force it:

* `getUpdates` allows exactly one consumer, and Telegram discards undelivered
  updates after 24 hours. A collector that only runs while your machine is open
  loses everything from longer gaps, permanently — there is no backfill.
* A remote MCP endpoint needs a public HTTPS URL that the client can reach.

A laptop is fine for *trying it out*: run the collector, point a local MCP
client at `http://127.0.0.1:8124`, and use a tunnel if you want a remote client
to reach it. Do not run two collectors against the same bot — they will steal
each other's updates.

Nothing is installed on the client side. No browser extension, no local proxy,
no stdio server: an MCP client connects to the URL and that is all.

## Install

For a full walkthrough — what the owner must provide, step-by-step
deployment, and the mistakes already made — see [SETUP.md](SETUP.md).

Requires Node 22+, a domain, and a TLS reverse proxy. Everything else is
optional.

```bash
git clone <this repo> /opt/telegram-archive-mcp
cd /opt/telegram-archive-mcp
npm install
npm run build

cp .env.example .env && chmod 600 .env
openssl rand -hex 32          # -> MCP_HTTP_SECRET
$EDITOR .env                  # TELEGRAM_BOT_TOKEN, MCP_HTTP_SECRET, MCP_PUBLIC_URL

sudo cp deploy/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tgbiz-collector tgbiz-mcp
```

Reverse proxy (Caddy shown; see `deploy/Caddyfile.snippet`):

```caddy
handle /tg-mcp* {
    uri strip_prefix /tg-mcp
    reverse_proxy 127.0.0.1:8124 {
        flush_interval -1     # MCP streams; never buffer
    }
}
```

Then connect a client to `https://your.host/tg-mcp/<secret>` and check it:

```bash
npm run diagnose -- 'https://your.host/tg-mcp?k=<secret>'
```

That asserts the endpoint rejects a missing and a wrong secret, allows CORS
preflight, exposes exactly the expected tools with correct annotations, returns
real data from each, survives reconnects, and serves two sessions at once.

## Server sizing

Measured, not estimated: **~2 KB per message**, mostly the raw update JSON. At
500 messages a day that is ~1 MB/day, ~350 MB/year. Disk is never the problem.

| Setup | Needs |
|---|---|
| Archive + MCP | 1 core, 512 MB RAM, 10 GB disk |
| + whisper `base` | 2 cores, 2 GB RAM, ~1.5 GB for model and build |
| + whisper `small` | 2 cores, 2 GB RAM **plus 2 GB swap**, or 4 GB RAM |

`small` needs ~770 MB resident. On a 2 GB box it survives only with swap;
without it, it will take neighbouring services down with it. `base` fits
without swap but is noticeably worse on non-English speech.

If the host is somewhere `api.telegram.org` is blocked, you need an outbound
proxy — Node's `fetch` ignores `HTTPS_PROXY` unless you run with
`NODE_USE_ENV_PROXY=1`.

## Optional: local transcription

```bash
apt-get install -y git build-essential cmake ffmpeg
git clone --depth 1 https://github.com/ggml-org/whisper.cpp /opt/whisper.cpp
cd /opt/whisper.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release \
  && cmake --build build -j2 --target whisper-cli
bash ./models/download-ggml-model.sh small
systemctl enable --now tgbiz-transcribe
```

Voice only by default (`TRANSCRIBE_TYPES`). The transcript is indexed for
search, exposed as a `transcript` field on every message, and appended to the
Media is deleted as soon as the text is stored.

Pin `WHISPER_LANG`. `auto` mis-detected a short Russian clip as English in
testing.

**The Bot API refuses files over 20 MB.** Larger items are marked
`media_status = 'skipped'` with the reason recorded.

## Groups and forum topics

Business covers 1:1 only. Groups arrive as plain `message` updates, which needs
all three of:

1. `message` in `ALLOWED_UPDATES` (it is);
2. **privacy mode disabled** — @BotFather → `/setprivacy` → *Disable*;
3. the bot a member of the group. If it joined *before* privacy was turned off,
   the old setting sticks — remove and re-add it, or make it an admin.

Verify with `getMe`: `can_read_all_group_messages` must be `true`.

Forum topics are tracked. Telegram names a topic only on the message that
created it and on replies into it, so the name is stored on first sight and
reused for the rest of the thread.

Private `message` updates are ignored on purpose: someone writing to the bot
directly produces the same `chat.id` as their business chat but an independent
`message_id` sequence, and mixing the two would interleave separate histories.

## Known limitations

* **The archive starts when the collector starts** — but you can fill in the
  past once, from an official Telegram Desktop export. See below.
* **Pictures do not reach ChatGPT.** Not a bug here. ChatGPT strips images that
  come out of a tool — a tool-supplied image URL is a silent exfiltration
  channel — and in testing it suppressed plain links from tool output too,
  sometimes dropping the whole reply. Three mechanisms were tried and all are
  correct server-side: an inline base64 block, a markdown link, and an Apps SDK
  widget (`_meta.ui.resourceUri`, `text/html;profile=mcp-app`). The tool returns
  a short opaque link so nothing depends on rendering, and the master secret
  stays out of it. Claude renders the inline image block fine — set
  `MCP_INLINE_IMAGE=1` for clients that support it.
* Photos are not OCR'd; video is not transcribed by default.
* Sending is text only — no media, and no way to target a specific forum topic.
* The archive grows without bound unless you use `telegram_forget`.

## Data model

`messages` keeps `chat_id`, `message_id`, `business_connection_id`, sender
fields, `date`, `text`, `caption`, `content_type`, `message_thread_id`,
`topic_name`, plus `outgoing`, `edit_date`, `is_deleted`, `transcript` and the
raw update JSON.

* **Dedup** — `updates.update_id` is a primary key and `messages` is unique on
  `(business_connection_id, chat_id, message_id)`. Both matter: Telegram
  redelivers unacknowledged updates after a restart.
* **Edits** overwrite the body and set `edit_date`; the FTS index follows.
* **Deletions** set `is_deleted = 1`. Rows are never removed — this is an
  archive, and a deleted message is still something you may want to ask about.
* **Direction** compares `from.id` to the connection owner, backfilled through
  `getBusinessConnection` when the connection predates the collector.

## Background

Built because I wanted my own Telegram answerable from the chat window I
already had open, and every existing route wanted a user session on a server I
would then have to trust forever. The long version — what was tried, what the
platforms refuse to do, and why the pieces ended up arranged this way — is in
[the write-up](https://nikeshin.space/en/entry/telegram-to-chatgpt/).

## Support

Questions, setup help and release updates:
[@bettertextletters](https://t.me/bettertextletters)

Bug reports and feature requests: GitHub Issues.

## Licence

Apache License 2.0. Not affiliated with Telegram, OpenAI or Anthropic.

You are responsible for what you archive. This stores other people's messages,
and they are not told about it; in some jurisdictions that carries obligations.
