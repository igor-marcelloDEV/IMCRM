import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  supabaseAdmin: vi.fn(() => ({ kind: 'admin-db' })),
  processBatch: vi.fn(),
}));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

vi.mock('@/lib/whatsapp/broadcast-core', () => ({
  processBroadcastDeliveryBatch: mocks.processBatch,
}));

import { GET } from './route';

describe('GET /api/whatsapp/broadcast/cron', () => {
  const originalSecret = process.env.AUTOMATION_CRON_SECRET;
  const originalBatchSize = process.env.BROADCAST_CRON_BATCH_SIZE;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTOMATION_CRON_SECRET = 'cron-secret';
    delete process.env.BROADCAST_CRON_BATCH_SIZE;
  });

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env.AUTOMATION_CRON_SECRET;
    } else {
      process.env.AUTOMATION_CRON_SECRET = originalSecret;
    }
    if (originalBatchSize === undefined) {
      delete process.env.BROADCAST_CRON_BATCH_SIZE;
    } else {
      process.env.BROADCAST_CRON_BATCH_SIZE = originalBatchSize;
    }
  });

  it('rejects an invalid secret before opening the queue', async () => {
    const response = await GET(
      new Request('http://localhost/api/whatsapp/broadcast/cron', {
        headers: { 'x-cron-secret': 'wrong-secret' },
      })
    );

    expect(response.status).toBe(401);
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled();
    expect(mocks.processBatch).not.toHaveBeenCalled();
  });

  it('processes one bounded batch with the service-role client', async () => {
    process.env.BROADCAST_CRON_BATCH_SIZE = '500';
    mocks.processBatch.mockResolvedValue({
      resumed: 2,
      claimed: 3,
      sent: 1,
      retried: 1,
      failed: 0,
      skipped: 1,
      stale: 0,
    });

    const response = await GET(
      new Request('http://localhost/api/whatsapp/broadcast/cron', {
        headers: { 'x-cron-secret': 'cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      claimed: 3,
      sent: 1,
      retried: 1,
      skipped: 1,
    });
    expect(mocks.processBatch).toHaveBeenCalledWith(
      { kind: 'admin-db' },
      { limit: 100, leaseSeconds: 300 }
    );
  });
});
