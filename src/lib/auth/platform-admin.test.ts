import { describe, expect, it } from "vitest";

import type { AccountContext } from "@/lib/auth/account";
import { ForbiddenError } from "@/lib/auth/account";
import { assertPlatformAdmin } from "./platform-admin";

function context(
  overrides: Partial<AccountContext> = {},
): AccountContext {
  return {
    supabase: {} as AccountContext["supabase"],
    userId: "owner-user",
    accountId: "operator-account",
    role: "owner",
    account: { id: "operator-account", name: "Operadora", logo_url: null },
    ...overrides,
  };
}

describe("assertPlatformAdmin", () => {
  it("allows the operator account owner", () => {
    expect(() =>
      assertPlatformAdmin(context(), {
        operatorAccountId: "operator-account",
      }),
    ).not.toThrow();
  });

  it.each(["agent", "viewer"] as const)(
    "rejects an operator-account %s before a cross-tenant read",
    (role) => {
      expect(() =>
        assertPlatformAdmin(context({ role }), {
          operatorAccountId: "operator-account",
        }),
      ).toThrow(ForbiddenError);
    },
  );

  it("rejects an owner from any other account", () => {
    expect(() =>
      assertPlatformAdmin(context({ accountId: "tenant-account" }), {
        operatorAccountId: "operator-account",
      }),
    ).toThrow(ForbiddenError);
  });

  it("requires the user allowlist whenever it is configured", () => {
    expect(() =>
      assertPlatformAdmin(context(), {
        operatorAccountId: "operator-account",
        adminUserIds: "other-owner, second-owner",
      }),
    ).toThrow(ForbiddenError);

    expect(() =>
      assertPlatformAdmin(context(), {
        operatorAccountId: "operator-account",
        adminUserIds: "other-owner, owner-user",
      }),
    ).not.toThrow();
  });
});
