-- ============================================================
-- 058_private_chat_media.sql
--
-- Conversation attachments contain customer data and must not be
-- addressable through permanent public Storage URLs. This migration:
--
--   1. makes only `chat-media` private (flow-media/catalog stay public);
--   2. replaces its public SELECT policy with account-scoped reads;
--   3. rewrites historical chat/template URLs to the authenticated,
--      stable application endpoint.
--
-- Upload/update/delete policies from 023 remain account-scoped and
-- unchanged. Object deletion is intentionally left to the Storage API:
-- deleting rows directly from storage.objects can orphan the underlying
-- blob. The composer already removes cancelled/failed staged uploads.
--
-- Idempotent and safe to re-run.
-- ============================================================

UPDATE storage.buckets
SET public = FALSE
WHERE id = 'chat-media';

DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Members can read account chat media" ON storage.objects;

CREATE POLICY "Members can read account chat media"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) =
          (storage.foldername(name))[1]
    )
  );

-- Existing outbound messages stored the bucket's public URL. Keep history
-- working after the bucket closes by persisting the app-owned authenticated
-- endpoint instead. Upload names from buildMediaPath contain only URL-safe
-- characters; only the folder separator needs encoding.
WITH legacy_chat_urls AS (
  SELECT
    id,
    regexp_replace(
      split_part(media_url, '?', 1),
      '^.*/storage/v1/object/(public|sign)/chat-media/',
      ''
    ) AS object_path
  FROM public.messages
  WHERE media_url ~ '/storage/v1/object/(public|sign)/chat-media/'
)
UPDATE public.messages AS message
SET media_url =
  '/api/whatsapp/media/chat?path=' ||
  replace(legacy.object_path, '/', '%2F')
FROM legacy_chat_urls AS legacy
WHERE message.id = legacy.id
  AND legacy.object_path LIKE 'account-%/%';

-- Template samples used chat-media before 058. New uploads use flow-media,
-- but drafts/history still need a readable preview and a path that the
-- submit route can exchange for a short-lived signed URL.
WITH legacy_template_urls AS (
  SELECT
    id,
    regexp_replace(
      split_part(header_media_url, '?', 1),
      '^.*/storage/v1/object/(public|sign)/chat-media/',
      ''
    ) AS object_path
  FROM public.message_templates
  WHERE header_media_url ~ '/storage/v1/object/(public|sign)/chat-media/'
)
UPDATE public.message_templates AS template
SET header_media_url =
  '/api/whatsapp/media/chat?path=' ||
  replace(legacy.object_path, '/', '%2F')
FROM legacy_template_urls AS legacy
WHERE template.id = legacy.id
  AND legacy.object_path LIKE 'account-%/%';
