import { migrate, openDb, getState, setState } from "./db.js";
import { ALLOW_ASSIST, handleAssistCallback } from "./assist.js";
import { LOG_RAW, POLL_TIMEOUT } from "./config.js";
import {
  ALLOWED_UPDATES,
  TelegramError,
  call,
  updateType,
  type TgBusinessConnection,
  type TgUpdate,
} from "./telegram.js";
import {
  alreadySeen,
  claimUpdate,
  markDeleted,
  saveBusinessConnection,
  saveBusinessMessage,
  saveEditedBusinessMessage,
} from "./store.js";

const OFFSET_KEY = "getUpdates_offset";

function log(...parts: unknown[]): void {
  console.log(new Date().toISOString(), ...parts);
}

function shortName(o: { first_name?: string | null; last_name?: string | null; username?: string | null }) {
  const name = [o.first_name, o.last_name].filter(Boolean).join(" ");
  const at = o.username ? `@${o.username}` : "";
  return [name, at].filter(Boolean).join(" ") || "(no name)";
}

function preview(s: string | undefined | null, n = 120): string {
  if (!s) return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
}

/**
 * A business_connection update is only sent when the connection changes, and
 * Telegram drops undelivered updates after 24h. If the bot was linked before
 * this collector first ran we would never learn the owner's user id (needed to
 * tell outgoing from incoming), so backfill it on first sight of a connection.
 */
async function ensureConnection(
  db: ReturnType<typeof openDb>,
  connectionId: string
): Promise<void> {
  if (!connectionId) return;
  const seen = db
    .prepare("SELECT 1 FROM business_connections WHERE id = ?")
    .get(connectionId);
  if (seen) return;
  try {
    const bc = await call<TgBusinessConnection>("getBusinessConnection", {
      business_connection_id: connectionId,
    });
    saveBusinessConnection(db, bc);
    log(
      `backfilled business_connection id=${bc.id} owner=${shortName(bc.user)} ` +
        `user_id=${bc.user.id} via getBusinessConnection`
    );
  } catch (err) {
    log(`could not backfill connection ${connectionId}: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const db = openDb();
  migrate(db);

  const me = await call<{ id: number; username?: string; can_connect_to_business?: boolean }>("getMe");
  log(`bot @${me.username} (id=${me.id}) can_connect_to_business=${me.can_connect_to_business}`);

  const hook = await call<{ url: string; pending_update_count: number }>("getWebhookInfo");
  if (hook.url) {
    log(`ERROR: a webhook is set (${hook.url}). getUpdates needs it removed: deleteWebhook.`);
    process.exit(1);
  }
  log(`no webhook set, pending updates: ${hook.pending_update_count}`);

  const known = db.prepare("SELECT COUNT(*) AS n FROM business_connections").get() as { n: number };
  log(`stored business connections: ${known.n}`);
  log(`polling getUpdates, allowed_updates=${JSON.stringify(ALLOWED_UPDATES)}`);

  let offset = Number(getState(db, OFFSET_KEY) ?? 0) || 0;
  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} received, stopping after the current poll`);
      stopping = true;
    });
  }

  while (!stopping) {
    let updates: TgUpdate[];
    try {
      updates = await call<TgUpdate[]>(
        "getUpdates",
        {
          offset: offset || undefined,
          timeout: POLL_TIMEOUT,
          allowed_updates: ALLOWED_UPDATES,
        },
        (POLL_TIMEOUT + 15) * 1000
      );
    } catch (err) {
      if (err instanceof TelegramError) {
        // 409 = another poller or a webhook is holding the queue; 429 = flood wait.
        const wait = err.retryAfter ?? (err.errorCode === 409 ? 5 : 3);
        log(`telegram error: ${err.message} — retrying in ${wait}s`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if ((err as { name?: string }).name === "AbortError") continue; // long-poll timed out
      log(`network error: ${(err as Error).message} — retrying in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const u of updates) {
      const type = updateType(u);

      if (alreadySeen(db, u.update_id)) {
        log(`update_id=${u.update_id} already stored, skipping (dedup)`);
        offset = Math.max(offset, u.update_id + 1);
        setState(db, OFFSET_KEY, String(offset));
        continue;
      }
      if (LOG_RAW) console.log(JSON.stringify(u));

      // Handle first, record second, advance the offset last. Recording an
      // update before it is handled means a crash in between loses it for good:
      // the dedup check would skip it on restart and Telegram will not send it
      // again. Message-level UNIQUE makes a redelivery harmless.
      try {
        if (u.business_connection) {
        const bc = u.business_connection;
        saveBusinessConnection(db, bc);
        log(
          `[business_connection] update_id=${u.update_id} id=${bc.id} ` +
            `user=${shortName(bc.user)} user_id=${bc.user.id} user_chat_id=${bc.user_chat_id} ` +
            `is_enabled=${bc.is_enabled !== false}`
        );
      } else if (u.business_message) {
        const m = u.business_message;
        await ensureConnection(db, m.business_connection_id ?? "");
        const r = saveBusinessMessage(db, m, u.update_id);
        log(
          `[business_message] update_id=${u.update_id} bc=${r.connectionId} ` +
            `chat.id=${m.chat.id} chat=${shortName(m.chat)} from.id=${m.from?.id} ` +
            `message_id=${m.message_id} date=${m.date} type=${r.contentType} ` +
            `dir=${r.outgoing ? "out" : "in"} ${r.inserted ? "" : "(dup, skipped)"} ` +
            `body="${preview(m.text ?? m.caption)}"`
        );
      } else if (u.edited_business_message) {
        const m = u.edited_business_message;
        await ensureConnection(db, m.business_connection_id ?? "");
        const r = saveEditedBusinessMessage(db, m, u.update_id);
        log(
          `[edited_business_message] update_id=${u.update_id} bc=${r.connectionId} ` +
            `chat.id=${m.chat.id} message_id=${m.message_id} edit_date=${m.edit_date} ` +
            `body="${preview(m.text ?? m.caption)}"`
        );
      } else if (u.deleted_business_messages) {
        const ev = u.deleted_business_messages;
        const n = markDeleted(db, ev);
        log(
          `[deleted_business_messages] update_id=${u.update_id} bc=${ev.business_connection_id} ` +
            `chat.id=${ev.chat.id} message_ids=${JSON.stringify(ev.message_ids)} marked=${n}`
        );
      } else if (u.message || u.edited_message) {
        // Groups and forum topics. These carry no business_connection_id, so
        // they land in the archive with an empty one and are told apart by the
        // chat type. Private chats also arrive here when someone writes to the
        // bot directly; Business already covers those, and the unique index
        // keeps the duplicate out.
        const m = (u.message ?? u.edited_message)!;
        const edited = !u.message;

        // Only groups. A private `message` is someone writing to the bot
        // directly: same chat.id as their business chat but a separate
        // message_id sequence, so mixing the two would corrupt the history.
        // Business already covers 1:1. Recorded as handled either way — an
        // update we deliberately ignore must still not be fetched forever.
        if (m.chat.type === "private") {
          log(`[message] update_id=${u.update_id} private chat ${m.chat.id}, ignored (Business covers 1:1)`);
        } else {
          const r = edited
            ? saveEditedBusinessMessage(db, m, u.update_id)
            : saveBusinessMessage(db, m, u.update_id);
          const where = m.chat.title ? `"${m.chat.title}"` : shortName(m.chat);
          const topic = m.message_thread_id ? ` thread=${m.message_thread_id}` : "";
          log(
            `[${edited ? "edited_message" : "message"}] update_id=${u.update_id} ` +
              `chat.id=${m.chat.id} type=${m.chat.type} ${where}${topic} ` +
              `from.id=${m.from?.id} message_id=${m.message_id} kind=${r.contentType} ` +
              `dir=${r.outgoing ? "out" : "in"} ${r.inserted || edited ? "" : "(dup, skipped)"} ` +
              `body="${preview(m.text ?? m.caption)}"`
          );
        }
        } else if ((u as { callback_query?: unknown }).callback_query) {
          // Assist mode: the owner tapped Send/Skip under a drafted reply.
          const cb = (u as unknown as { callback_query: Parameters<typeof handleAssistCallback>[1] }).callback_query;
          if (ALLOW_ASSIST) {
            const handled = await handleAssistCallback(db, cb);
            log(`[callback_query] update_id=${u.update_id} ${handled ? "handled" : "ignored"}`);
          } else {
            log(`[callback_query] update_id=${u.update_id} (assist disabled)`);
          }
        } else {
          log(`[${type}] update_id=${u.update_id} (stored raw, no handler)`);
        }
        claimUpdate(db, u.update_id, type, u);
      } catch (err) {
        // One malformed update must not wedge the collector forever, but it
        // must be loud and recoverable: the raw payload is kept and flagged, so
        // it can be replayed by hand once the cause is fixed.
        log(`FAILED update_id=${u.update_id} (${type}): ${(err as Error).message}`);
        claimUpdate(db, u.update_id, `error:${type}`, u);
      }

      offset = Math.max(offset, u.update_id + 1);
      setState(db, OFFSET_KEY, String(offset));
    }

    if (updates.length) setState(db, OFFSET_KEY, String(offset));
  }

  db.close();
  log("stopped");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
