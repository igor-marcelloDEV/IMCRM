import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
  runAutomationsForTrigger: vi.fn(async () => undefined),
  scheduleInvoice: vi.fn(async () => ({
    id: 'invoice-1',
    status: 'SCHEDULED',
  })),
  decrypt: vi.fn(() => 'plain-asaas-key'),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: dependencyMocks.supabaseAdmin,
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: dependencyMocks.runAutomationsForTrigger,
}));
vi.mock('@/lib/orders/tenant-asaas', () => ({
  scheduleInvoice: dependencyMocks.scheduleInvoice,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: dependencyMocks.decrypt,
}));

import { POST } from './route';

const ORDER = {
  id: '4c388ef5-c154-4f5f-a657-907a8fc11291',
  account_id: 'account-1',
  contact_id: 'contact-1',
  status: 'pending_payment',
  total_cents: 1099,
  currency: 'BRL',
  gateway_payment_id: 'pay_123',
};

const AUTH_CONFIG = { webhook_token: 'webhook-secret' };
const INVOICE_CONFIG = {
  encrypted_asaas_api_key: null,
  asaas_env: 'sandbox',
  municipal_service_id: null,
  municipal_service_name: null,
  default_taxes: null,
  nfe_enabled: false,
};

interface DbOptions {
  order?: { data: unknown; error: unknown };
  authConfig?: { data: unknown; error: unknown };
  invoiceConfig?: { data: unknown; error: unknown };
  transition?: { data: unknown; error: unknown };
  invoiceUpdate?: { data: unknown; error: unknown };
}

function selectBuilder(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => result),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return builder;
}

function updateBuilder(
  result: { data: unknown; error: unknown },
  updates: Array<Record<string, unknown>>
) {
  const builder = {
    update: vi.fn((payload: Record<string, unknown>) => {
      updates.push(payload);
      return builder;
    }),
    eq: vi.fn(async () => result),
  };
  return builder;
}

function makeDb(options: DbOptions = {}) {
  let orderReads = 0;
  let configReads = 0;
  const invoiceUpdates: Array<Record<string, unknown>> = [];
  const orderResult = options.order ?? { data: ORDER, error: null };
  const authResult = options.authConfig ?? {
    data: AUTH_CONFIG,
    error: null,
  };
  const invoiceResult = options.invoiceConfig ?? {
    data: INVOICE_CONFIG,
    error: null,
  };
  const transitionResult = options.transition ?? {
    data: { ...ORDER, status: 'paid' },
    error: null,
  };

  const from = vi.fn((table: string) => {
    if (table === 'orders') {
      orderReads += 1;
      if (orderReads === 1) return selectBuilder(orderResult);
      return updateBuilder(
        options.invoiceUpdate ?? { data: null, error: null },
        invoiceUpdates
      );
    }
    if (table === 'tenant_payment_configs') {
      configReads += 1;
      return selectBuilder(configReads === 1 ? authResult : invoiceResult);
    }
    if (table === 'order_items') {
      const result = { data: [{ total_cents: ORDER.total_cents, catalog_items: { offer_type: 'service' } }], error: null };
      const builder = { select: vi.fn(), eq: vi.fn(async () => result) };
      builder.select.mockReturnValue(builder);
      return builder;
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  const rpc = vi.fn(() => ({
    maybeSingle: vi.fn(async () => transitionResult),
  }));
  return { db: { from, rpc }, from, rpc, invoiceUpdates };
}

function paymentRequest(
  payment: Record<string, unknown> = {},
  token = 'webhook-secret',
  event = 'PAYMENT_CONFIRMED'
) {
  return new Request('http://localhost/api/orders/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'asaas-access-token': token,
    },
    body: JSON.stringify({
      event,
      payment: {
        id: 'pay_123',
        externalReference: ORDER.id,
        value: 10.99,
        currency: 'BRL',
        status: 'CONFIRMED',
        ...payment,
      },
    }),
  });
}

describe('POST /api/orders/webhook', () => {
  let restoreConsole: () => void;

  beforeEach(() => {
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    restoreConsole = () => {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    };
  });

  afterEach(() => {
    restoreConsole();
    vi.clearAllMocks();
  });

  it('atomically confirms a correlated payment and runs effects once', async () => {
    const { db, rpc } = makeDb();
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest());
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toEqual({ received: true, processed: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rpc).toHaveBeenCalledWith('confirm_tenant_order_payment', {
      p_order_id: ORDER.id,
      p_gateway_payment_id: 'pay_123',
      p_total_cents: 1099,
      p_currency: 'BRL',
      p_paid_at: expect.any(String),
    });
    expect(dependencyMocks.runAutomationsForTrigger).toHaveBeenCalledTimes(1);
    expect(dependencyMocks.scheduleInvoice).not.toHaveBeenCalled();
  });

  it('acknowledges an already-paid replay without rerunning effects', async () => {
    const { db, rpc } = makeDb({
      order: { data: { ...ORDER, status: 'paid' }, error: null },
    });
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      received: true,
      processed: false,
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(dependencyMocks.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(dependencyMocks.scheduleInvoice).not.toHaveBeenCalled();
  });

  it('rejects a wrong tenant webhook token before changing the order', async () => {
    const { db, rpc } = makeDb();
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest({}, 'wrong-secret'));

    expect(response.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a payment id that is not the charge stored on the order', async () => {
    const { db, rpc } = makeDb();
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest({ id: 'pay_attacker' }));

    expect(response.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ value: 9.99 }, 'Valor'],
    [{ currency: 'USD' }, 'Moeda'],
  ])('rejects mismatched financial data: %j', async (payment, messagePart) => {
    const { db, rpc } = makeDb();
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest(payment));
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.error).toContain(messagePart);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns a retriable response when the order lookup fails', async () => {
    const { db } = makeDb({
      order: { data: null, error: { code: '08006' } },
    });
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest());

    expect(response.status).toBe(503);
    expect(dependencyMocks.runAutomationsForTrigger).not.toHaveBeenCalled();
  });

  it('returns a retriable response when the atomic transition fails', async () => {
    const { db } = makeDb({
      transition: { data: null, error: { code: '40001' } },
    });
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest());

    expect(response.status).toBe(503);
    expect(dependencyMocks.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(dependencyMocks.scheduleInvoice).not.toHaveBeenCalled();
  });

  it('does not run effects when a concurrent delivery wins the transition', async () => {
    const { db } = makeDb({
      transition: { data: null, error: null },
    });
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest());

    expect(response.status).toBe(503);
    expect(dependencyMocks.runAutomationsForTrigger).not.toHaveBeenCalled();
    expect(dependencyMocks.scheduleInvoice).not.toHaveBeenCalled();
  });

  it('surfaces invoice persistence failures as retriable', async () => {
    const { db } = makeDb({
      invoiceConfig: {
        data: {
          ...INVOICE_CONFIG,
          encrypted_asaas_api_key: 'encrypted-key',
          municipal_service_id: 'service-1',
          municipal_service_name: 'Consultoria',
          nfe_enabled: true,
        },
        error: null,
      },
      invoiceUpdate: { data: null, error: { code: '08006' } },
    });
    dependencyMocks.supabaseAdmin.mockReturnValue(db);

    const response = await POST(paymentRequest());

    expect(dependencyMocks.scheduleInvoice).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(503);
  });
});
