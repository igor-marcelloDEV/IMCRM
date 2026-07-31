import { beforeEach, describe, expect, it, vi } from "vitest";

const accountMocks = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  toErrorResponse: vi.fn(() =>
    Response.json({ error: "Não autorizado" }, { status: 401 }),
  ),
}));

vi.mock("@/lib/auth/account", () => accountMocks);

import { GET } from "./route";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const PATH = `account-${ACCOUNT}/1700000000000-photo.png`;

describe("GET /api/whatsapp/media/chat", () => {
  const download = vi.fn();
  const from = vi.fn(() => ({ download }));

  beforeEach(() => {
    vi.clearAllMocks();
    accountMocks.getCurrentAccount.mockResolvedValue({
      accountId: ACCOUNT,
      supabase: { storage: { from } },
    });
  });

  it("streams account-owned media without public caching", async () => {
    download.mockResolvedValue({
      data: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      error: null,
    });

    const response = await GET(
      new Request(
        `https://crm.example/api/whatsapp/media/chat?path=${encodeURIComponent(PATH)}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(from).toHaveBeenCalledWith("chat-media");
    expect(download).toHaveBeenCalledWith(PATH);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it.each([
    "account-other/1700000000000-secret.png",
    `account-${ACCOUNT}/../account-other/secret.png`,
    `account-${ACCOUNT}\\secret.png`,
  ])("rejects cross-account or traversal path %s before Storage", async (path) => {
    const response = await GET(
      new Request(
        `https://crm.example/api/whatsapp/media/chat?path=${encodeURIComponent(path)}`,
      ),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(from).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it("authenticates before inspecting or downloading the object", async () => {
    accountMocks.getCurrentAccount.mockRejectedValue(new Error("no session"));

    const response = await GET(
      new Request(
        `https://crm.example/api/whatsapp/media/chat?path=${encodeURIComponent(PATH)}`,
      ),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(from).not.toHaveBeenCalled();
  });
});
