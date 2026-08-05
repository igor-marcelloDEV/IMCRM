-- ============================================================
-- 085_claim_cart_checkout_addons.sql
--
-- claim_cart_checkout (migration 057) converts a WhatsApp-bot cart
-- into a real order — it summed cart_items.unit_price_cents only, so
-- any add-ons priced via cart_item_addons (migration 082, populated
-- by the flow engine's new addon-group sub-flow) were silently
-- dropped from both the charged total AND the order_items snapshot.
-- Same signature, so CREATE OR REPLACE keeps existing grants intact.
-- ============================================================

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

  -- Pre-generate each line's order_item_id so cart_item_addons can be
  -- correlated to their new order_item_addons row without depending on
  -- INSERT/RETURNING order (same trick as create_public_store_order,
  -- migration 084) — and fold each line's add-on cost into its total
  -- up front, since that total is both inserted into order_items AND
  -- summed into cart_total/the order's charged amount below.
  CREATE TEMPORARY TABLE _claim_order_items ON COMMIT DROP AS
  SELECT
    gen_random_uuid() AS order_item_id,
    items.id AS cart_item_id,
    items.catalog_item_id,
    COALESCE(catalog.name, 'Item') AS name,
    items.quantity,
    items.unit_price_cents,
    (
      items.quantity::bigint * (
        items.unit_price_cents::bigint
        + COALESCE((
          SELECT sum(addons.price_cents_snapshot::bigint * addons.quantity::bigint)
          FROM public.cart_item_addons AS addons
          WHERE addons.cart_item_id = items.id
        ), 0)
      )
    )::integer AS total_cents
  FROM public.cart_items AS items
  LEFT JOIN public.catalog_items AS catalog
    ON catalog.id = items.catalog_item_id
  WHERE items.cart_id = selected_cart.id;

  -- `lines` alias is load-bearing: bare `total_cents` here is ambiguous
  -- against this function's own RETURNS TABLE column of the same name.
  SELECT
    count(*)::integer,
    COALESCE(sum(lines.total_cents::bigint), 0)
  INTO line_count, cart_total
  FROM _claim_order_items AS lines;

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
    id,
    order_id,
    catalog_item_id,
    name_snapshot,
    quantity,
    unit_price_cents,
    total_cents
  )
  SELECT
    lines.order_item_id,
    selected_order.id,
    lines.catalog_item_id,
    lines.name,
    lines.quantity,
    lines.unit_price_cents,
    lines.total_cents
  FROM _claim_order_items AS lines;

  INSERT INTO public.order_item_addons (
    order_item_id,
    catalog_item_addon_id,
    name_snapshot,
    price_cents_snapshot,
    quantity
  )
  SELECT
    lines.order_item_id,
    addons.catalog_item_addon_id,
    addons.name_snapshot,
    addons.price_cents_snapshot,
    addons.quantity
  FROM public.cart_item_addons AS addons
  JOIN _claim_order_items AS lines ON lines.cart_item_id = addons.cart_item_id;

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
