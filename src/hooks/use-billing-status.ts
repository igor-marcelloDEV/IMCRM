"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type BillingStatus =
  | "loading"
  | "none"
  | "pending"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "expired";

/** Statuses that grant full app access. Everything else routes the
 *  account to /billing — see middleware.ts + dashboard-shell.tsx. */
const ACCESS_GRANTING: BillingStatus[] = ["trialing", "active"];

export function hasBillingAccess(status: BillingStatus): boolean {
  return ACCESS_GRANTING.includes(status);
}

/**
 * Current account's subscription status, refreshed in realtime.
 * Mirrors `useUnreadNotifications` (fetch-once + postgres_changes
 * subscription) so the app unblocks the instant the Asaas webhook
 * confirms a payment, without the user needing to refresh.
 */
export function useBillingStatus(accountId: string | null): BillingStatus {
  const [status, setStatus] = useState<BillingStatus>("loading");
  // Both DashboardShellInner and the /billing page call this hook, so
  // two instances are mounted at once whenever /billing itself is the
  // active page. Supabase Realtime topics are per-connection — two
  // `.channel()` calls sharing the exact same topic name collide (the
  // second join can fail or tear down the first), so each instance
  // needs its own unique topic even though they watch the same rows.
  const instanceIdRef = useRef(Math.random().toString(36).slice(2));

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    const load = async () => {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("status")
        .eq("account_id", accountId)
        .in("status", ["pending", "trialing", "active", "past_due", "canceled", "expired"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setStatus("none");
        return;
      }
      setStatus(data.status as BillingStatus);
    };

    void load();

    const channel = supabase
      .channel(`billing-status-${accountId}-${instanceIdRef.current}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "subscriptions", filter: `account_id=eq.${accountId}` },
        () => {
          // Any change (insert/update) to this account's subscription
          // row(s) — just re-fetch rather than trying to reconcile the
          // realtime payload by hand (there's at most one live row,
          // so a full reload is cheap).
          void load();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [accountId]);

  return status;
}
