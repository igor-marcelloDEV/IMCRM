-- ============================================================
-- 054_inbound_message_idempotency.sql
--
-- Meta, Baileys and Instagram retry webhook deliveries. Persisting
-- first and running effects second is only safe when the provider key
-- can be claimed exactly once. This migration:
--   1. preserves historical duplicate rows but clears the duplicate
--      provider key on every row after the oldest;
--   2. enforces one provider message per conversation;
--   3. records the first inbound message exactly once;
--   4. inserts the message and increments unread_count atomically.
-- ============================================================

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY conversation_id, provider, provider_message_key
      ORDER BY created_at ASC, id ASC
    ) AS duplicate_rank
  FROM public.messages
  WHERE provider IS NOT NULL
    AND provider_message_key IS NOT NULL
)
UPDATE public.messages AS m
SET provider_message_key = NULL
FROM ranked AS r
WHERE m.id = r.id
  AND r.duplicate_rank > 1;

DROP INDEX IF EXISTS idx_messages_provider_message_key;
CREATE INDEX idx_messages_provider_message_key
  ON public.messages(provider, provider_message_key)
  WHERE provider_message_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_provider_key_unique
  ON public.messages(conversation_id, provider, provider_message_key)
  WHERE provider_message_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.conversation_first_inbound_claims (
  conversation_id UUID PRIMARY KEY
    REFERENCES public.conversations(id) ON DELETE CASCADE,
  message_id UUID NOT NULL UNIQUE
    REFERENCES public.messages(id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.conversation_first_inbound_claims ENABLE ROW LEVEL SECURITY;

-- Backfill existing threads before accepting new events.
INSERT INTO public.conversation_first_inbound_claims (conversation_id, message_id, claimed_at)
SELECT DISTINCT ON (m.conversation_id)
  m.conversation_id,
  m.id,
  COALESCE(m.created_at, NOW())
FROM public.messages AS m
WHERE m.sender_type = 'customer'
ORDER BY m.conversation_id, m.created_at ASC NULLS LAST, m.id ASC
ON CONFLICT (conversation_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.record_inbound_message(
  p_conversation_id UUID,
  p_content_type TEXT,
  p_content_text TEXT,
  p_media_url TEXT,
  p_provider whatsapp_provider_type,
  p_provider_message_key TEXT,
  p_created_at TIMESTAMPTZ,
  p_reply_to_message_id UUID DEFAULT NULL,
  p_interactive_reply_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  inserted_message_id UUID,
  is_first_inbound BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_message_id UUID;
  v_is_first BOOLEAN := FALSE;
  v_last_message_at TIMESTAMPTZ := COALESCE(p_created_at, NOW());
BEGIN
  IF p_provider_message_key IS NULL OR BTRIM(p_provider_message_key) = '' THEN
    RAISE EXCEPTION 'provider message key is required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.messages (
    conversation_id,
    sender_type,
    content_type,
    content_text,
    media_url,
    message_id,
    provider,
    provider_message_key,
    status,
    created_at,
    reply_to_message_id,
    interactive_reply_id
  )
  VALUES (
    p_conversation_id,
    'customer',
    p_content_type,
    p_content_text,
    p_media_url,
    CASE
      WHEN p_provider = 'meta_cloud_api'::whatsapp_provider_type
        THEN p_provider_message_key
      ELSE NULL
    END,
    p_provider,
    p_provider_message_key,
    'delivered',
    v_last_message_at,
    p_reply_to_message_id,
    p_interactive_reply_id
  )
  ON CONFLICT (conversation_id, provider, provider_message_key)
    WHERE provider_message_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_message_id;

  -- A retry already owns this provider key. Returning zero rows makes
  -- the caller stop before flows, automations, AI and webhooks.
  IF v_message_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.conversation_first_inbound_claims (
    conversation_id,
    message_id
  )
  VALUES (p_conversation_id, v_message_id)
  ON CONFLICT (conversation_id) DO NOTHING
  RETURNING TRUE INTO v_is_first;

  UPDATE public.conversations
  SET last_message_text = COALESCE(
        NULLIF(p_content_text, ''),
        '[' || p_content_type || ']'
      ),
      last_message_at = v_last_message_at,
      unread_count = COALESCE(unread_count, 0) + 1,
      updated_at = NOW()
  WHERE id = p_conversation_id;

  RETURN QUERY
  SELECT v_message_id, COALESCE(v_is_first, FALSE);
END;
$$;

ALTER FUNCTION public.record_inbound_message(
  UUID, TEXT, TEXT, TEXT, whatsapp_provider_type, TEXT, TIMESTAMPTZ, UUID, TEXT
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.record_inbound_message(
  UUID, TEXT, TEXT, TEXT, whatsapp_provider_type, TEXT, TIMESTAMPTZ, UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_inbound_message(
  UUID, TEXT, TEXT, TEXT, whatsapp_provider_type, TEXT, TIMESTAMPTZ, UUID, TEXT
) TO service_role;

