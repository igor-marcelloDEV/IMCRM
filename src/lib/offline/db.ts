import { openDB, type DBSchema, type IDBPDatabase } from "idb";

// The offline order-taking store (Fase 6) — no IndexedDB usage existed
// anywhere in this codebase before this, so this is deliberately
// minimal: a queue of not-yet-sent mutations ("outbox") and a mirror
// of the last-fetched catalog so the item picker still has something
// to show while offline.

interface OutboxEntry {
  /** Also the idempotency key sent as `client_request_id`. */
  id: string;
  url: string;
  method: "POST" | "PATCH";
  body: unknown;
  createdAt: number;
  /** Bumped on each failed retry — surfaced so a permanently-stuck
   *  entry (e.g. the order was deleted server-side) is visible rather
   *  than retried forever silently. */
  attempts: number;
}

interface CatalogCacheEntry {
  accountId: string;
  items: unknown[];
  cachedAt: number;
}

interface OfflineDB extends DBSchema {
  outbox: {
    key: string;
    value: OutboxEntry;
    indexes: { "by-createdAt": number };
  };
  "catalog-cache": {
    key: string;
    value: CatalogCacheEntry;
  };
}

let dbPromise: Promise<IDBPDatabase<OfflineDB>> | null = null;

function getDb(): Promise<IDBPDatabase<OfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OfflineDB>("imcrm-offline", 1, {
      upgrade(db) {
        const outbox = db.createObjectStore("outbox", { keyPath: "id" });
        outbox.createIndex("by-createdAt", "createdAt");
        db.createObjectStore("catalog-cache", { keyPath: "accountId" });
      },
    });
  }
  return dbPromise;
}

export async function outboxAdd(entry: OutboxEntry): Promise<void> {
  const db = await getDb();
  await db.put("outbox", entry);
}

export async function outboxRemove(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("outbox", id);
}

export async function outboxBumpAttempts(id: string): Promise<void> {
  const db = await getDb();
  const entry = await db.get("outbox", id);
  if (entry) await db.put("outbox", { ...entry, attempts: entry.attempts + 1 });
}

export async function outboxList(): Promise<OutboxEntry[]> {
  const db = await getDb();
  return db.getAllFromIndex("outbox", "by-createdAt");
}

export async function outboxCount(): Promise<number> {
  const db = await getDb();
  return db.count("outbox");
}

export async function cacheCatalog(accountId: string, items: unknown[]): Promise<void> {
  const db = await getDb();
  await db.put("catalog-cache", { accountId, items, cachedAt: Date.now() });
}

export async function getCachedCatalog(accountId: string): Promise<unknown[] | null> {
  const db = await getDb();
  const entry = await db.get("catalog-cache", accountId);
  return entry?.items ?? null;
}

export type { OutboxEntry };
