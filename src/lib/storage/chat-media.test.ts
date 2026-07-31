import { describe, expect, it } from "vitest";

import {
  buildChatMediaInternalUrl,
  extractChatMediaPath,
  isChatMediaPathForAccount,
} from "./chat-media";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const PATH = `account-${ACCOUNT}/1700000000000-photo.png`;

describe("chat-media paths", () => {
  it("accepts only the caller account's canonical object path", () => {
    expect(isChatMediaPathForAccount(PATH, ACCOUNT)).toBe(true);
    expect(
      isChatMediaPathForAccount(
        "account-other/1700000000000-photo.png",
        ACCOUNT,
      ),
    ).toBe(false);
  });

  it.each([
    `account-${ACCOUNT}/../account-other/secret.png`,
    `account-${ACCOUNT}/..`,
    `account-${ACCOUNT}\\secret.png`,
    `/account-${ACCOUNT}/secret.png`,
    `account-${ACCOUNT}/folder/secret.png`,
    `account-${ACCOUNT}/`,
  ])("rejects traversal or non-canonical path %s", (path) => {
    expect(isChatMediaPathForAccount(path, ACCOUNT)).toBe(false);
  });

  it("builds and parses the stable authenticated URL", () => {
    const stableUrl = buildChatMediaInternalUrl(PATH);
    expect(stableUrl).toBe(
      `/api/whatsapp/media/chat?path=${encodeURIComponent(PATH)}`,
    );
    expect(extractChatMediaPath(stableUrl)).toBe(PATH);
  });

  it("extracts a path from legacy public and signed Storage URLs", () => {
    expect(
      extractChatMediaPath(
        `https://project.supabase.co/storage/v1/object/public/chat-media/${PATH}`,
      ),
    ).toBe(PATH);
    expect(
      extractChatMediaPath(
        `https://project.supabase.co/storage/v1/object/sign/chat-media/${PATH}?token=short`,
      ),
    ).toBe(PATH);
  });
});
