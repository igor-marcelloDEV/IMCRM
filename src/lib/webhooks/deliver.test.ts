import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (secret: string) => secret,
  encrypt: (secret: string) => secret,
}));
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import {
  DEFAULT_DELIVERY_BATCH_SIZE,
  DELIVERY_LEASE_SECONDS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_DELIVERY_ATTEMPTS,
  WebhookDeliveryPersistenceError,
  WebhookEnqueueError,
  deliveryBatchSize,
  dispatchWebhookEvent,
  drainWebhookDeliveries,
  processClaimedWebhookDelivery,
  retryDelayMs,
  type ClaimedWebhookDelivery,
} from './deliver';
import { isDeliverableUrl } from './ssrf';
import { verifySignatureHeader } from './sign';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const PAYLOAD =
  '{"id":"event-1","event":"message.received","occurred_at":"2026-07-29T11:59:00.000Z","account_id":"acct-1","data":{"x":1}}';

function claimed(
  overrides: Partial<ClaimedWebhookDelivery> = {}
): ClaimedWebhookDelivery {
  return {
    delivery_id: 'delivery-1',
    event_id: 'event-1',
    endpoint_id: 'endpoint-1',
    account_id: 'acct-1',
    event_name: 'message.received',
    payload_text: PAYLOAD,
    attempt_count: 1,
    lease_token: 'lease-1',
    endpoint_url: 'https://receiver.example/webhook',
    endpoint_secret: 'whsec_test',
    ...overrides,
  };
}

function enqueueDb(options?: {
  endpointIds?: string[];
  selectError?: { message: string } | null;
  insertError?: { message: string } | null;
}) {
  const insertedRows: Array<Record<string, unknown>> = [];
  const endpointIds = options?.endpointIds ?? ['endpoint-1'];

  const from = vi.fn((table: string) => {
    if (table === 'webhook_endpoints') {
      const builder = {
        select: vi.fn(),
        eq: vi.fn(),
        contains: vi.fn(async () => ({
          data: endpointIds.map((id) => ({ id })),
          error: options?.selectError ?? null,
        })),
      };
      builder.select.mockReturnValue(builder);
      builder.eq.mockReturnValue(builder);
      return builder;
    }
    if (table === 'outbound_webhook_deliveries') {
      return {
        insert: vi.fn((rows: Array<Record<string, unknown>>) => {
          insertedRows.push(...rows);
          return {
            select: vi.fn(async () => ({
              data: options?.insertError
                ? null
                : rows.map((_, index) => ({ id: `delivery-${index}` })),
              error: options?.insertError ?? null,
            })),
          };
        }),
      };
    }
    throw new Error(`Unexpected table ${table}`);
  });

  return {
    db: { from } as unknown as SupabaseClient,
    from,
    insertedRows,
  };
}

beforeEach(() => {
  vi.mocked(isDeliverableUrl).mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('dispatchWebhookEvent durable enqueue', () => {
  it('persists one endpoint delivery with a shared stable payload and id', async () => {
    const { db, insertedRows } = enqueueDb({
      endpointIds: ['endpoint-a', 'endpoint-b'],
    });

    await dispatchWebhookEvent(
      db,
      'acct-1',
      'message.received',
      { x: 1 }
    );

    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0].event_id).toBe(insertedRows[1].event_id);
    expect(insertedRows[0].payload).toBe(insertedRows[1].payload);
    expect(insertedRows.map((row) => row.endpoint_id)).toEqual([
      'endpoint-a',
      'endpoint-b',
    ]);
    const parsed = JSON.parse(String(insertedRows[0].payload));
    expect(parsed.id).toBe(insertedRows[0].event_id);
    expect(parsed).toMatchObject({
      event: 'message.received',
      account_id: 'acct-1',
      data: { x: 1 },
    });
  });

  it('does not enqueue when no endpoint subscribes', async () => {
    const { db, from, insertedRows } = enqueueDb({ endpointIds: [] });

    await dispatchWebhookEvent(db, 'acct-1', 'message.received', {});

    expect(insertedRows).toHaveLength(0);
    expect(from).not.toHaveBeenCalledWith('outbound_webhook_deliveries');
  });

  it.each([
    [
      { selectError: { message: 'read failed' } },
      /resolve webhook subscriptions/,
    ],
    [
      { insertError: { message: 'write failed' } },
      /persist webhook deliveries/,
    ],
  ])('never hides persistence failure: %j', async (options, message) => {
    const { db } = enqueueDb(options);

    await expect(
      dispatchWebhookEvent(db, 'acct-1', 'message.received', {})
    ).rejects.toThrow(message);
    await expect(
      dispatchWebhookEvent(db, 'acct-1', 'message.received', {})
    ).rejects.toBeInstanceOf(WebhookEnqueueError);
  });
});

describe('processClaimedWebhookDelivery', () => {
  it('signs and sends the exact persisted bytes, then completes its lease', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'complete_outbound_webhook_delivery') {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 204 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      processClaimedWebhookDelivery(
        { rpc } as unknown as SupabaseClient,
        claimed(),
        NOW
      )
    ).resolves.toBe('delivered');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://receiver.example/webhook');
    expect(init?.body).toBe(PAYLOAD);
    expect(init?.redirect).toBe('manual');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Imcrm-Webhook-Id']).toBe('endpoint-1');
    expect(headers['X-Imcrm-Delivery-Id']).toBe('delivery-1');
    expect(
      verifySignatureHeader(
        headers['X-Imcrm-Signature'],
        PAYLOAD,
        'whsec_test',
        Math.floor(NOW.getTime() / 1000)
      )
    ).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      'complete_outbound_webhook_delivery',
      expect.objectContaining({
        p_delivery_id: 'delivery-1',
        p_lease_token: 'lease-1',
        p_response_status: 204,
      })
    );
  });

  it('schedules exponential retry and preserves the lease token on failure', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'fail_outbound_webhook_delivery') {
        return { data: 'retry_scheduled', error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    );

    await expect(
      processClaimedWebhookDelivery(
        { rpc } as unknown as SupabaseClient,
        claimed({ attempt_count: 2 }),
        NOW
      )
    ).resolves.toBe('retry_scheduled');

    expect(rpc).toHaveBeenCalledWith(
      'fail_outbound_webhook_delivery',
      expect.objectContaining({
        p_delivery_id: 'delivery-1',
        p_lease_token: 'lease-1',
        p_next_attempt_at: '2026-07-29T12:01:00.000Z',
        p_response_status: 503,
        p_max_attempts: MAX_DELIVERY_ATTEMPTS,
        p_max_endpoint_failures: MAX_CONSECUTIVE_FAILURES,
      })
    );
  });

  it('retries/auto-disables through the same durable failure path for SSRF refusal', async () => {
    vi.mocked(isDeliverableUrl).mockResolvedValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const rpc = vi.fn(async () => ({ data: 'dead', error: null }));

    await expect(
      processClaimedWebhookDelivery(
        { rpc } as unknown as SupabaseClient,
        claimed({ attempt_count: MAX_DELIVERY_ATTEMPTS }),
        NOW
      )
    ).resolves.toBe('dead');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith(
      'fail_outbound_webhook_delivery',
      expect.objectContaining({
        p_error: 'refused non-public delivery target',
      })
    );
  });

  it('surfaces failure-state persistence errors for lease recovery', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 }))
    );
    const rpc = vi.fn(async () => ({
      data: null,
      error: { message: 'database unavailable' },
    }));

    await expect(
      processClaimedWebhookDelivery(
        { rpc } as unknown as SupabaseClient,
        claimed(),
        NOW
      )
    ).rejects.toBeInstanceOf(WebhookDeliveryPersistenceError);
  });
});

describe('drainWebhookDeliveries', () => {
  it('claims with bounded lease settings and reports the batch outcome', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'claim_outbound_webhook_deliveries') {
        return { data: [claimed()], error: null };
      }
      if (name === 'complete_outbound_webhook_delivery') {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 }))
    );

    await expect(
      drainWebhookDeliveries(
        { rpc } as unknown as SupabaseClient,
        { batchSize: 25, now: NOW }
      )
    ).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      retried: 0,
      dead: 0,
      stale: 0,
    });
    expect(rpc).toHaveBeenCalledWith(
      'claim_outbound_webhook_deliveries',
      {
        p_limit: 25,
        p_lease_seconds: DELIVERY_LEASE_SECONDS,
        p_max_attempts: MAX_DELIVERY_ATTEMPTS,
      }
    );
  });
});

describe('retry and batch policy', () => {
  it('uses capped exponential backoff', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(99)).toBe(60 * 60 * 1000);
  });

  it('defaults and caps the configured batch size', () => {
    expect(deliveryBatchSize(undefined)).toBe(DEFAULT_DELIVERY_BATCH_SIZE);
    expect(deliveryBatchSize('nope')).toBe(DEFAULT_DELIVERY_BATCH_SIZE);
    expect(deliveryBatchSize('5000')).toBe(100);
    expect(deliveryBatchSize('20')).toBe(20);
  });
});
