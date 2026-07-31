-- ============================================================
-- 052_authorization_hardening.sql
--
-- Closes two authorization gaps:
--   1. Storage writes must follow the account role hierarchy. Viewers
--      remain able to read shared media, but only agent+ may create,
--      replace, or delete account media.
--   2. Service-only SECURITY DEFINER RPCs must not inherit PostgreSQL's
--      default PUBLIC EXECUTE privilege.
--
-- Existing public-read policies for flow-media/chat-media are left
-- unchanged because Meta needs to fetch those URLs.
-- ============================================================

-- ============================================================
-- STORAGE: flow-media (account paths + legacy user paths)
-- ============================================================

DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND (
          ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          OR auth.uid()::text = (storage.foldername(name))[1]
        )
    )
  );

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND (
          ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          OR auth.uid()::text = (storage.foldername(name))[1]
        )
    )
  )
  WITH CHECK (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND (
          ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          OR auth.uid()::text = (storage.foldername(name))[1]
        )
    )
  );

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND (
          ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          OR auth.uid()::text = (storage.foldername(name))[1]
        )
    )
  );

-- ============================================================
-- STORAGE: chat-media (account paths only)
-- ============================================================

DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  )
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- SECURITY DEFINER: service-role-only RPCs
-- ============================================================

REVOKE ALL ON FUNCTION public.record_webhook_failure(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(uuid, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(uuid, integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.claim_coupon(text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_coupon(text, uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.release_coupon_use(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_coupon_use(uuid)
  TO service_role;
