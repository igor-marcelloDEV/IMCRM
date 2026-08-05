"use client";

import { useEffect } from "react";
import { CloudOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { useOutboxCount } from "@/hooks/use-outbox-count";
import { startOfflineSync } from "@/lib/offline/sync";

/** Starts the offline-outbox sync loop once for the whole dashboard,
 *  and shows a small badge whenever there's queued work — either
 *  because we're offline right now, or because a drain is still
 *  catching up right after reconnecting. Renders nothing otherwise. */
export function SyncStatusBadge() {
  const online = useOnlineStatus();
  const pending = useOutboxCount();

  useEffect(() => startOfflineSync(), []);

  if (online && pending === 0) return null;

  return (
    <div className="flex h-9 items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 text-xs font-medium text-amber-500">
      <CloudOff className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">
        {!online ? "Offline" : "Sincronizando"}
        {pending > 0 && ` — ${pending} pendente${pending === 1 ? "" : "s"}`}
      </span>
      {pending > 0 && <span className="sm:hidden">{pending}</span>}
    </div>
  );
}
