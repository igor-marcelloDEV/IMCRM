import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
// `mockAccountId`    — profiles.account_id the billing gate looks up for
//                      `mockUser`; null mirrors a profile row that hasn't
//                      resolved (the gate no-ops rather than blocking).
// `mockSubscriptionStatus` — the account's live subscription status, or
//                      null for "no active/trialing row" (the billing gate
//                      redirects in that case).
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];
let mockAccountId: string | null = "acct-1";
let mockSubscriptionStatus: "active" | "trialing" | null = "active";

// Minimal chainable query-builder stub — just enough surface for the two
// call shapes middleware.ts actually uses (profiles / subscriptions
// point lookups), not a general Supabase client mock.
function fromMock(table: string) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    maybeSingle: async () => {
      if (table === "profiles") {
        return { data: mockAccountId ? { account_id: mockAccountId } : null };
      }
      if (table === "subscriptions") {
        return {
          data: mockSubscriptionStatus ? { status: mockSubscriptionStatus } : null,
        };
      }
      return { data: null };
    },
  };
  return chain;
}

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
    from: fromMock,
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
  mockAccountId = "acct-1";
  mockSubscriptionStatus = "active";
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — billing gate", () => {
  it("redirects to /billing when the account has no active/trialing subscription", async () => {
    mockUser = { id: "user-1" };
    mockSubscriptionStatus = null;

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/billing");
  });

  it("does not redirect when the subscription is active", async () => {
    mockUser = { id: "user-1" };
    mockSubscriptionStatus = "active";

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.headers.get("location")).toBeNull();
  });

  it("does not redirect when the subscription is trialing", async () => {
    mockUser = { id: "user-1" };
    mockSubscriptionStatus = "trialing";

    const res = await middleware(new NextRequest("https://app.test/inbox"));

    expect(res.headers.get("location")).toBeNull();
  });

  it("never redirects /billing itself, even with no subscription", async () => {
    mockUser = { id: "user-1" };
    mockSubscriptionStatus = null;

    const res = await middleware(new NextRequest("https://app.test/billing"));

    expect(res.headers.get("location")).toBeNull();
  });

  it("no-ops when the profile hasn't resolved an account_id yet", async () => {
    mockUser = { id: "user-1" };
    mockAccountId = null;
    mockSubscriptionStatus = null;

    const res = await middleware(new NextRequest("https://app.test/dashboard"));

    expect(res.headers.get("location")).toBeNull();
  });
});
