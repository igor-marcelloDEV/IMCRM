import type { SupabaseClient } from "@supabase/supabase-js";

import {
  evaluateSubscriptionEntitlement,
  type EntitlementDecision,
  type SubscriptionEntitlementRow,
} from "./entitlement";

/**
 * Loads the newest subscription row and evaluates it with the single
 * entitlement rule. The platform-operator account is an explicit
 * exception: it must remain able to administer billing even when it
 * is not itself a paying tenant.
 */
export async function getAccountEntitlement(
  supabase: SupabaseClient,
  accountId: string,
  now: Date | number = Date.now(),
): Promise<EntitlementDecision> {
  const operatorAccountId = process.env.PLATFORM_OPERATOR_ACCOUNT_ID;
  if (operatorAccountId && accountId === operatorAccountId) {
    return {
      hasAccess: true,
      reason: "operator",
      status: null,
      expiresAt: null,
    };
  }

  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, trial_ends_at, current_period_end")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[getAccountEntitlement] subscription fetch error:", error);
    return {
      hasAccess: false,
      reason: "no_subscription",
      status: null,
      expiresAt: null,
    };
  }

  return evaluateSubscriptionEntitlement(
    data as SubscriptionEntitlementRow | null,
    now,
  );
}
