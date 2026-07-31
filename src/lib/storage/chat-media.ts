export const CHAT_MEDIA_BUCKET = "chat-media";
export const CHAT_MEDIA_INTERNAL_PATH = "/api/whatsapp/media/chat";

/** Enough for a draft preview without turning it into a durable link. */
export const CHAT_MEDIA_PREVIEW_TTL_SECONDS = 60 * 60;

/** Meta/Baileys fetch immediately; keep the provider link deliberately short. */
export const CHAT_MEDIA_PROVIDER_TTL_SECONDS = 10 * 60;

const SAFE_OBJECT_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Chat uploads have exactly one account folder and one sanitized filename.
 * Rejecting extra segments, dot segments and backslashes keeps Storage from
 * ever interpreting a caller-controlled traversal differently from us.
 */
export function isChatMediaPathForAccount(
  path: string,
  accountId: string,
): boolean {
  if (!path || path.length > 1024 || path.includes("\\") || path.includes("\0")) {
    return false;
  }

  const segments = path.split("/");
  return (
    segments.length === 2 &&
    segments[0] === `account-${accountId}` &&
    SAFE_OBJECT_NAME.test(segments[1]) &&
    segments[1] !== "." &&
    segments[1] !== ".."
  );
}

export function buildChatMediaInternalUrl(path: string): string {
  return `${CHAT_MEDIA_INTERNAL_PATH}?path=${encodeURIComponent(path)}`;
}

/**
 * Recognize both the new authenticated URL and legacy public/signed
 * Supabase URLs. Used only to migrate/resolve media already stored before
 * `chat-media` became private.
 */
export function extractChatMediaPath(value: string): string | null {
  if (!value) return null;

  try {
    const url = new URL(value, "http://internal.invalid");
    if (url.pathname === CHAT_MEDIA_INTERNAL_PATH) {
      return url.searchParams.get("path");
    }

    for (const marker of [
      "/storage/v1/object/public/chat-media/",
      "/storage/v1/object/sign/chat-media/",
    ]) {
      const markerIndex = url.pathname.indexOf(marker);
      if (markerIndex === -1) continue;
      const encodedPath = url.pathname.slice(markerIndex + marker.length);
      return decodeURIComponent(encodedPath);
    }
  } catch {
    return null;
  }

  return null;
}
