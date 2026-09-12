# Assist mode — draft replies, approve in your DM

When someone writes to you, a scheduled Claude Code agent reads the thread
through the connector, drafts a reply in your voice, and the bot sends it to your
Telegram DM with **Send / Skip** buttons. Nothing reaches the other person until
you tap Send.

```
someone writes you
   → collector archives it (realtime)
   → agent, once a minute, only if something is unanswered:
        assist_pending → telegram_get_messages / kb_search → assist_draft
   → the bot DMs you the draft with Send / Skip
   → you tap Send → it goes out as you
```

The connector holds **no model**. The drafting is entirely the agent's, so there
is no API key on the server, and there is no autonomous send.

## Setup

### 1. Turn the module on (server)

In the connector's `.env`:

```env
ALLOW_ASSIST=1
ASSIST_OWNER_CHAT_ID=<your Telegram user id>
ASSIST_DEBOUNCE_SECONDS=30
```

To get your user id: press **Start** on your bot, then either read it from the
collector log (the `/start` arrives as a private message and the id is the
`chat.id`), or ask **@userinfobot**. The bot can only DM you after you have
pressed Start.

Restart the MCP service and refresh the connector so the assist tools appear.

### 2. Point Claude Code at the connector

Copy `mcp.json.example` to `mcp.json` and put your connector URL (with the
secret) in it. The server key **must be `tg`** — the wrapper's `--allowedTools`
names `mcp__tg__*`.

### 3. Schedule the agent

```cron
* * * * * MCP_URL='https://YOUR_HOST/tg-mcp/YOUR_SECRET' SCOPE=private /path/to/agent/run-assist.sh
*/5 * * * * MCP_URL='https://YOUR_HOST/tg-mcp/YOUR_SECRET' SCOPE=group /path/to/agent/run-assist.sh
```

Every minute the wrapper asks the connector how many chats are unanswered. If
none, it exits — no Claude Code run, no tokens. Only when there is a real,
unanswered message does it spend a run to draft.

`SCOPE` picks which chats count as pending (default `all` if unset):

- `private` — 1:1 DMs through the business connection. The draft is written
  in the owner's voice and, once approved, goes out as the owner.
- `group` — groups and supergroups. The draft posts under the **bot's own
  name**, visible to everyone in the group, never as the owner. Groups are
  noisier than a DM inbox, so give this scope its own, slower cron line
  (e.g. every 5 minutes) rather than sharing the per-minute one with `private`.

## Files

| | |
|---|---|
| `assist-prompt.md` | the agent's instructions — read the thread, draft in your voice, submit |
| `run-assist.sh` | cron wrapper: cheap pending-check, then Claude Code only if there is work |
| `mcp.json.example` | Claude Code MCP config pointing at the connector |

## What it will and will not do

- **Will:** draft one reply per chat whose newest message is one you have not
  answered, checking the thread and your notes first, and DM it to you.
- **Will not:** send, edit, react or delete anything itself; draft for bots or
  notification services; draft for a thread you have already replied to; act
  without your Send tap.

## Cost

`assist_pending` is one SQL query behind the MCP — near-zero, so per-minute
polling is free on a quiet inbox. A Claude Code run happens only when there is
something to draft, and drafts one reply per waiting chat.
