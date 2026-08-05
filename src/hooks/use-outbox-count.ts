"use client";

import { useEffect, useState } from "react";
import { pendingOutboxCount, SYNCED_EVENT } from "@/lib/offline/outbox";

/** Live count of queued-but-not-yet-sent order mutations. Refreshes on
 *  the outbox's own "synced" event and on a short poll — there's no
 *  IndexedDB change-notification API to subscribe to directly. */
export function useOutboxCount(): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void pendingOutboxCount().then((n) => {
        if (!cancelled) setCount(n);
      });
    };
    refresh();
    window.addEventListener(SYNCED_EVENT, refresh);
    const interval = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.removeEventListener(SYNCED_EVENT, refresh);
      clearInterval(interval);
    };
  }, []);

  return count;
}
