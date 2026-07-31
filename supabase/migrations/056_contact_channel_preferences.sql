-- ============================================================
-- 056_contact_channel_preferences.sql
--
-- A channel-specific suppression ledger. Missing rows mean "unknown";
-- an explicit opted_out row always wins over campaign or automation
-- selection. The model is intentionally generic so Gmail/SMS can use
-- the same enforcement point later.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.contact_channel_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'email', 'sms')),
  purpose TEXT NOT NULL DEFAULT 'marketing'
    CHECK (purpose IN ('marketing', 'transactional', 'support')),
  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown', 'opted_in', 'opted_out')),
  source TEXT NOT NULL DEFAULT 'manual',
  proof JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  consented_at TIMESTAMPTZ,
  opted_out_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contact_id, channel, purpose)
);

CREATE INDEX IF NOT EXISTS idx_contact_channel_preferences_suppression
  ON public.contact_channel_preferences(account_id, channel, purpose, status)
  WHERE status = 'opted_out';

ALTER TABLE public.contact_channel_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_channel_preferences_select
  ON public.contact_channel_preferences;
CREATE POLICY contact_channel_preferences_select
  ON public.contact_channel_preferences
  FOR SELECT
  USING (public.is_account_member(account_id));

DROP POLICY IF EXISTS contact_channel_preferences_insert
  ON public.contact_channel_preferences;
CREATE POLICY contact_channel_preferences_insert
  ON public.contact_channel_preferences
  FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1
      FROM public.contacts AS c
      WHERE c.id = contact_id
        AND c.account_id = account_id
    )
  );

DROP POLICY IF EXISTS contact_channel_preferences_update
  ON public.contact_channel_preferences;
CREATE POLICY contact_channel_preferences_update
  ON public.contact_channel_preferences
  FOR UPDATE
  USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND EXISTS (
      SELECT 1
      FROM public.contacts AS c
      WHERE c.id = contact_id
        AND c.account_id = account_id
    )
  );

DROP POLICY IF EXISTS contact_channel_preferences_delete
  ON public.contact_channel_preferences;
CREATE POLICY contact_channel_preferences_delete
  ON public.contact_channel_preferences
  FOR DELETE
  USING (public.is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_contact_channel_preferences_updated_at
  ON public.contact_channel_preferences;
CREATE TRIGGER set_contact_channel_preferences_updated_at
  BEFORE UPDATE ON public.contact_channel_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Platform nurture messages are marketing too. Record an explicit,
-- optional opt-in on the account owner's profile instead of treating
-- a required phone field as consent.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS marketing_opt_in_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS marketing_opt_out_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_phone TEXT;
  v_account_id UUID;
  v_marketing_opt_in BOOLEAN;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  v_phone := NULLIF(NEW.raw_user_meta_data->>'phone', '');
  v_marketing_opt_in :=
    LOWER(COALESCE(NEW.raw_user_meta_data->>'marketing_opt_in', 'false'))
      = 'true';

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (
    user_id,
    full_name,
    email,
    phone,
    account_id,
    account_role,
    marketing_opt_in_at
  )
  VALUES (
    NEW.id,
    v_full_name,
    NEW.email,
    v_phone,
    v_account_id,
    'owner',
    CASE WHEN v_marketing_opt_in THEN NOW() ELSE NULL END
  );

  PERFORM public.provision_starter_content(v_account_id, NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_new_user()
  FROM PUBLIC, anon, authenticated;
