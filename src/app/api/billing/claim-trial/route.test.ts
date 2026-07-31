import { afterEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({ client: true })),
  createTrialClaimRepository: vi.fn(() => ({ repository: true })),
  previewTrialClaim: vi.fn(),
  claimTrial: vi.fn(),
}));

vi.mock("@/lib/billing/admin-client", () => ({
  supabaseAdmin: dependencyMocks.supabaseAdmin,
}));
vi.mock("@/lib/billing/trial-claim", () => ({
  createTrialClaimRepository: dependencyMocks.createTrialClaimRepository,
  previewTrialClaim: dependencyMocks.previewTrialClaim,
  claimTrial: dependencyMocks.claimTrial,
}));

import { GET, POST } from "./route";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEF";

describe("/api/billing/claim-trial", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps GET read-only and renders a POST confirmation", async () => {
    dependencyMocks.previewTrialClaim.mockResolvedValue("claimable");

    const response = await GET(
      new Request(
        `https://crm.example/api/billing/claim-trial?token=${TOKEN}`,
      ),
    );
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain('method="post"');
    expect(html).toContain(`value="${TOKEN}"`);
    expect(dependencyMocks.previewTrialClaim).toHaveBeenCalledTimes(1);
    expect(dependencyMocks.claimTrial).not.toHaveBeenCalled();
  });

  it("claims only on POST and redirects to login", async () => {
    dependencyMocks.claimTrial.mockResolvedValue("claimed");

    const body = new FormData();
    body.set("token", TOKEN);
    const response = await POST(
      new Request("https://crm.example/api/billing/claim-trial", {
        method: "POST",
        body,
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://crm.example/login");
    expect(dependencyMocks.claimTrial).toHaveBeenCalledWith(
      { repository: true },
      TOKEN,
    );
  });

  it("redirects malformed or missing links without mutating state", async () => {
    dependencyMocks.previewTrialClaim.mockResolvedValue("invalid");

    const response = await GET(
      new Request("https://crm.example/api/billing/claim-trial"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://crm.example/billing",
    );
    expect(dependencyMocks.claimTrial).not.toHaveBeenCalled();
  });

  it("treats a POST replay as success without a second user flow", async () => {
    dependencyMocks.claimTrial.mockResolvedValue("already_claimed");

    const response = await POST(
      new Request("https://crm.example/api/billing/claim-trial", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: TOKEN }),
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://crm.example/login");
  });
});
