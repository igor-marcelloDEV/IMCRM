import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

export const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const BLOCKING_SUBSCRIPTION_STATUSES = [
  "pending",
  "trialing",
  "active",
  "past_due",
] as const;

export type TrialClaimPreview =
  | "claimable"
  | "invalid"
  | "already_claimed"
  | "already_subscribed";

export type TrialClaimResult =
  | "claimed"
  | "invalid"
  | "already_claimed"
  | "already_subscribed"
  | "unavailable";

interface TrialNudge {
  accountId: string;
  claimedAt: string | null;
  expiresAt: string | null;
}

export interface TrialClaimRepository {
  findNudge(token: string): Promise<TrialNudge | null>;
  hasBlockingSubscription(accountId: string): Promise<boolean>;
  findMonthlyPlanId(): Promise<string | null>;
  insertTrial(args: {
    accountId: string;
    planId: string;
    trialEndsAt: string;
  }): Promise<"created" | "conflict">;
  markClaimed(accountId: string, claimedAt: string): Promise<void>;
}

export function isTrialClaimToken(token: string | null): token is string {
  return !!token && TOKEN_PATTERN.test(token);
}

export function hashTrialClaimToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function isExpired(expiresAt: string | null, now: Date | number): boolean {
  if (!expiresAt) return true;
  const nowMs = typeof now === "number" ? now : now.getTime();
  const parsed = Date.parse(expiresAt);
  return !Number.isFinite(parsed) || parsed <= nowMs;
}

export async function previewTrialClaim(
  repository: TrialClaimRepository,
  token: string | null,
  now: Date | number = Date.now(),
): Promise<TrialClaimPreview> {
  if (!isTrialClaimToken(token)) return "invalid";
  const nudge = await repository.findNudge(token);
  if (!nudge) return "invalid";
  if (nudge.claimedAt) return "already_claimed";
  if (isExpired(nudge.expiresAt, now)) return "invalid";
  if (await repository.hasBlockingSubscription(nudge.accountId)) {
    return "already_subscribed";
  }
  return "claimable";
}

/**
 * Idempotent trial provisioning. Replays never create a second
 * subscription, and a concurrent unique-index conflict is treated as
 * another request having completed the same logical operation.
 */
export async function claimTrial(
  repository: TrialClaimRepository,
  token: string | null,
  now: Date = new Date(),
): Promise<TrialClaimResult> {
  if (!isTrialClaimToken(token)) return "invalid";

  const nudge = await repository.findNudge(token);
  if (!nudge) return "invalid";
  if (nudge.claimedAt) return "already_claimed";
  if (isExpired(nudge.expiresAt, now)) return "invalid";

  const claimedAt = now.toISOString();
  if (await repository.hasBlockingSubscription(nudge.accountId)) {
    await repository.markClaimed(nudge.accountId, claimedAt);
    return "already_subscribed";
  }

  const planId = await repository.findMonthlyPlanId();
  if (!planId) return "unavailable";

  const insertResult = await repository.insertTrial({
    accountId: nudge.accountId,
    planId,
    trialEndsAt: new Date(now.getTime() + TRIAL_DURATION_MS).toISOString(),
  });
  await repository.markClaimed(nudge.accountId, claimedAt);

  return insertResult === "created" ? "claimed" : "already_subscribed";
}

export function createTrialClaimRepository(
  supabase: SupabaseClient,
): TrialClaimRepository {
  return {
    async findNudge(token) {
      const { data, error } = await supabase
        .from("billing_nudges")
        .select("account_id, trial_claimed_at, trial_claim_expires_at")
        .eq("trial_claim_token_hash", hashTrialClaimToken(token))
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        accountId: data.account_id as string,
        claimedAt: (data.trial_claimed_at as string | null) ?? null,
        expiresAt: (data.trial_claim_expires_at as string | null) ?? null,
      };
    },

    async hasBlockingSubscription(accountId) {
      const { data, error } = await supabase
        .from("subscriptions")
        .select("id")
        .eq("account_id", accountId)
        .in("status", [...BLOCKING_SUBSCRIPTION_STATUSES])
        .maybeSingle();
      if (error) throw error;
      return !!data;
    },

    async findMonthlyPlanId() {
      const { data, error } = await supabase
        .from("billing_plans")
        .select("id")
        .eq("code", "monthly")
        .maybeSingle();
      if (error) throw error;
      return (data?.id as string | undefined) ?? null;
    },

    async insertTrial({ accountId, planId, trialEndsAt }) {
      const { error } = await supabase.from("subscriptions").insert({
        account_id: accountId,
        plan_id: planId,
        status: "trialing",
        trial_ends_at: trialEndsAt,
      });
      if (!error) return "created";
      if (error.code === "23505") return "conflict";
      throw error;
    },

    async markClaimed(accountId, claimedAt) {
      const { error } = await supabase
        .from("billing_nudges")
        .update({ trial_claimed_at: claimedAt })
        .eq("account_id", accountId);
      if (error) throw error;
    },
  };
}
