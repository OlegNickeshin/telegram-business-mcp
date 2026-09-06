# Setup guide

Two audiences. **Part 1** is for the person who wants this running — what to
obtain before anyone starts. **Part 2** is for whoever does the install, human
or agent. **Part 3** is the list of things that have already cost someone an
afternoon; read it before debugging anything.

---

# Part 1 — What you need to provide

Nothing here can be done by the installer on your behalf. Gather all five
first; the install stalls at whichever one is missing.

### 1. A server

A small VPS, always on. Not a laptop — see *Where this runs* in the README for
why. Minimums:

| If you want | Then |
|---|---|
| Archive + MCP only | 1 core, 512 MB RAM, 10 GB disk |
| + voice transcription | 2 cores, 2 GB RAM **and 2 GB swap**, ~1.5 GB extra disk |

Hand over root SSH access. The host must be able to reach `api.telegram.org`
directly — in some countries it is blocked, and then you need an outbound proxy
before anything works.

### 2. A domain or subdomain

Something like `tg.yourdomain.com`, with an A record pointing at the server's
IP. Needed because an MCP client will only talk to a public HTTPS URL. A
subdomain of a domain you already own is fine.

### 3. A Telegram bot

In [@BotFather](https://t.me/BotFather): `/newbot`, pick a name, copy the
token. It looks like `123456789:AA...`.

**Treat it like a password.** Send it over something private, not a public
chat. If it leaks, `/revoke` in BotFather kills it instantly.

### 4. The bot connected to your Business account

Requires Telegram Premium. In the Telegram app: **Settings → Telegram Business
→ Chatbots**, find your bot, connect it.

While you are there, look at the permission toggles. A business connection can
grant far more than reading messages — renaming your account and posting
stories are both on that list. Turn off anything this does not need.

### 5. Three decisions

| Question | Default | What it means |
|---|---|---|
| Should the assistant be able to **send messages as you**? | no | Messages reach real people instantly and cannot be recalled. Off unless you ask for it. Say so now if you want the full "tell it to reply and it replies" mode — it is one line, and easier decided before the server is live than after a surprise message. |
| Transcribe **voice messages**? | no | Runs locally, nothing leaves the server. Needs the bigger box above. |
| Mirror into **Linear**? | no | Only if you need access from a phone app that cannot use custom MCP connectors. Needs a Linear account and a personal API key. |

### What you should understand before starting

The archive **starts empty** and fills from the moment the collector runs.
Telegram's Bot API cannot fetch history from before that, by design. Nothing in
this project can work around it.

It stores **other people's messages**, and they are not told. In some
jurisdictions that carries obligations. That is your call to make, not the
installer's.

---

# Part 2 — Installing

Everything runs on the server. Nothing is installed on any client.

## Step 0 — Check what you were given

```bash
ssh root@<server>
nproc && free -m | head -2 && df -h / | tail -1
curl -s -o /dev/null -w "telegram: HTTP %{http_code}\n" --max-time 15 https://api.telegram.org/
```

If the last line is not `HTTP 302`, stop: the host cannot reach Telegram and
nothing else matters yet.

Verify the token and that it is Business-capable — do this before writing any
config:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getMe"
```

`can_connect_to_business` must be `true`. If `ok` is `false`, the token is wrong
or revoked.

## Step 1 — Node and the code

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
git clone <repo> /opt/telegram-archive-mcp
cd /opt/telegram-archive-mcp
npm install
npm run build
```

## Step 2 — Configuration

```bash
cp .env.example .env && chmod 600 .env
openssl rand -hex 32        # -> MCP_HTTP_SECRET
```

Fill in exactly four values to start:

```
TELEGRAM_BOT_TOKEN=<from BotFather>
DB_PATH=/opt/telegram-archive-mcp/data/telegram.db
MCP_HTTP_SECRET=<the random hex>
MCP_PUBLIC_URL=https://tg.yourdomain.com/tg-mcp
```

Leave the `ALLOW_*` switches alone for now: the defaults make this a read-only
archive. Get reading working first, then turn on what the owner actually asked
for — a broken install is far easier to diagnose with a small surface, and a
stray message to a real contact cannot be taken back.

## Step 3 — Services

```bash
cp deploy/tgbiz-collector.service deploy/tgbiz-mcp.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tgbiz-collector tgbiz-mcp
journalctl -u tgbiz-collector -f
```

Send yourself a message in any Business chat. It should appear in that log
within seconds. **If nothing appears, do not continue** — everything downstream
depends on this.

## Step 4 — TLS

Caddy is the least work, because it obtains the certificate itself:

```caddy
tg.yourdomain.com {
    handle /tg-mcp* {
        uri strip_prefix /tg-mcp
        reverse_proxy 127.0.0.1:8124 {
            flush_interval -1
        }
    }
}
```

`flush_interval -1` is not optional: MCP streams responses, and buffering them
breaks the connection in ways that look like a server bug.

```bash
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
curl -s https://tg.yourdomain.com/tg-mcp/healthz
```

The health endpoint needs no secret and returns counts only, never message
text. If it answers, the public path works.

## Step 5 — Verify properly

```bash
cd /opt/telegram-archive-mcp
npm run diagnose -- 'https://tg.yourdomain.com/tg-mcp?k=<secret>'
```

This asserts, in order: a missing secret is rejected, a wrong secret is
rejected, CORS preflight passes, exactly the expected tools are exposed with
correct annotations, every tool returns real data, three further sessions
connect (what a page reload does), and two concurrent sessions are both served.
It exits non-zero on any failure. Do not hand over a deployment that has not
passed it.

## Step 6 — Connect ChatGPT

**Web only.** Developer Mode does not exist in the ChatGPT mobile app. The
mobile *browser* works, since it loads the same web client.

### Turn on Developer Mode

Find **Developer mode** in settings and enable it. OpenAI moves this around —
it has lived under *Connectors → Advanced* and under *Security and login* —
so look for the words rather than a fixed path. If it is not there, close and
reopen the settings panel; the menu often refreshes only on reopen.

Available on Plus, Pro, Business, Enterprise and Edu.

### Create the connector

Open the plugins list and choose **New Plugin**, then fill in exactly this:

| Field | Value |
|---|---|
| Icon | skip, or a 256×256 PNG under 10 KB |
| Name | `Telegram Archive` |
| Description | `Search your Telegram history and reply from chat.` |
| Connection | **Server URL** (not Tunnel) |
| Server URL | `https://tg.yourdomain.com/tg-mcp/<secret>` |
| Authentication | **None** |
| Risk checkbox | tick it |

Three things that trip people up:

**Authentication must be None.** The secret is the path segment, so ChatGPT has
nothing to authenticate with. Leaving the dropdown on OAuth makes it hunt for
OAuth metadata, fail to find any, and refuse to create the plugin.

**The `https://example.com/sse` placeholder does not mean you need SSE.** This
server speaks Streamable HTTP. Paste the URL exactly as above; append nothing.

**The risk warning is accurate.** That URL is the whole credential, and with
`ALLOW_SEND=1` it writes to the owner's contacts. It ends up in the connector
settings and in chat history. Rotate `MCP_HTTP_SECRET` if it escapes.

### Confirm it took

Ask ChatGPT something like *"list my Telegram chats"*. The reply should include
a tool card. Expand it: the request should be a `telegram_*` call and the
response real data.

If the tools do not appear, delete the plugin and re-create it — ChatGPT caches
the tool list at connect time, so a server-side change to tool descriptions or
resources needs a fresh connection.

## Step 6b — Connect Claude

Claude supports remote MCP the same way, and the setup is shorter because there
is no developer mode to find first.

**Customize → Connectors → Add custom connector**, then paste the same URL:

```
https://tg.yourdomain.com/tg-mcp/<secret>
```

On Team and Enterprise plans only an Owner can add one, under
*Organization settings → Connectors*. Free plans allow exactly one custom
connector.

Two differences worth knowing:

* **Claude connects from Anthropic's cloud, not from your machine.** The server
  must be reachable on the public internet — which it already is, but it means
  a laptop behind a tunnel needs that tunnel up whenever Claude is used.
* **Claude renders inline images.** Set `MCP_INLINE_IMAGE=1` and
  `telegram_get_photo` will show the picture in the conversation instead of a
  link. ChatGPT ignores those blocks, so leave it off if both clients share one
  server.

Any other MCP client takes the same URL, or the `?k=<secret>` query form.

## Step 7 — Optional modules, one at a time

Each is inert until configured, so add them only after Step 5 passes.

**Sending.** Off by default. If the owner asked for it, set `ALLOW_SEND=1` and
restart `tgbiz-mcp`. Test with a message to yourself first. What changes: the
endpoint secret now writes to the owner's contacts, not just reads — rotate it
if the URL ever leaks.

**Voice transcription.** Needs swap on a 2 GB box — set that up *before*
building, or the first run takes down the neighbouring services:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo "/swapfile none swap sw 0 0" >> /etc/fstab

apt-get install -y git build-essential cmake ffmpeg
git clone --depth 1 https://github.com/ggml-org/whisper.cpp /opt/whisper.cpp
cd /opt/whisper.cpp && cmake -B build -DCMAKE_BUILD_TYPE=Release \
  && cmake --build build -j2 --target whisper-cli
bash ./models/download-ggml-model.sh small

cp deploy/tgbiz-transcribe.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now tgbiz-transcribe
```

Set `WHISPER_LANG` to the language actually spoken. `auto` mis-detects short
clips.

**Linear mirror.** Only if a phone client is needed. Key from Linear → Settings
→ Account → Security & Access:

```bash
npm run linear-check      # verifies the key and team, writes nothing
npm run linear-dryrun     # prints every comment it would post
npm run linear-backfill   # actually pushes the archive
systemctl enable --now tgbiz-linear
```

Always run `linear-check` and `linear-dryrun` before the backfill. The dry run
is the only chance to see what lands in someone's workspace before it does.

**Groups.** Business covers 1:1 only. For groups: @BotFather → `/setprivacy` →
*Disable*, then add the bot to the group. If the bot was already a member, the
old privacy setting sticks — remove and re-add it. Confirm with `getMe` that
`can_read_all_group_messages` is `true`.

## Handing over

The person needs three things, and only three:

1. The connector URL, including the secret. This *is* the credential.
2. Which capabilities you enabled.
3. How to rotate: change `MCP_HTTP_SECRET` in `.env`, restart `tgbiz-mcp`,
   update the client.

Do not hand over the bot token. Nothing on the client side needs it, and it is
the one credential that can be used against the Telegram account itself.

---

# Part 3 — Things that will waste your time

Each of these was found the hard way.

**Privacy mode sticks to existing group membership.** Turning it off in
BotFather does not affect groups the bot is already in. Remove and re-add the
bot, or make it an admin. Symptom: everything looks configured, the bot is in
the group, and nothing arrives.

**Node's `fetch` ignores `HTTPS_PROXY`.** `curl` honours it, so a host looks
reachable while the service times out. Run with `NODE_USE_ENV_PROXY=1` where a
proxy is required.

**`getUpdates` allows exactly one consumer.** Two collectors on one bot steal
each other's updates and both lose data. Never leave a debug run going.

**Telegram keeps undelivered updates for 24 hours.** A gap longer than that is
permanent. There is no backfill.

**SQLite's `LOWER()` only folds ASCII.** Name search silently fails for
non-Latin alphabets. This project registers a Unicode-aware `ulower()`; if you
add SQL, use it.

**Linear's API key goes in `Authorization` *without* `Bearer`.** With the
prefix it fails. `Bearer` is for OAuth tokens only.

**A leading `>` in a Linear comment is markdown.** The editor turns it into a
blockquote and the character never reaches the API — which is why the send
marker is `tg:`, not `>`.

**`text/html+skybridge` is wrong for Apps SDK widgets.** It appears in blog
posts. The documented type is `text/html;profile=mcp-app`, and the descriptor
key is `_meta.ui.resourceUri`.

**ChatGPT does not render pictures from tool output** — not as base64, not as a
markdown image, and links from tool results are suppressed too, sometimes
taking the whole reply with them. A tool-supplied URL is an exfiltration
channel and this is deliberate. The tool returns a short opaque link; do not
spend a day trying to make an image appear.

**whisper `small` needs ~770 MB resident.** On a 2 GB box without swap it will
be killed, and it may take other services with it. Add swap first.

**`CREATE TRIGGER IF NOT EXISTS` silently keeps an old definition.** Changing
what an FTS trigger indexes requires dropping it first, or the change appears
to apply and does nothing.

**`better-sqlite3` infers a custom function's arity from its signature.** A
rest parameter reports zero and every call fails with "wrong number of
arguments". Declare parameters explicitly.
