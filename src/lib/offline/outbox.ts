import { outboxAdd, outboxRemove, outboxBumpAttempts, outboxList, outboxCount, type OutboxEntry } from "./db";

// Order-item mutations only (Fase 6 scope — see migration 086's
// header comment for why offline order *creation* is out of scope).
// `queueableFetch` never throws: a network failure queues the request
// into IndexedDB instead of surfacing an error, since "offline" isn't
// really a failure here, it's the expected condition this exists for.

export type QueueableResult<T> = { ok: true; data: T } | { ok: false; queued: true };

const SYNCED_EVENT = "imcrm:outbox-synced";

/** A real HTTP response came back rejecting the request (validation,
 *  stock, permissions, etc.) — distinct from `fetch()` itself throwing
 *  because the request never reached the server at all. Only the
 *  latter means "queue it for later". */
class HttpRejectionError extends Error {}

/** POST/PATCH that falls back to the offline queue on network failure.
 *  `body` always gets a `client_request_id` merged in — harmless for
 *  PATCH (which is naturally idempotent and just ignores the field),
 *  load-bearing for POST (see migration 086). */
export async function queueableFetch<T = unknown>(
  url: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<QueueableResult<T>> {
  const id = crypto.randomUUID();
  const fullBody = { ...body, client_request_id: id };

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    await outboxAdd({ id, url, method, body: fullBody, createdAt: Date.now(), attempts: 0 });
    return { ok: false, queued: true };
  }

  try {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fullBody),
    });
    if (!res.ok) {
      // A real server-side rejection (validation, stock, etc.) — not a
      // connectivity problem, so surface it normally rather than queuing.
      const data = await res.json().catch(() => ({}));
      throw new HttpRejectionError(data.error ?? `${method} ${url} failed (${res.status})`);
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    if (err instanceof HttpRejectionError) throw err;
    // fetch() itself threw (TypeError: Failed to fetch, or similar) —
    // the request never reached the server. That's the "actually
    // offline" case this queues for.
    await outboxAdd({ id, url, method, body: fullBody, createdAt: Date.now(), attempts: 0 });
    return { ok: false, queued: true };
  }
}

export async function pendingOutboxCount(): Promise<number> {
  return outboxCount();
}

/** Drains the outbox in FIFO order, stopping at the first entry that
 *  still fails (keeps ordering — replaying item-adds out of order
 *  could change which line an increment merges into). Dispatches
 *  `imcrm:outbox-synced` after every successful replay so any open
 *  order view can refetch and show the now-committed item. */
export async function drainOutbox(): Promise<void> {
  const entries = await outboxList();
  for (const entry of entries) {
    const ok = await replayOne(entry);
    if (!ok) break;
  }
}

async function replayOne(entry: OutboxEntry): Promise<boolean> {
  try {
    const res = await fetch(entry.url, {
      method: entry.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry.body),
    });
    if (!res.ok) {
      // Server rejected it outright (order was closed/canceled since,
      // etc.) — no amount of retrying fixes that. Drop it rather than
      // block every later entry behind a permanently-failing one.
      await outboxRemove(entry.id);
      return true;
    }
    await outboxRemove(entry.id);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(SYNCED_EVENT));
    }
    return true;
  } catch {
    await outboxBumpAttempts(entry.id);
    return false; // still offline (or the server's unreachable) — stop draining
  }
}

export { SYNCED_EVENT };
