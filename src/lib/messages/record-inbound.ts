import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppProviderType } from '@/types';

export interface RecordInboundMessageInput {
  conversationId: string;
  contentType: string;
  contentText: string | null;
  mediaUrl?: string | null;
  provider: WhatsAppProviderType;
  providerMessageKey: string;
  createdAt: string;
  replyToMessageId?: string | null;
  interactiveReplyId?: string | null;
}

export interface RecordedInboundMessage {
  insertedMessageId: string;
  isFirstInbound: boolean;
}

/**
 * Atomically claims an inbound provider key and updates its conversation.
 * A null result is an expected provider retry, not an error.
 */
export async function recordInboundMessage(
  db: SupabaseClient,
  input: RecordInboundMessageInput,
): Promise<RecordedInboundMessage | null> {
  const { data, error } = await db.rpc('record_inbound_message', {
    p_conversation_id: input.conversationId,
    p_content_type: input.contentType,
    p_content_text: input.contentText,
    p_media_url: input.mediaUrl ?? null,
    p_provider: input.provider,
    p_provider_message_key: input.providerMessageKey,
    p_created_at: input.createdAt,
    p_reply_to_message_id: input.replyToMessageId ?? null,
    p_interactive_reply_id: input.interactiveReplyId ?? null,
  });

  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.inserted_message_id) return null;

  return {
    insertedMessageId: row.inserted_message_id as string,
    isFirstInbound: Boolean(row.is_first_inbound),
  };
}

