import { afterEach, describe, expect, it } from "vitest";

import { getAccountEntitlement } from "./account-entitlement";

describe("getAccountEntitlement", () => {
  afterEach(() => {
    delete process.env.PLATFORM_OPERATOR_ACCOUNT_ID;
  });

  it("explicitly bypasses billing for the platform operator", async () => {
    process.env.PLATFORM_OPERATOR_ACCOUNT_ID = "operator-account";
    const client = {
      from() {
        throw new Error("operator bypass must not query subscriptions");
      },
    };

    await expect(
      getAccountEntitlement(client as never, "operator-account"),
    ).resolves.toMatchObject({ hasAccess: true, reason: "operator" });
  });
});
