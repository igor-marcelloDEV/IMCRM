import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  getProviderForAccount: vi.fn(),
  findOrCreateContact: vi.fn(),
}));

vi.mock('@/lib/whatsapp/provider-factory', () => ({
  getProviderForAccount: mocks.getProviderForAccount,
}));

vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: mocks.findOrCreateContact,
}));

import {
  createBroadcast,
  processBroadcastDeliveryBatch,
  BroadcastError,
} from './broadcast-core';

interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

function fakeDb(options: {
  tables?: Record<string, QueryResult[]>;
  rpc?: (name: string, args: Record<string, unknown>) => Promise<QueryResult>;
}): SupabaseClient {
  const tables = Object.fromEntries(
    Object.entries(options.tables ?? {}).map(([table, results]) => [
      table,
      [...results],
    ])
  );

  return {
    from(table: string) {
      const next = () => tables[table]?.shift() ?? { data: null, error: null };
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'order', 'limit']) {
        builder[method] = vi.fn(() => builder);
      }
      builder.maybeSingle = vi.fn(async () => next());
      builder.single = vi.fn(async () => next());
      builder.then = (
        resolve: (value: QueryResult) => unknown,
        reject?: (reason: unknown) => unknown
      ) => Promise.resolve(next()).then(resolve, reject);
      return builder;
    },
    rpc(name: string, args: Record<string, unknown>) {
      return (
        options.rpc?.(name, args) ??
        Promise.resolve({ data: null, error: null })
      );
    },
  } as unknown as SupabaseClient;
}

describe('createBroadcast validation', () => {
  const db = {} as SupabaseClient;

  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients,
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('durable broadcast enqueue', () => {
  const provider = {
    type: 'meta_cloud_api',
    sendTemplate: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderForAccount.mockResolvedValue(provider);
  });

  it('persists an opt-out as skipped and creates no browser/provider send', async () => {
    let enqueueArgs: Record<string, unknown> = {};
    const db = fakeDb({
      tables: {
        broadcasts: [{ data: null, error: null }],
        message_templates: [{ data: null, error: null }],
        contacts: [
          {
            data: [
              { id: 'contact-1', phone: '+5511999999999' },
              { id: 'contact-2', phone: '+5511888888888' },
            ],
            error: null,
          },
        ],
        contact_channel_preferences: [
          { data: [{ contact_id: 'contact-2' }], error: null },
        ],
      },
      rpc: async (name, args) => {
        expect(name).toBe('enqueue_broadcast_delivery');
        enqueueArgs = args;
        return {
          data: [
            {
              broadcast_id: 'broadcast-1',
              total_recipients: 2,
              rejected_recipients: 0,
              skipped_count: 1,
              replayed: false,
            },
          ],
          error: null,
        };
      },
    });

    const result = await createBroadcast(db, 'account-1', 'user-1', {
      name: 'Promo',
      templateName: 'promo',
      idempotencyKey: 'attempt-1',
      recipients: [
        {
          contactId: 'contact-1',
          to: '+5511999999999',
          params: ['Igor'],
        },
        {
          contactId: 'contact-2',
          to: '+5511888888888',
          params: ['Ana'],
        },
      ],
    });

    expect(result).toMatchObject({
      broadcastId: 'broadcast-1',
      accepted: 1,
      skipped: 1,
      status: 'sending',
    });
    expect(
      (enqueueArgs.p_recipients as Array<Record<string, unknown>>)[1]
    ).toMatchObject({
      contact_id: 'contact-2',
      status: 'skipped',
      error_message: 'marketing_opt_out',
    });
    expect(provider.sendTemplate).not.toHaveBeenCalled();
  });

  it('reports an all-suppressed campaign as complete with zero queued sends', async () => {
    const db = fakeDb({
      tables: {
        broadcasts: [{ data: null, error: null }],
        message_templates: [{ data: null, error: null }],
        contacts: [
          {
            data: [{ id: 'contact-1', phone: '+5511999999999' }],
            error: null,
          },
        ],
        contact_channel_preferences: [
          { data: [{ contact_id: 'contact-1' }], error: null },
        ],
      },
      rpc: async () => ({
        data: [
          {
            broadcast_id: 'broadcast-1',
            total_recipients: 1,
            rejected_recipients: 0,
            skipped_count: 1,
            replayed: false,
          },
        ],
        error: null,
      }),
    });

    await expect(
      createBroadcast(db, 'account-1', 'user-1', {
        templateName: 'promo',
        idempotencyKey: 'all-suppressed',
        recipients: [
          {
            contactId: 'contact-1',
            to: '+5511999999999',
          },
        ],
      })
    ).resolves.toMatchObject({
      status: 'sent',
      accepted: 0,
      skipped: 1,
    });
  });

  it('replays the same request key without resolving or enqueueing again', async () => {
    let fingerprint = '';
    const firstDb = fakeDb({
      tables: {
        broadcasts: [{ data: null, error: null }],
        message_templates: [{ data: null, error: null }],
        contacts: [
          {
            data: [{ id: 'contact-1', phone: '+5511999999999' }],
            error: null,
          },
        ],
        contact_channel_preferences: [{ data: [], error: null }],
      },
      rpc: async (_name, args) => {
        fingerprint = args.p_enqueue_fingerprint as string;
        return {
          data: [
            {
              broadcast_id: 'broadcast-1',
              total_recipients: 1,
              rejected_recipients: 0,
              skipped_count: 0,
              replayed: false,
            },
          ],
          error: null,
        };
      },
    });
    const input = {
      name: 'Promo',
      templateName: 'promo',
      idempotencyKey: 'stable-attempt',
      recipients: [
        {
          contactId: 'contact-1',
          to: '+5511999999999',
          params: ['Igor'],
        },
      ],
    };

    await createBroadcast(firstDb, 'account-1', 'user-1', input);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const secondRpc = vi.fn();
    const secondDb = fakeDb({
      tables: {
        broadcasts: [
          {
            data: {
              id: 'broadcast-1',
              status: 'sending',
              total_recipients: 1,
              rejected_recipients: 0,
              skipped_count: 0,
              enqueue_fingerprint: fingerprint,
            },
            error: null,
          },
        ],
      },
      rpc: secondRpc,
    });
    mocks.getProviderForAccount.mockClear();

    await expect(
      createBroadcast(secondDb, 'account-1', 'user-1', input)
    ).resolves.toMatchObject({ broadcastId: 'broadcast-1', replayed: true });
    expect(mocks.getProviderForAccount).not.toHaveBeenCalled();
    expect(secondRpc).not.toHaveBeenCalled();
  });
});

describe('processBroadcastDeliveryBatch', () => {
  const claimedJob = {
    id: 'job-1',
    account_id: 'account-1',
    broadcast_id: 'broadcast-1',
    recipient_id: 'recipient-1',
    destination: '5511999999999',
    template_params: [],
    message_params: null,
    status: 'processing',
    attempts: 1,
    max_attempts: 5,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rechecks consent immediately before send and atomically skips', async () => {
    let claimCount = 0;
    const rpc = vi.fn(async (name: string) => {
      if (name === 'resume_sending_broadcast_jobs') {
        return { data: 0, error: null };
      }
      if (name === 'claim_broadcast_delivery_jobs') {
        return {
          data: claimCount++ === 0 ? [claimedJob] : [],
          error: null,
        };
      }
      if (name === 'skip_broadcast_delivery_job') {
        return { data: true, error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const db = fakeDb({
      tables: {
        broadcasts: [
          {
            data: {
              account_id: 'account-1',
              template_name: 'promo',
              template_language: 'pt_BR',
              template_variables: null,
            },
            error: null,
          },
        ],
        broadcast_recipients: [
          { data: { contact_id: 'contact-1' }, error: null },
        ],
        contact_channel_preferences: [
          { data: { status: 'opted_out' }, error: null },
        ],
      },
      rpc,
    });

    await expect(
      processBroadcastDeliveryBatch(db, {
        workerId: 'worker-1',
        limit: 10,
      })
    ).resolves.toMatchObject({ claimed: 1, skipped: 1, sent: 0 });
    expect(rpc).toHaveBeenCalledWith(
      'skip_broadcast_delivery_job',
      expect.objectContaining({ p_reason: 'marketing_opt_out' })
    );
    expect(mocks.getProviderForAccount).not.toHaveBeenCalled();
  });

  it('reschedules a retryable provider failure with exponential backoff', async () => {
    const provider = {
      type: 'meta_cloud_api',
      sendTemplate: vi.fn().mockRejectedValue(new Error('network unavailable')),
    };
    mocks.getProviderForAccount.mockResolvedValue(provider);
    let claimCount = 0;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'resume_sending_broadcast_jobs') {
        return { data: 0, error: null };
      }
      if (name === 'claim_broadcast_delivery_jobs') {
        return {
          data: claimCount++ === 0 ? [claimedJob] : [],
          error: null,
        };
      }
      if (name === 'fail_or_retry_broadcast_delivery_job') {
        expect(args).toMatchObject({
          p_retryable: true,
          p_delay_seconds: 30,
        });
        return { data: 'retry', error: null };
      }
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const db = fakeDb({
      tables: {
        broadcasts: [
          {
            data: {
              account_id: 'account-1',
              template_name: 'promo',
              template_language: 'pt_BR',
              template_variables: null,
            },
            error: null,
          },
        ],
        broadcast_recipients: [
          { data: { contact_id: 'contact-1' }, error: null },
        ],
        contact_channel_preferences: [{ data: null, error: null }],
        message_templates: [{ data: null, error: null }],
      },
      rpc,
    });

    await expect(
      processBroadcastDeliveryBatch(db, {
        workerId: 'worker-1',
        limit: 10,
      })
    ).resolves.toMatchObject({ claimed: 1, retried: 1, failed: 0 });
    expect(provider.sendTemplate).toHaveBeenCalledTimes(1);
  });
});
