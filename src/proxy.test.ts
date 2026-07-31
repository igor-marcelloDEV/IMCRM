import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];
let mockAccountId: string | null = "acct-1";
let mockSubscription: {
  status: "active" | "trialing";
  trial_ends_at: string | null;
  current_period_end: string | null;
} | null = {
  status: "active",
  trial_ends_at: null,
  current_period_end: "2099-01-01T00:00:00.000Z",
};

function fromMock(table: string) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      if (table === "profiles") {
        return { data: mockAccountId ? { account_id: mockAccountId } : null };
      }
      if (table === "subscriptions") {
        return { data: mockSubscription, error: null };
      }
      return { data: null, error: null };
    },
  };
  return chain;
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (cookies: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
    from: fromMock,
  }),
}));

const { proxy } = await import("./proxy");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  delete process.env.PLATFORM_OPERATOR_ACCOUNT_ID;
  mockUser = null;
  refreshedCookies = [];
  mockAccountId = "acct-1";
  mockSubscription = {
    status: "active",
    trial_ends_at: null,
    current_period_end: "2099-01-01T00:00:00.000Z",
  };
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("proxy refreshed-cookie handling", () => {
  it("keeps a rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const response = await proxy(new NextRequest("https://app.test/login"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/today");
    expect(response.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("keeps cookie writes when redirecting an unauthenticated request", async () => {
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const response = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(response.headers.get("location")).toContain("/login");
    expect(response.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("preserves an invite token for an already signed-in user", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const response = await proxy(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(response.headers.get("location")).toContain("/join/abc123");
    expect(response.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("proxy optimistic entitlement gate", () => {
  it("redirects an account without an entitlement to billing", async () => {
    mockUser = { id: "user-1" };
    mockSubscription = null;

    const response = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(response.headers.get("location")).toContain("/billing");
  });

  it("allows active and trialing rows only while their date is future", async () => {
    mockUser = { id: "user-1" };

    for (const subscription of [
      {
        status: "active" as const,
        trial_ends_at: null,
        current_period_end: "2099-01-01T00:00:00.000Z",
      },
      {
        status: "trialing" as const,
        trial_ends_at: "2099-01-01T00:00:00.000Z",
        current_period_end: null,
      },
    ]) {
      mockSubscription = subscription;
      const response = await proxy(
        new NextRequest("https://app.test/dashboard"),
      );
      expect(response.headers.get("location")).toBeNull();
    }

    for (const subscription of [
      {
        status: "active" as const,
        trial_ends_at: null,
        current_period_end: "2000-01-01T00:00:00.000Z",
      },
      {
        status: "trialing" as const,
        trial_ends_at: "2000-01-01T00:00:00.000Z",
        current_period_end: null,
      },
    ]) {
      mockSubscription = subscription;
      const response = await proxy(
        new NextRequest("https://app.test/dashboard"),
      );
      expect(response.headers.get("location")).toContain("/billing");
    }
  });

  it("always leaves billing reachable", async () => {
    mockUser = { id: "user-1" };
    mockSubscription = null;

    const response = await proxy(new NextRequest("https://app.test/billing"));

    expect(response.headers.get("location")).toBeNull();
  });

  it("fails open optimistically when account context is unavailable", async () => {
    mockUser = { id: "user-1" };
    mockAccountId = null;
    mockSubscription = null;

    const response = await proxy(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(response.headers.get("location")).toBeNull();
  });

  it("explicitly exempts the platform operator from billing", async () => {
    mockUser = { id: "user-1" };
    mockSubscription = null;
    process.env.PLATFORM_OPERATOR_ACCOUNT_ID = "acct-1";

    const response = await proxy(new NextRequest("https://app.test/admin"));

    expect(response.headers.get("location")).toBeNull();
  });
});

describe("proxy protected-page coverage", () => {
  it.each([
    "/today",
    "/tasks",
    "/orders",
    "/flows",
    "/notifications",
    "/agents",
    "/admin",
  ])("redirects unauthenticated access to %s", async (pathname) => {
    const response = await proxy(
      new NextRequest(`https://app.test${pathname}`),
    );
    expect(response.headers.get("location")).toContain("/login");
  });
});
