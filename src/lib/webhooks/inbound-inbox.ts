import { createHash, randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

export type InboundWebhookProvider = 'whatsapp' | 'instagram';
export const MAX_INBOUND_WEBHOOK_BODY_BYTES = 1_048_576;

export interface RecordedInboundWebhook {
  outcomeStatus: 'pending' | 'processing' | 'failed' | 'processed' | 'dead';
  shouldProcess: boolean;
}

interface RecordedInboundWebhookRow {
  outcome_status: RecordedInboundWebhook['outcomeStatus'];
  should_process: boolean;
}

export function inboundWebhookEventKey(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

export function isInboundWebhookBodyTooLarge(rawBody: string): boolean {
  return Buffer.byteLength(rawBody, 'utf8') > MAX_INBOUND_WEBHOOK_BODY_BYTES;
}

export async function recordInboundWebhook(
  db: SupabaseClient,
  provider: InboundWebhookProvider,
  eventKey: string,
  rawBody: string
): Promise<RecordedInboundWebhook> {
  const { data, error } = await db
    .rpc('record_inbound_webhook_event', {
      p_provider: provider,
      p_event_key: eventKey,
      p_raw_body: rawBody,
    })
    .maybeSingle();

  if (error || !data) {
    throw new Error(
      `Could not persist ${provider} webhook: ${error?.message ?? 'empty RPC response'}`
    );
  }

  const row = data as unknown as RecordedInboundWebhookRow;
  return {
    outcomeStatus: row.outcome_status,
    shouldProcess: row.should_process,
  };
}

export type TrackedInboundResult = 'processed' | 'busy';

/**
 * Claims, runs and completes one persisted inbound request.
 *
 * The provider-specific processor may safely throw.  We retain the exact
 * signed body, schedule exponential retry in SQL, then rethrow so the
 * runtime captures the original failure. Completion clears `raw_body`
 * immediately; only metadata remains for the 30-day audit window.
 */
export async function runTrackedInboundWebhook(
  db: SupabaseClient,
  provider: InboundWebhookProvider,
  eventKey: string,
  processor: () => Promise<void>
): Promise<TrackedInboundResult> {
  const leaseToken = randomUUID();
  const { data: claimed, error: claimError } = await db.rpc(
    'claim_inbound_webhook_event',
    {
      p_provider: provider,
      p_event_key: eventKey,
      p_lease_token: leaseToken,
      p_lease_seconds: 90,
    }
  );

  if (claimError) {
    throw new Error(
      `Could not claim ${provider} webhook: ${claimError.message}`
    );
  }
  if (claimed !== true) return 'busy';

  try {
    await processor();

    const { data: completed, error: completeError } = await db.rpc(
      'complete_inbound_webhook_event',
      {
        p_provider: provider,
        p_event_key: eventKey,
        p_lease_token: leaseToken,
      }
    );
    if (completeError || completed !== true) {
      throw new Error(
        `Could not complete ${provider} webhook: ${
          completeError?.message ?? 'event lease was lost'
        }`
      );
    }
    return 'processed';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { error: failError } = await db.rpc('fail_inbound_webhook_event', {
      p_provider: provider,
      p_event_key: eventKey,
      p_lease_token: leaseToken,
      p_error: message,
      p_max_attempts: 12,
    });
    if (failError) {
      console.error(
        `[${provider} webhook] could not persist failure state:`,
        failError
      );
    }
    throw error;
  }
}
