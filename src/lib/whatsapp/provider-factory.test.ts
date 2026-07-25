import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { getProviderForAccount } from './provider-factory';
import { MetaCloudApiProvider } from './meta-provider';
import { BaileysWorkerProvider } from './baileys-provider';
import { ProviderError } from './provider';
import { encrypt } from './encryption';

// ---------------------------------------------------------------------------
// getProviderForAccount resolves accounts.active_whatsapp_provider into a
// concrete WhatsAppProvider — Meta by default, Baileys when the account
// opted in and the worker is actually connected. These tests cover the
// branch that matters most: a misconfigured/half-connected account must
// fail with a clear ProviderError, never a silent wrong-provider send.
// ---------------------------------------------------------------------------

interface DbFixture {
  account?: Record<string, unknown> | null;
  accountError?: unknown;
  config?: Record<string, unknown> | null;
  configError?: unknown;
  connection?: Record<string, unknown> | null;
  connectionError?: unknown;
}

function makeTableChain(resolved: { data: unknown; error: unknown }) {
  // `select`/`eq`/`update` all return the SAME per-table chain object so
  // the terminal (`single`/`maybeSingle`) always resolves to that table's
  // fixture — a shared chain across tables would let one table's query
  // silently resolve with another table's data.
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.update = vi.fn(() => chain);
  chain.single = vi.fn(async () => resolved);
  chain.maybeSingle = vi.fn(async () => resolved);
  return chain;
}

function makeDb(fixture: DbFixture): SupabaseClient {
  return {
    from: vi.fn((table: string) => {
      if (table === 'accounts') {
        return makeTableChain({
          data: fixture.account ?? null,
          error: fixture.accountError ?? null,
        });
      }
      if (table === 'whatsapp_config') {
        return makeTableChain({
          data: fixture.config ?? null,
          error: fixture.configError ?? null,
        });
      }
      if (table === 'baileys_connections') {
        return makeTableChain({
          data: fixture.connection ?? null,
          error: fixture.connectionError ?? null,
        });
      }
      return makeTableChain({ data: null, error: null });
    }),
  } as unknown as SupabaseClient;
}

describe('getProviderForAccount', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a MetaCloudApiProvider when active_whatsapp_provider is meta_cloud_api', async () => {
    const db = makeDb({
      account: { active_whatsapp_provider: 'meta_cloud_api' },
      config: {
        id: 'cfg-1',
        phone_number_id: 'PNID-1',
        access_token: encrypt('plaintext-token'),
      },
    });

    const provider = await getProviderForAccount(db, 'acct-1');
    expect(provider).toBeInstanceOf(MetaCloudApiProvider);
    expect(provider.type).toBe('meta_cloud_api');
  });

  it('throws whatsapp_not_configured when Meta is active but no config row exists', async () => {
    const db = makeDb({ account: { active_whatsapp_provider: 'meta_cloud_api' }, config: null });

    await expect(getProviderForAccount(db, 'acct-1')).rejects.toMatchObject({
      code: 'whatsapp_not_configured',
    });
    await expect(getProviderForAccount(db, 'acct-1')).rejects.toBeInstanceOf(ProviderError);
  });

  it('returns a BaileysWorkerProvider when active and connected, with the worker configured', async () => {
    vi.stubEnv('WHATSAPP_WORKER_URL', 'http://localhost:3100');
    vi.stubEnv('WORKER_API_SECRET', 'shared-secret');

    const db = makeDb({
      account: { active_whatsapp_provider: 'baileys' },
      connection: { status: 'connected' },
    });

    const provider = await getProviderForAccount(db, 'acct-1');
    expect(provider).toBeInstanceOf(BaileysWorkerProvider);
    expect(provider.type).toBe('baileys');
  });

  it('throws whatsapp_not_configured when Baileys is active but not yet connected (qr_pending)', async () => {
    vi.stubEnv('WHATSAPP_WORKER_URL', 'http://localhost:3100');
    vi.stubEnv('WORKER_API_SECRET', 'shared-secret');

    const db = makeDb({
      account: { active_whatsapp_provider: 'baileys' },
      connection: { status: 'qr_pending' },
    });

    await expect(getProviderForAccount(db, 'acct-1')).rejects.toMatchObject({
      code: 'whatsapp_not_configured',
    });
  });

  it('throws whatsapp_not_configured when Baileys is active but no connection row exists yet', async () => {
    vi.stubEnv('WHATSAPP_WORKER_URL', 'http://localhost:3100');
    vi.stubEnv('WORKER_API_SECRET', 'shared-secret');

    const db = makeDb({ account: { active_whatsapp_provider: 'baileys' }, connection: null });

    await expect(getProviderForAccount(db, 'acct-1')).rejects.toMatchObject({
      code: 'whatsapp_not_configured',
    });
  });

  it('throws baileys_worker_not_configured when connected but the worker env vars are unset', async () => {
    vi.stubEnv('WHATSAPP_WORKER_URL', '');
    vi.stubEnv('WORKER_API_SECRET', '');

    const db = makeDb({
      account: { active_whatsapp_provider: 'baileys' },
      connection: { status: 'connected' },
    });

    await expect(getProviderForAccount(db, 'acct-1')).rejects.toMatchObject({
      code: 'baileys_worker_not_configured',
    });
  });

  it('throws whatsapp_not_configured when the account itself cannot be resolved', async () => {
    const db = makeDb({ account: null });

    await expect(getProviderForAccount(db, 'missing-acct')).rejects.toMatchObject({
      code: 'whatsapp_not_configured',
    });
  });
});
