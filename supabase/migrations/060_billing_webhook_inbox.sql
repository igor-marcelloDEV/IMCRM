-- ============================================================
-- 060_billing_webhook_inbox.sql
--
-- Durable, idempotent processing for the platform Asaas webhook.
--
-- The previous route performed several independent writes and always
-- returned 200, even when one of them failed.  That could acknowledge a
-- payment without activating the tenant, or extend the same subscription
-- twice when Asaas emitted PAYMENT_CONFIRMED and PAYMENT_RECEIVED for the
-- same charge.
--
-- Events are now recorded before processing and the financial transition
-- happens in one SECURITY DEFINER RPC.  A failed transition leaves a
-- retriable audit row; the HTTP route returns 503 so Asaas retries.
-- ============================================================

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS expected_amount_cents INTEGER;
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_expected_amount_cents_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_expected_amount_cents_check
  CHECK (expected_amount_cents IS NULL OR expected_amount_cents >= 0);

-- Existing active subscriptions can safely learn their expected renewal
-- value from the most recent confirmed payment. Pending legacy checkouts
-- without a payment stay NULL and must be restarted through checkout
-- before a webhook can grant access; every new checkout persists the
-- authoritative server-computed amount.
UPDATE public.subscriptions AS subscription
SET expected_amount_cents = (
  SELECT payment.amount_cents
  FROM public.payments AS payment
  WHERE payment.subscription_id = subscription.id
    AND payment.status = 'confirmed'
  ORDER BY payment.paid_at DESC NULLS LAST, payment.created_at DESC
  LIMIT 1
)
WHERE subscription.expected_amount_cents IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.payments AS payment
    WHERE payment.subscription_id = subscription.id
      AND payment.status = 'confirmed'
  );

CREATE TABLE IF NOT EXISTS public.billing_webhook_events (
  gateway TEXT NOT NULL DEFAULT 'asaas'
    CHECK (gateway IN ('asaas')),
  gateway_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  -- Retained only while an event is pending/failed. Terminal rows keep
  -- metadata for idempotency without retaining the gateway body.
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'ignored', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (gateway, gateway_event_id),
  CHECK (status IN ('processed', 'ignored') OR payload IS NOT NULL)
);

-- Keep this migration safe to re-run while developing an unapplied
-- migration: older local copies may have created payload as NOT NULL.
ALTER TABLE public.billing_webhook_events
  ALTER COLUMN payload DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_retry
  ON public.billing_webhook_events (received_at)
  WHERE status IN ('pending', 'failed');

DROP TRIGGER IF EXISTS set_billing_webhook_events_updated_at
  ON public.billing_webhook_events;
CREATE TRIGGER set_billing_webhook_events_updated_at
  BEFORE UPDATE ON public.billing_webhook_events
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;

-- This table contains gateway payloads and is operational/audit data.  It
-- is intentionally unavailable to browser roles.
REVOKE ALL ON TABLE public.billing_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.billing_webhook_events TO service_role;

-- Record the event independently from the financial transition.  On a
-- replay we keep the original payload and reject an event-id collision with
-- different contents rather than silently processing attacker-controlled
-- replacement data.
CREATE OR REPLACE FUNCTION public.record_asaas_billing_event(
  p_event_id TEXT,
  p_event_type TEXT,
  p_payload JSONB
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
  v_row public.billing_webhook_events%ROWTYPE;
BEGIN
  p_event_id := BTRIM(p_event_id);
  p_event_type := BTRIM(p_event_type);

  IF NULLIF(p_event_id, '') IS NULL
     OR LENGTH(p_event_id) > 255
     OR NULLIF(p_event_type, '') IS NULL
     OR LENGTH(p_event_type) > 100
     OR p_payload IS NULL
     OR OCTET_LENGTH(p_payload::TEXT) > 262144 THEN
    RAISE EXCEPTION 'invalid Asaas webhook event';
  END IF;

  INSERT INTO public.billing_webhook_events (
    gateway,
    gateway_event_id,
    event_type,
    payload
  )
  VALUES ('asaas', p_event_id, p_event_type, p_payload)
  ON CONFLICT (gateway, gateway_event_id) DO NOTHING;

  SELECT *
    INTO v_row
    FROM public.billing_webhook_events
   WHERE gateway = 'asaas'
     AND gateway_event_id = p_event_id
   FOR UPDATE;

  IF v_row.event_type IS DISTINCT FROM p_event_type
     OR (
       v_row.payload IS NOT NULL
       AND v_row.payload IS DISTINCT FROM p_payload
     ) THEN
    RAISE EXCEPTION 'Asaas event id collision with a different payload';
  END IF;

  outcome_status := v_row.status;
  should_process := v_row.status IN ('pending', 'failed');
  RETURN NEXT;
END;
$$;

-- Atomically applies a recorded event.  The nested exception block creates
-- a PostgreSQL subtransaction: partial payment/subscription mutations are
-- rolled back while the event itself is retained as `failed` for retry and
-- diagnosis.
CREATE OR REPLACE FUNCTION public.process_asaas_billing_event(
  p_event_id TEXT
)
RETURNS TABLE (
  outcome_status TEXT,
  error_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.billing_webhook_events%ROWTYPE;
  v_payment JSONB;
  v_gateway_payment_id TEXT;
  v_external_reference TEXT;
  v_gateway_subscription_id TEXT;
  v_billing_type TEXT;
  v_due_date DATE;
  v_amount NUMERIC;
  v_amount_cents INTEGER;
  v_payment_audit JSONB;
  v_subscription_id UUID;
  v_account_id UUID;
  v_cycle_days INTEGER;
  v_subscription_status TEXT;
  v_current_period_end TIMESTAMPTZ;
  v_expected_amount_cents INTEGER;
  v_existing_payment_subscription UUID;
  v_existing_payment_status TEXT;
  v_period_start TIMESTAMPTZ;
BEGIN
  SELECT *
    INTO v_event
    FROM public.billing_webhook_events
   WHERE gateway = 'asaas'
     AND gateway_event_id = p_event_id
   FOR UPDATE;

  IF NOT FOUND THEN
    outcome_status := 'failed';
    error_message := 'billing webhook event was not recorded';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_event.status IN ('processed', 'ignored') THEN
    outcome_status := v_event.status;
    error_message := NULL;
    RETURN NEXT;
    RETURN;
  END IF;

  UPDATE public.billing_webhook_events
     SET status = 'processing',
         attempt_count = attempt_count + 1,
         last_error = NULL
   WHERE gateway = 'asaas'
     AND gateway_event_id = p_event_id;

  BEGIN
    IF v_event.event_type IN ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE') THEN
      v_payment := v_event.payload->'payment';
      v_gateway_payment_id := NULLIF(v_payment->>'id', '');
      v_external_reference := NULLIF(v_payment->>'externalReference', '');

      IF v_payment IS NULL
         OR v_gateway_payment_id IS NULL
         OR LENGTH(v_gateway_payment_id) > 255
         OR v_external_reference IS NULL
         OR LENGTH(v_external_reference) > 255
         OR JSONB_TYPEOF(v_payment->'value') IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'payment event is missing correlation fields';
      END IF;

      -- Lock the logical payment even before a payments row exists. A row
      -- lock alone cannot protect the "not found, then insert" race: two
      -- concurrent events could otherwise attach one gateway charge to two
      -- subscriptions before the unique index resolves the insert conflict.
      PERFORM pg_advisory_xact_lock(
        hashtextextended('asaas:' || v_gateway_payment_id, 0)
      );

      SELECT
        s.id,
        s.account_id,
        p.cycle_days,
        s.status,
        s.current_period_end,
        s.expected_amount_cents
        INTO
          v_subscription_id,
          v_account_id,
          v_cycle_days,
          v_subscription_status,
          v_current_period_end,
          v_expected_amount_cents
        FROM public.subscriptions s
        JOIN public.billing_plans p ON p.id = s.plan_id
       WHERE s.id::TEXT = v_external_reference
       FOR UPDATE OF s;

      -- Asaas may deliver events for charges created outside IMCRM.  Keep
      -- an audit row, but deliberately do not retry an event we cannot
      -- correlate to one of our subscriptions.
      IF NOT FOUND THEN
        UPDATE public.billing_webhook_events
           SET status = 'ignored',
               payload = NULL,
               processed_at = NOW(),
               last_error = 'unknown subscription externalReference'
         WHERE gateway = 'asaas'
           AND gateway_event_id = p_event_id;

        outcome_status := 'ignored';
        error_message := NULL;
        RETURN NEXT;
        RETURN;
      END IF;

      v_billing_type := CASE UPPER(COALESCE(v_payment->>'billingType', ''))
        WHEN 'PIX' THEN 'pix'
        WHEN 'BOLETO' THEN 'boleto'
        WHEN 'CREDIT_CARD' THEN 'credit_card'
        ELSE NULL
      END;
      v_gateway_subscription_id := NULLIF(v_payment->>'subscription', '');
      IF LENGTH(COALESCE(v_gateway_subscription_id, '')) > 255 THEN
        v_gateway_subscription_id := NULL;
      END IF;

      -- A YYYY-MM-DD-shaped value can still be an impossible date. Treat an
      -- invalid optional due date as absent instead of retrying forever.
      v_due_date := NULL;
      IF COALESCE(v_payment->>'dueDate', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN
        BEGIN
          v_due_date := (v_payment->>'dueDate')::DATE;
        EXCEPTION WHEN DATETIME_FIELD_OVERFLOW THEN
          v_due_date := NULL;
        END;
      END IF;

      v_amount := (v_payment->>'value')::NUMERIC;
      IF v_amount < 0 OR v_amount > 21474836.47 THEN
        RAISE EXCEPTION 'payment value is outside the supported range';
      END IF;
      v_amount_cents := ROUND(v_amount * 100);

      -- Fail closed when a legacy pending checkout has no authoritative
      -- server-side amount. Accepting the gateway-provided value as truth
      -- would let an underpaid or unrelated charge activate access.
      IF v_expected_amount_cents IS NULL
         OR v_amount_cents <> v_expected_amount_cents THEN
        UPDATE public.billing_webhook_events
           SET status = 'ignored',
               payload = NULL,
               processed_at = NOW(),
               last_error = CASE
                 WHEN v_expected_amount_cents IS NULL
                   THEN 'subscription has no authoritative expected amount'
                 ELSE FORMAT(
                   'amount mismatch: expected %s cents, received %s cents',
                   v_expected_amount_cents,
                   v_amount_cents
                 )
               END
         WHERE gateway = 'asaas'
           AND gateway_event_id = p_event_id;

        outcome_status := 'ignored';
        error_message := NULL;
        RETURN NEXT;
        RETURN;
      END IF;

      -- The payment row needs enough provenance for support, not the full
      -- gateway object (which may contain customer PII).
      v_payment_audit := JSONB_STRIP_NULLS(JSONB_BUILD_OBJECT(
        'eventType', v_event.event_type,
        'gatewayPaymentId', v_gateway_payment_id,
        'billingType', v_payment->>'billingType',
        'dueDate', v_payment->>'dueDate'
      ));

      SELECT subscription_id, status
        INTO v_existing_payment_subscription, v_existing_payment_status
        FROM public.payments
       WHERE gateway_payment_id = v_gateway_payment_id
       FOR UPDATE;

      IF FOUND AND v_existing_payment_subscription <> v_subscription_id THEN
        RAISE EXCEPTION 'gateway payment is already linked to another subscription';
      END IF;

      IF v_event.event_type IN ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED') THEN
        INSERT INTO public.payments (
          gateway_payment_id,
          subscription_id,
          account_id,
          amount_cents,
          currency,
          status,
          billing_type,
          due_date,
          paid_at,
          raw_payload
        )
        VALUES (
          v_gateway_payment_id,
          v_subscription_id,
          v_account_id,
          v_amount_cents,
          'BRL',
          'confirmed',
          v_billing_type,
          v_due_date,
          NOW(),
          v_payment_audit
        )
        ON CONFLICT (gateway_payment_id) DO UPDATE
          SET status = 'confirmed',
              amount_cents = EXCLUDED.amount_cents,
              billing_type = COALESCE(EXCLUDED.billing_type, public.payments.billing_type),
              due_date = COALESCE(EXCLUDED.due_date, public.payments.due_date),
              paid_at = COALESCE(public.payments.paid_at, EXCLUDED.paid_at),
              raw_payload = EXCLUDED.raw_payload;

        -- One financial period per gateway charge.  Asaas commonly emits
        -- both CONFIRMED and RECEIVED for one payment; the second event
        -- updates the audit payload but must not add another period.
        IF v_existing_payment_status IS DISTINCT FROM 'confirmed'
           AND v_subscription_status NOT IN ('canceled', 'expired') THEN
          v_period_start := GREATEST(COALESCE(v_current_period_end, NOW()), NOW());

          UPDATE public.subscriptions
             SET status = 'active',
                 billing_type = COALESCE(v_billing_type, billing_type),
                 gateway_subscription_id =
                   COALESCE(v_gateway_subscription_id, gateway_subscription_id),
                 current_period_start = v_period_start,
                 current_period_end =
                   v_period_start + make_interval(days => GREATEST(v_cycle_days, 1))
           WHERE id = v_subscription_id;
        END IF;
      ELSE
        -- Never downgrade a charge already confirmed if an older OVERDUE
        -- delivery arrives out of order.
        IF v_existing_payment_status IS DISTINCT FROM 'confirmed' THEN
          INSERT INTO public.payments (
            gateway_payment_id,
            subscription_id,
            account_id,
            amount_cents,
            currency,
            status,
            billing_type,
            due_date,
            raw_payload
          )
          VALUES (
            v_gateway_payment_id,
            v_subscription_id,
            v_account_id,
            v_amount_cents,
            'BRL',
            'overdue',
            v_billing_type,
            v_due_date,
            v_payment_audit
          )
          ON CONFLICT (gateway_payment_id) DO UPDATE
            SET status = CASE
                  WHEN public.payments.status = 'confirmed'
                    THEN public.payments.status
                  ELSE 'overdue'
                END,
                amount_cents = EXCLUDED.amount_cents,
                billing_type = COALESCE(EXCLUDED.billing_type, public.payments.billing_type),
                due_date = COALESCE(EXCLUDED.due_date, public.payments.due_date),
                raw_payload = EXCLUDED.raw_payload;

          -- Keep access through a period that was already paid.  Once the
          -- paid-through instant passes, overdue correctly closes the gate.
          IF v_current_period_end IS NULL OR v_current_period_end <= NOW() THEN
            UPDATE public.subscriptions
               SET status = 'past_due'
             WHERE id = v_subscription_id
               AND status NOT IN ('canceled', 'expired');
          END IF;
        END IF;
      END IF;

    ELSIF v_event.event_type = 'SUBSCRIPTION_DELETED' THEN
      v_external_reference :=
        NULLIF(v_event.payload->'subscription'->>'externalReference', '');

      IF v_external_reference IS NULL THEN
        RAISE EXCEPTION 'subscription event is missing externalReference';
      END IF;

      UPDATE public.subscriptions
         SET status = 'canceled',
             canceled_at = COALESCE(canceled_at, NOW())
       WHERE id::TEXT = v_external_reference;

      IF NOT FOUND THEN
        UPDATE public.billing_webhook_events
           SET status = 'ignored',
               payload = NULL,
               processed_at = NOW(),
               last_error = 'unknown subscription externalReference'
         WHERE gateway = 'asaas'
           AND gateway_event_id = p_event_id;

        outcome_status := 'ignored';
        error_message := NULL;
        RETURN NEXT;
        RETURN;
      END IF;
    ELSE
      UPDATE public.billing_webhook_events
         SET status = 'ignored',
             payload = NULL,
             processed_at = NOW(),
             last_error = 'event type is not handled'
       WHERE gateway = 'asaas'
         AND gateway_event_id = p_event_id;

      outcome_status := 'ignored';
      error_message := NULL;
      RETURN NEXT;
      RETURN;
    END IF;

    UPDATE public.billing_webhook_events
       SET status = 'processed',
           payload = NULL,
           processed_at = NOW(),
           last_error = NULL
     WHERE gateway = 'asaas'
       AND gateway_event_id = p_event_id;

    outcome_status := 'processed';
    error_message := NULL;
    RETURN NEXT;
    RETURN;
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.billing_webhook_events
       SET status = 'failed',
           last_error = LEFT(SQLERRM, 1000)
     WHERE gateway = 'asaas'
       AND gateway_event_id = p_event_id;

    outcome_status := 'failed';
    error_message := LEFT(SQLERRM, 1000);
    RETURN NEXT;
    RETURN;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.record_asaas_billing_event(TEXT, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.process_asaas_billing_event(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_asaas_billing_event(TEXT, TEXT, JSONB)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.process_asaas_billing_event(TEXT)
  TO service_role;
