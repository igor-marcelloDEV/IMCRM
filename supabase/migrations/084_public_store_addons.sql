-- ============================================================
-- 084_public_store_addons.sql
--
-- Rewrites create_public_store_order (migration 065) to support:
--   1. Priced add-ons per line (migration 082's catalog_item_addons),
--      revalidated server-side — the client-sent price is never
--      trusted, same rule as the base item price already followed.
--   2. Pickup-vs-delivery + structured address/geo, folded into the
--      same atomic transaction instead of a follow-up UPDATE from the
--      route (migration 081/083's columns).
--   3. Pickup-slot capacity, serialized with an advisory lock so two
--      concurrent checkouts for the last spot in a slot can't both
--      succeed (migration 083's pickup_capacity_per_slot).
--
-- Two catalog lines can now legitimately share a catalog_item_id (the
-- same product with two different add-on configs), so the stock
-- check/decrement — which used to be one-row-per-line — is aggregated
-- by catalog_item_id first; doing it per-line would silently drop one
-- line's deduction (Postgres UPDATE...FROM only applies once per
-- target row when multiple FROM rows match it).
-- ============================================================

DROP FUNCTION IF EXISTS public.create_public_store_order(uuid, uuid, jsonb);

CREATE FUNCTION public.create_public_store_order(
  p_account_id uuid,
  p_contact_id uuid,
  p_items jsonb,
  p_fulfillment_type text DEFAULT NULL,
  p_delivery_address_line text DEFAULT NULL,
  p_delivery_number text DEFAULT NULL,
  p_delivery_complement text DEFAULT NULL,
  p_delivery_neighborhood text DEFAULT NULL,
  p_delivery_city text DEFAULT NULL,
  p_delivery_state text DEFAULT NULL,
  p_delivery_zip text DEFAULT NULL,
  p_delivery_lat double precision DEFAULT NULL,
  p_delivery_lng double precision DEFAULT NULL,
  p_pickup_scheduled_at timestamptz DEFAULT NULL
)
RETURNS TABLE (
  order_id uuid,
  deal_id uuid,
  total_cents integer,
  currency text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_user_id uuid;
  v_currency text;
  v_pipeline_id uuid;
  v_stage_id uuid;
  v_order_id uuid;
  v_deal_id uuid;
  v_total bigint;
  v_line_count integer;
  v_pickup_capacity integer;
  v_pickup_booked integer;
BEGIN
  IF p_account_id IS NULL OR p_contact_id IS NULL OR p_items IS NULL THEN
    RAISE EXCEPTION 'checkout identifiers are required' USING ERRCODE = '22004';
  END IF;

  SELECT accounts.owner_user_id, COALESCE(accounts.default_currency, 'BRL')
  INTO v_owner_user_id, v_currency
  FROM public.accounts AS accounts
  WHERE accounts.id = p_account_id;

  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'checkout account not found' USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.contacts AS contacts
    WHERE contacts.id = p_contact_id AND contacts.account_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'contact does not belong to checkout account'
      USING ERRCODE = '23514';
  END IF;

  SELECT pipelines.id INTO v_pipeline_id
  FROM public.pipelines AS pipelines
  WHERE pipelines.account_id = p_account_id
  ORDER BY pipelines.created_at ASC
  LIMIT 1;

  IF v_pipeline_id IS NULL THEN
    RAISE EXCEPTION 'account has no pipeline configured' USING ERRCODE = '23514';
  END IF;

  SELECT pipeline_stages.id INTO v_stage_id
  FROM public.pipeline_stages AS pipeline_stages
  WHERE pipeline_stages.pipeline_id = v_pipeline_id
  ORDER BY pipeline_stages.position ASC
  LIMIT 1;

  IF v_stage_id IS NULL THEN
    RAISE EXCEPTION 'pipeline has no stage configured' USING ERRCODE = '23514';
  END IF;

  -- Serialize concurrent bookings of the same pickup slot — there's no
  -- dedicated slot row to lock (slots are generated on the fly), so an
  -- advisory lock keyed by account+timestamp stands in for one. Held
  -- for the rest of the transaction, released automatically on commit.
  IF p_fulfillment_type = 'pickup' AND p_pickup_scheduled_at IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_account_id::text || p_pickup_scheduled_at::text, 0));

    SELECT accounts.pickup_capacity_per_slot INTO v_pickup_capacity
    FROM public.accounts AS accounts WHERE accounts.id = p_account_id;

    SELECT count(*) INTO v_pickup_booked
    FROM public.orders AS orders
    WHERE orders.account_id = p_account_id
      AND orders.fulfillment_type = 'pickup'
      AND orders.pickup_scheduled_at = p_pickup_scheduled_at
      AND orders.status <> 'canceled';

    IF v_pickup_booked >= COALESCE(v_pickup_capacity, 5) THEN
      RAISE EXCEPTION 'pickup slot is full' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Lock every referenced catalog row up front so a concurrent public
  -- checkout can't race past the stock check below.
  PERFORM 1
  FROM public.catalog_items AS catalog
  WHERE catalog.id IN (
    SELECT (elem->>'catalog_item_id')::uuid
    FROM jsonb_array_elements(p_items) AS elem
  )
  FOR UPDATE;

  -- `WITH ORDINALITY` numbers each JSON line so its add-ons (looked up
  -- separately below) can be correlated back without depending on
  -- INSERT/RETURNING row order — the order_item_id is pre-generated
  -- here instead.
  CREATE TEMPORARY TABLE _checkout_lines ON COMMIT DROP AS
  SELECT
    gen_random_uuid() AS order_item_id,
    ord.line_no,
    catalog.id AS catalog_item_id,
    catalog.name,
    catalog.price_cents,
    catalog.stock_quantity,
    (ord.elem->>'quantity')::integer AS quantity
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS ord(elem, line_no)
  JOIN public.catalog_items AS catalog
    ON catalog.id = (ord.elem->>'catalog_item_id')::uuid
  WHERE catalog.account_id = p_account_id
    AND catalog.is_active
    AND upper(catalog.currency) = upper(v_currency);

  SELECT count(*) INTO v_line_count FROM _checkout_lines;
  IF v_line_count = 0 THEN
    RAISE EXCEPTION 'cart has no valid items' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (SELECT 1 FROM _checkout_lines WHERE quantity IS NULL OR quantity <= 0) THEN
    RAISE EXCEPTION 'item quantity must be positive' USING ERRCODE = '23514';
  END IF;

  -- Two lines can share a catalog_item_id (same product, different
  -- add-ons) — aggregate before checking/decrementing stock so both
  -- lines' quantities count against the same physical inventory.
  IF EXISTS (
    SELECT 1 FROM (
      SELECT catalog_item_id, stock_quantity, sum(quantity) AS total_qty
      FROM _checkout_lines
      GROUP BY catalog_item_id, stock_quantity
    ) AS agg
    WHERE agg.stock_quantity IS NOT NULL AND agg.stock_quantity < agg.total_qty
  ) THEN
    RAISE EXCEPTION 'insufficient stock for one or more items' USING ERRCODE = '23514';
  END IF;

  -- Add-ons: re-priced from catalog_item_addons (never the client),
  -- scoped to the SAME product the line is actually for.
  CREATE TEMPORARY TABLE _checkout_line_addons ON COMMIT DROP AS
  SELECT
    lines.order_item_id,
    lines.line_no,
    addon.id AS catalog_item_addon_id,
    addon.name,
    addon.price_cents,
    grp.id AS group_id,
    COALESCE((a.elem->>'quantity')::integer, 1) AS quantity
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS ord(elem, line_no)
  JOIN _checkout_lines AS lines ON lines.line_no = ord.line_no
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(ord.elem->'addons', '[]'::jsonb)) AS a(elem)
  JOIN public.catalog_item_addons AS addon ON addon.id = (a.elem->>'addon_id')::uuid
  JOIN public.catalog_item_addon_groups AS grp
    ON grp.id = addon.group_id AND grp.catalog_item_id = lines.catalog_item_id
  WHERE addon.is_active;

  -- Required groups the line never touched at all.
  IF EXISTS (
    SELECT 1
    FROM _checkout_lines AS l
    JOIN public.catalog_item_addon_groups AS g ON g.catalog_item_id = l.catalog_item_id AND g.required
    WHERE NOT EXISTS (
      SELECT 1 FROM _checkout_line_addons AS a WHERE a.line_no = l.line_no AND a.group_id = g.id
    )
  ) THEN
    RAISE EXCEPTION 'a required add-on group was not selected' USING ERRCODE = '23514';
  END IF;

  -- Groups that WERE touched, but with a count outside min/max.
  IF EXISTS (
    SELECT 1
    FROM _checkout_line_addons AS a
    JOIN public.catalog_item_addon_groups AS g ON g.id = a.group_id
    GROUP BY a.line_no, a.group_id, g.min_select, g.max_select
    HAVING count(*) NOT BETWEEN g.min_select AND g.max_select
  ) THEN
    RAISE EXCEPTION 'add-on selection violates group rules' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.orders (
    account_id, contact_id, status, subtotal_cents, total_cents, currency, source,
    fulfillment_type, delivery_address_line, delivery_number, delivery_complement,
    delivery_neighborhood, delivery_city, delivery_state, delivery_zip,
    delivery_lat, delivery_lng, pickup_scheduled_at
  ) VALUES (
    p_account_id, p_contact_id, 'pending_payment', 0, 0, v_currency, 'public_store',
    p_fulfillment_type, p_delivery_address_line, p_delivery_number, p_delivery_complement,
    p_delivery_neighborhood, p_delivery_city, p_delivery_state, p_delivery_zip,
    p_delivery_lat, p_delivery_lng, p_pickup_scheduled_at
  )
  RETURNING id INTO v_order_id;

  INSERT INTO public.order_items (
    id, order_id, catalog_item_id, name_snapshot, quantity, unit_price_cents, total_cents
  )
  SELECT
    lines.order_item_id, v_order_id, lines.catalog_item_id, lines.name, lines.quantity, lines.price_cents,
    (
      lines.quantity::bigint * (
        lines.price_cents::bigint
        + COALESCE((
          SELECT sum(a.price_cents::bigint * a.quantity::bigint)
          FROM _checkout_line_addons AS a WHERE a.order_item_id = lines.order_item_id
        ), 0)
      )
    )::integer
  FROM _checkout_lines AS lines;

  INSERT INTO public.order_item_addons (
    order_item_id, catalog_item_addon_id, name_snapshot, price_cents_snapshot, quantity
  )
  SELECT order_item_id, catalog_item_addon_id, name, price_cents, quantity
  FROM _checkout_line_addons;

  -- `oi` alias is load-bearing: bare `total_cents`/`order_id` here would
  -- be ambiguous against this function's own RETURNS TABLE column names.
  SELECT COALESCE(sum(oi.total_cents), 0) INTO v_total
  FROM public.order_items AS oi WHERE oi.order_id = v_order_id;

  IF v_total <= 0 OR v_total > 2147483647 THEN
    RAISE EXCEPTION 'order total is outside the supported range' USING ERRCODE = '22003';
  END IF;

  UPDATE public.orders SET subtotal_cents = v_total::integer, total_cents = v_total::integer
  WHERE id = v_order_id;

  UPDATE public.catalog_items AS catalog
  SET stock_quantity = catalog.stock_quantity - agg.total_qty
  FROM (
    SELECT catalog_item_id, sum(quantity) AS total_qty
    FROM _checkout_lines
    GROUP BY catalog_item_id
  ) AS agg
  WHERE catalog.id = agg.catalog_item_id AND catalog.stock_quantity IS NOT NULL;

  INSERT INTO public.deals (
    account_id, user_id, pipeline_id, stage_id, contact_id, title, value, currency, status
  ) VALUES (
    p_account_id, v_owner_user_id, v_pipeline_id, v_stage_id, p_contact_id,
    -- 'open', not 'active' — deals_status_check (migration 002) only
    -- allows open/won/lost. Migration 065 originally shipped with
    -- 'active' and 067 fixed it; preserving that fix here since this
    -- rewrite otherwise started from 065's body.
    'Pedido site', v_total / 100.0, v_currency, 'open'
  )
  RETURNING id INTO v_deal_id;

  UPDATE public.orders SET deal_id = v_deal_id WHERE id = v_order_id;

  RETURN QUERY SELECT v_order_id, v_deal_id, v_total::integer, v_currency;
END;
$$;

-- Postgres grants EXECUTE to PUBLIC on new functions by default — 067
-- closed that gap for the old 3-arg signature, but this rewrite's
-- extended signature is a distinct function object that starts back
-- at the (over-permissive) default. Only the checkout route's
-- service-role client should ever call this.
REVOKE ALL ON FUNCTION public.create_public_store_order(
  uuid, uuid, jsonb, text, text, text, text, text, text, text, text,
  double precision, double precision, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_public_store_order(
  uuid, uuid, jsonb, text, text, text, text, text, text, text, text,
  double precision, double precision, timestamptz
) TO service_role;
