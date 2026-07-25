import { downloadMediaMessage, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import pino from 'pino';
import { supabaseAdmin } from './supabase-admin.js';

const CHAT_MEDIA_BUCKET = 'chat-media';
const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  image: 'jpg',
  video: 'mp4',
  audio: 'ogg',
  document: 'bin',
};

/**
 * Fallback content-type per message kind, used only when Baileys
 * didn't report one on the message itself. Must match one of
 * `chat-media`'s `allowed_mime_types` (see migration
 * 023_chat_media.sql) or Supabase Storage rejects the upload.
 */
const DEFAULT_MIME_BY_CONTENT_TYPE: Record<string, string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  audio: 'audio/ogg',
  document: 'application/pdf',
};

/**
 * Normalize a WhatsApp-reported mimetype to one `chat-media`'s bucket
 * actually allows. WhatsApp sends parameterized values (e.g. voice
 * notes as `audio/ogg; codecs=opus`) that don't exact-match the
 * bucket's plain `audio/ogg` allow-list entry, and Baileys documents
 * can carry types (e.g. a stray `text/plain;charset=UTF-8`, the bug
 * this function was added to fix) that need to fall back to a known-
 * good default rather than fail the whole upload.
 */
function normalizeMimeType(raw: string | undefined | null, contentType: string): string {
  const base = raw?.split(';')[0]?.trim().toLowerCase();
  const ALLOWED = new Set([
    'image/png', 'image/jpeg', 'image/webp',
    'video/mp4', 'video/3gpp',
    'application/pdf', 'application/vnd.ms-powerpoint', 'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'audio/ogg', 'audio/mpeg',
  ]);
  if (base && ALLOWED.has(base)) return base;
  return DEFAULT_MIME_BY_CONTENT_TYPE[contentType] ?? 'application/octet-stream';
}

/**
 * Download an inbound media message's bytes and upload them to the
 * same `chat-media` Storage bucket (and account-scoped path
 * convention: `account-<id>/<timestamp>-<name>.<ext>`) that
 * `src/lib/storage/upload-media.ts` uses for agent-uploaded
 * attachments in the main app — so `messages.media_url` works
 * identically regardless of which path produced it. Returns the
 * public URL, or null on failure (message still lands with no
 * attachment rather than being dropped entirely).
 */
export async function downloadAndHostMedia(
  sock: WASocket,
  msg: WAMessage,
  accountId: string,
  contentType: 'image' | 'video' | 'audio' | 'document',
  fileName?: string | null,
  mimeType?: string | null,
): Promise<string | null> {
  try {
    const buffer = (await downloadMediaMessage(
      msg,
      'buffer',
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    )) as Buffer;

    const ext = fileName?.includes('.')
      ? fileName.split('.').pop()!.toLowerCase()
      : EXT_BY_CONTENT_TYPE[contentType];
    const path = `account-${accountId}/${Date.now()}-baileys-inbound.${ext}`;
    const normalizedMimeType = normalizeMimeType(mimeType, contentType);

    const { error } = await supabaseAdmin.storage.from(CHAT_MEDIA_BUCKET).upload(path, buffer, {
      cacheControl: '3600',
      upsert: false,
      contentType: normalizedMimeType,
    });
    if (error) {
      console.error('[media] upload failed:', error.message);
      return null;
    }

    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from(CHAT_MEDIA_BUCKET).getPublicUrl(path);
    return publicUrl;
  } catch (err) {
    console.error('[media] download failed:', err);
    return null;
  }
}
