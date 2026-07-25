-- ============================================================
-- 040_notifications_i18n.sql
--
-- The `notify_conversation_assigned()` trigger (migration 027) wrote a
-- fully composed English sentence into `notifications.title`/`body`.
-- The rest of the app renders every user-facing string through
-- next-intl (see messages/{en,pt-BR,ko}.json), so this was the one
-- place text reached the UI already baked into one language,
-- regardless of NEXT_PUBLIC_APP_LOCALE.
--
-- Fix: the trigger already computes the contact's and actor's display
-- names (v_contact_name / v_actor_name) — store those as their own
-- columns instead of interpolating them into an English sentence.
-- The frontend renders the localized sentence via t() using these as
-- placeholders. `title`/`body` are left in place (still populated,
-- unused by the UI going forward) rather than dropped, since dropping
-- a NOT NULL column the trigger writes to is a bigger, riskier change
-- than this fix calls for.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_name TEXT;

CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Skip self-assignment — nothing to notify the agent about.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
    FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body, contact_name, actor_name
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact'),
    v_contact_name,
    v_actor_name
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;
