import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: dependencyMocks.supabaseAdmin,
}));

import { GET } from './route';

function request(secret = 'cron-secret') {
  return new Request('https://crm.example/api/webhooks/inbound/cron', {
    headers: { 'x-cron-secret': secret },
  });
}

describe('GET /api/webhooks/inbound/cron', () => {
  const previousCronSecret = process.env.AUTOMATION_CRON_SECRET;
  const previousMetaSecret = process.env.META_APP_SECRET;
  const previousSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;

  beforeEach(() => {
    process.env.AUTOMATION_CRON_SECRET = 'cron-secret';
    process.env.META_APP_SECRET = 'meta-secret';
    delete process.env.NEXT_PUBLIC_SITE_URL;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (previousCronSecret === undefined) {
      delete process.env.AUTOMATION_CRON_SECRET;
    } else {
      process.env.AUTOMATION_CRON_SECRET = previousCronSecret;
    }
    if (previousMetaSecret === undefined) {
      delete process.env.META_APP_SECRET;
    } else {
      process.env.META_APP_SECRET = previousMetaSecret;
    }
    if (previousSiteUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects an invalid cron secret before reserving events', async () => {
    const rpc = vi.fn();
    dependencyMocks.supabaseAdmin.mockReturnValue({ rpc });

    const result = await GET(request('wrong'));

    expect(result.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('replays the exact body through each provider route with a signature', async () => {
    // A public deployment URL must never redirect persisted customer
    // messages to another origin.
    process.env.NEXT_PUBLIC_SITE_URL = 'https://attacker.example';
    const rows = [
      {
        provider: 'whatsapp',
        event_key: 'a'.repeat(64),
        raw_body: '{"entry":[{"id":"wa"}]}',
      },
      {
        provider: 'instagram',
        event_key: 'b'.repeat(64),
        raw_body: '{"entry":[{"id":"ig"}]}',
      },
    ];
    const rpc = vi.fn(async (name: string) => {
      if (name === 'reserve_inbound_webhook_replays') {
        return { data: rows, error: null };
      }
      if (name === 'prune_inbound_webhook_events') {
        return { data: 0, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    dependencyMocks.supabaseAdmin.mockReturnValue({ rpc });
    const fetchMock = vi.fn(
      async (...args: [RequestInfo | URL, RequestInit?]) => {
        void args;
        return new Response(null, { status: 200 });
      }
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await GET(request());

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      reserved: 2,
      replayed: 2,
      failed: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0].toString()).toBe(
      'https://crm.example/api/whatsapp/webhook'
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        body: rows[0].raw_body,
        headers: expect.objectContaining({
          'X-Hub-Signature-256': expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
        }),
      })
    );
    expect(fetchMock.mock.calls[1][0].toString()).toBe(
      'https://crm.example/api/instagram/webhook'
    );
  });

  it('reports a failed replay without discarding its reserved row', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'reserve_inbound_webhook_replays') {
        return {
          data: [
            {
              provider: 'whatsapp',
              event_key: 'c'.repeat(64),
              raw_body: '{"entry":[]}',
            },
          ],
          error: null,
        };
      }
      return { data: 0, error: null };
    });
    dependencyMocks.supabaseAdmin.mockReturnValue({ rpc });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 }))
    );

    const result = await GET(request());

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual({
      reserved: 1,
      replayed: 0,
      failed: 1,
    });
  });

  it('prunes old metadata when there is nothing to replay', async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'reserve_inbound_webhook_replays') {
        return { data: [], error: null };
      }
      if (name === 'prune_inbound_webhook_events') {
        return { data: 3, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    dependencyMocks.supabaseAdmin.mockReturnValue({ rpc });

    const result = await GET(request());

    await expect(result.json()).resolves.toEqual({
      reserved: 0,
      replayed: 0,
      failed: 0,
    });
    expect(rpc).toHaveBeenCalledWith('prune_inbound_webhook_events');
  });
});
