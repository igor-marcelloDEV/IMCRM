import { config } from './config.js';

export interface InboundMessagePayload {
  accountId: string;
  fromPhone: string;
  contactName?: string;
  providerMessageKey: string;
  contentType: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location';
  contentText: string | null;
  mediaUrl?: string | null;
  replyToProviderMessageKey?: string | null;
  timestamp?: string;
}

/**
 * Deliver an inbound message to the main app's
 * `/api/whatsapp/worker-webhook`, which runs it through the same
 * `ingestInboundMessage` pipeline the Meta webhook uses (contact/
 * conversation creation, Flows, automations, AI auto-reply).
 *
 * Errors are logged, not thrown — a delivery failure here must not
 * crash the Baileys socket's event loop. A message that fails to
 * deliver is effectively dropped for v1; retry/backoff is a follow-up
 * if this turns out to matter in practice.
 */
export async function postInboundMessage(payload: InboundMessagePayload): Promise<void> {
  try {
    const response = await fetch(`${config.appBaseUrl}/api/whatsapp/worker-webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.workerApiSecret}`,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(
        `[webhook-client] app rejected inbound message for ${payload.accountId}: ${response.status} ${text}`,
      );
    }
  } catch (err) {
    console.error(`[webhook-client] failed to deliver inbound message for ${payload.accountId}:`, err);
  }
}
