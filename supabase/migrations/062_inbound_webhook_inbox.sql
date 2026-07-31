-- ============================================================
-- 062_inbound_webhook_inbox.sql
--
-- Durable inbox for Meta (WhatsApp + Instagram) webhook requests.
--
-- The HTTP routes still acknowledge quickly, but only after the exact
-- signed body is persisted.  A short `after()` attempt handles the normal
-- path; a protected cron replays due rows after a crash or transient error.
-- Provider message keys remain the business-level idempotency boundary
-- (migration 054), while this table prevents an acknowledged request from
-- disappearing before that boundary is reached.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.inbound_webhook_events (
  provider TEXT NOT NULL CHECK (provider IN ('whatsapp', 'instagram')),
  event_key TEXT NOT NULL,
  raw_body TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'failed', 'processed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ,
  lease_token UUID,
  replay_reserved_until TIMESTAMPTZ,
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_key),
  CHECK (event_key ~ '^[0-9a-f]{64}$'),
  CHECK (raw_body IS NULL OR OCTET_LENGTH(raw_body) <= 1048576),
  CHECK (status IN ('processed', 'dead') OR raw_body IS NOT NULL),
  CHECK (
    (
      status = 'processing'
      AND lease_until IS NOT NULL
      AND lease_token IS NOT NULL
    )
    OR (
      status <> 'processing'
      AND lease_token IS NULL
    )
  )
);

-- These guards make a manual re-run safe for local databases where an
-- earlier draft of this not-yet-released migration was already executed.
ALTER TABLE public.inbound_webhook_events
  ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE public.inbound_webhook_events
  ADD COLUMN IF NOT EXISTS replay_reserved_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_inbound_webhook_events_due
  ON public.inbound_webhook_events (next_attempt_at, received_at)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_inbound_webhook_events_stale_lease
  ON public.inbound_webhook_events (lease_until)
  WHERE status = 'processing';

DROP TRIGGER IF EXISTS set_inbound_webhook_events_updated_at
  ON public.inbound_webhook_events;
CREATE TRIGGER set_inbound_webhook_events_updated_at
  BEFORE UPDATE ON public.inbound_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.inbound_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.inbound_webhook_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inbound_webhook_events
  TO service_role;

CREATE OR REPLACE FUNCTION public.record_inbound_webhook_event(
  p_provider TEXT,
  p_event_key TEXT,
  p_raw_body TEXT
)
RETURNS TABLE (
  outcome_status TEXT,
  should_process BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.inbound_webhook_events%ROWTYPE;
BEGIN
  IF p_provider NOT IN ('whatsapp', 'instagram')
     OR p_event_key !~ '^[0-9a-f]{64}$'
     OR p_raw_body IS NULL
     OR OCTET_LENGTH(p_raw_body) > 1048576 THEN
    RAISE EXCEPTION 'invalid inbound webhook event';
  END IF;

  INSERT INTO public.inbound_webhook_events (
    provider,
    event_key,
    raw_body
  )
  VALUES (p_provider, p_event_key, p_raw_body)
  ON CONFLICT (provider, event_key) DO NOTHING;

  SELECT *
    INTO v_row
    FROM public.inbound_webhook_events
   WHERE provider = p_provider
     AND event_key = p_event_key
   FOR UPDATE;

  -- SHA-256 collisions are not a realistic replay mechanism, but refusing a
  -- different retained body makes the invariant explicit.  Successful rows
  -- intentionally clear raw_body for data minimisation.
  IF v_row.raw_body IS NOT NULL
     AND v_row.raw_body IS DISTINCT FROM p_raw_body THEN
    RAISE EXCEPTION 'inbound webhook key collision';
  END IF;

  outcome_status := v_row.status;
  should_process :=
    v_row.next_attempt_at <= NOW()
    AND (
      v_row.status IN ('pending', 'failed')
      OR (
        v_row.status = 'processing'
        AND v_row.lease_until <= NOW()
      )
    );
  RETURN NEXT;
END;
$$;

-- Remove the draft signatures if this file is re-run locally. Keeping them
-- would leave token-less completion/failure RPCs callable by service_role.
DROP FUNCTION IF EXISTS public.claim_inbound_webhook_event(TEXT, TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.complete_inbound_webhook_event(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.fail_inbound_webhook_event(
  TEXT,
  TEXT,
  TEXT,
  INTEGER
);

CREATE OR REPLACE FUNCTION public.claim_inbound_webhook_event(
  p_provider TEXT,
  p_event_key TEXT,
  p_lease_token UUID,
  p_lease_seconds INTEGER DEFAULT 90
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH claimed AS (
    UPDATE public.inbound_webhook_events
       SET status = 'processing',
           attempt_count = attempt_count + 1,
           lease_until = NOW() + make_interval(
             secs => GREATEST(30, LEAST(COALESCE(p_lease_seconds, 90), 300))
           ),
           lease_token = p_lease_token,
           replay_reserved_until = NULL,
           last_error = NULL
     WHERE provider = p_provider
       AND event_key = p_event_key
       AND p_lease_token IS NOT NULL
       AND raw_body IS NOT NULL
       AND next_attempt_at <= NOW()
       AND (
         status IN ('pending', 'failed')
         OR (status = 'processing' AND lease_until <= NOW())
       )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$;

CREATE OR REPLACE FUNCTION public.complete_inbound_webhook_event(
  p_provider TEXT,
  p_event_key TEXT,
  p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH completed AS (
    UPDATE public.inbound_webhook_events
       SET status = 'processed',
           raw_body = NULL,
           lease_until = NULL,
           lease_token = NULL,
           replay_reserved_until = NULL,
           last_error = NULL,
           processed_at = NOW()
     WHERE provider = p_provider
       AND event_key = p_event_key
       AND status = 'processing'
       AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM completed);
$$;

CREATE OR REPLACE FUNCTION public.fail_inbound_webhook_event(
  p_provider TEXT,
  p_event_key TEXT,
  p_lease_token UUID,
  p_error TEXT,
  p_max_attempts INTEGER DEFAULT 12
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status TEXT;
BEGIN
  UPDATE public.inbound_webhook_events
     SET status = CASE
           WHEN attempt_count >= GREATEST(COALESCE(p_max_attempts, 12), 1)
             THEN 'dead'
           ELSE 'failed'
         END,
         next_attempt_at = NOW() + (
           LEAST(
             3600,
             15 * POWER(2, GREATEST(attempt_count - 1, 0))
           ) * INTERVAL '1 second'
         ),
         raw_body = CASE
           WHEN attempt_count >= GREATEST(COALESCE(p_max_attempts, 12), 1)
             THEN NULL
           ELSE raw_body
         END,
         lease_until = NULL,
         lease_token = NULL,
         replay_reserved_until = NULL,
         last_error = LEFT(COALESCE(p_error, 'unknown error'), 1000)
   WHERE provider = p_provider
     AND event_key = p_event_key
     AND status = 'processing'
     AND lease_token = p_lease_token
  RETURNING status INTO v_status;

  RETURN v_status;
END;
$$;

-- Reserve due rows for a short replay kick.  The webhook route itself owns
-- the processing lease; this reservation only prevents two cron invocations
-- from POSTing the same body simultaneously.
CREATE OR REPLACE FUNCTION public.reserve_inbound_webhook_replays(
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  provider TEXT,
  event_key TEXT,
  raw_body TEXT
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH due AS (
    SELECT event.provider, event.event_key
      FROM public.inbound_webhook_events event
     WHERE event.raw_body IS NOT NULL
       AND event.next_attempt_at <= NOW()
       AND (
         event.replay_reserved_until IS NULL
         OR event.replay_reserved_until <= NOW()
       )
       AND (
         (
           event.status IN ('pending', 'failed')
         )
         OR (
           event.status = 'processing'
           AND event.lease_until <= NOW()
         )
       )
     ORDER BY event.next_attempt_at, event.received_at
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100))
  ),
  reserved AS (
    UPDATE public.inbound_webhook_events event
       SET replay_reserved_until = NOW() + INTERVAL '2 minutes'
      FROM due
     WHERE event.provider = due.provider
       AND event.event_key = due.event_key
    RETURNING event.provider, event.event_key, event.raw_body
  )
  SELECT reserved.provider, reserved.event_key, reserved.raw_body
    FROM reserved;
$$;

CREATE OR REPLACE FUNCTION public.prune_inbound_webhook_events()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.inbound_webhook_events
   WHERE (status = 'processed' AND processed_at < NOW() - INTERVAL '30 days')
      OR (status = 'dead' AND updated_at < NOW() - INTERVAL '90 days');
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.record_inbound_webhook_event(TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_inbound_webhook_event(
  TEXT,
  TEXT,
  UUID,
  INTEGER
)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_inbound_webhook_event(TEXT, TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_inbound_webhook_event(
  TEXT,
  TEXT,
  UUID,
  TEXT,
  INTEGER
)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_inbound_webhook_replays(INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_inbound_webhook_events()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_inbound_webhook_event(TEXT, TEXT, TEXT)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_inbound_webhook_event(
  TEXT,
  TEXT,
  UUID,
  INTEGER
)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_inbound_webhook_event(TEXT, TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_inbound_webhook_event(
  TEXT,
  TEXT,
  UUID,
  TEXT,
  INTEGER
)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_inbound_webhook_replays(INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_inbound_webhook_events()
  TO service_role;
