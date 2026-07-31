-- ============================================================
-- 057_checkout_integrity.sql
--
-- Transactional/idempotent checkout and recoverable PIX creation:
--   * one order per cart, with safe legacy deduplication;
--   * cart + order items + totals + linked deal created in one RPC;
--   * checkout_pending claims a cart without falsely closing it;
--   * a leased payment attempt prevents concurrent PIX creation;
--   * gateway ids, PIX payload and cart completion persist atomically;
--   * operational failures remain visible on the order for support.
-- ============================================================

ALTER TABLE public.carts
  DROP CONSTRAINT IF EXISTS carts_status_check;
ALTER TABLE public.carts
  ADD CONSTRAINT carts_status_check
  CHECK (status IN ('open', 'checkout_pending', 'checked_out', 'abandoned'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_checkout_cart_per_contact
  ON public.carts(contact_id)
  WHERE status IN ('open', 'checkout_pending');

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pix_copy_paste text,
  ADD COLUMN IF NOT EXISTS pix_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_claim_token uuid,
  ADD COLUMN IF NOT EXISTS payment_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkout_error_code text,
  ADD COLUMN IF NOT EXISTS checkout_error_detail text,
  ADD COLUMN IF NOT EXISTS checkout_error_at timestamptz;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_payment_attempt_count_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_payment_attempt_count_check
  CHECK (payment_attempt_count >= 0);

-- Old application code could race and create more than one order for
-- the same cart. Preserve every financial row, but retain the cart link
-- only on the most authoritative one before enforcing uniqueness.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY cart_id
      ORDER BY
        CASE
          WHEN status = 'paid' THEN 0
          WHEN gateway_payment_id IS NOT NULL THEN 1
          ELSE 2
        END,
        created_at,
        id
    ) AS position
  FROM public.orders
  WHERE cart_id IS NOT NULL
)
UPDATE public.orders AS orders
SET cart_id = NULL
FROM ranked
WHERE orders.id = ranked.id
  AND ranked.position > 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_cart_id_key'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_cart_id_key UNIQUE (cart_id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_orders_checkout_errors
  ON public.orders(account_id, checkout_error_at DESC)
  WHERE checkout_error_at IS NOT NULL;

-- Every cart-item write locks its parent cart and is accepted only
-- while that cart is open. This closes the race where checkout had
-- already calculated the total but a concurrent inbound message
-- inserted/incremented a line before the snapshot was copied.
CREATE OR REPLACE FUNCTION public.require_open_cart_for_item_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  source_status text;
  destination_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT carts.status
    INTO source_status
    FROM public.carts AS carts
    WHERE carts.id = OLD.cart_id
    FOR UPDATE;

    IF source_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'cart items can only change while the cart is open'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT carts.status
    INTO destination_status
    FROM public.carts AS carts
    WHERE carts.id = NEW.cart_id
    FOR UPDATE;

    IF destination_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'cart items can only be added to an open cart'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.cart_id IS DISTINCT FROM OLD.cart_id THEN
    SELECT carts.status
    INTO destination_status
    FROM public.carts AS carts
    WHERE carts.id = NEW.cart_id
    FOR UPDATE;

    IF destination_status IS DISTINCT FROM 'open' THEN
      RAISE EXCEPTION 'cart items can only be added to an open cart'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS require_open_cart_for_item_write
  ON public.cart_items;
CREATE TRIGGER require_open_cart_for_item_write
  BEFORE INSERT OR UPDATE ON public.cart_items
  FOR EACH ROW
  EXECUTE FUNCTION public.require_open_cart_for_item_write();

-- Lock/claim the cart and create the complete local checkout snapshot
-- in one transaction. The RPC either commits cart + order + line items
-- + deal together or leaves all four untouched.
CREATE OR REPLACE FUNCTION public.claim_cart_checkout(
  p_account_id uuid,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_pipeline_id uuid,
  p_stage_id uuid
)
RETURNS TABLE (
  order_id uuid,
  cart_id uuid,
  account_id uuid,
  contact_id uuid,
  total_cents integer,
  currency text,
  gateway_customer_id text,
  gateway_payment_id text,
  pix_copy_paste text,
  pix_expires_at timestamptz,
  created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  selected_cart public.carts%ROWTYPE;
  selected_order public.orders%ROWTYPE;
  selected_currency text;
  line_count integer;
  cart_total bigint;
  new_deal_id uuid;
BEGIN
  IF p_account_id IS NULL
     OR p_contact_id IS NULL
     OR p_user_id IS NULL
     OR p_pipeline_id IS NULL
     OR p_stage_id IS NULL THEN
    RAISE EXCEPTION 'checkout identifiers are required'
      USING ERRCODE = '22004';
  END IF;

  -- Serializes even the small window before a concrete cart row is
  -- selected, while FOR UPDATE below protects the cart itself.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(p_account_id::text || ':' || p_contact_id::text, 0)
  );

  SELECT carts.*
  INTO selected_cart
  FROM public.carts AS carts
  WHERE carts.account_id = p_account_id
    AND carts.contact_id = p_contact_id
    AND carts.status IN ('checkout_pending', 'open')
  ORDER BY
    CASE WHEN carts.status = 'checkout_pending' THEN 0 ELSE 1 END,
    carts.created_at
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT orders.*
  INTO selected_order
  FROM public.orders AS orders
  WHERE orders.cart_id = selected_cart.id;

  IF FOUND THEN
    IF selected_order.account_id <> p_account_id
       OR selected_order.contact_id IS DISTINCT FROM p_contact_id
       OR selected_order.status <> 'pending_payment' THEN
      RAISE EXCEPTION 'cart is already linked to an incompatible order'
        USING ERRCODE = '23514';
    END IF;

    IF selected_cart.status = 'open' THEN
      UPDATE public.carts
      SET status = 'checkout_pending'
      WHERE id = selected_cart.id;
    END IF;

    RETURN QUERY
    SELECT
      selected_order.id,
      selected_order.cart_id,
      selected_order.account_id,
      selected_order.contact_id,
      selected_order.total_cents,
      selected_order.currency,
      selected_order.gateway_customer_id,
      selected_order.gateway_payment_id,
      selected_order.pix_copy_paste,
      selected_order.pix_expires_at,
      false;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.contacts AS contacts
    WHERE contacts.id = p_contact_id
      AND contacts.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'contact does not belong to checkout account'
      USING ERRCODE = '23514';
  END IF;

  IF p_conversation_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM public.conversations AS conversations
       WHERE conversations.id = p_conversation_id
         AND conversations.account_id = p_account_id
         AND conversations.contact_id = p_contact_id
     ) THEN
    RAISE EXCEPTION 'conversation does not belong to checkout contact'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles AS profiles
    WHERE profiles.user_id = p_user_id
      AND profiles.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'checkout actor does not belong to account'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.pipelines AS pipelines
    JOIN public.pipeline_stages AS stages
      ON stages.pipeline_id = pipelines.id
    WHERE pipelines.id = p_pipeline_id
      AND pipelines.account_id = p_account_id
      AND stages.id = p_stage_id
  ) THEN
    RAISE EXCEPTION 'pipeline/stage does not belong to checkout account'
      USING ERRCODE = '23514';
  END IF;

  -- Existing rows cannot be changed/deleted until the snapshot
  -- commits. New inserts/updates are serialized through the parent
  -- cart lock by require_open_cart_for_item_write().
  PERFORM 1
  FROM public.cart_items AS items
  WHERE items.cart_id = selected_cart.id
  FOR UPDATE;

  SELECT
    count(*)::integer,
    COALESCE(
      sum(items.quantity::bigint * items.unit_price_cents::bigint),
      0
    )
  INTO line_count, cart_total
  FROM public.cart_items AS items
  WHERE items.cart_id = selected_cart.id;

  IF line_count = 0 THEN
    RETURN;
  END IF;
  IF cart_total <= 0 OR cart_total > 2147483647 THEN
    RAISE EXCEPTION 'cart total is outside the supported payment range'
      USING ERRCODE = '22003';
  END IF;

  SELECT COALESCE(accounts.default_currency, 'BRL')
  INTO selected_currency
  FROM public.accounts AS accounts
  WHERE accounts.id = p_account_id;

  IF selected_currency IS NULL THEN
    RAISE EXCEPTION 'checkout account not found'
      USING ERRCODE = '23503';
  END IF;
  IF upper(selected_currency) <> 'BRL' THEN
    RAISE EXCEPTION 'tenant PIX checkout requires BRL account currency'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.cart_items AS items
    JOIN public.catalog_items AS catalog
      ON catalog.id = items.catalog_item_id
    WHERE items.cart_id = selected_cart.id
      AND (
        catalog.account_id <> p_account_id
        OR upper(catalog.currency) <> upper(selected_currency)
        OR items.unit_price_cents < 0
      )
  ) THEN
    RAISE EXCEPTION 'cart items do not match checkout account/currency'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.orders (
    account_id,
    cart_id,
    contact_id,
    status,
    subtotal_cents,
    total_cents,
    currency
  )
  VALUES (
    p_account_id,
    selected_cart.id,
    p_contact_id,
    'pending_payment',
    cart_total::integer,
    cart_total::integer,
    selected_currency
  )
  RETURNING *
  INTO selected_order;

  INSERT INTO public.order_items (
    order_id,
    catalog_item_id,
    name_snapshot,
    quantity,
    unit_price_cents,
    total_cents
  )
  SELECT
    selected_order.id,
    items.catalog_item_id,
    COALESCE(catalog.name, 'Item'),
    items.quantity,
    items.unit_price_cents,
    (
      items.quantity::bigint * items.unit_price_cents::bigint
    )::integer
  FROM public.cart_items AS items
  LEFT JOIN public.catalog_items AS catalog
    ON catalog.id = items.catalog_item_id
  WHERE items.cart_id = selected_cart.id;

  INSERT INTO public.deals (
    account_id,
    user_id,
    pipeline_id,
    stage_id,
    contact_id,
    conversation_id,
    title,
    value,
    currency,
    status
  )
  VALUES (
    p_account_id,
    p_user_id,
    p_pipeline_id,
    p_stage_id,
    p_contact_id,
    p_conversation_id,
    'Pedido via WhatsApp',
    cart_total::numeric / 100,
    selected_currency,
    'open'
  )
  RETURNING id
  INTO new_deal_id;

  UPDATE public.orders
  SET deal_id = new_deal_id
  WHERE id = selected_order.id
  RETURNING *
  INTO selected_order;

  UPDATE public.carts
  SET status = 'checkout_pending'
  WHERE id = selected_cart.id;

  RETURN QUERY
  SELECT
    selected_order.id,
    selected_order.cart_id,
    selected_order.account_id,
    selected_order.contact_id,
    selected_order.total_cents,
    selected_order.currency,
    selected_order.gateway_customer_id,
    selected_order.gateway_payment_id,
    selected_order.pix_copy_paste,
    selected_order.pix_expires_at,
    true;
END;
$$;

-- Short lease around the network call. A crashed/ambiguous attempt is
-- recoverable after expiry by looking up the order externalReference
-- at Asaas before any second POST /payments.
CREATE OR REPLACE FUNCTION public.claim_order_payment_attempt(
  p_order_id uuid,
  p_account_id uuid,
  p_lease_seconds integer DEFAULT 90
)
RETURNS TABLE (
  order_id uuid,
  claim_token uuid,
  attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_claim_token uuid := gen_random_uuid();
BEGIN
  RETURN QUERY
  UPDATE public.orders AS orders
  SET
    payment_claim_token = new_claim_token,
    payment_claimed_at = now(),
    payment_attempt_count = orders.payment_attempt_count + 1,
    checkout_error_code = NULL,
    checkout_error_detail = NULL,
    checkout_error_at = NULL
  WHERE orders.id = p_order_id
    AND orders.account_id = p_account_id
    AND orders.status = 'pending_payment'
    AND orders.gateway_payment_id IS NULL
    AND (
      orders.payment_claim_token IS NULL
      OR orders.payment_claimed_at IS NULL
      OR orders.payment_claimed_at <
        now() - make_interval(
          secs => LEAST(GREATEST(p_lease_seconds, 30), 600)
        )
    )
  RETURNING
    orders.id,
    orders.payment_claim_token,
    orders.payment_attempt_count;
END;
$$;

-- Persist gateway reconciliation and close the cart in the same DB
-- transaction. With a claim token this is first-time completion; with
-- NULL it only recovers PIX details for the already-correlated payment.
CREATE OR REPLACE FUNCTION public.complete_order_pix_charge(
  p_order_id uuid,
  p_account_id uuid,
  p_claim_token uuid,
  p_gateway_customer_id text,
  p_gateway_payment_id text,
  p_pix_copy_paste text,
  p_pix_expires_at timestamptz
)
RETURNS TABLE (
  order_id uuid,
  cart_id uuid,
  total_cents integer,
  currency text,
  gateway_payment_id text,
  pix_copy_paste text,
  pix_expires_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  completed_order public.orders%ROWTYPE;
  cart_is_complete boolean;
BEGIN
  IF p_gateway_payment_id IS NULL
     OR btrim(p_gateway_payment_id) = ''
     OR p_pix_copy_paste IS NULL
     OR btrim(p_pix_copy_paste) = '' THEN
    RAISE EXCEPTION 'gateway payment id and PIX payload are required'
      USING ERRCODE = '22004';
  END IF;

  IF p_claim_token IS NOT NULL THEN
    UPDATE public.orders AS orders
    SET
      gateway_customer_id = p_gateway_customer_id,
      gateway_payment_id = p_gateway_payment_id,
      pix_copy_paste = p_pix_copy_paste,
      pix_expires_at = p_pix_expires_at,
      payment_claim_token = NULL,
      payment_claimed_at = NULL,
      checkout_error_code = NULL,
      checkout_error_detail = NULL,
      checkout_error_at = NULL
    WHERE orders.id = p_order_id
      AND orders.account_id = p_account_id
      AND orders.status = 'pending_payment'
      AND orders.gateway_payment_id IS NULL
      AND orders.payment_claim_token = p_claim_token
    RETURNING *
    INTO completed_order;
  ELSE
    UPDATE public.orders AS orders
    SET
      pix_copy_paste = p_pix_copy_paste,
      pix_expires_at = p_pix_expires_at,
      checkout_error_code = NULL,
      checkout_error_detail = NULL,
      checkout_error_at = NULL
    WHERE orders.id = p_order_id
      AND orders.account_id = p_account_id
      AND orders.status = 'pending_payment'
      AND orders.gateway_payment_id = p_gateway_payment_id
    RETURNING *
    INTO completed_order;
  END IF;

  IF completed_order.id IS NULL THEN
    RETURN;
  END IF;
  IF completed_order.cart_id IS NULL THEN
    RAISE EXCEPTION 'charged checkout order is not linked to a cart'
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.carts
  SET status = 'checked_out'
  WHERE id = completed_order.cart_id
    AND account_id = p_account_id
    AND status IN ('open', 'checkout_pending');

  IF NOT FOUND THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.carts AS carts
      WHERE carts.id = completed_order.cart_id
        AND carts.account_id = p_account_id
        AND carts.status = 'checked_out'
    )
    INTO cart_is_complete;

    IF NOT cart_is_complete THEN
      RAISE EXCEPTION 'checkout cart could not be completed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    completed_order.id,
    completed_order.cart_id,
    completed_order.total_cents,
    completed_order.currency,
    completed_order.gateway_payment_id,
    completed_order.pix_copy_paste,
    completed_order.pix_expires_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_order_checkout_error(
  p_order_id uuid,
  p_account_id uuid,
  p_claim_token uuid,
  p_error_code text,
  p_error_detail text,
  p_hold_claim boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.orders AS orders
  SET
    checkout_error_code = left(COALESCE(p_error_code, 'checkout_failed'), 120),
    checkout_error_detail = left(COALESCE(p_error_detail, ''), 2000),
    checkout_error_at = now(),
    payment_claim_token = CASE
      WHEN p_claim_token IS NULL OR p_hold_claim
        THEN orders.payment_claim_token
      ELSE NULL
    END,
    payment_claimed_at = CASE
      WHEN p_claim_token IS NULL
        THEN orders.payment_claimed_at
      WHEN p_hold_claim
        THEN now()
      ELSE NULL
    END
  WHERE orders.id = p_order_id
    AND orders.account_id = p_account_id
    AND (
      p_claim_token IS NULL
      OR orders.payment_claim_token = p_claim_token
    );

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_order_checkout_error(
  p_order_id uuid,
  p_account_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE public.orders
  SET
    checkout_error_code = NULL,
    checkout_error_detail = NULL,
    checkout_error_at = NULL
  WHERE id = p_order_id
    AND account_id = p_account_id;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_cart_checkout(
  uuid, uuid, uuid, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_cart_checkout(
  uuid, uuid, uuid, uuid, uuid, uuid
) TO service_role;

REVOKE ALL ON FUNCTION public.claim_order_payment_attempt(
  uuid, uuid, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_order_payment_attempt(
  uuid, uuid, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.complete_order_pix_charge(
  uuid, uuid, uuid, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_order_pix_charge(
  uuid, uuid, uuid, text, text, text, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.record_order_checkout_error(
  uuid, uuid, uuid, text, text, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_order_checkout_error(
  uuid, uuid, uuid, text, text, boolean
) TO service_role;

REVOKE ALL ON FUNCTION public.clear_order_checkout_error(
  uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_order_checkout_error(
  uuid, uuid
) TO service_role;
