import { drainOutbox } from "./outbox";

const FOREGROUND_POLL_MS = 30_000;

/** Wires up outbox draining: immediately on `online`, and on a
 *  foreground interval — iOS Safari has no Background Sync API, so a
 *  reconnect while the tab is backgrounded/closed only gets picked up
 *  once it's foregrounded again (or the next `online` event fires).
 *  Call once near the app root; returns a cleanup function. */
export function startOfflineSync(): () => void {
  if (typeof window === "undefined") return () => {};

  void drainOutbox();

  const onOnline = () => void drainOutbox();
  window.addEventListener("online", onOnline);

  const interval = setInterval(() => {
    if (navigator.onLine) void drainOutbox();
  }, FOREGROUND_POLL_MS);

  const onVisible = () => {
    if (document.visibilityState === "visible" && navigator.onLine) void drainOutbox();
  };
  document.addEventListener("visibilitychange", onVisible);

  return () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(interval);
  };
}
