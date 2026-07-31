-- ============================================================
-- 063_tasks_activities.sql
--
-- Account-scoped operational tasks and a compact, append-only
-- activity timeline. Task/entity ownership is enforced in the
-- database, not left to API callers. Timeline rows are inserted by
-- triggers in the same transaction as the audited mutation.
-- ============================================================

-- ============================================================
-- TASKS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  due_at timestamptz,
  completed_at timestamptz,
  assigned_to uuid
    REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  created_by uuid
    REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  contact_id uuid
    REFERENCES public.contacts(id) ON DELETE SET NULL,
  deal_id uuid
    REFERENCES public.deals(id) ON DELETE SET NULL,
  order_id uuid
    REFERENCES public.orders(id) ON DELETE SET NULL,
  conversation_id uuid
    REFERENCES public.conversations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT tasks_description_check
    CHECK (
      description IS NULL
      OR char_length(description) <= 5000
    ),
  CONSTRAINT tasks_status_check
    CHECK (status IN ('open', 'completed', 'canceled')),
  CONSTRAINT tasks_priority_check
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT tasks_completed_at_check
    CHECK (
      (status = 'completed' AND completed_at IS NOT NULL)
      OR
      (status <> 'completed' AND completed_at IS NULL)
    )
);

-- Range scans for "today" and overdue both use this partial index.
-- CURRENT_DATE/NOW() cannot appear in an index predicate because
-- they are not immutable, so due_at remains the ordered range key.
CREATE INDEX IF NOT EXISTS idx_tasks_account_open_due
  ON public.tasks(account_id, due_at, id)
  WHERE status = 'open' AND due_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_account_assignee
  ON public.tasks(account_id, assigned_to, status, due_at);

CREATE INDEX IF NOT EXISTS idx_tasks_account_created
  ON public.tasks(account_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_tasks_contact
  ON public.tasks(account_id, contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_deal
  ON public.tasks(account_id, deal_id, created_at DESC)
  WHERE deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_order
  ON public.tasks(account_id, order_id, created_at DESC)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_conversation
  ON public.tasks(account_id, conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_task_account_links()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN
      RAISE EXCEPTION 'task account cannot be changed'
        USING ERRCODE = '23514';
    END IF;

    -- Historical authorship may only become NULL when its profile is
    -- erased. It can never be reassigned to a different person.
    IF NEW.created_by IS DISTINCT FROM OLD.created_by
       AND NOT (
         NEW.created_by IS NULL
         AND pg_trigger_depth() > 1
       ) THEN
      RAISE EXCEPTION 'task creator cannot be changed'
        USING ERRCODE = '23514';
    END IF;

    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  ELSE
    IF NEW.created_by IS NULL THEN
      RAISE EXCEPTION 'task creator is required'
        USING ERRCODE = '23502';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := NEW.created_at;
  END IF;

  NEW.title := btrim(NEW.title);
  NEW.description := NULLIF(btrim(NEW.description), '');

  IF TG_OP = 'INSERT' THEN
    NEW.completed_at := CASE
      WHEN NEW.status = 'completed' THEN now()
      ELSE NULL
    END;
  ELSIF NEW.status = 'completed' THEN
    NEW.completed_at := CASE
      WHEN OLD.status = 'completed' THEN OLD.completed_at
      ELSE now()
    END;
  ELSE
    NEW.completed_at := NULL;
  END IF;

  IF NEW.assigned_to IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.profiles AS profiles
       WHERE profiles.user_id = NEW.assigned_to
         AND profiles.account_id = NEW.account_id
     ) THEN
    RAISE EXCEPTION 'task assignee does not belong to task account'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.created_by IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.profiles AS profiles
       WHERE profiles.user_id = NEW.created_by
         AND profiles.account_id = NEW.account_id
     ) THEN
    RAISE EXCEPTION 'task creator does not belong to task account'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.contact_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.contacts AS contacts
       WHERE contacts.id = NEW.contact_id
         AND contacts.account_id = NEW.account_id
     ) THEN
    RAISE EXCEPTION 'task contact does not belong to task account'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.deal_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.deals AS deals
       WHERE deals.id = NEW.deal_id
         AND deals.account_id = NEW.account_id
     ) THEN
    RAISE EXCEPTION 'task deal does not belong to task account'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.order_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.orders AS orders
       WHERE orders.id = NEW.order_id
         AND orders.account_id = NEW.account_id
     ) THEN
    RAISE EXCEPTION 'task order does not belong to task account'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.conversation_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.conversations AS conversations
       WHERE conversations.id = NEW.conversation_id
         AND conversations.account_id = NEW.account_id
     ) THEN
    RAISE EXCEPTION 'task conversation does not belong to task account'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_task_account_links
  ON public.tasks;
CREATE TRIGGER validate_task_account_links
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_task_account_links();

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tasks_select ON public.tasks;
DROP POLICY IF EXISTS tasks_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_update ON public.tasks;
DROP POLICY IF EXISTS tasks_delete ON public.tasks;

CREATE POLICY tasks_select
  ON public.tasks
  FOR SELECT
  USING (public.is_account_member(account_id, 'viewer'));

CREATE POLICY tasks_insert
  ON public.tasks
  FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND created_by = auth.uid()
  );

CREATE POLICY tasks_update
  ON public.tasks
  FOR UPDATE
  USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));

-- Intentionally no DELETE policy. API DELETE is a recoverable status
-- transition to canceled, and agents can later reopen the task.

REVOKE ALL ON TABLE public.tasks FROM anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;

-- ============================================================
-- ACTIVITIES
-- ============================================================

CREATE TABLE IF NOT EXISTS public.activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  actor_id uuid
    REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  summary text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  task_id uuid,
  contact_id uuid,
  deal_id uuid,
  order_id uuid,
  conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activities_event_type_check
    CHECK (
      char_length(event_type) BETWEEN 3 AND 80
      AND event_type ~ '^[a-z_]+\.[a-z_]+$'
    ),
  CONSTRAINT activities_entity_type_check
    CHECK (entity_type IN ('task', 'deal', 'note', 'order')),
  CONSTRAINT activities_summary_check
    CHECK (char_length(btrim(summary)) BETWEEN 1 AND 500),
  CONSTRAINT activities_metadata_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_activities_account_created
  ON public.activities(account_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_activities_account_entity
  ON public.activities(
    account_id,
    entity_type,
    entity_id,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_activities_account_actor
  ON public.activities(account_id, actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_task
  ON public.activities(account_id, task_id, created_at DESC)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_contact
  ON public.activities(account_id, contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_deal
  ON public.activities(account_id, deal_id, created_at DESC)
  WHERE deal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_order
  ON public.activities(account_id, order_id, created_at DESC)
  WHERE order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_activities_conversation
  ON public.activities(account_id, conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS activities_select ON public.activities;
CREATE POLICY activities_select
  ON public.activities
  FOR SELECT
  USING (public.is_account_member(account_id, 'viewer'));

-- Trigger-owned table: authenticated callers can read their account's
-- timeline, but cannot forge, edit or remove audit events.
REVOKE ALL ON TABLE public.activities FROM anon, authenticated;
GRANT SELECT ON TABLE public.activities TO authenticated;
GRANT ALL ON TABLE public.activities TO service_role;

CREATE OR REPLACE FUNCTION public.protect_activity_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- An account-level ON DELETE CASCADE invokes this trigger nested
  -- beneath the FK trigger. Permit only that cleanup path.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  -- A deleted team member must not leave behind a stable user
  -- identifier. The FK may only clear actor_id; every other field
  -- remains byte-for-byte equivalent.
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND OLD.actor_id IS NOT NULL
     AND NEW.actor_id IS NULL
     AND (to_jsonb(NEW) - 'actor_id')
       = (to_jsonb(OLD) - 'actor_id') THEN
    RETURN NEW;
  END IF;

  -- Contact erasure is the sole customer-context mutation exception:
  -- preserve the audit event while removing associated context/PII.
  -- The nested trigger depth plus transaction-local capability flag
  -- prevents a direct UPDATE from impersonating the redaction path.
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND current_setting(
       'imcrm.activity_contact_redaction',
       true
     ) = 'on'
     AND NEW.id IS NOT DISTINCT FROM OLD.id
     AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id
     AND NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id
     AND NEW.event_type IS NOT DISTINCT FROM OLD.event_type
     AND NEW.entity_type IS NOT DISTINCT FROM OLD.entity_type
     AND NEW.entity_id IS NOT DISTINCT FROM OLD.entity_id
     AND NEW.task_id IS NOT DISTINCT FROM OLD.task_id
     AND NEW.deal_id IS NOT DISTINCT FROM OLD.deal_id
     AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
     AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
     AND NEW.contact_id IS NULL
     AND NEW.conversation_id IS NULL
     AND NEW.summary IN (
       'Atividade de tarefa (contato removido)',
       'Atividade de negócio (contato removido)',
       'Atividade de nota (conteúdo removido)',
       'Atividade de pedido (contato removido)'
     )
     AND NEW.metadata = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'activities are append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS protect_activity_history
  ON public.activities;
CREATE TRIGGER protect_activity_history
  BEFORE UPDATE OR DELETE ON public.activities
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_activity_history();

CREATE OR REPLACE FUNCTION public.append_activity(
  p_account_id uuid,
  p_actor_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_summary text,
  p_metadata jsonb DEFAULT '{}'::jsonb,
  p_task_id uuid DEFAULT NULL,
  p_contact_id uuid DEFAULT NULL,
  p_deal_id uuid DEFAULT NULL,
  p_order_id uuid DEFAULT NULL,
  p_conversation_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  INSERT INTO public.activities (
    account_id,
    actor_id,
    event_type,
    entity_type,
    entity_id,
    summary,
    metadata,
    task_id,
    contact_id,
    deal_id,
    order_id,
    conversation_id
  )
  VALUES (
    p_account_id,
    p_actor_id,
    p_event_type,
    p_entity_type,
    p_entity_id,
    btrim(p_summary),
    COALESCE(p_metadata, '{}'::jsonb),
    p_task_id,
    p_contact_id,
    p_deal_id,
    p_order_id,
    p_conversation_id
  );
$$;

REVOKE ALL ON FUNCTION public.append_activity(
  uuid, uuid, text, text, uuid, text, jsonb,
  uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.append_activity(
  uuid, uuid, text, text, uuid, text, jsonb,
  uuid, uuid, uuid, uuid, uuid
) TO service_role;

-- Preserve timeline chronology while honoring contact erasure. Every
-- activity associated with that contact loses the direct link,
-- conversation link, contextual summary and metadata. New events
-- intentionally avoid copying free-form task, deal or note text in
-- the first place. Event type and business entity IDs remain so
-- aggregate history is still meaningful.
CREATE OR REPLACE FUNCTION public.redact_contact_activities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM set_config(
    'imcrm.activity_contact_redaction',
    'on',
    true
  );

  UPDATE public.activities AS activities
  SET
    contact_id = NULL,
    conversation_id = NULL,
    summary = CASE activities.entity_type
      WHEN 'task' THEN 'Atividade de tarefa (contato removido)'
      WHEN 'deal' THEN 'Atividade de negócio (contato removido)'
      WHEN 'note' THEN 'Atividade de nota (conteúdo removido)'
      ELSE 'Atividade de pedido (contato removido)'
    END,
    metadata = '{}'::jsonb
  WHERE activities.account_id = OLD.account_id
    AND (
      activities.contact_id = OLD.id
      OR activities.conversation_id IN (
        SELECT conversations.id
        FROM public.conversations AS conversations
        WHERE conversations.account_id = OLD.account_id
          AND conversations.contact_id = OLD.id
      )
    );

  PERFORM set_config(
    'imcrm.activity_contact_redaction',
    'off',
    true
  );
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS redact_contact_activities
  ON public.contacts;
CREATE TRIGGER redact_contact_activities
  BEFORE DELETE ON public.contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.redact_contact_activities();

-- ============================================================
-- TASK LIFECYCLE TIMELINE
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_task_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  activity_type text;
  activity_summary text;
  changes jsonb := '{}'::jsonb;
BEGIN
  -- FK-driven SET NULL updates during entity/profile erasure should
  -- not manufacture user-facing activity events.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.append_activity(
      NEW.account_id,
      COALESCE(auth.uid(), NEW.created_by),
      'task.created',
      'task',
      NEW.id,
      'Tarefa criada',
      jsonb_strip_nulls(jsonb_build_object(
        'status', NEW.status,
        'priority', NEW.priority,
        'due_at', NEW.due_at,
        'assigned_to', NEW.assigned_to
      )),
      NEW.id,
      NEW.contact_id,
      NEW.deal_id,
      NEW.order_id,
      NEW.conversation_id
    );
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    changes := changes || jsonb_build_object(
      'status',
      jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    changes := changes || jsonb_build_object(
      'assigned_to',
      jsonb_build_object('from', OLD.assigned_to, 'to', NEW.assigned_to)
    );
  END IF;
  IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    changes := changes || jsonb_build_object(
      'due_at',
      jsonb_build_object('from', OLD.due_at, 'to', NEW.due_at)
    );
  END IF;
  IF NEW.priority IS DISTINCT FROM OLD.priority THEN
    changes := changes || jsonb_build_object(
      'priority',
      jsonb_build_object('from', OLD.priority, 'to', NEW.priority)
    );
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    changes := changes || jsonb_build_object('title_changed', true);
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    changes := changes || jsonb_build_object(
      'description_changed',
      true
    );
  END IF;
  IF NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.deal_id IS DISTINCT FROM OLD.deal_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    changes := changes || jsonb_build_object(
      'links',
      jsonb_build_object(
        'contact_id', NEW.contact_id,
        'deal_id', NEW.deal_id,
        'order_id', NEW.order_id,
        'conversation_id', NEW.conversation_id
      )
    );
  END IF;

  IF changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    CASE NEW.status
      WHEN 'completed' THEN
        activity_type := 'task.completed';
        activity_summary := 'Tarefa concluída';
      WHEN 'canceled' THEN
        activity_type := 'task.canceled';
        activity_summary := 'Tarefa cancelada';
      WHEN 'open' THEN
        activity_type := 'task.reopened';
        activity_summary := 'Tarefa reaberta';
    END CASE;
  ELSIF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    activity_type := CASE
      WHEN NEW.assigned_to IS NULL THEN 'task.unassigned'
      ELSE 'task.assigned'
    END;
    activity_summary := CASE
      WHEN NEW.assigned_to IS NULL
        THEN 'Responsável removido da tarefa'
      ELSE 'Responsável alterado na tarefa'
    END;
  ELSIF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    activity_type := 'task.rescheduled';
    activity_summary := 'Prazo da tarefa alterado';
  ELSE
    activity_type := 'task.updated';
    activity_summary := 'Tarefa atualizada';
  END IF;

  PERFORM public.append_activity(
    NEW.account_id,
    auth.uid(),
    activity_type,
    'task',
    NEW.id,
    activity_summary,
    jsonb_build_object('changes', changes),
    NEW.id,
    NEW.contact_id,
    NEW.deal_id,
    NEW.order_id,
    NEW.conversation_id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS record_task_activity
  ON public.tasks;
CREATE TRIGGER record_task_activity
  AFTER INSERT OR UPDATE ON public.tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.record_task_activity();

-- ============================================================
-- DEAL TIMELINE
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_deal_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  activity_type text;
  activity_summary text;
  changes jsonb := '{}'::jsonb;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.append_activity(
      NEW.account_id,
      auth.uid(),
      'deal.created',
      'deal',
      NEW.id,
      'Negócio criado',
      jsonb_strip_nulls(jsonb_build_object(
        'status', NEW.status,
        'stage_id', NEW.stage_id,
        'value', NEW.value,
        'currency', NEW.currency,
        'assigned_to', NEW.assigned_to
      )),
      NULL,
      NEW.contact_id,
      NEW.id,
      NULL,
      NEW.conversation_id
    );
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    changes := changes || jsonb_build_object(
      'status',
      jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  END IF;
  IF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    changes := changes || jsonb_build_object(
      'stage_id',
      jsonb_build_object('from', OLD.stage_id, 'to', NEW.stage_id)
    );
  END IF;
  IF NEW.value IS DISTINCT FROM OLD.value
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    changes := changes || jsonb_build_object(
      'value',
      jsonb_build_object(
        'from', OLD.value,
        'to', NEW.value,
        'currency', NEW.currency
      )
    );
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    changes := changes || jsonb_build_object(
      'assigned_to',
      jsonb_build_object('from', OLD.assigned_to, 'to', NEW.assigned_to)
    );
  END IF;
  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id THEN
    changes := changes || jsonb_build_object('details_changed', true);
  END IF;

  IF changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    activity_type := CASE NEW.status
      WHEN 'won' THEN 'deal.won'
      WHEN 'lost' THEN 'deal.lost'
      ELSE 'deal.reopened'
    END;
    activity_summary := CASE NEW.status
      WHEN 'won' THEN 'Negócio ganho'
      WHEN 'lost' THEN 'Negócio perdido'
      ELSE 'Negócio reaberto'
    END;
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    activity_type := 'deal.stage_changed';
    activity_summary := 'Etapa do negócio alterada';
  ELSIF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    activity_type := 'deal.assigned';
    activity_summary := 'Responsável do negócio alterado';
  ELSIF NEW.value IS DISTINCT FROM OLD.value
        OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    activity_type := 'deal.value_changed';
    activity_summary := 'Valor do negócio alterado';
  ELSE
    activity_type := 'deal.updated';
    activity_summary := 'Negócio atualizado';
  END IF;

  PERFORM public.append_activity(
    NEW.account_id,
    auth.uid(),
    activity_type,
    'deal',
    NEW.id,
    activity_summary,
    jsonb_build_object('changes', changes),
    NULL,
    NEW.contact_id,
    NEW.id,
    NULL,
    NEW.conversation_id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS record_deal_activity
  ON public.deals;
CREATE TRIGGER record_deal_activity
  AFTER INSERT OR UPDATE ON public.deals
  FOR EACH ROW
  EXECUTE FUNCTION public.record_deal_activity();

-- ============================================================
-- CONTACT NOTE TIMELINE
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_contact_note_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  source_note public.contact_notes%ROWTYPE;
  activity_type text;
  activity_summary text;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.note_text IS NOT DISTINCT FROM OLD.note_text THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    source_note := OLD;
  ELSE
    source_note := NEW;
  END IF;
  activity_type := CASE TG_OP
    WHEN 'INSERT' THEN 'note.created'
    WHEN 'UPDATE' THEN 'note.updated'
    ELSE 'note.deleted'
  END;
  activity_summary := CASE TG_OP
    WHEN 'INSERT' THEN 'Nota adicionada ao contato'
    WHEN 'UPDATE' THEN 'Nota do contato atualizada'
    ELSE 'Nota removida do contato'
  END;

  PERFORM public.append_activity(
    source_note.account_id,
    COALESCE(auth.uid(), source_note.user_id),
    activity_type,
    'note',
    source_note.id,
    activity_summary,
    '{}'::jsonb,
    NULL,
    source_note.contact_id,
    NULL,
    NULL,
    NULL
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS record_contact_note_activity
  ON public.contact_notes;
CREATE TRIGGER record_contact_note_activity
  AFTER INSERT OR UPDATE OR DELETE ON public.contact_notes
  FOR EACH ROW
  EXECUTE FUNCTION public.record_contact_note_activity();

-- ============================================================
-- ORDER TIMELINE
-- ============================================================

CREATE OR REPLACE FUNCTION public.record_order_activity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  activity_type text;
  activity_summary text;
  changes jsonb := '{}'::jsonb;
  linked_conversation_id uuid;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.deal_id IS NOT NULL THEN
    SELECT deals.conversation_id
    INTO linked_conversation_id
    FROM public.deals AS deals
    WHERE deals.id = NEW.deal_id
      AND deals.account_id = NEW.account_id;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM public.append_activity(
      NEW.account_id,
      auth.uid(),
      'order.created',
      'order',
      NEW.id,
      'Pedido criado',
      jsonb_strip_nulls(jsonb_build_object(
        'status', NEW.status,
        'total_cents', NEW.total_cents,
        'currency', NEW.currency
      )),
      NULL,
      NEW.contact_id,
      NEW.deal_id,
      NEW.id,
      linked_conversation_id
    );
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    changes := changes || jsonb_build_object(
      'status',
      jsonb_build_object('from', OLD.status, 'to', NEW.status)
    );
  END IF;
  IF NEW.total_cents IS DISTINCT FROM OLD.total_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency THEN
    changes := changes || jsonb_build_object(
      'total',
      jsonb_build_object(
        'from_cents', OLD.total_cents,
        'to_cents', NEW.total_cents,
        'currency', NEW.currency
      )
    );
  END IF;
  IF NEW.gateway_payment_id IS DISTINCT FROM OLD.gateway_payment_id THEN
    changes := changes || jsonb_build_object(
      'payment_linked',
      NEW.gateway_payment_id IS NOT NULL
    );
  END IF;
  IF NEW.invoice_status IS DISTINCT FROM OLD.invoice_status THEN
    changes := changes || jsonb_build_object(
      'invoice_status',
      jsonb_build_object(
        'from', OLD.invoice_status,
        'to', NEW.invoice_status
      )
    );
  END IF;

  IF changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    activity_type := CASE NEW.status
      WHEN 'paid' THEN 'order.paid'
      WHEN 'canceled' THEN 'order.canceled'
      ELSE 'order.reopened'
    END;
    activity_summary := CASE NEW.status
      WHEN 'paid' THEN 'Pedido pago'
      WHEN 'canceled' THEN 'Pedido cancelado'
      ELSE 'Pedido reaberto'
    END;
  ELSIF NEW.gateway_payment_id IS DISTINCT FROM OLD.gateway_payment_id THEN
    activity_type := 'order.payment_linked';
    activity_summary := 'Cobrança vinculada ao pedido';
  ELSIF NEW.invoice_status IS DISTINCT FROM OLD.invoice_status THEN
    activity_type := 'order.invoice_updated';
    activity_summary := 'Situação da nota fiscal atualizada';
  ELSE
    activity_type := 'order.total_changed';
    activity_summary := 'Total do pedido alterado';
  END IF;

  PERFORM public.append_activity(
    NEW.account_id,
    auth.uid(),
    activity_type,
    'order',
    NEW.id,
    activity_summary,
    jsonb_build_object('changes', changes),
    NULL,
    NEW.contact_id,
    NEW.deal_id,
    NEW.id,
    linked_conversation_id
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS record_order_activity
  ON public.orders;
CREATE TRIGGER record_order_activity
  AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.record_order_activity();

REVOKE ALL ON FUNCTION public.validate_task_account_links()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.protect_activity_history()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_task_activity()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_deal_activity()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_contact_note_activity()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_order_activity()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.redact_contact_activities()
  FROM PUBLIC, anon, authenticated;
