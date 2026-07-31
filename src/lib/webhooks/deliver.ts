// ============================================================
// Durable outbound webhook delivery.
//
// `dispatchWebhookEvent` now performs one responsibility synchronously:
// persist the exact payload once for every subscribed endpoint. A cron
// worker claims those rows with database leases and performs the HTTP
// attempt. Retries therefore survive process exits and serverless freezes.
// ============================================================

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { WebhookEvent } from '@/lib/webhooks/events';

export const DELIVERY_TIMEOUT_MS = 5000;
export const DELIVERY_LEASE_SECONDS = 60;
export const MAX_DELIVERY_ATTEMPTS = 8;
export const MAX_CONSECUTIVE_FAILURES = 15;
export const DEFAULT_DELIVERY_BATCH_SIZE = 50;
export const MAX_DELIVERY_BATCH_SIZE = 100;
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 60 * 60 * 1000;

interface EndpointSubscriptionRow {
  id: string;
}

export interface ClaimedWebhookDelivery {
  delivery_id: string;
  event_id: string;
  endpoint_id: string;
  account_id: string;
  event_name: WebhookEvent;
  payload_text: string;
  attempt_count: number;
  lease_token: string;
  endpoint_url: string;
  endpoint_secret: string;
}

export type DeliveryAttemptOutcome =
  | 'delivered'
  | 'retry_scheduled'
  | 'dead'
  | 'stale';

export interface DrainWebhookDeliveriesResult {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
  stale: number;
}

export class WebhookEnqueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookEnqueueError';
  }
}

export class WebhookDeliveryPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookDeliveryPersistenceError';
  }
}

/**
 * Enqueue one immutable copy per currently-subscribed endpoint.
 *
 * The event UUID and serialized body are created once and reused for every
 * endpoint row. Retries later send `payload` verbatim, so receiver dedupe and
 * HMAC verification remain stable. Database failures deliberately throw:
 * callers must never mistake a dropped durable enqueue for success.
 */
export async function dispatchWebhookEvent(
  db: SupabaseClient,
  accountId: string,
  event: WebhookEvent,
  data: unknown
): Promise<void> {
  const { data: rows, error } = await db
    .from('webhook_endpoints')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .contains('events', [event]);

  if (error) {
    throw new WebhookEnqueueError(
      `Failed to resolve webhook subscriptions: ${error.message}`
    );
  }

  const endpoints = (rows ?? []) as EndpointSubscriptionRow[];
  if (endpoints.length === 0) return;

  const eventId = randomUUID();
  const payload = JSON.stringify({
    id: eventId,
    event,
    occurred_at: new Date().toISOString(),
    account_id: accountId,
    data,
  });

  const deliveries = endpoints.map((endpoint) => ({
    event_id: eventId,
    endpoint_id: endpoint.id,
    account_id: accountId,
    event,
    payload,
  }));

  const { data: inserted, error: insertError } = await db
    .from('outbound_webhook_deliveries')
    .insert(deliveries)
    .select('id');

  if (insertError || !inserted || inserted.length !== deliveries.length) {
    throw new WebhookEnqueueError(
      `Failed to persist webhook deliveries: ${
        insertError?.message ?? 'insert count mismatch'
      }`
    );
  }
}

/** Exponential retry delay: 30s, 1m, 2m ... capped at one hour. */
export function retryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.floor(attemptCount) - 1);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

export function deliveryBatchSize(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_DELIVERY_BATCH_SIZE;
  }
  return Math.min(parsed, MAX_DELIVERY_BATCH_SIZE);
}

async function finalizeSuccess(
  db: SupabaseClient,
  delivery: ClaimedWebhookDelivery,
  responseStatus: number,
  deliveredAt: Date
): Promise<DeliveryAttemptOutcome> {
  const { data, error } = await db.rpc(
    'complete_outbound_webhook_delivery',
    {
      p_delivery_id: delivery.delivery_id,
      p_lease_token: delivery.lease_token,
      p_response_status: responseStatus,
      p_delivered_at: deliveredAt.toISOString(),
    }
  );
  if (error) {
    throw new WebhookDeliveryPersistenceError(
      `Failed to complete delivery ${delivery.delivery_id}: ${error.message}`
    );
  }
  return data === true ? 'delivered' : 'stale';
}

async function finalizeFailure(
  db: SupabaseClient,
  delivery: ClaimedWebhookDelivery,
  reason: string,
  responseStatus: number | null,
  failedAt: Date
): Promise<DeliveryAttemptOutcome> {
  const nextAttemptAt = new Date(
    failedAt.getTime() + retryDelayMs(delivery.attempt_count)
  );
  const { data, error } = await db.rpc('fail_outbound_webhook_delivery', {
    p_delivery_id: delivery.delivery_id,
    p_lease_token: delivery.lease_token,
    p_next_attempt_at: nextAttemptAt.toISOString(),
    p_error: reason.slice(0, 2000),
    p_response_status: responseStatus,
    p_max_attempts: MAX_DELIVERY_ATTEMPTS,
    p_max_endpoint_failures: MAX_CONSECUTIVE_FAILURES,
  });
  if (error) {
    throw new WebhookDeliveryPersistenceError(
      `Failed to record delivery ${delivery.delivery_id}: ${error.message}`
    );
  }
  if (
    data !== 'retry_scheduled' &&
    data !== 'dead' &&
    data !== 'stale'
  ) {
    throw new WebhookDeliveryPersistenceError(
      `Unexpected failure outcome for delivery ${delivery.delivery_id}`
    );
  }
  return data;
}

/**
 * Execute one claimed delivery. SSRF validation and secret decryption happen
 * on every attempt; redirects remain disabled. Only the exact persisted
 * `payload_text` is signed and sent.
 */
export async function processClaimedWebhookDelivery(
  db: SupabaseClient,
  delivery: ClaimedWebhookDelivery,
  now: Date = new Date()
): Promise<DeliveryAttemptOutcome> {
  if (!(await isDeliverableUrl(delivery.endpoint_url))) {
    return finalizeFailure(
      db,
      delivery,
      'refused non-public delivery target',
      null,
      now
    );
  }

  let secret: string;
  try {
    secret = decrypt(delivery.endpoint_secret);
  } catch {
    return finalizeFailure(
      db,
      delivery,
      'endpoint secret could not be decrypted',
      null,
      now
    );
  }

  let response: Response;
  try {
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    response = await fetch(delivery.endpoint_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Imcrm-Event': delivery.event_name,
        // Compatibility: this header has always identified the endpoint.
        'X-Imcrm-Webhook-Id': delivery.endpoint_id,
        // New durable attempt identifier, stable across retries.
        'X-Imcrm-Delivery-Id': delivery.delivery_id,
        'X-Imcrm-Signature': buildSignatureHeader(
          delivery.payload_text,
          secret,
          timestampSeconds
        ),
      },
      body: delivery.payload_text,
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'webhook request failed';
    return finalizeFailure(db, delivery, reason, null, now);
  }

  if (!response.ok) {
    return finalizeFailure(
      db,
      delivery,
      `endpoint responded ${response.status}`,
      response.status,
      now
    );
  }

  return finalizeSuccess(db, delivery, response.status, now);
}

/**
 * Claim a batch with database leases and process distinct endpoints in
 * parallel. Finalization errors are rethrown after the rest of the batch has
 * settled; their rows recover after lease expiry instead of disappearing.
 */
export async function drainWebhookDeliveries(
  db: SupabaseClient,
  options: {
    batchSize?: number;
    now?: Date;
  } = {}
): Promise<DrainWebhookDeliveriesResult> {
  const batchSize = Math.min(
    Math.max(options.batchSize ?? DEFAULT_DELIVERY_BATCH_SIZE, 1),
    MAX_DELIVERY_BATCH_SIZE
  );
  const { data, error } = await db.rpc(
    'claim_outbound_webhook_deliveries',
    {
      p_limit: batchSize,
      p_lease_seconds: DELIVERY_LEASE_SECONDS,
      p_max_attempts: MAX_DELIVERY_ATTEMPTS,
    }
  );
  if (error) {
    throw new WebhookDeliveryPersistenceError(
      `Failed to claim webhook deliveries: ${error.message}`
    );
  }

  const deliveries = (data ?? []) as ClaimedWebhookDelivery[];
  const result: DrainWebhookDeliveriesResult = {
    claimed: deliveries.length,
    delivered: 0,
    retried: 0,
    dead: 0,
    stale: 0,
  };
  if (deliveries.length === 0) return result;

  const settled = await Promise.allSettled(
    deliveries.map((delivery) =>
      processClaimedWebhookDelivery(db, delivery, options.now ?? new Date())
    )
  );

  const persistenceErrors: unknown[] = [];
  for (const attempt of settled) {
    if (attempt.status === 'rejected') {
      persistenceErrors.push(attempt.reason);
      continue;
    }
    if (attempt.value === 'delivered') result.delivered += 1;
    if (attempt.value === 'retry_scheduled') result.retried += 1;
    if (attempt.value === 'dead') result.dead += 1;
    if (attempt.value === 'stale') result.stale += 1;
  }

  if (persistenceErrors.length > 0) {
    throw new AggregateError(
      persistenceErrors,
      'One or more webhook delivery states could not be persisted'
    );
  }

  return result;
}
