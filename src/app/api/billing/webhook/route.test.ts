import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/billing/admin-client', () => ({
  supabaseAdmin: dependencyMocks.supabaseAdmin,
}));

import { POST } from './route';

interface RpcResult {
  data: unknown;
  error: unknown;
}

function makeDb(results: RpcResult[]) {
  const rpc = vi.fn(() => {
    const result = results.shift();
    if (!result) throw new Error('Unexpected RPC call');
    return {
      maybeSingle: vi.fn(async () => result),
    };
  });
  return { db: { rpc }, rpc };
}

function webhookRequest(
  body: Record<string, unknown> = {},
  token = 'billing-webhook-secret'
) {
  return new Request('http://localhost/api/billing/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'asaas-access-token': token,
    },
    body: JSON.stringify({
      id: 'evt_123',
      event: 'PAYMENT_CONFIRMED',
      payment: {
        id: 'pay_123',
        value: 149.9,
        externalReference: 'subscription-1',
        billingType: 'PIX',
        customer: 'cus_sensitive',
        description: 'Dados privados do cliente',
      },
      ...body,
    }),
  });
}

describe('POST /api/billing/webhook', () => {
  const previousToken = process.env.ASAAS_WEBHOOK_TOKEN;

  beforeEach(() => {
    process.env.ASAAS_WEBHOOK_TOKEN = 'billing-webhook-secret';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (previousToken === undefined) {
      delete process.env.ASAAS_WEBHOOK_TOKEN;
    } else {
      process.env.ASAAS_WEBHOOK_TOKEN = previousToken;
    }
    vi.restoreAllMocks();
  });

  it('persists and atomically processes a valid event', async () => {
    const { db, rpc } = makeDb([
      {
        data: { outcome_status: 'pending', should_process: true },
        error: null,
      },
      {
        data: { outcome_status: 'processed', error_message: null },
        error: null,
      },
    ]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      processed: true,
      ignored: false,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).toHaveBeenNthCalledWith(1, 'record_asaas_billing_event', {
      p_event_id: 'evt_123',
      p_event_type: 'PAYMENT_CONFIRMED',
      p_payload: {
        payment: {
          id: 'pay_123',
          value: 149.9,
          externalReference: 'subscription-1',
          billingType: 'PIX',
        },
      },
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'process_asaas_billing_event', {
      p_event_id: 'evt_123',
    });
  });

  it('acknowledges an already processed replay without reprocessing it', async () => {
    const { db, rpc } = makeDb([
      {
        data: { outcome_status: 'processed', should_process: false },
        error: null,
      },
    ]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      processed: true,
      duplicate: true,
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid authentication before touching the database', async () => {
    const { db, rpc } = makeDb([]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(webhookRequest({}, 'wrong-token'));

    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: '' }, 'Evento inválido'],
    [
      {
        payment: {
          id: 'pay_123',
          value: Number.NaN,
          externalReference: 'subscription-1',
        },
      },
      'Evento de pagamento inválido',
    ],
    [
      {
        payment: {
          id: 'pay_123',
          value: 21_474_836.48,
          externalReference: 'subscription-1',
        },
      },
      'Evento de pagamento inválido',
    ],
    [
      {
        event: 'SUBSCRIPTION_DELETED',
        payment: undefined,
        subscription: {},
      },
      'Evento de assinatura inválido',
    ],
  ])('rejects malformed financial payloads: %j', async (body, message) => {
    const { db, rpc } = makeDb([]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(webhookRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: message });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a non-object JSON body without throwing', async () => {
    const { db, rpc } = makeDb([]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);
    const request = new Request('http://localhost/api/billing/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'asaas-access-token': 'billing-webhook-secret',
      },
      body: 'null',
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects an oversized authenticated body before parsing it', async () => {
    const { db, rpc } = makeDb([]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);
    const request = new Request('http://localhost/api/billing/webhook', {
      method: 'POST',
      headers: {
        'asaas-access-token': 'billing-webhook-secret',
        'content-length': '262145',
      },
      body: '{}',
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns a retriable response when event persistence fails', async () => {
    const { db } = makeDb([{ data: null, error: { code: '08006' } }]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(503);
  });

  it('returns a retriable response when the atomic processor fails', async () => {
    const { db } = makeDb([
      {
        data: { outcome_status: 'pending', should_process: true },
        error: null,
      },
      {
        data: {
          outcome_status: 'failed',
          error_message: 'serialization failure',
        },
        error: null,
      },
    ]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(503);
  });

  it('acknowledges audited events that do not belong to IMCRM', async () => {
    const { db } = makeDb([
      {
        data: { outcome_status: 'pending', should_process: true },
        error: null,
      },
      {
        data: { outcome_status: 'ignored', error_message: null },
        error: null,
      },
    ]);
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(webhookRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      processed: false,
      ignored: true,
    });
  });
});
