-- ============================================================
-- 061_outbound_webhook_deliveries.sql
--
-- Durable, at-least-once delivery queue for outbound account webhooks.
-- One immutable payload is enqueued once per subscribed endpoint. Workers
-- claim rows with SKIP LOCKED, a lease token prevents stale workers from
-- finalizing a reclaimed attempt, and an endpoint processes only its oldest
-- outstanding delivery so retries do not reorder later events.
--
-- No dashboard/API RLS policy is created: this is internal infrastructure
-- accessed only through the service-role enqueue/worker paths.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.outbound_webhook_deliveries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL,
  endpoint_id        uuid NOT NULL
    REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL
    REFERENCES public.accounts(id) ON DELETE CASCADE,
  event              text NOT NULL,
  -- Kept only while delivery can still be retried. Terminal transitions
  -- clear it so customer/event data is not retained indefinitely.
  payload            text,
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'delivered', 'dead')),
  attempt_count      integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  next_attempt_at    timestamptz DEFAULT now(),
  lease_token        uuid,
  lease_expires_at   timestamptz,
  response_status    integer
    CHECK (response_status IS NULL OR response_status BETWEEN 100 AND 599),
  last_error         text,
  delivered_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id),
  CHECK (
    (
      status = 'processing'
      AND lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
    OR
    (
      status <> 'processing'
      AND lease_token IS NULL
      AND lease_expires_at IS NULL
    )
  ),
  CONSTRAINT outbound_webhook_deliveries_payload_active_check CHECK (
    status NOT IN ('pending', 'processing')
    OR payload IS NOT NULL
  ),
  CHECK (status <> 'pending' OR next_attempt_at IS NOT NULL)
);

ALTER TABLE public.outbound_webhook_deliveries
  ALTER COLUMN payload DROP NOT NULL;
ALTER TABLE public.outbound_webhook_deliveries
  DROP CONSTRAINT IF EXISTS outbound_webhook_deliveries_payload_active_check;
ALTER TABLE public.outbound_webhook_deliveries
  ADD CONSTRAINT outbound_webhook_deliveries_payload_active_check
  CHECK (
    status NOT IN ('pending', 'processing')
    OR payload IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_due_idx
  ON public.outbound_webhook_deliveries
    (next_attempt_at, created_at, id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_endpoint_order_idx
  ON public.outbound_webhook_deliveries
    (endpoint_id, created_at, id)
  WHERE status IN ('pending', 'processing');

ALTER TABLE public.outbound_webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.outbound_webhook_deliveries
  FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.outbound_webhook_deliveries TO service_role;

-- Claim at most one oldest outstanding delivery per endpoint. A pending
-- retry blocks newer events for the same endpoint, preserving enqueue order.
CREATE OR REPLACE FUNCTION public.claim_outbound_webhook_deliveries(
  p_limit integer DEFAULT 50,
  p_lease_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 8
)
RETURNS TABLE (
  delivery_id uuid,
  event_id uuid,
  endpoint_id uuid,
  account_id uuid,
  event_name text,
  payload_text text,
  attempt_count integer,
  lease_token uuid,
  endpoint_url text,
  endpoint_secret text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_lease_seconds integer :=
    LEAST(GREATEST(COALESCE(p_lease_seconds, 60), 10), 600);
  v_max_attempts integer :=
    LEAST(GREATEST(COALESCE(p_max_attempts, 8), 1), 100);
BEGIN
  -- A worker can die after claiming its final allowed attempt, or an
  -- operator can lower the attempt cap while a retry is pending. Make
  -- either terminal state explicit so it cannot block the endpoint queue.
  UPDATE public.outbound_webhook_deliveries AS exhausted
  SET
    status = 'dead',
    payload = NULL,
    next_attempt_at = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error = COALESCE(
      exhausted.last_error,
      'lease expired after maximum attempts'
    ),
    updated_at = v_now
  WHERE exhausted.attempt_count >= v_max_attempts
    AND (
      exhausted.status = 'pending'
      OR (
        exhausted.status = 'processing'
        AND exhausted.lease_expires_at <= v_now
      )
    );

  RETURN QUERY
  WITH candidates AS (
    SELECT delivery.id
    FROM public.outbound_webhook_deliveries AS delivery
    JOIN public.webhook_endpoints AS endpoint
      ON endpoint.id = delivery.endpoint_id
     AND endpoint.is_active = TRUE
    WHERE delivery.attempt_count < v_max_attempts
      AND (
        (
          delivery.status = 'pending'
          AND delivery.next_attempt_at <= v_now
        )
        OR
        (
          delivery.status = 'processing'
          AND delivery.lease_expires_at <= v_now
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.outbound_webhook_deliveries AS older
        WHERE older.endpoint_id = delivery.endpoint_id
          AND older.status IN ('pending', 'processing')
          AND (older.created_at, older.id) <
            (delivery.created_at, delivery.id)
      )
    ORDER BY delivery.created_at, delivery.id
    FOR UPDATE OF delivery SKIP LOCKED
    LIMIT v_limit
  ),
  claimed AS (
    UPDATE public.outbound_webhook_deliveries AS delivery
    SET
      status = 'processing',
      attempt_count = delivery.attempt_count + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = v_now + make_interval(
        secs => v_lease_seconds
      ),
      updated_at = v_now
    FROM candidates
    WHERE delivery.id = candidates.id
    RETURNING
      delivery.id,
      delivery.event_id,
      delivery.endpoint_id,
      delivery.account_id,
      delivery.event,
      delivery.payload,
      delivery.attempt_count,
      delivery.lease_token
  )
  SELECT
    claimed.id,
    claimed.event_id,
    claimed.endpoint_id,
    claimed.account_id,
    claimed.event,
    claimed.payload,
    claimed.attempt_count,
    claimed.lease_token,
    endpoint.url,
    endpoint.secret
  FROM claimed
  JOIN public.webhook_endpoints AS endpoint
    ON endpoint.id = claimed.endpoint_id;
END;
$$;

-- Finalize only the worker that still owns the lease. If its lease expired
-- and another worker reclaimed the row, this returns false and leaves the
-- new attempt authoritative.
CREATE OR REPLACE FUNCTION public.complete_outbound_webhook_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_response_status integer,
  p_delivered_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_endpoint_id uuid;
BEGIN
  UPDATE public.outbound_webhook_deliveries AS delivery
  SET
    status = 'delivered',
    payload = NULL,
    next_attempt_at = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    response_status = p_response_status,
    last_error = NULL,
    delivered_at = p_delivered_at,
    updated_at = p_delivered_at
  WHERE delivery.id = p_delivery_id
    AND delivery.status = 'processing'
    AND delivery.lease_token = p_lease_token
  RETURNING delivery.endpoint_id INTO v_endpoint_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  UPDATE public.webhook_endpoints
  SET
    failure_count = 0,
    last_delivery_at = p_delivered_at
  WHERE id = v_endpoint_id;

  RETURN TRUE;
END;
$$;

-- Record an attempt failure and schedule its retry atomically with the
-- endpoint's consecutive-failure counter. Reaching either the per-delivery
-- attempt cap or endpoint failure threshold produces a terminal row; an
-- auto-disabled endpoint also terminalizes its remaining queue.
CREATE OR REPLACE FUNCTION public.fail_outbound_webhook_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_next_attempt_at timestamptz,
  p_error text,
  p_response_status integer,
  p_max_attempts integer,
  p_max_endpoint_failures integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_endpoint_id uuid;
  v_attempt_count integer;
  v_endpoint_disabled boolean;
  v_terminal boolean;
  v_now timestamptz := clock_timestamp();
  v_max_attempts integer :=
    LEAST(GREATEST(COALESCE(p_max_attempts, 8), 1), 100);
  v_max_endpoint_failures integer :=
    LEAST(GREATEST(COALESCE(p_max_endpoint_failures, 15), 1), 10000);
BEGIN
  SELECT delivery.endpoint_id, delivery.attempt_count
  INTO v_endpoint_id, v_attempt_count
  FROM public.outbound_webhook_deliveries AS delivery
  WHERE delivery.id = p_delivery_id
    AND delivery.status = 'processing'
    AND delivery.lease_token = p_lease_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'stale';
  END IF;

  UPDATE public.webhook_endpoints AS endpoint
  SET
    failure_count = endpoint.failure_count + 1,
    is_active = CASE
      WHEN endpoint.failure_count + 1 >=
        v_max_endpoint_failures
      THEN FALSE
      ELSE endpoint.is_active
    END
  WHERE endpoint.id = v_endpoint_id
  RETURNING NOT endpoint.is_active INTO v_endpoint_disabled;

  v_terminal :=
    v_attempt_count >= v_max_attempts
    OR COALESCE(v_endpoint_disabled, TRUE);

  UPDATE public.outbound_webhook_deliveries AS delivery
  SET
    status = CASE WHEN v_terminal THEN 'dead' ELSE 'pending' END,
    payload = CASE WHEN v_terminal THEN NULL ELSE delivery.payload END,
    next_attempt_at = CASE
      WHEN v_terminal THEN NULL
      ELSE GREATEST(COALESCE(p_next_attempt_at, v_now), v_now)
    END,
    lease_token = NULL,
    lease_expires_at = NULL,
    response_status = p_response_status,
    last_error = LEFT(COALESCE(p_error, 'delivery failed'), 2000),
    updated_at = v_now
  WHERE delivery.id = p_delivery_id;

  IF COALESCE(v_endpoint_disabled, TRUE) THEN
    UPDATE public.outbound_webhook_deliveries AS queued
    SET
      status = 'dead',
      payload = NULL,
      next_attempt_at = NULL,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_error = COALESCE(
        queued.last_error,
        'endpoint auto-disabled after consecutive failures'
      ),
      updated_at = v_now
    WHERE queued.endpoint_id = v_endpoint_id
      AND queued.id <> p_delivery_id
      AND queued.status IN ('pending', 'processing');
  END IF;

  RETURN CASE WHEN v_terminal THEN 'dead' ELSE 'retry_scheduled' END;
END;
$$;

ALTER FUNCTION public.claim_outbound_webhook_deliveries(integer, integer, integer)
  OWNER TO postgres;
ALTER FUNCTION public.complete_outbound_webhook_delivery(uuid, uuid, integer, timestamptz)
  OWNER TO postgres;
ALTER FUNCTION public.fail_outbound_webhook_delivery(
  uuid, uuid, timestamptz, text, integer, integer, integer
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_outbound_webhook_deliveries(integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_outbound_webhook_delivery(uuid, uuid, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_outbound_webhook_delivery(
  uuid, uuid, timestamptz, text, integer, integer, integer
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_outbound_webhook_deliveries(integer, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_outbound_webhook_delivery(uuid, uuid, integer, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_outbound_webhook_delivery(
  uuid, uuid, timestamptz, text, integer, integer, integer
) TO service_role;
