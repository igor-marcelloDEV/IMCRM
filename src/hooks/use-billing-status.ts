"use client";

import { useEffect, useId, useState } from "react";

import {
  evaluateSubscriptionEntitlement,
  type SubscriptionEntitlementRow,
  type SubscriptionStatus,
} from "@/lib/billing/entitlement";
import { createClient } from "@/lib/supabase/client";

export type BillingStatus = "loading" | "none" | SubscriptionStatus;

export interface BillingEntitlementState {
  status: BillingStatus;
  hasAccess: boolean;
  expiresAt: string | null;
}

const LOADING_STATE: BillingEntitlementState = {
  status: "loading",
  hasAccess: false,
  expiresAt: null,
};

/**
 * Realtime client mirror of the authoritative server entitlement.
 * Status alone is insufficient: the shared evaluator also checks the
 * corresponding trial/current-period expiration.
 */
export function useBillingStatus(
  accountId: string | null,
): BillingEntitlementState {
  const [state, setState] = useState<BillingEntitlementState>(LOADING_STATE);
  const instanceId = useId().replaceAll(":", "");

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    const load = async () => {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("status, trial_ends_at, current_period_end")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setState({ status: "none", hasAccess: false, expiresAt: null });
        return;
      }

      const row = data as SubscriptionEntitlementRow;
      const entitlement = evaluateSubscriptionEntitlement(row);
      setState({
        status: row.status,
        hasAccess: entitlement.hasAccess,
        expiresAt: entitlement.expiresAt,
      });
    };

    void load();

    const channel = supabase
      .channel(`billing-status-${accountId}-${instanceId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "subscriptions",
          filter: `account_id=eq.${accountId}`,
        },
        () => {
          void load();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [accountId, instanceId]);

  return state;
}
