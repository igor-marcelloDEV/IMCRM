import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type Contact,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { useSupabaseAuthState } from './auth-state.js';
import { updateConnectionStatus, clearAuthKeys } from './connections.js';
import { postInboundMessage } from './webhook-client.js';
import { downloadAndHostMedia } from './media.js';

/**
 * One Baileys socket per account, kept in memory for the life of the
 * process. A single worker instance serves every account that has
 * chosen the Baileys/WhatsApp Web provider — there's no per-tenant
 * process, just a per-tenant WebSocket inside this one.
 */
const sockets = new Map<string, WASocket>();

/**
 * Per-account cache of LID → phone-number JID, learned from Baileys'
 * `contacts.upsert`/`contacts.update` events (WhatsApp's contact sync
 * — the one public, documented source of this mapping; there is no
 * direct "resolve this LID" call in the library). Some chats are
 * addressed only by an opaque LID (`<id>@lid`) instead of the phone
 * number under WhatsApp's newer privacy model — until sync has told
 * us the matching phone JID, messages from that LID are skipped
 * rather than mis-filed under a fake "phone number" (see
 * `resolvePhoneJid`).
 */
const lidMaps = new Map<string, Map<string, string>>();

function getLidMap(accountId: string): Map<string, string> {
  let map = lidMaps.get(accountId);
  if (!map) {
    map = new Map();
    lidMaps.set(accountId, map);
  }
  return map;
}

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });

function toJid(phone: string): string {
  return `${phone.replace(/^\+/, '')}@s.whatsapp.net`;
}

function fromJid(jid: string): string {
  // Multi-device JIDs carry a `:deviceId` suffix (e.g.
  // `556592109521:61@s.whatsapp.net`) — most visible on the bot's own
  // `sock.user.id`, since that's always a specific linked device.
  // Strip it so the phone number we persist/display is clean.
  return jid.split('@')[0].split(':')[0];
}

/**
 * Resolve a message key's `remoteJid` to a real phone-number JID
 * (`<number>@s.whatsapp.net`).
 *
 * WhatsApp's newer privacy model addresses some chats by an opaque
 * "LID" (`<id>@lid`) instead of the phone number — the LID's user-part
 * is NOT a phone number and must never be treated as one (it was
 * being persisted as `contacts.phone`, producing contacts nobody could
 * actually be replied to). Three ways to resolve it, in order:
 *   1. `key.remoteJidAlt` the library attached directly (present on
 *      some message types).
 *   2. `lidMap`, learned from `contacts.upsert`/`contacts.update`.
 *   3. `sock.signalRepository.lidMapping.getPNForLID` — Baileys' own
 *      persistent LID↔PN store (backed by our Supabase auth-state
 *      keys, `key_type = 'lid-mapping'`; see migration
 *      038_baileys_lid_mapping.sql for why that needed its own fix).
 * Falls back to skipping the message (return null) rather than
 * guessing.
 */
async function resolvePhoneJid(
  sock: WASocket,
  key: proto.IMessageKey,
  lidMap: Map<string, string>,
): Promise<string | null> {
  const jid = key.remoteJid;
  if (!jid) return null;
  if (jid.endsWith('@s.whatsapp.net')) return jid;
  if (jid.endsWith('@lid')) {
    const alt = (key as { remoteJidAlt?: string }).remoteJidAlt;
    if (alt?.endsWith('@s.whatsapp.net')) return alt;

    const mapped = lidMap.get(jid);
    if (mapped?.endsWith('@s.whatsapp.net')) return mapped;

    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn) {
        const resolved = pn.endsWith('@s.whatsapp.net') ? pn : `${pn}@s.whatsapp.net`;
        lidMap.set(jid, resolved);
        return resolved;
      }
    } catch (err) {
      console.warn(`[baileys] getPNForLID failed for ${jid}:`, err);
    }
    return null;
  }
  return null;
}

export function isConnected(accountId: string): boolean {
  return sockets.has(accountId);
}

export async function startConnection(accountId: string): Promise<void> {
  if (sockets.has(accountId)) {
    // Already connecting or connected — connect() is meant to be
    // idempotent from the caller's (the Next.js route's) perspective.
    return;
  }

  const { state, saveCreds } = await useSupabaseAuthState(accountId);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  });

  sockets.set(accountId, sock);
  const lidMap = getLidMap(accountId);

  sock.ev.on('creds.update', saveCreds);

  const learnLidMappings = (contacts: (Contact | Partial<Contact>)[]) => {
    for (const c of contacts) {
      if (c.lid && c.phoneNumber) lidMap.set(c.lid, c.phoneNumber);
    }
  };
  sock.ev.on('contacts.upsert', learnLidMappings);
  sock.ev.on('contacts.update', learnLidMappings);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      await updateConnectionStatus(accountId, { status: 'qr_pending', qr_code: qrDataUrl });
    }

    if (connection === 'open') {
      const phoneNumber = sock.user?.id ? fromJid(sock.user.id) : null;
      await updateConnectionStatus(accountId, {
        status: 'connected',
        qr_code: null,
        phone_number: phoneNumber,
        connected_at: new Date().toISOString(),
      });
    }

    if (connection === 'close') {
      sockets.delete(accountId);
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        await updateConnectionStatus(accountId, {
          status: 'disconnected',
          qr_code: null,
          phone_number: null,
        });
        await clearAuthKeys(accountId);
      } else {
        // Transient drop (network blip, server restart on WhatsApp's
        // side, etc.) — reconnect automatically so the account doesn't
        // silently go dark until someone notices and re-scans a QR.
        await updateConnectionStatus(accountId, { status: 'disconnected' });
        startConnection(accountId).catch((err) =>
          console.error(`[baileys] reconnect failed for ${accountId}:`, err),
        );
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    // Own number, re-read per batch (cheap) so a message arriving right
    // after connect still sees it once `sock.user` populates.
    const ownPhone = sock.user?.id ? fromJid(sock.user.id) : null;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || !msg.key.remoteJid) continue;
      // Group messages (@g.us) and broadcast lists are out of scope
      // for v1 — this integration targets 1:1 customer conversations,
      // matching how the rest of IMCRM models a "contact".
      if (msg.key.remoteJid.endsWith('@g.us')) continue;

      const phoneJid = await resolvePhoneJid(sock, msg.key, lidMap);
      if (!phoneJid) {
        console.warn(
          `[baileys] skipping message with no resolvable phone JID (remoteJid=${msg.key.remoteJid}) for account ${accountId}`,
        );
        continue;
      }
      const fromPhone = fromJid(phoneJid);
      // "Message yourself" / notes-to-self and multi-device sync echoes
      // surface as inbound messages from the account's own number —
      // not a customer. Skip so they don't create a fake contact.
      if (ownPhone && fromPhone === ownPhone) continue;

      handleInboundMessage(accountId, sock, msg, fromPhone).catch((err) =>
        console.error(`[baileys] failed to handle inbound message for ${accountId}:`, err),
      );
    }
  });
}

export async function stopConnection(accountId: string): Promise<void> {
  const sock = sockets.get(accountId);
  if (sock) {
    try {
      await sock.logout();
    } catch {
      // Already dead on the wire — fall through to local cleanup.
    }
    sockets.delete(accountId);
  }
  lidMaps.delete(accountId);
  await clearAuthKeys(accountId);
  await updateConnectionStatus(accountId, { status: 'disconnected', qr_code: null, phone_number: null });
}

async function handleInboundMessage(
  accountId: string,
  sock: WASocket,
  msg: WAMessage,
  fromPhone: string,
): Promise<void> {
  const providerMessageKey = msg.key.id!;
  const contactName = msg.pushName ?? undefined;
  const m = msg.message!;

  // Ephemeral ("disappearing messages" mode) and view-once wrappers
  // aren't distinct content — they carry a completely normal
  // text/image/video message one level down at `.message`. Unwrapping
  // here means a view-once photo (very common — verification selfies,
  // etc.) lands as a real image instead of falling through to the
  // "unsupported" branch below, which is what was silently swallowing
  // a meaningful share of real inbound leads.
  const effective =
    m.ephemeralMessage?.message ??
    m.viewOnceMessage?.message ??
    m.viewOnceMessageV2?.message ??
    m.viewOnceMessageV2Extension?.message ??
    m;

  let contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' = 'text';
  let contentText: string | null = null;
  let mediaUrl: string | null = null;

  if (effective.conversation) {
    contentText = effective.conversation;
  } else if (effective.extendedTextMessage?.text) {
    contentText = effective.extendedTextMessage.text;
  } else if (effective.imageMessage) {
    contentType = 'image';
    contentText = effective.imageMessage.caption ?? null;
    mediaUrl = await downloadAndHostMedia(sock, msg, accountId, 'image', null, effective.imageMessage.mimetype);
  } else if (effective.videoMessage) {
    contentType = 'video';
    contentText = effective.videoMessage.caption ?? null;
    mediaUrl = await downloadAndHostMedia(sock, msg, accountId, 'video', null, effective.videoMessage.mimetype);
  } else if (effective.documentMessage) {
    contentType = 'document';
    contentText = effective.documentMessage.caption ?? effective.documentMessage.fileName ?? null;
    mediaUrl = await downloadAndHostMedia(
      sock, msg, accountId, 'document', effective.documentMessage.fileName, effective.documentMessage.mimetype,
    );
  } else if (effective.audioMessage) {
    contentType = 'audio';
    mediaUrl = await downloadAndHostMedia(sock, msg, accountId, 'audio', null, effective.audioMessage.mimetype);
  } else if (effective.locationMessage) {
    contentType = 'location';
    const loc = effective.locationMessage;
    contentText = [loc.name, loc.address, `${loc.degreesLatitude},${loc.degreesLongitude}`]
      .filter(Boolean)
      .join(' - ');
  } else if (effective.liveLocationMessage) {
    contentType = 'location';
    const loc = effective.liveLocationMessage;
    contentText = `${loc.degreesLatitude},${loc.degreesLongitude}`;
  } else {
    // Sticker, poll, reaction, shared contact, deleted/edited-message
    // protocol frames, etc. — not modelled as first-class content.
    // Bracketed, type-specific text so the thread isn't silently
    // missing a turn AND downstream consumers (automations
    // interpolating {{message.text}} into a deal title, an AI
    // auto-reply quoting it back) can recognize the `[...]` shape as
    // "not real customer text" and skip it instead of echoing it —
    // see interpolate() in src/lib/automations/engine.ts.
    if (effective.stickerMessage) contentText = '[Figurinha]';
    else if (effective.pollCreationMessage || effective.pollCreationMessageV2 || effective.pollCreationMessageV3) contentText = '[Enquete]';
    else if (effective.reactionMessage) contentText = `[Reação: ${effective.reactionMessage.text || '👍'}]`;
    else if (effective.contactMessage || effective.contactsArrayMessage) contentText = '[Contato compartilhado]';
    else contentText = '[Tipo de mensagem não suportado no WhatsApp Web]';
  }

  const replyToProviderMessageKey = m.extendedTextMessage?.contextInfo?.stanzaId ?? undefined;
  const timestamp = msg.messageTimestamp
    ? new Date(Number(msg.messageTimestamp) * 1000).toISOString()
    : undefined;

  await postInboundMessage({
    accountId,
    fromPhone,
    contactName,
    providerMessageKey,
    contentType,
    contentText,
    mediaUrl,
    replyToProviderMessageKey,
    timestamp,
  });
}

export interface SendTextRequest {
  type: 'text';
  to: string;
  text: string;
}

export interface SendMediaRequest {
  type: 'media';
  to: string;
  kind: 'image' | 'video' | 'document' | 'audio';
  link: string;
  caption?: string;
  filename?: string;
}

export type SendRequest = SendTextRequest | SendMediaRequest;

/**
 * Send a message through this account's Baileys socket.
 *
 * Note: `contextMessageId`/reply-quoting is intentionally not
 * supported — Baileys' quote feature needs the FULL original message
 * object, not just an id, and the worker doesn't keep a message
 * cache. A quoted send just lands as a normal, unquoted message. See
 * the plan doc's Baileys-scope notes.
 */
export async function sendViaBaileys(
  accountId: string,
  req: SendRequest,
): Promise<{ providerMessageKey: string }> {
  const sock = sockets.get(accountId);
  if (!sock) {
    throw new Error(`No active WhatsApp Web connection for account ${accountId}`);
  }

  const jid = toJid(req.to);
  let result: WAMessage | undefined;

  if (req.type === 'text') {
    result = await sock.sendMessage(jid, { text: req.text });
  } else {
    const caption = req.caption;
    switch (req.kind) {
      case 'image':
        result = await sock.sendMessage(jid, { image: { url: req.link }, caption });
        break;
      case 'video':
        result = await sock.sendMessage(jid, { video: { url: req.link }, caption });
        break;
      case 'document':
        result = await sock.sendMessage(jid, {
          document: { url: req.link },
          // Baileys requires a mimetype for documents; we only ever get
          // a URL + filename from the provider interface (mirrors how
          // Meta's sendMediaMessage works), so fall back to a generic
          // binary type rather than sniffing the URL/extension.
          mimetype: 'application/octet-stream',
          fileName: req.filename ?? 'file',
          caption,
        });
        break;
      case 'audio':
        result = await sock.sendMessage(jid, {
          audio: { url: req.link },
          mimetype: 'audio/ogg; codecs=opus',
        });
        break;
    }
  }

  if (!result?.key?.id) {
    throw new Error('WhatsApp Web send did not return a message id.');
  }
  return { providerMessageKey: result.key.id };
}
