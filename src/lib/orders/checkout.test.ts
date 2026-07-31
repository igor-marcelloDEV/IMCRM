import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { AsaasClientConfig } from '@/lib/billing/asaas';
import {
  CheckoutPersistenceError,
  claimCheckoutOrder,
  ensureCheckoutPix,
} from './checkout';

interface FakeResult {
  data: unknown;
  error: { message: string } | null;
}

class FakeBuilder implements PromiseLike<FakeResult> {
  constructor(private readonly result: FakeResult) {}

  select(): this {
    return this;
  }

  update(): this {
    return this;
  }

  eq(): this {
    return this;
  }

  maybeSingle(): Promise<FakeResult> {
    return Promise.resolve(this.result);
  }

  then<TResult1 = FakeResult, TResult2 = never>(
    onfulfilled?:
      ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function ok(data: unknown): FakeResult {
  return { data, error: null };
}

function makeDb(args: {
  tables?: Record<string, FakeResult[]>;
  rpcs?: Record<string, FakeResult[]>;
}) {
  const tables = Object.fromEntries(
    Object.entries(args.tables ?? {}).map(([name, results]) => [
      name,
      [...results],
    ])
  ) as Record<string, FakeResult[]>;
  const rpcs = Object.fromEntries(
    Object.entries(args.rpcs ?? {}).map(([name, results]) => [
      name,
      [...results],
    ])
  ) as Record<string, FakeResult[]>;

  const from = vi.fn((table: string) => {
    const result = tables[table]?.shift() ?? ok(null);
    return new FakeBuilder(result);
  });
  const rpc = vi.fn((name: string, rpcArgs?: Record<string, unknown>) => {
    void rpcArgs;
    const result = rpcs[name]?.shift() ?? ok(null);
    return new FakeBuilder(result);
  });

  return {
    db: { from, rpc } as unknown as SupabaseClient,
    from,
    rpc,
  };
}

const tenantConfig: AsaasClientConfig = {
  apiKey: 'tenant-key',
  env: 'sandbox',
};

const pendingOrder = {
  id: 'order-1',
  account_id: 'account-1',
  contact_id: 'contact-1',
  cart_id: 'cart-1',
  status: 'pending_payment',
  total_cents: 1250,
  currency: 'BRL',
  gateway_customer_id: null,
  gateway_payment_id: null,
  pix_copy_paste: null,
  pix_expires_at: null,
};

describe('claimCheckoutOrder', () => {
  it('maps the transactional cart claim result', async () => {
    const { db, rpc } = makeDb({
      rpcs: {
        claim_cart_checkout: [
          ok({
            order_id: 'order-1',
            cart_id: 'cart-1',
            total_cents: 1250,
            currency: 'BRL',
            created: true,
          }),
        ],
      },
    });

    await expect(
      claimCheckoutOrder(db, {
        accountId: 'account-1',
        contactId: 'contact-1',
        conversationId: 'conversation-1',
        userId: 'user-1',
        pipelineId: 'pipeline-1',
        stageId: 'stage-1',
      })
    ).resolves.toEqual({
      orderId: 'order-1',
      cartId: 'cart-1',
      totalCents: 1250,
      currency: 'BRL',
      created: true,
    });
    expect(rpc).toHaveBeenCalledWith('claim_cart_checkout', {
      p_account_id: 'account-1',
      p_contact_id: 'contact-1',
      p_conversation_id: 'conversation-1',
      p_user_id: 'user-1',
      p_pipeline_id: 'pipeline-1',
      p_stage_id: 'stage-1',
    });
  });

  it('surfaces a Supabase RPC failure instead of treating it as no cart', async () => {
    const { db } = makeDb({
      rpcs: {
        claim_cart_checkout: [
          { data: null, error: { message: 'database unavailable' } },
        ],
      },
    });

    await expect(
      claimCheckoutOrder(db, {
        accountId: 'account-1',
        contactId: 'contact-1',
        conversationId: null,
        userId: 'user-1',
        pipelineId: 'pipeline-1',
        stageId: 'stage-1',
      })
    ).rejects.toThrow(CheckoutPersistenceError);
  });
});

describe('ensureCheckoutPix', () => {
  it('treats an already-paid correlated order as a successful retry', async () => {
    const getTenantConfig = vi.fn();
    const { db, rpc } = makeDb({
      tables: {
        orders: [
          ok({
            ...pendingOrder,
            status: 'paid',
            gateway_customer_id: 'customer-existing',
            gateway_payment_id: 'payment-existing',
            pix_copy_paste: 'pix-existing',
          }),
        ],
      },
    });

    await expect(
      ensureCheckoutPix(
        db,
        {
          accountId: 'account-1',
          orderId: 'order-1',
          contactId: 'contact-1',
        },
        { getTenantConfig }
      )
    ).resolves.toMatchObject({
      ok: true,
      orderId: 'order-1',
      pixCopyPaste: 'pix-existing',
      reusedGatewayPayment: true,
    });
    expect(getTenantConfig).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('reuses a persisted PIX and finishes the cart without calling Asaas', async () => {
    const getTenantConfig = vi.fn();
    const createOrGetCustomer = vi.fn();
    const createOrGetPixPayment = vi.fn();
    const { db, rpc } = makeDb({
      tables: {
        orders: [
          ok({
            ...pendingOrder,
            gateway_customer_id: 'customer-existing',
            gateway_payment_id: 'payment-existing',
            pix_copy_paste: 'pix-existing',
            pix_expires_at: '2026-07-30T12:00:00Z',
          }),
        ],
      },
      rpcs: {
        complete_order_pix_charge: [
          ok({
            order_id: 'order-1',
            cart_id: 'cart-1',
            total_cents: 1250,
            currency: 'BRL',
            gateway_payment_id: 'payment-existing',
            pix_copy_paste: 'pix-existing',
            pix_expires_at: '2026-07-30T12:00:00Z',
          }),
        ],
      },
    });

    await expect(
      ensureCheckoutPix(
        db,
        {
          accountId: 'account-1',
          orderId: 'order-1',
          contactId: 'contact-1',
        },
        {
          getTenantConfig,
          createOrGetCustomer,
          createOrGetPixPayment,
        }
      )
    ).resolves.toMatchObject({
      ok: true,
      orderId: 'order-1',
      pixCopyPaste: 'pix-existing',
      reusedGatewayPayment: true,
    });
    expect(getTenantConfig).not.toHaveBeenCalled();
    expect(createOrGetCustomer).not.toHaveBeenCalled();
    expect(createOrGetPixPayment).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('complete_order_pix_charge', {
      p_order_id: 'order-1',
      p_account_id: 'account-1',
      p_claim_token: null,
      p_gateway_customer_id: 'customer-existing',
      p_gateway_payment_id: 'payment-existing',
      p_pix_copy_paste: 'pix-existing',
      p_pix_expires_at: '2026-07-30T12:00:00Z',
    });
  });

  it('leases one attempt, uses the order UUID and completes persistence', async () => {
    const getTenantConfig = vi.fn(async () => tenantConfig);
    const createOrGetCustomer = vi.fn(async () => ({
      id: 'customer-1',
      name: 'Maria',
      email: 'maria@example.com',
    }));
    const createOrGetPixPayment = vi.fn(async () => ({
      payment: {
        id: 'payment-1',
        status: 'PENDING',
        invoiceUrl: 'https://invoice.test/payment-1',
      },
      qrCode: {
        encodedImage: 'base64',
        payload: 'pix-new',
        expirationDate: '2026-07-30T12:00:00Z',
      },
      reused: false,
    }));
    const { db, rpc } = makeDb({
      tables: {
        orders: [ok(pendingOrder)],
        contacts: [
          ok({
            name: 'Maria',
            email: null,
            phone: '5511999999999',
            cpf_cnpj: '529.982.247-25',
          }),
        ],
      },
      rpcs: {
        claim_order_payment_attempt: [
          ok({
            order_id: 'order-1',
            claim_token: 'claim-1',
            attempt_count: 1,
          }),
        ],
        complete_order_pix_charge: [
          ok({
            order_id: 'order-1',
            cart_id: 'cart-1',
            total_cents: 1250,
            currency: 'BRL',
            gateway_payment_id: 'payment-1',
            pix_copy_paste: 'pix-new',
            pix_expires_at: '2026-07-30T12:00:00Z',
          }),
        ],
      },
    });

    const result = await ensureCheckoutPix(
      db,
      {
        accountId: 'account-1',
        orderId: 'order-1',
        contactId: 'contact-1',
      },
      {
        getTenantConfig,
        createOrGetCustomer,
        createOrGetPixPayment,
        now: () => new Date('2026-07-29T10:00:00Z'),
      }
    );

    expect(result).toMatchObject({
      ok: true,
      orderId: 'order-1',
      pixCopyPaste: 'pix-new',
      reusedGatewayPayment: false,
    });
    expect(createOrGetCustomer).toHaveBeenCalledWith(
      expect.objectContaining({
        cpfCnpj: '52998224725',
        externalReference: 'contact-1',
      })
    );
    expect(createOrGetPixPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'customer-1',
        value: 12.5,
        dueDate: '2026-07-30',
        externalReference: 'order-1',
      })
    );
    expect(rpc).toHaveBeenCalledWith('complete_order_pix_charge', {
      p_order_id: 'order-1',
      p_account_id: 'account-1',
      p_claim_token: 'claim-1',
      p_gateway_customer_id: 'customer-1',
      p_gateway_payment_id: 'payment-1',
      p_pix_copy_paste: 'pix-new',
      p_pix_expires_at: '2026-07-30T12:00:00Z',
    });
  });

  it('persists an ambiguous Asaas error, retains the lease and does not complete', async () => {
    const createOrGetPixPayment = vi.fn(async () => {
      throw new Error('network response lost');
    });
    const { db, rpc } = makeDb({
      tables: {
        orders: [ok(pendingOrder)],
        contacts: [
          ok({
            name: 'Maria',
            email: 'maria@example.com',
            phone: '5511999999999',
            cpf_cnpj: '52998224725',
          }),
        ],
      },
      rpcs: {
        claim_order_payment_attempt: [
          ok({
            order_id: 'order-1',
            claim_token: 'claim-1',
            attempt_count: 1,
          }),
        ],
        record_order_checkout_error: [ok(true)],
      },
    });

    const result = await ensureCheckoutPix(
      db,
      {
        accountId: 'account-1',
        orderId: 'order-1',
        contactId: 'contact-1',
      },
      {
        getTenantConfig: vi.fn(async () => tenantConfig),
        createOrGetCustomer: vi.fn(async () => ({
          id: 'customer-1',
          name: 'Maria',
          email: 'maria@example.com',
        })),
        createOrGetPixPayment,
      }
    );

    expect(result).toMatchObject({
      ok: false,
      orderId: 'order-1',
      code: 'asaas_charge_failed',
    });
    expect(rpc).toHaveBeenCalledWith('record_order_checkout_error', {
      p_order_id: 'order-1',
      p_account_id: 'account-1',
      p_claim_token: 'claim-1',
      p_error_code: 'asaas_charge_failed',
      p_error_detail: 'network response lost',
      p_hold_claim: true,
    });
    expect(
      rpc.mock.calls.some(([name]) => name === 'complete_order_pix_charge')
    ).toBe(false);
  });

  it('holds the lease when Asaas succeeds but local PIX persistence fails', async () => {
    const { db, rpc } = makeDb({
      tables: {
        orders: [ok(pendingOrder)],
        contacts: [
          ok({
            name: 'Maria',
            email: null,
            phone: '5511999999999',
            cpf_cnpj: '52998224725',
          }),
        ],
      },
      rpcs: {
        claim_order_payment_attempt: [
          ok({
            order_id: 'order-1',
            claim_token: 'claim-1',
            attempt_count: 1,
          }),
        ],
        complete_order_pix_charge: [
          { data: null, error: { message: 'write timeout' } },
        ],
        record_order_checkout_error: [ok(true)],
      },
    });

    const result = await ensureCheckoutPix(
      db,
      {
        accountId: 'account-1',
        orderId: 'order-1',
        contactId: 'contact-1',
      },
      {
        getTenantConfig: vi.fn(async () => tenantConfig),
        createOrGetCustomer: vi.fn(async () => ({
          id: 'customer-1',
          name: 'Maria',
          email: 'maria@example.com',
        })),
        createOrGetPixPayment: vi.fn(async () => ({
          payment: {
            id: 'payment-1',
            status: 'PENDING',
            invoiceUrl: 'https://invoice.test/payment-1',
          },
          qrCode: {
            encodedImage: 'base64',
            payload: 'pix-new',
            expirationDate: '2026-07-30T12:00:00Z',
          },
          reused: false,
        })),
      }
    );

    expect(result).toMatchObject({
      ok: false,
      orderId: 'order-1',
      code: 'pix_persistence_failed',
    });
    expect(rpc).toHaveBeenCalledWith('record_order_checkout_error', {
      p_order_id: 'order-1',
      p_account_id: 'account-1',
      p_claim_token: 'claim-1',
      p_error_code: 'pix_persistence_failed',
      p_error_detail: 'complete_order_pix_charge: write timeout',
      p_hold_claim: true,
    });
  });

  it('does not call Asaas while another payment lease is active', async () => {
    const createOrGetCustomer = vi.fn();
    const createOrGetPixPayment = vi.fn();
    const { db } = makeDb({
      tables: {
        orders: [ok(pendingOrder)],
        contacts: [
          ok({
            name: 'Maria',
            email: null,
            phone: '5511999999999',
            cpf_cnpj: '52998224725',
          }),
        ],
      },
      rpcs: {
        claim_order_payment_attempt: [ok(null)],
      },
    });

    await expect(
      ensureCheckoutPix(
        db,
        {
          accountId: 'account-1',
          orderId: 'order-1',
          contactId: 'contact-1',
        },
        {
          getTenantConfig: vi.fn(async () => tenantConfig),
          createOrGetCustomer,
          createOrGetPixPayment,
        }
      )
    ).resolves.toMatchObject({
      ok: false,
      code: 'payment_attempt_in_progress',
    });
    expect(createOrGetCustomer).not.toHaveBeenCalled();
    expect(createOrGetPixPayment).not.toHaveBeenCalled();
  });
});
