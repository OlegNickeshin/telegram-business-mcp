#!/usr/bin/env bash
#
# Cron wrapper for the assist agent.
#
# Cheap first: ask the connector how many chats await a reply — one SQL delta
# behind the MCP. Only if something is pending do we spend a Claude Code run.
# So this can fire every minute and cost nothing on a quiet inbox.
#
# Env:
#   MCP_URL     full connector URL incl. the secret, e.g. https://host/tg-mcp/<secret>
#   CLAUDE_BIN  path to the claude CLI (default: claude)
#   AGENT_DIR   this directory (default: the script's own dir)
set -euo pipefail

AGENT_DIR="${AGENT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
: "${MCP_URL:?set MCP_URL to the connector URL including the secret}"

# --- cheap check: how many pending? ---------------------------------------
pending_json=$(curl -s -X POST "$MCP_URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"assist_pending","arguments":{}}}')

count=$(printf '%s' "$pending_json" \
  | grep -o '"count":[0-9]*' | head -1 | grep -o '[0-9]*' || true)
count=${count:-0}

if [ "$count" -eq 0 ]; then
  exit 0   # quiet inbox: no model spend
fi

echo "$(date -u +%FT%TZ) assist: $count pending, running agent"

# --- spend a run only when there is work ----------------------------------
# Headless Claude Code, pointed at the connector, allowed only the tools the
# agent needs. Adjust the flags to your Claude Code version if needed.
"$CLAUDE_BIN" -p "$(cat "$AGENT_DIR/assist-prompt.md")" \
  --mcp-config "$AGENT_DIR/mcp.json" \
  --allowedTools "mcp__tg__assist_pending,mcp__tg__assist_draft,mcp__tg__telegram_get_messages,mcp__tg__telegram_search_messages,mcp__tg__kb_search_notes" \
  --permission-mode acceptEdits \
  >> "$AGENT_DIR/assist.log" 2>&1
