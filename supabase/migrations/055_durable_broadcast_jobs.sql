-- ============================================================
-- 055_durable_broadcast_jobs.sql
--
-- Broadcast delivery used to run either in the browser or in
-- Next.js `after()`. Both disappear when the tab/function dies and
-- can leave campaigns permanently stuck in `sending`.
--
-- This migration makes delivery durable:
--   * one persisted, idempotent job per broadcast recipient;
--   * atomic enqueue of broadcast + recipients + jobs;
--   * atomic claim with FOR UPDATE SKIP LOCKED and a renewable lease;
--   * bounded attempts, next_run_at backoff and terminal failure;
--   * explicit `skipped` recipients (for marketing opt-outs) that do
--     not inflate the technical failure count;
--   * recovery jobs for legacy campaigns already stuck in `sending`.
--
-- All queue RPCs are service-role only. Dashboard callers authorize
-- through the server route before that route uses the service client.
-- ============================================================

-- Request-level idempotency. Existing rows remain NULL; every new
-- server-side enqueue supplies a key and request fingerprint.
ALTER TABLE public.broadcasts
  ADD COLUMN IF NOT EXISTS enqueue_key TEXT,
  ADD COLUMN IF NOT EXISTS enqueue_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS rejected_recipients INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS skipped_count INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcasts_account_enqueue_key
  ON public.broadcasts(account_id, enqueue_key);

ALTER TABLE public.broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_rejected_recipients_check;
ALTER TABLE public.broadcasts
  ADD CONSTRAINT broadcasts_rejected_recipients_check
  CHECK (rejected_recipients >= 0);

ALTER TABLE public.broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_skipped_count_check;
ALTER TABLE public.broadcasts
  ADD CONSTRAINT broadcasts_skipped_count_check
  CHECK (skipped_count >= 0);

-- Consent suppression is a completed outcome, not a provider failure.
ALTER TABLE public.broadcast_recipients
  DROP CONSTRAINT IF EXISTS broadcast_recipients_status_check;
ALTER TABLE public.broadcast_recipients
  ADD CONSTRAINT broadcast_recipients_status_check
  CHECK (
    status IN (
      'pending',
      'sent',
      'delivered',
      'read',
      'replied',
      'failed',
      'skipped'
    )
  );

-- Migration 005 owns the incremental aggregate trigger. Extend its
-- status map and safety-net recompute for the new skipped_count.
CREATE OR REPLACE FUNCTION public._bcast_cols_for_status(s TEXT)
RETURNS TEXT[] AS $$
BEGIN
  IF s = 'pending'   THEN RETURN ARRAY[]::TEXT[]; END IF;
  IF s = 'sent'      THEN RETURN ARRAY['sent_count']; END IF;
  IF s = 'delivered' THEN RETURN ARRAY['sent_count','delivered_count']; END IF;
  IF s = 'read'      THEN RETURN ARRAY['sent_count','delivered_count','read_count']; END IF;
  IF s = 'replied'   THEN RETURN ARRAY['sent_count','delivered_count','read_count','replied_count']; END IF;
  IF s = 'failed'    THEN RETURN ARRAY['failed_count']; END IF;
  IF s = 'skipped'   THEN RETURN ARRAY['skipped_count']; END IF;
  RETURN ARRAY[]::TEXT[];
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.recompute_broadcast_counts(bid UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.broadcasts b SET
    sent_count       = agg.sent_count,
    delivered_count  = agg.delivered_count,
    read_count       = agg.read_count,
    replied_count    = agg.replied_count,
    failed_count     = agg.failed_count,
    skipped_count    = agg.skipped_count,
    updated_at       = NOW()
  FROM (
    SELECT
      COUNT(*) FILTER (WHERE status IN ('sent','delivered','read','replied')) AS sent_count,
      COUNT(*) FILTER (WHERE status IN ('delivered','read','replied'))        AS delivered_count,
      COUNT(*) FILTER (WHERE status IN ('read','replied'))                    AS read_count,
      COUNT(*) FILTER (WHERE status = 'replied')                              AS replied_count,
      COUNT(*) FILTER (WHERE status = 'failed')                               AS failed_count,
      COUNT(*) FILTER (WHERE status = 'skipped')                              AS skipped_count
    FROM public.broadcast_recipients
    WHERE broadcast_id = bid
  ) agg
  WHERE b.id = bid;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- DURABLE RECIPIENT JOBS
-- ============================================================

CREATE TABLE IF NOT EXISTS public.broadcast_delivery_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  broadcast_id UUID NOT NULL REFERENCES public.broadcasts(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL
    REFERENCES public.broadcast_recipients(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  -- NULL means "derive from broadcasts.template_variables" and is
  -- used only by recovery jobs for legacy browser-created campaigns.
  template_params JSONB,
  message_params JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'processing',
        'retry',
        'succeeded',
        'failed',
        'skipped'
      )
    ),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5
    CHECK (max_attempts BETWEEN 1 AND 20),
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT broadcast_delivery_jobs_recipient_unique UNIQUE(recipient_id),
  CONSTRAINT broadcast_delivery_jobs_template_params_check
    CHECK (
      template_params IS NULL
      OR jsonb_typeof(template_params) = 'array'
    ),
  CONSTRAINT broadcast_delivery_jobs_message_params_check
    CHECK (
      message_params IS NULL
      OR jsonb_typeof(message_params) = 'object'
    )
);

CREATE INDEX IF NOT EXISTS idx_broadcast_delivery_jobs_due
  ON public.broadcast_delivery_jobs(next_run_at, id)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_broadcast_delivery_jobs_expired_lease
  ON public.broadcast_delivery_jobs(lease_expires_at, id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_broadcast_delivery_jobs_broadcast
  ON public.broadcast_delivery_jobs(broadcast_id, status);

ALTER TABLE public.broadcast_delivery_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.broadcast_delivery_jobs
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.broadcast_delivery_jobs
  TO service_role;

DROP TRIGGER IF EXISTS set_broadcast_delivery_jobs_updated_at
  ON public.broadcast_delivery_jobs;
CREATE TRIGGER set_broadcast_delivery_jobs_updated_at
BEFORE UPDATE ON public.broadcast_delivery_jobs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- ATOMIC ENQUEUE
--
-- p_recipients is an array of:
-- {
--   "contact_id": uuid,
--   "destination": text,
--   "status": "pending" | "skipped",
--   "error_message": text?,
--   "template_params": string[]?,
--   "message_params": object?
-- }
--
-- The unique (account_id, enqueue_key) row is the HTTP retry gate.
-- The unique recipient_id on jobs is the per-recipient retry gate.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enqueue_broadcast_delivery(
  p_account_id UUID,
  p_user_id UUID,
  p_name TEXT,
  p_template_name TEXT,
  p_template_language TEXT,
  p_template_variables JSONB,
  p_audience_filter JSONB,
  p_enqueue_key TEXT,
  p_enqueue_fingerprint TEXT,
  p_rejected_recipients INTEGER,
  p_recipients JSONB
)
RETURNS TABLE (
  broadcast_id UUID,
  total_recipients INTEGER,
  rejected_recipients INTEGER,
  skipped_count INTEGER,
  replayed BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_broadcast_id UUID;
  v_existing_fingerprint TEXT;
  v_created BOOLEAN := FALSE;
  v_item JSONB;
  v_contact_id UUID;
  v_recipient_id UUID;
  v_status TEXT;
  v_template_params JSONB;
  v_message_params JSONB;
BEGIN
  IF p_enqueue_key IS NULL
     OR BTRIM(p_enqueue_key) = ''
     OR LENGTH(p_enqueue_key) > 200 THEN
    RAISE EXCEPTION 'enqueue key must contain 1..200 characters'
      USING ERRCODE = '22023';
  END IF;
  IF p_enqueue_fingerprint IS NULL
     OR p_enqueue_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'enqueue fingerprint must be a SHA-256 hex digest'
      USING ERRCODE = '22023';
  END IF;
  IF p_rejected_recipients < 0 THEN
    RAISE EXCEPTION 'rejected recipient count cannot be negative'
      USING ERRCODE = '22023';
  END IF;
  IF p_recipients IS NULL
     OR jsonb_typeof(p_recipients) <> 'array'
     OR jsonb_array_length(p_recipients) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'recipients must be an array containing 1..1000 rows'
      USING ERRCODE = '22023';
  END IF;

  SELECT b.id, b.enqueue_fingerprint
    INTO v_broadcast_id, v_existing_fingerprint
  FROM public.broadcasts b
  WHERE b.account_id = p_account_id
    AND b.enqueue_key = p_enqueue_key;

  IF v_broadcast_id IS NULL THEN
    INSERT INTO public.broadcasts (
      account_id,
      user_id,
      name,
      template_name,
      template_language,
      template_variables,
      audience_filter,
      status,
      total_recipients,
      rejected_recipients,
      enqueue_key,
      enqueue_fingerprint
    )
    VALUES (
      p_account_id,
      p_user_id,
      p_name,
      p_template_name,
      p_template_language,
      p_template_variables,
      p_audience_filter,
      'sending',
      jsonb_array_length(p_recipients),
      p_rejected_recipients,
      p_enqueue_key,
      p_enqueue_fingerprint
    )
    ON CONFLICT (account_id, enqueue_key) DO NOTHING
    RETURNING id INTO v_broadcast_id;

    IF v_broadcast_id IS NOT NULL THEN
      v_created := TRUE;
      v_existing_fingerprint := p_enqueue_fingerprint;
    ELSE
      -- A concurrent request won the idempotency key.
      SELECT b.id, b.enqueue_fingerprint
        INTO v_broadcast_id, v_existing_fingerprint
      FROM public.broadcasts b
      WHERE b.account_id = p_account_id
        AND b.enqueue_key = p_enqueue_key;
    END IF;
  END IF;

  IF v_broadcast_id IS NULL THEN
    RAISE EXCEPTION 'failed to resolve enqueued broadcast';
  END IF;
  IF v_existing_fingerprint IS DISTINCT FROM p_enqueue_fingerprint THEN
    RAISE EXCEPTION 'enqueue key was already used for a different request'
      USING ERRCODE = '22023';
  END IF;

  IF v_created THEN
    -- Reject duplicate contacts defensively even though the TypeScript
    -- planner already collapses them. One contact must map to one job.
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_recipients) AS r(value)
      GROUP BY value->>'contact_id'
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'recipient contacts must be unique'
        USING ERRCODE = '22023';
    END IF;

    -- Every contact must belong to the account fixed by the API key or
    -- cookie session. This is defense in depth around service-role use.
    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(p_recipients) AS r(value)
      LEFT JOIN public.contacts c
        ON c.id = (value->>'contact_id')::UUID
       AND c.account_id = p_account_id
      WHERE c.id IS NULL
    ) THEN
      RAISE EXCEPTION 'a recipient contact does not belong to the account'
        USING ERRCODE = '22023';
    END IF;

    FOR v_item IN
      SELECT value FROM jsonb_array_elements(p_recipients)
    LOOP
      v_contact_id := (v_item->>'contact_id')::UUID;
      v_status := COALESCE(v_item->>'status', 'pending');
      IF v_status NOT IN ('pending', 'skipped') THEN
        RAISE EXCEPTION 'enqueue recipient status must be pending or skipped'
          USING ERRCODE = '22023';
      END IF;

      v_template_params := v_item->'template_params';
      IF v_template_params = 'null'::JSONB THEN
        v_template_params := NULL;
      END IF;
      IF v_template_params IS NOT NULL
         AND jsonb_typeof(v_template_params) <> 'array' THEN
        RAISE EXCEPTION 'template_params must be an array or null'
          USING ERRCODE = '22023';
      END IF;

      v_message_params := v_item->'message_params';
      IF v_message_params = 'null'::JSONB THEN
        v_message_params := NULL;
      END IF;
      IF v_message_params IS NOT NULL
         AND jsonb_typeof(v_message_params) <> 'object' THEN
        RAISE EXCEPTION 'message_params must be an object or null'
          USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.broadcast_recipients (
        broadcast_id,
        contact_id,
        status,
        error_message
      )
      VALUES (
        v_broadcast_id,
        v_contact_id,
        v_status,
        NULLIF(v_item->>'error_message', '')
      )
      RETURNING id INTO v_recipient_id;

      IF v_status = 'pending' THEN
        INSERT INTO public.broadcast_delivery_jobs (
          account_id,
          broadcast_id,
          recipient_id,
          destination,
          template_params,
          message_params
        )
        VALUES (
          p_account_id,
          v_broadcast_id,
          v_recipient_id,
          COALESCE(v_item->>'destination', ''),
          v_template_params,
          v_message_params
        )
        ON CONFLICT (recipient_id) DO NOTHING;
      END IF;
    END LOOP;
  END IF;

  -- Covers the all-suppressed case, where no job exists for a cron
  -- worker to complete and therefore no later outcome RPC would be
  -- available to close the campaign.
  PERFORM public.finalize_broadcast_delivery(v_broadcast_id);

  RETURN QUERY
  SELECT
    b.id,
    b.total_recipients,
    b.rejected_recipients,
    b.skipped_count,
    NOT v_created
  FROM public.broadcasts b
  WHERE b.id = v_broadcast_id;
END;
$$;

-- ============================================================
-- RECOVERY + FINALIZATION
-- ============================================================

CREATE OR REPLACE FUNCTION public.resume_sending_broadcast_jobs(
  p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER := GREATEST(1, LEAST(COALESCE(p_limit, 100), 1000));
  v_inserted INTEGER := 0;
  v_broadcast_id UUID;
BEGIN
  WITH candidates AS (
    SELECT
      b.account_id,
      b.id AS broadcast_id,
      br.id AS recipient_id,
      COALESCE(c.phone, '') AS destination
    FROM public.broadcasts b
    JOIN public.broadcast_recipients br
      ON br.broadcast_id = b.id
    LEFT JOIN public.contacts c
      ON c.id = br.contact_id
    LEFT JOIN public.broadcast_delivery_jobs j
      ON j.recipient_id = br.id
    WHERE b.status = 'sending'
      AND br.status = 'pending'
      AND j.id IS NULL
    ORDER BY br.created_at, br.id
    LIMIT v_limit
  )
  INSERT INTO public.broadcast_delivery_jobs (
    account_id,
    broadcast_id,
    recipient_id,
    destination,
    template_params
  )
  SELECT
    account_id,
    broadcast_id,
    recipient_id,
    destination,
    NULL
  FROM candidates
  ON CONFLICT (recipient_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Also repair the other legacy failure mode: every recipient became
  -- terminal but the browser/function died before flipping the parent.
  FOR v_broadcast_id IN
    SELECT b.id
    FROM public.broadcasts b
    WHERE b.status = 'sending'
      AND NOT EXISTS (
        SELECT 1
        FROM public.broadcast_recipients br
        WHERE br.broadcast_id = b.id
          AND br.status = 'pending'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.broadcast_delivery_jobs j
        WHERE j.broadcast_id = b.id
          AND j.status IN ('pending', 'processing', 'retry')
      )
    ORDER BY b.updated_at, b.id
    LIMIT v_limit
  LOOP
    PERFORM public.finalize_broadcast_delivery(v_broadcast_id);
  END LOOP;

  RETURN v_inserted;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_broadcast_delivery(
  p_broadcast_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
  v_sent INTEGER;
  v_failed INTEGER;
BEGIN
  -- Any pending recipient or non-terminal job means work remains.
  IF EXISTS (
    SELECT 1
    FROM public.broadcast_recipients br
    WHERE br.broadcast_id = p_broadcast_id
      AND br.status = 'pending'
  ) OR EXISTS (
    SELECT 1
    FROM public.broadcast_delivery_jobs j
    WHERE j.broadcast_id = p_broadcast_id
      AND j.status IN ('pending', 'processing', 'retry')
  ) THEN
    UPDATE public.broadcasts
    SET status = 'sending'
    WHERE id = p_broadcast_id
      AND status = 'sending';
    RETURN 'sending';
  END IF;

  SELECT b.sent_count, b.failed_count
    INTO v_sent, v_failed
  FROM public.broadcasts b
  WHERE b.id = p_broadcast_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Partial provider success is a completed campaign. A campaign with
  -- only consent-suppressed recipients is also complete (`sent`) and
  -- remains distinguishable through skipped_count. Only a campaign
  -- with technical failures and zero sends is `failed`.
  v_status := CASE
    WHEN COALESCE(v_sent, 0) > 0 OR COALESCE(v_failed, 0) = 0
      THEN 'sent'
    ELSE 'failed'
  END;

  UPDATE public.broadcasts
  SET status = v_status,
      updated_at = NOW()
  WHERE id = p_broadcast_id;

  RETURN v_status;
END;
$$;

-- ============================================================
-- ATOMIC CLAIM / LEASE
-- ============================================================

CREATE OR REPLACE FUNCTION public.claim_broadcast_delivery_jobs(
  p_worker_id TEXT,
  p_limit INTEGER DEFAULT 20,
  p_lease_seconds INTEGER DEFAULT 120
)
RETURNS SETOF public.broadcast_delivery_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER := GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
  v_lease_seconds INTEGER :=
    GREATEST(30, LEAST(COALESCE(p_lease_seconds, 120), 900));
  v_exhausted UUID[];
  v_broadcast_id UUID;
BEGIN
  IF p_worker_id IS NULL
     OR BTRIM(p_worker_id) = ''
     OR LENGTH(p_worker_id) > 128 THEN
    RAISE EXCEPTION 'worker id must contain 1..128 characters'
      USING ERRCODE = '22023';
  END IF;

  -- A worker can die after the final provider attempt. Once its lease
  -- expires, close the job instead of claiming a sixth attempt.
  SELECT COALESCE(ARRAY_AGG(exhausted.id), ARRAY[]::UUID[])
    INTO v_exhausted
  FROM (
    SELECT j.id
    FROM public.broadcast_delivery_jobs j
    JOIN public.broadcasts b ON b.id = j.broadcast_id
    WHERE b.status = 'sending'
      AND j.attempts >= j.max_attempts
      AND (
        (j.status IN ('pending', 'retry') AND j.next_run_at <= NOW())
        OR
        (j.status = 'processing' AND j.lease_expires_at <= NOW())
      )
    ORDER BY j.next_run_at, j.id
    FOR UPDATE OF j SKIP LOCKED
    LIMIT v_limit
  ) AS exhausted;

  IF CARDINALITY(v_exhausted) > 0 THEN
    UPDATE public.broadcast_recipients br
    SET status = 'failed',
        error_message = COALESCE(
          j.last_error,
          'Delivery exhausted its retry limit'
        )
    FROM public.broadcast_delivery_jobs j
    WHERE j.id = ANY(v_exhausted)
      AND br.id = j.recipient_id
      AND br.status = 'pending';

    UPDATE public.broadcast_delivery_jobs j
    SET status = 'failed',
        completed_at = NOW(),
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        last_error = COALESCE(
          j.last_error,
          'Delivery exhausted its retry limit'
        )
    WHERE j.id = ANY(v_exhausted);

    FOR v_broadcast_id IN
      SELECT DISTINCT j.broadcast_id
      FROM public.broadcast_delivery_jobs j
      WHERE j.id = ANY(v_exhausted)
    LOOP
      PERFORM public.finalize_broadcast_delivery(v_broadcast_id);
    END LOOP;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
    FROM public.broadcast_delivery_jobs j
    JOIN public.broadcasts b ON b.id = j.broadcast_id
    WHERE b.status = 'sending'
      AND j.attempts < j.max_attempts
      AND (
        (j.status IN ('pending', 'retry') AND j.next_run_at <= NOW())
        OR
        (j.status = 'processing' AND j.lease_expires_at <= NOW())
      )
    ORDER BY j.next_run_at, j.id
    FOR UPDATE OF j SKIP LOCKED
    LIMIT v_limit
  )
  UPDATE public.broadcast_delivery_jobs j
  SET status = 'processing',
      attempts = j.attempts + 1,
      locked_at = NOW(),
      locked_by = p_worker_id,
      lease_expires_at = NOW() + make_interval(secs => v_lease_seconds)
  FROM candidates c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$$;

-- ============================================================
-- JOB OUTCOMES
-- ============================================================

CREATE OR REPLACE FUNCTION public.complete_broadcast_delivery_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_provider_message_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.broadcast_delivery_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job
  FROM public.broadcast_delivery_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF v_job.status = 'succeeded' THEN
    RETURN TRUE;
  END IF;
  IF v_job.status <> 'processing'
     OR v_job.locked_by IS DISTINCT FROM p_worker_id THEN
    RETURN FALSE;
  END IF;

  UPDATE public.broadcast_recipients
  SET status = 'sent',
      sent_at = COALESCE(sent_at, NOW()),
      whatsapp_message_id = p_provider_message_id,
      error_message = NULL
  WHERE id = v_job.recipient_id
    AND status = 'pending';

  UPDATE public.broadcast_delivery_jobs
  SET status = 'succeeded',
      completed_at = NOW(),
      locked_at = NULL,
      locked_by = NULL,
      lease_expires_at = NULL,
      last_error = NULL
  WHERE id = p_job_id;

  PERFORM public.finalize_broadcast_delivery(v_job.broadcast_id);
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.skip_broadcast_delivery_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.broadcast_delivery_jobs%ROWTYPE;
  v_reason TEXT := COALESCE(NULLIF(BTRIM(p_reason), ''), 'skipped');
BEGIN
  SELECT * INTO v_job
  FROM public.broadcast_delivery_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF v_job.status = 'skipped' THEN
    RETURN TRUE;
  END IF;
  IF v_job.status <> 'processing'
     OR v_job.locked_by IS DISTINCT FROM p_worker_id THEN
    RETURN FALSE;
  END IF;

  UPDATE public.broadcast_recipients
  SET status = 'skipped',
      error_message = v_reason
  WHERE id = v_job.recipient_id
    AND status = 'pending';

  UPDATE public.broadcast_delivery_jobs
  SET status = 'skipped',
      completed_at = NOW(),
      locked_at = NULL,
      locked_by = NULL,
      lease_expires_at = NULL,
      last_error = v_reason
  WHERE id = p_job_id;

  PERFORM public.finalize_broadcast_delivery(v_job.broadcast_id);
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_or_retry_broadcast_delivery_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_error TEXT,
  p_retryable BOOLEAN,
  p_delay_seconds INTEGER DEFAULT 30
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.broadcast_delivery_jobs%ROWTYPE;
  v_error TEXT := LEFT(
    COALESCE(NULLIF(BTRIM(p_error), ''), 'Unknown delivery error'),
    2000
  );
  v_delay INTEGER :=
    GREATEST(1, LEAST(COALESCE(p_delay_seconds, 30), 86400));
BEGIN
  SELECT * INTO v_job
  FROM public.broadcast_delivery_jobs
  WHERE id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;
  IF v_job.status IN ('succeeded', 'failed', 'skipped') THEN
    RETURN v_job.status;
  END IF;
  IF v_job.status <> 'processing'
     OR v_job.locked_by IS DISTINCT FROM p_worker_id THEN
    RETURN 'stale';
  END IF;

  IF p_retryable AND v_job.attempts < v_job.max_attempts THEN
    UPDATE public.broadcast_delivery_jobs
    SET status = 'retry',
        next_run_at = NOW() + make_interval(secs => v_delay),
        locked_at = NULL,
        locked_by = NULL,
        lease_expires_at = NULL,
        last_error = v_error
    WHERE id = p_job_id;

    UPDATE public.broadcast_recipients
    SET error_message = v_error
    WHERE id = v_job.recipient_id
      AND status = 'pending';

    RETURN 'retry';
  END IF;

  UPDATE public.broadcast_recipients
  SET status = 'failed',
      error_message = v_error
  WHERE id = v_job.recipient_id
    AND status = 'pending';

  UPDATE public.broadcast_delivery_jobs
  SET status = 'failed',
      completed_at = NOW(),
      locked_at = NULL,
      locked_by = NULL,
      lease_expires_at = NULL,
      last_error = v_error
  WHERE id = p_job_id;

  PERFORM public.finalize_broadcast_delivery(v_job.broadcast_id);
  RETURN 'failed';
END;
$$;

-- Backfill one job for every legacy pending recipient in a campaign
-- already marked sending. NULL template_params tells the worker to
-- derive values from broadcasts.template_variables when possible.
INSERT INTO public.broadcast_delivery_jobs (
  account_id,
  broadcast_id,
  recipient_id,
  destination,
  template_params
)
SELECT
  b.account_id,
  b.id,
  br.id,
  COALESCE(c.phone, ''),
  NULL
FROM public.broadcasts b
JOIN public.broadcast_recipients br
  ON br.broadcast_id = b.id
LEFT JOIN public.contacts c
  ON c.id = br.contact_id
WHERE b.status = 'sending'
  AND br.status = 'pending'
ON CONFLICT (recipient_id) DO NOTHING;

-- Queue internals are intentionally unavailable to browser roles.
ALTER FUNCTION public.enqueue_broadcast_delivery(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, INTEGER, JSONB
) OWNER TO postgres;
ALTER FUNCTION public.resume_sending_broadcast_jobs(INTEGER) OWNER TO postgres;
ALTER FUNCTION public.finalize_broadcast_delivery(UUID) OWNER TO postgres;
ALTER FUNCTION public.claim_broadcast_delivery_jobs(TEXT, INTEGER, INTEGER)
  OWNER TO postgres;
ALTER FUNCTION public.complete_broadcast_delivery_job(UUID, TEXT, TEXT)
  OWNER TO postgres;
ALTER FUNCTION public.skip_broadcast_delivery_job(UUID, TEXT, TEXT)
  OWNER TO postgres;
ALTER FUNCTION public.fail_or_retry_broadcast_delivery_job(
  UUID, TEXT, TEXT, BOOLEAN, INTEGER
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.enqueue_broadcast_delivery(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_sending_broadcast_jobs(INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_broadcast_delivery(UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_broadcast_delivery_jobs(
  TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_broadcast_delivery_job(
  UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_broadcast_delivery_job(UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_or_retry_broadcast_delivery_job(
  UUID, TEXT, TEXT, BOOLEAN, INTEGER
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_broadcast_delivery(
  UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, TEXT, INTEGER, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.resume_sending_broadcast_jobs(INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_broadcast_delivery(UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_broadcast_delivery_jobs(
  TEXT, INTEGER, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_broadcast_delivery_job(
  UUID, TEXT, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.skip_broadcast_delivery_job(UUID, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_or_retry_broadcast_delivery_job(
  UUID, TEXT, TEXT, BOOLEAN, INTEGER
) TO service_role;
