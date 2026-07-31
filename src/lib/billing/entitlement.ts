export type SubscriptionStatus =
  | "pending"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "expired";

export interface SubscriptionEntitlementRow {
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_end: string | null;
}

export type EntitlementReason =
  | "operator"
  | "active"
  | "trialing"
  | "no_subscription"
  | "inactive_status"
  | "missing_expiration"
  | "expired";

export interface EntitlementDecision {
  hasAccess: boolean;
  reason: EntitlementReason;
  status: SubscriptionStatus | null;
  expiresAt: string | null;
}

const DENIED_NO_SUBSCRIPTION: EntitlementDecision = {
  hasAccess: false,
  reason: "no_subscription",
  status: null,
  expiresAt: null,
};

function parseFutureExpiration(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const expiresAt = Date.parse(value);
  return Number.isFinite(expiresAt) && expiresAt > nowMs ? expiresAt : null;
}

/**
 * Pure, fail-closed entitlement rule shared by server guards, Proxy,
 * API-key authentication, and the client-side realtime mirror.
 *
 * A status alone never grants access: trials need a future
 * `trial_ends_at`, and paid subscriptions need a future
 * `current_period_end`.
 */
export function evaluateSubscriptionEntitlement(
  subscription: SubscriptionEntitlementRow | null | undefined,
  now: Date | number = Date.now(),
): EntitlementDecision {
  if (!subscription) return { ...DENIED_NO_SUBSCRIPTION };

  const nowMs = typeof now === "number" ? now : now.getTime();
  const expiration =
    subscription.status === "trialing"
      ? subscription.trial_ends_at
      : subscription.status === "active"
        ? subscription.current_period_end
        : null;

  if (subscription.status !== "trialing" && subscription.status !== "active") {
    return {
      hasAccess: false,
      reason: "inactive_status",
      status: subscription.status,
      expiresAt: expiration,
    };
  }

  if (!expiration) {
    return {
      hasAccess: false,
      reason: "missing_expiration",
      status: subscription.status,
      expiresAt: null,
    };
  }

  const parsedExpiration = parseFutureExpiration(expiration, nowMs);
  if (!parsedExpiration) {
    return {
      hasAccess: false,
      reason: "expired",
      status: subscription.status,
      expiresAt: expiration,
    };
  }

  return {
    hasAccess: true,
    reason: subscription.status,
    status: subscription.status,
    expiresAt: new Date(parsedExpiration).toISOString(),
  };
}
