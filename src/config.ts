import path from "node:path";

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill it in, ` +
        `then run node with --env-file=.env`
    );
  }
  return v.trim();
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : fallback;
}

/** Telegram token lives here and nowhere else. It is never returned by any MCP tool. */
export const TELEGRAM_BOT_TOKEN = () => req("TELEGRAM_BOT_TOKEN");

export const DB_PATH = path.resolve(opt("DB_PATH", "./data/telegram.db"));
export const POLL_TIMEOUT = Number(opt("POLL_TIMEOUT", "30"));
export const LOG_RAW = opt("LOG_RAW", "0") === "1";

export const MCP_PORT = Number(opt("MCP_PORT", "8123"));
export const MCP_HOST = opt("MCP_HOST", "127.0.0.1");
export const MCP_PATH_SECRET = opt("MCP_PATH_SECRET", "");
export const MCP_BEARER_TOKEN = opt("MCP_BEARER_TOKEN", "");
