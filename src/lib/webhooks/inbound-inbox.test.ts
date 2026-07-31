import { describe, expect, it, vi } from 'vitest';

import {
  inboundWebhookEventKey,
  isInboundWebhookBodyTooLarge,
  recordInboundWebhook,
  runTrackedInboundWebhook,
} from './inbound-inbox';

function rpcResult(data: unknown, error: unknown = null) {
  return Promise.resolve({ data, error });
}

describe('inbound webhook durable inbox', () => {
  it('builds a deterministic SHA-256 key over the exact signed bytes', () => {
    expect(inboundWebhookEventKey('{"entry":[]}')).toBe(
      'b89ccf2859d9df19d734a6000af9ecf4e188d966aaa02d84a0573b7b4167fc28'
    );
    expect(inboundWebhookEventKey(' {"entry":[]}')).not.toBe(
      inboundWebhookEventKey('{"entry":[]}')
    );
  });

  it('applies the body limit to UTF-8 bytes, not JavaScript characters', () => {
    expect(isInboundWebhookBodyTooLarge('a'.repeat(1_048_576))).toBe(false);
    expect(isInboundWebhookBodyTooLarge('😀'.repeat(262_145))).toBe(true);
  });

  it('records the raw body before processing', async () => {
    const maybeSingle = vi.fn(async () => ({
      data: { outcome_status: 'pending', should_process: true },
      error: null,
    }));
    const rpc = vi.fn(() => ({ maybeSingle }));

    await expect(
      recordInboundWebhook(
        { rpc } as never,
        'whatsapp',
        'a'.repeat(64),
        '{"entry":[]}'
      )
    ).resolves.toEqual({
      outcomeStatus: 'pending',
      shouldProcess: true,
    });
    expect(rpc).toHaveBeenCalledWith('record_inbound_webhook_event', {
      p_provider: 'whatsapp',
      p_event_key: 'a'.repeat(64),
      p_raw_body: '{"entry":[]}',
    });
  });

  it('claims, processes and completes one event', async () => {
    const rpc = vi.fn((name: string, params?: unknown) => {
      void params;
      if (name === 'claim_inbound_webhook_event') return rpcResult(true);
      if (name === 'complete_inbound_webhook_event') return rpcResult(true);
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const processor = vi.fn(async () => undefined);

    await expect(
      runTrackedInboundWebhook(
        { rpc } as never,
        'instagram',
        'b'.repeat(64),
        processor
      )
    ).resolves.toBe('processed');
    expect(processor).toHaveBeenCalledTimes(1);
    const claimParams = rpc.mock.calls[0][1] as {
      p_lease_token: string;
    };
    expect(claimParams.p_lease_token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(rpc).toHaveBeenCalledWith('complete_inbound_webhook_event', {
      p_provider: 'instagram',
      p_event_key: 'b'.repeat(64),
      p_lease_token: claimParams.p_lease_token,
    });
  });

  it('does not process while another worker owns the lease', async () => {
    const rpc = vi.fn(() => rpcResult(false));
    const processor = vi.fn(async () => undefined);

    await expect(
      runTrackedInboundWebhook(
        { rpc } as never,
        'whatsapp',
        'c'.repeat(64),
        processor
      )
    ).resolves.toBe('busy');
    expect(processor).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('records retry state and preserves the original processor error', async () => {
    const rpc = vi.fn((name: string, params?: unknown) => {
      void params;
      if (name === 'claim_inbound_webhook_event') return rpcResult(true);
      if (name === 'fail_inbound_webhook_event') return rpcResult('failed');
      throw new Error(`Unexpected RPC: ${name}`);
    });
    const processorError = new Error('transient database outage');

    await expect(
      runTrackedInboundWebhook(
        { rpc } as never,
        'whatsapp',
        'd'.repeat(64),
        async () => {
          throw processorError;
        }
      )
    ).rejects.toBe(processorError);
    expect(rpc).toHaveBeenCalledWith('fail_inbound_webhook_event', {
      p_provider: 'whatsapp',
      p_event_key: 'd'.repeat(64),
      p_lease_token: (rpc.mock.calls[0][1] as { p_lease_token: string })
        .p_lease_token,
      p_error: 'transient database outage',
      p_max_attempts: 12,
    });
  });

  it('cannot mark a newer worker failed after losing its lease', async () => {
    const rpc = vi.fn((name: string, params?: unknown) => {
      void params;
      if (name === 'claim_inbound_webhook_event') return rpcResult(true);
      if (name === 'complete_inbound_webhook_event') return rpcResult(false);
      if (name === 'fail_inbound_webhook_event') return rpcResult(null);
      throw new Error(`Unexpected RPC: ${name}`);
    });

    await expect(
      runTrackedInboundWebhook(
        { rpc } as never,
        'whatsapp',
        'e'.repeat(64),
        async () => undefined
      )
    ).rejects.toThrow('event lease was lost');

    const claimToken = (rpc.mock.calls[0][1] as { p_lease_token: string })
      .p_lease_token;
    expect(rpc).toHaveBeenNthCalledWith(
      3,
      'fail_inbound_webhook_event',
      expect.objectContaining({ p_lease_token: claimToken })
    );
  });
});
