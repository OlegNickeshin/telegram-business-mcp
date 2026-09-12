# Assist agent (Claude Code)

The connector side is `ALLOW_ASSIST`. This is the other half: a scheduled Claude
Code run that drafts replies and submits them for your approval.

## How it fits

```
someone writes you
   → collector archives it (realtime)
   → this agent (per minute, only if something is pending):
        assist_pending → telegram_get_messages / kb_search → assist_draft
   → the bot DMs you the draft with Send / Skip
   → you tap Send → it goes out as you
```

The connector holds no model. The drafting is entirely this agent's, so there is
no API key on the server and nothing is sent to anyone without you tapping Send.

## Setup

1. On the server, turn the module on: `ALLOW_ASSIST=1`, set `ASSIST_OWNER_CHAT_ID`
   to your own Telegram user id (press Start on the bot first, or it cannot DM
   you), and restart. Refresh the connector so the assist tools appear.
2. Copy `mcp.json.example` to `mcp.json` and put your connector URL (with the
   secret) in it.
3. Point the wrapper at the connector and schedule it:

   ```cron
   * * * * * MCP_URL='https://host/tg-mcp/SECRET' /path/to/agent/run-assist.sh
   ```

   Every minute it does a cheap "how many pending" check and only spends a
   Claude Code run when there is an unanswered message. A quiet inbox costs
   nothing.

## Why per-minute is fine

`assist_pending` is one SQL query behind the MCP — near-zero. The model wakes
only when the newest message in some chat is one you have not answered. Bursts
settle first (`ASSIST_DEBOUNCE_SECONDS`), and one draft is made per chat, not per
message.
