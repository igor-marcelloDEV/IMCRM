import { describe, expect, it } from "vitest";

import {
  evaluateSubscriptionEntitlement,
  type SubscriptionEntitlementRow,
} from "./entitlement";

const NOW = new Date("2026-07-29T12:00:00.000Z");
const FUTURE = "2026-07-30T12:00:00.000Z";
const PAST = "2026-07-28T12:00:00.000Z";

function subscription(
  overrides: Partial<SubscriptionEntitlementRow>,
): SubscriptionEntitlementRow {
  return {
    status: "active",
    trial_ends_at: null,
    current_period_end: FUTURE,
    ...overrides,
  };
}

describe("evaluateSubscriptionEntitlement", () => {
  it("requires an active status and a future current period end", () => {
    expect(
      evaluateSubscriptionEntitlement(subscription({}), NOW),
    ).toMatchObject({ hasAccess: true, reason: "active" });
    expect(
      evaluateSubscriptionEntitlement(
        subscription({ current_period_end: PAST }),
        NOW,
      ),
    ).toMatchObject({ hasAccess: false, reason: "expired" });
    expect(
      evaluateSubscriptionEntitlement(
        subscription({ current_period_end: null }),
        NOW,
      ),
    ).toMatchObject({ hasAccess: false, reason: "missing_expiration" });
  });

  it("requires a trialing status and a future trial end", () => {
    expect(
      evaluateSubscriptionEntitlement(
        subscription({
          status: "trialing",
          trial_ends_at: FUTURE,
          current_period_end: null,
        }),
        NOW,
      ),
    ).toMatchObject({ hasAccess: true, reason: "trialing" });
    expect(
      evaluateSubscriptionEntitlement(
        subscription({
          status: "trialing",
          trial_ends_at: PAST,
          current_period_end: null,
        }),
        NOW,
      ),
    ).toMatchObject({ hasAccess: false, reason: "expired" });
  });

  it("denies non-granting statuses even when a date is in the future", () => {
    expect(
      evaluateSubscriptionEntitlement(
        subscription({ status: "past_due", current_period_end: FUTURE }),
        NOW,
      ),
    ).toMatchObject({ hasAccess: false, reason: "inactive_status" });
  });

  it("fails closed for missing subscriptions and invalid dates", () => {
    expect(evaluateSubscriptionEntitlement(null, NOW)).toMatchObject({
      hasAccess: false,
      reason: "no_subscription",
    });
    expect(
      evaluateSubscriptionEntitlement(
        subscription({ current_period_end: "not-a-date" }),
        NOW,
      ),
    ).toMatchObject({ hasAccess: false, reason: "expired" });
  });
});
