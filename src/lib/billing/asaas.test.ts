import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrGetPixPayment, type AsaasClientConfig } from './asaas';

const config: AsaasClientConfig = {
  apiKey: 'test-key',
  env: 'sandbox',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOrGetPixPayment', () => {
  it('reuses an existing payment correlated by order externalReference', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'pay_existing',
              status: 'PENDING',
              invoiceUrl: 'https://invoice.test/existing',
              customer: 'cus_123',
              value: 123.45,
              billingType: 'PIX',
              externalReference: 'order-123',
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          encodedImage: 'base64',
          payload: 'pix-existing',
          expirationDate: '2026-07-30T12:00:00Z',
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createOrGetPixPayment({
      config,
      customerId: 'cus_123',
      value: 123.45,
      dueDate: '2026-07-30',
      description: 'Pedido via WhatsApp',
      externalReference: 'order-123',
    });

    expect(result.reused).toBe(true);
    expect(result.payment.id).toBe('pay_existing');
    expect(result.qrCode.payload).toBe('pix-existing');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://sandbox.asaas.com/api/v3/payments?externalReference=order-123&billingType=PIX&limit=10'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://sandbox.asaas.com/api/v3/payments/pay_existing/pixQrCode'
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')
    ).toBe(false);
  });

  it('creates one PIX only after reconciliation finds no existing charge', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'pay_new',
          status: 'PENDING',
          invoiceUrl: 'https://invoice.test/new',
          customer: 'cus_123',
          value: 10,
          billingType: 'PIX',
          externalReference: 'order-new',
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          encodedImage: 'base64',
          payload: 'pix-new',
          expirationDate: '2026-07-30T12:00:00Z',
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await createOrGetPixPayment({
      config,
      customerId: 'cus_123',
      value: 10,
      dueDate: '2026-07-30',
      description: 'Pedido via WhatsApp',
      externalReference: 'order-new',
    });

    expect(result.reused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [, createInit] = fetchMock.mock.calls[1] ?? [];
    expect(createInit?.method).toBe('POST');
    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      customer: 'cus_123',
      billingType: 'PIX',
      value: 10,
      externalReference: 'order-new',
    });
  });

  it('refuses a mismatched correlated charge instead of creating another', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'pay_wrong_value',
            status: 'PENDING',
            invoiceUrl: 'https://invoice.test/wrong',
            customer: 'cus_123',
            value: 9.99,
            billingType: 'PIX',
            externalReference: 'order-123',
          },
        ],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createOrGetPixPayment({
        config,
        customerId: 'cus_123',
        value: 10,
        dueDate: '2026-07-30',
        description: 'Pedido via WhatsApp',
        externalReference: 'order-123',
      })
    ).rejects.toThrow('valor do pedido');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
