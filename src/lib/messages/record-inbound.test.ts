import { describe, expect, it, vi } from 'vitest';
import { recordInboundMessage } from './record-inbound';

function mockDb(data: unknown, error: unknown = null) {
  return {
    rpc: vi.fn().mockResolvedValue({ data, error }),
  };
}

const input = {
  conversationId: 'conversation-1',
  contentType: 'text',
  contentText: 'Olá',
  provider: 'meta_cloud_api' as const,
  providerMessageKey: 'wamid-1',
  createdAt: '2026-07-29T12:00:00.000Z',
};

describe('recordInboundMessage', () => {
  it('maps the atomic RPC result', async () => {
    const db = mockDb([
      { inserted_message_id: 'message-1', is_first_inbound: true },
    ]);

    await expect(
      recordInboundMessage(db as never, input),
    ).resolves.toEqual({
      insertedMessageId: 'message-1',
      isFirstInbound: true,
    });

    expect(db.rpc).toHaveBeenCalledWith('record_inbound_message', {
      p_conversation_id: 'conversation-1',
      p_content_type: 'text',
      p_content_text: 'Olá',
      p_media_url: null,
      p_provider: 'meta_cloud_api',
      p_provider_message_key: 'wamid-1',
      p_created_at: '2026-07-29T12:00:00.000Z',
      p_reply_to_message_id: null,
      p_interactive_reply_id: null,
    });
  });

  it('returns null when a provider retry loses the unique claim', async () => {
    const db = mockDb([]);
    await expect(recordInboundMessage(db as never, input)).resolves.toBeNull();
  });

  it('surfaces database errors so callers can log and retry', async () => {
    const error = new Error('database unavailable');
    const db = mockDb(null, error);
    await expect(recordInboundMessage(db as never, input)).rejects.toBe(error);
  });
});

