import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencyMocks = vi.hoisted(() => ({
  webhookAdmin: vi.fn(() => ({ kind: 'webhook-admin' })),
  deliveryBatchSize: vi.fn(() => 25),
  drainWebhookDeliveries: vi.fn(),
}));

vi.mock('@/lib/webhooks/admin-client', () => ({
  webhookAdmin: dependencyMocks.webhookAdmin,
}));
vi.mock('@/lib/webhooks/deliver', () => ({
  deliveryBatchSize: dependencyMocks.deliveryBatchSize,
  drainWebhookDeliveries: dependencyMocks.drainWebhookDeliveries,
}));

import { GET } from './route';

describe('GET /api/webhooks/cron', () => {
  const previousSecret = process.env.AUTOMATION_CRON_SECRET;
  const previousBatch = process.env.WEBHOOK_DELIVERY_BATCH_SIZE;

  beforeEach(() => {
    process.env.AUTOMATION_CRON_SECRET = 'cron-secret';
    process.env.WEBHOOK_DELIVERY_BATCH_SIZE = '25';
    dependencyMocks.drainWebhookDeliveries.mockResolvedValue({
      claimed: 2,
      delivered: 1,
      retried: 1,
      dead: 0,
      stale: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (previousSecret === undefined) {
      delete process.env.AUTOMATION_CRON_SECRET;
    } else {
      process.env.AUTOMATION_CRON_SECRET = previousSecret;
    }
    if (previousBatch === undefined) {
      delete process.env.WEBHOOK_DELIVERY_BATCH_SIZE;
    } else {
      process.env.WEBHOOK_DELIVERY_BATCH_SIZE = previousBatch;
    }
  });

  it('fails closed when the shared cron secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET;

    const response = await GET(
      new Request('https://crm.example/api/webhooks/cron')
    );

    expect(response.status).toBe(503);
    expect(dependencyMocks.drainWebhookDeliveries).not.toHaveBeenCalled();
  });

  it('rejects a wrong cron secret before opening the queue', async () => {
    const response = await GET(
      new Request('https://crm.example/api/webhooks/cron', {
        headers: { 'x-cron-secret': 'wrong-secret' },
      })
    );

    expect(response.status).toBe(401);
    expect(dependencyMocks.webhookAdmin).not.toHaveBeenCalled();
    expect(dependencyMocks.drainWebhookDeliveries).not.toHaveBeenCalled();
  });

  it('drains a configured batch and disables response caching', async () => {
    const response = await GET(
      new Request('https://crm.example/api/webhooks/cron', {
        headers: { 'x-cron-secret': 'cron-secret' },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      claimed: 2,
      delivered: 1,
      retried: 1,
      dead: 0,
      stale: 0,
    });
    expect(dependencyMocks.deliveryBatchSize).toHaveBeenCalledWith('25');
    expect(dependencyMocks.drainWebhookDeliveries).toHaveBeenCalledWith(
      { kind: 'webhook-admin' },
      { batchSize: 25 }
    );
  });

  it('returns a retriable server error when queue state cannot be persisted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    dependencyMocks.drainWebhookDeliveries.mockRejectedValue(
      new Error('database unavailable')
    );

    const response = await GET(
      new Request('https://crm.example/api/webhooks/cron', {
        headers: { 'x-cron-secret': 'cron-secret' },
      })
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
