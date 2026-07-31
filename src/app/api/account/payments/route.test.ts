import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn(),
}));
const adminMocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => authMocks);
vi.mock('@/lib/automations/admin-client', () => adminMocks);
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: vi.fn((value: string) => `encrypted:${value}`),
}));

import { GET, PATCH } from './route';

function queryReturning(result: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => result),
  };
  builder.select.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  return builder;
}

describe('/api/account/payments', () => {
  beforeEach(() => {
    authMocks.toErrorResponse.mockImplementation((error: unknown) => {
      const typed = error as { status?: number; message?: string };
      return Response.json(
        { error: typed.message ?? 'Erro interno do servidor' },
        { status: typed.status ?? 500 }
      );
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('requires an admin and never returns payment credentials from GET', async () => {
    const query = queryReturning({
      data: {
        asaas_env: 'production',
        municipal_service_id: 'service-1',
        municipal_service_name: 'Consultoria',
        nfe_enabled: true,
        encrypted_asaas_api_key: 'encrypted-api-key',
        webhook_token: 'tenant-webhook-secret',
      },
      error: null,
    });
    const from = vi.fn(() => query);
    authMocks.requireRole.mockResolvedValue({
      accountId: 'account-1',
      supabase: { from },
    });

    const response = await GET();
    const json = await response.json();

    expect(authMocks.requireRole).toHaveBeenCalledWith('admin');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(json).toEqual({
      config: {
        connected: true,
        asaas_env: 'production',
        municipal_service_id: 'service-1',
        municipal_service_name: 'Consultoria',
        nfe_enabled: true,
        webhook_configured: true,
      },
    });
    expect(JSON.stringify(json)).not.toContain('tenant-webhook-secret');
    expect(JSON.stringify(json)).not.toContain('encrypted-api-key');
  });

  it('returns the role guard response before querying settings', async () => {
    const forbidden = Object.assign(new Error('Acesso negado'), {
      status: 403,
    });
    authMocks.requireRole.mockRejectedValue(forbidden);

    const response = await GET();

    expect(response.status).toBe(403);
    expect(authMocks.toErrorResponse).toHaveBeenCalledWith(forbidden);
  });

  it('reveals the webhook token only through an explicit admin action', async () => {
    const query = queryReturning({
      data: {
        webhook_token: 'tenant-webhook-secret',
        municipal_service_id: null,
      },
      error: null,
    });
    adminMocks.supabaseAdmin.mockReturnValue({
      from: vi.fn(() => query),
    });
    authMocks.requireRole.mockResolvedValue({
      accountId: 'account-1',
      supabase: {},
    });

    const response = await PATCH(
      new Request('http://localhost/api/account/payments', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reveal_webhook_token: true }),
      })
    );

    expect(authMocks.requireRole).toHaveBeenCalledWith('admin');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      webhook_token: 'tenant-webhook-secret',
    });
  });
});
