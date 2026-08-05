import { describe, expect, it } from "vitest";

import {
  claimTrial,
  hashTrialClaimToken,
  previewTrialClaim,
  type TrialClaimRepository,
} from "./trial-claim";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEF";
const NOW = new Date("2026-07-29T12:00:00.000Z");
const EXPIRES_AT = "2026-08-05T12:00:00.000Z";

function inMemoryRepository(options?: {
  blockingSubscription?: boolean;
}): TrialClaimRepository & { insertCount: number; trialEndsAt: string | null } {
  let claimedAt: string | null = null;
  let blockingSubscription = options?.blockingSubscription ?? false;
  const repository = {
    insertCount: 0,
    trialEndsAt: null as string | null,
    async findNudge(token: string) {
      return token === TOKEN
        ? { accountId: "acct-1", claimedAt, expiresAt: EXPIRES_AT }
        : null;
    },
    async hasBlockingSubscription() {
      return blockingSubscription;
    },
    async findMonthlyPlanId() {
      return "plan-monthly";
    },
    async insertTrial({ trialEndsAt }: { trialEndsAt: string }) {
      repository.insertCount += 1;
      repository.trialEndsAt = trialEndsAt;
      blockingSubscription = true;
      return "created" as const;
    },
    async markClaimed(_accountId: string, value: string) {
      claimedAt = value;
    },
  };
  return repository;
}

describe("trial claim", () => {
  it("keeps preview read-only", async () => {
    const repository = inMemoryRepository();
    await expect(previewTrialClaim(repository, TOKEN, NOW)).resolves.toBe(
      "claimable",
    );
    expect(repository.insertCount).toBe(0);
  });

  it("provisions once and treats a replay idempotently", async () => {
    const repository = inMemoryRepository();

    await expect(claimTrial(repository, TOKEN, NOW)).resolves.toBe("claimed");
    await expect(claimTrial(repository, TOKEN, NOW)).resolves.toBe(
      "already_claimed",
    );

    expect(repository.insertCount).toBe(1);
    expect(repository.trialEndsAt).toBe("2026-08-05T12:00:00.000Z");
  });

  it("does not create a trial over an existing subscription", async () => {
    const repository = inMemoryRepository({ blockingSubscription: true });

    await expect(claimTrial(repository, TOKEN, NOW)).resolves.toBe(
      "already_subscribed",
    );
    expect(repository.insertCount).toBe(0);
  });

  it("rejects malformed bearer tokens before repository access", async () => {
    const repository = inMemoryRepository();
    await expect(claimTrial(repository, "<script>", NOW)).resolves.toBe(
      "invalid",
    );
    expect(repository.insertCount).toBe(0);
  });

  it("rejects an expired offer", async () => {
    const repository = inMemoryRepository();
    await expect(
      previewTrialClaim(
        {
          ...repository,
          async findNudge() {
            return {
              accountId: "acct-1",
              claimedAt: null,
              expiresAt: "2026-07-28T12:00:00.000Z",
            };
          },
        },
        TOKEN,
        NOW,
      ),
    ).resolves.toBe("invalid");
  });

  it("hashes bearer tokens deterministically without storing the raw value", () => {
    expect(hashTrialClaimToken(TOKEN)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashTrialClaimToken(TOKEN)).toBe(hashTrialClaimToken(TOKEN));
    expect(hashTrialClaimToken(TOKEN)).not.toContain(TOKEN);
  });
});
