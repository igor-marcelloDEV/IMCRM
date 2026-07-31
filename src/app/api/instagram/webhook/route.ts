import { NextResponse, after } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import {
  ingestInstagramComment,
  ingestInstagramMessage,
} from '@/lib/instagram/inbound';
import {
  inboundWebhookEventKey,
  isInboundWebhookBodyTooLarge,
  MAX_INBOUND_WEBHOOK_BODY_BYTES,
  recordInboundWebhook,
  runTrackedInboundWebhook,
} from '@/lib/webhooks/inbound-inbox';

// Mirrors src/app/api/whatsapp/webhook/route.ts — same handshake +
// signature verification (it's the same Meta App, so the same
// META_APP_SECRET signs both), same after()-deferred processing so we
// ack Meta within its timeout while the DB work still completes on a
// serverless runtime (see that file's comment for the incident this
// pattern fixed).
export const maxDuration = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null;
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    );
  }
  return _adminClient;
}

interface InstagramCommentChangeValue {
  id: string;
  text?: string;
  from?: { id: string; username?: string };
  media?: { id: string };
}

interface InstagramMessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  message?: {
    mid: string;
    text?: string;
    is_echo?: boolean;
    attachments?: { type: string; payload?: { url?: string } }[];
  };
}

interface InstagramWebhookEntry {
  id: string;
  time?: number;
  changes?: { field: string; value: InstagramCommentChangeValue }[];
  messaging?: InstagramMessagingEvent[];
}

// GET — webhook verification handshake (identical shape to the
// WhatsApp webhook's, scoped to instagram_configs instead).
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mode = searchParams.get('hub.mode');
    const challenge = searchParams.get('hub.challenge');
    const verifyToken = searchParams.get('hub.verify_token');

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      );
    }

    const { data: configs, error: configError } = await supabaseAdmin()
      .from('instagram_configs')
      .select('id, verify_token');

    if (configError || !configs) {
      console.error(
        '[instagram webhook] Error fetching configs for verification:',
        configError
      );
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null;
    for (const config of configs) {
      if (!config.verify_token) continue;
      try {
        if (decrypt(config.verify_token) === verifyToken) {
          matchedConfig = config;
          break;
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      if (isLegacyFormat(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('instagram_configs')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[instagram webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error
              );
            }
          });
      }
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    );
  } catch (error) {
    console.error('[instagram webhook] Error in GET verification:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST — comments + DMs
export async function POST(request: Request) {
  const declaredLength = Number.parseInt(
    request.headers.get('content-length') ?? '',
    10
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_INBOUND_WEBHOOK_BODY_BYTES
  ) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  const rawBody = await request.text();
  if (isInboundWebhookBodyTooLarge(rawBody)) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }
  const signature = request.headers.get('x-hub-signature-256');

  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[instagram webhook] rejected request with invalid signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: { entry?: InstagramWebhookEntry[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventKey = inboundWebhookEventKey(rawBody);
  const db = supabaseAdmin();
  let shouldProcess = false;
  try {
    const recorded = await recordInboundWebhook(
      db,
      'instagram',
      eventKey,
      rawBody
    );
    shouldProcess = recorded.shouldProcess;
  } catch (error) {
    console.error(
      '[instagram webhook] could not persist inbound request:',
      error
    );
    return NextResponse.json(
      { error: 'Temporary webhook persistence failure' },
      { status: 503 }
    );
  }

  if (shouldProcess) {
    after(async () => {
      try {
        await runTrackedInboundWebhook(db, 'instagram', eventKey, () =>
          processWebhook(body)
        );
      } catch (error) {
        console.error('[instagram webhook] Error processing webhook:', error);
      }
    });
  }

  return NextResponse.json(
    { status: 'received', duplicate: !shouldProcess },
    { status: 200 }
  );
}

async function processWebhook(body: { entry?: InstagramWebhookEntry[] }) {
  if (!body.entry) return;

  for (const entry of body.entry) {
    // `entry.id` is the IG Business Account id — how Meta tells us
    // which connected tenant this event belongs to (mirrors the
    // WhatsApp webhook's phone_number_id lookup).
    const { data: config, error: configError } = await supabaseAdmin()
      .from('instagram_configs')
      .select('*')
      .eq('instagram_business_account_id', entry.id)
      .maybeSingle();

    if (configError) {
      console.error(
        '[instagram webhook] config lookup failed for',
        entry.id,
        configError
      );
      continue;
    }
    if (!config) {
      console.warn(
        '[instagram webhook] no config found for ig account',
        entry.id
      );
      continue;
    }

    const accountId = config.account_id as string;
    const configOwnerUserId = config.created_by as string;

    for (const change of entry.changes ?? []) {
      if (change.field !== 'comments') continue;
      const value = change.value;
      if (!value?.id || !value.from?.id) continue;
      await ingestInstagramComment(
        supabaseAdmin(),
        accountId,
        configOwnerUserId,
        {
          commentId: value.id,
          mediaId: value.media?.id ?? '',
          fromIgsid: value.from.id,
          fromUsername: value.from.username ?? null,
          text: value.text ?? '',
        }
      );
    }

    for (const event of entry.messaging ?? []) {
      // Echoes are messages WE sent, delivered back on the same
      // webhook — skip them, they're not inbound.
      if (event.message?.is_echo) continue;
      if (!event.sender?.id || !event.message?.mid) continue;
      await ingestInstagramMessage(
        supabaseAdmin(),
        accountId,
        configOwnerUserId,
        {
          senderIgsid: event.sender.id,
          recipientIgsid: event.recipient?.id ?? entry.id,
          mid: event.message.mid,
          text: event.message.text ?? null,
          attachmentUrl: event.message.attachments?.[0]?.payload?.url ?? null,
          timestamp: event.timestamp ?? Date.now(),
        }
      );
    }
  }
}
