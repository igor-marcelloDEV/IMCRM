import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createBroadcast: vi.fn(),
  supabaseAdmin: vi.fn(() => ({ kind: 'admin-db' })),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse(error: unknown) {
    const typed = error as { message?: string; status?: number };
    return Response.json(
      { error: typed.message ?? 'Erro interno do servidor' },
      { status: typed.status ?? 500 }
    );
  },
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

vi.mock('@/lib/whatsapp/broadcast-core', () => {
  class MockBroadcastError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly status: number
    ) {
      super(message);
    }
  }
  return {
    BroadcastError: MockBroadcastError,
    createBroadcast: mocks.createBroadcast,
  };
});

import { POST } from './route';

describe('POST /api/whatsapp/broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forbids a viewer before touching the service queue', async () => {
    mocks.requireRole.mockRejectedValue(
      Object.assign(new Error('Esta ação requer a função agent ou superior'), {
        status: 403,
      })
    );

    const response = await POST(
      new Request('http://localhost/api/whatsapp/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: [{ phone: '+5511999999999', params: ['Igor'] }],
          template_name: 'welcome',
          template_language: 'pt_BR',
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.createBroadcast).not.toHaveBeenCalled();
  });

  it('enqueues once and exposes queued versus consent-suppressed counts', async () => {
    mocks.requireRole.mockResolvedValue({
      accountId: 'account-1',
      userId: 'user-1',
      role: 'agent',
      supabase: { kind: 'session-db' },
      account: { id: 'account-1', name: 'Acme' },
    });
    mocks.createBroadcast.mockResolvedValue({
      broadcastId: 'broadcast-1',
      status: 'sending',
      totalRecipients: 2,
      accepted: 1,
      rejected: 0,
      skipped: 1,
      replayed: false,
    });

    const response = await POST(
      new Request('http://localhost/api/whatsapp/broadcast', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'wizard-attempt-1',
        },
        body: JSON.stringify({
          name: 'Promo',
          recipients: [
            {
              contact_id: 'contact-1',
              phone: '+5511999999999',
              params: ['Igor'],
            },
            {
              contact_id: 'contact-2',
              phone: '+5511888888888',
              params: ['Ana'],
            },
          ],
          template_name: 'promo',
          template_language: 'pt_BR',
        }),
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      broadcast_id: 'broadcast-1',
      queued: 1,
      skipped: 1,
      replayed: false,
    });
    expect(mocks.createBroadcast).toHaveBeenCalledWith(
      { kind: 'admin-db' },
      'account-1',
      'user-1',
      expect.objectContaining({
        idempotencyKey: 'wizard-attempt-1',
        recipients: [
          expect.objectContaining({ contactId: 'contact-1' }),
          expect.objectContaining({ contactId: 'contact-2' }),
        ],
      })
    );
  });
});
