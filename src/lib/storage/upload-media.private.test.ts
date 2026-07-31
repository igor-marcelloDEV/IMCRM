import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencyMocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => dependencyMocks);

import { uploadAccountMedia } from "./upload-media";

function client() {
  const upload = vi.fn(async () => ({ error: null }));
  const createSignedUrl = vi.fn(async () => ({
    data: { signedUrl: "https://storage.example/signed/preview" },
    error: null,
  }));
  const getPublicUrl = vi.fn(() => ({
    data: { publicUrl: "https://storage.example/public/asset" },
  }));
  const remove = vi.fn(async () => ({ error: null }));
  const storageFrom = vi.fn(() => ({
    upload,
    createSignedUrl,
    getPublicUrl,
    remove,
  }));
  const profileQuery = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({
      data: { account_id: "acct-1" },
      error: null,
    })),
  };
  profileQuery.select.mockReturnValue(profileQuery);
  profileQuery.eq.mockReturnValue(profileQuery);

  return {
    value: {
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: "user-1" } },
          error: null,
        })),
      },
      from: vi.fn(() => profileQuery),
      storage: { from: storageFrom },
    },
    upload,
    createSignedUrl,
    getPublicUrl,
  };
}

describe("uploadAccountMedia privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only a temporary signed preview for chat-media", async () => {
    const mock = client();
    dependencyMocks.createClient.mockReturnValue(mock.value);

    const result = await uploadAccountMedia(
      "chat-media",
      { name: "photo.png", type: "image/png" } as File,
    );

    expect(result.url).toBe("https://storage.example/signed/preview");
    expect(result.path).toMatch(/^account-acct-1\/\d+-photo\.png$/);
    expect(mock.createSignedUrl).toHaveBeenCalledWith(result.path, 3600);
    expect(mock.getPublicUrl).not.toHaveBeenCalled();
  });

  it("preserves public URLs for flow-media in this phase", async () => {
    const mock = client();
    dependencyMocks.createClient.mockReturnValue(mock.value);

    const result = await uploadAccountMedia(
      "flow-media",
      { name: "template.png", type: "image/png" } as File,
    );

    expect(result.url).toBe("https://storage.example/public/asset");
    expect(mock.getPublicUrl).toHaveBeenCalledWith(result.path);
    expect(mock.createSignedUrl).not.toHaveBeenCalled();
  });
});
