-- ============================================================
-- 065_public_store.sql
--
-- Public storefront — an unauthenticated link (`/loja/{account_id}`)
-- where a tenant's own customers browse the catalog, build a cart,
-- and check out themselves. Exists because the WhatsApp Cloud API
-- 24h messaging window (and lack of an approved template) can leave
-- a tenant unable to message a lead at all — the storefront gives
-- them a channel-independent way to still close the sale.
--
-- Reuses the existing catalog_items/orders/order_items schema
-- (migration 046) and the 'source' column (migration 064) — a
-- public-store order is not fundamentally different from a comanda,
-- it's just self-service. Also adds inventory tracking
-- (catalog_items.stock_quantity), requested independently but a
-- prerequisite for the storefront not overselling a limited item.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- STOCK — NULL means "not tracked" (unlimited, today's behaviour for
-- every existing row). A non-null value is decremented atomically by
-- create_public_store_order below and by the comanda item-add route;
-- it never goes negative (CHECK + the row lock in both write paths).
-- ============================================================
ALTER TABLE catalog_items ADD COLUMN IF NOT EXISTS stock_quantity INTEGER;
ALTER TABLE catalog_items DROP CONSTRAINT IF EXISTS catalog_items_stock_quantity_check;
ALTER TABLE catalog_items ADD CONSTRAINT catalog_items_stock_quantity_check
  CHECK (stock_quantity IS NULL OR stock_quantity >= 0);

-- ============================================================
-- ORDERS.source — a checkout completed on the public storefront,
-- distinct from a WhatsApp-Flow checkout or a hand-opened comanda.
-- ============================================================
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check
  CHECK (source IN ('whatsapp_checkout', 'manual', 'public_store'));

-- ============================================================
-- create_public_store_order — the public checkout route's one write.
-- No `carts` row is involved (there's no chat-driven, item-at-a-time
-- flow to persist mid-way through) and no acting user/profile check
-- (the caller isn't a signed-in account member) — those are what set
-- claim_cart_checkout (migration 057) apart. What's shared with it:
-- server-side price/currency/ownership revalidation of every line,
-- and a linked Deal so the sale enters the same pipeline a WhatsApp
-- checkout would. The Deal is owned by the account's immutable owner
-- (accounts.owner_user_id) since there is no acting agent to assign
-- it to — same "system-created, reassign later" shape as any
-- automation-created deal.
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_public_store_order(
  p_account_id uuid,
  p_contact_id uuid,
  p_items jsonb
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

  -- Lock every referenced catalog row up front so a concurrent public
  -- checkout can't race past the stock check below.
  PERFORM 1
  FROM public.catalog_items AS catalog
  WHERE catalog.id IN (
    SELECT (elem->>'catalog_item_id')::uuid
    FROM jsonb_array_elements(p_items) AS elem
  )
  FOR UPDATE;

  CREATE TEMPORARY TABLE _checkout_lines ON COMMIT DROP AS
  SELECT
    catalog.id AS catalog_item_id,
    catalog.name,
    catalog.price_cents,
    catalog.stock_quantity,
    (elem->>'quantity')::integer AS quantity
  FROM jsonb_array_elements(p_items) AS elem
  JOIN public.catalog_items AS catalog
    ON catalog.id = (elem->>'catalog_item_id')::uuid
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

  IF EXISTS (
    SELECT 1 FROM _checkout_lines
    WHERE stock_quantity IS NOT NULL AND stock_quantity < quantity
  ) THEN
    RAISE EXCEPTION 'insufficient stock for one or more items' USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(sum(quantity::bigint * price_cents::bigint), 0)
  INTO v_total
  FROM _checkout_lines;

  IF v_total <= 0 OR v_total > 2147483647 THEN
    RAISE EXCEPTION 'order total is outside the supported range' USING ERRCODE = '22003';
  END IF;

  INSERT INTO public.orders (
    account_id, contact_id, status, subtotal_cents, total_cents, currency, source
  ) VALUES (
    p_account_id, p_contact_id, 'pending_payment', v_total::integer, v_total::integer, v_currency, 'public_store'
  )
  RETURNING id INTO v_order_id;

  INSERT INTO public.order_items (
    order_id, catalog_item_id, name_snapshot, quantity, unit_price_cents, total_cents
  )
  SELECT
    v_order_id, catalog_item_id, name, quantity, price_cents,
    (quantity::bigint * price_cents::bigint)::integer
  FROM _checkout_lines;

  UPDATE public.catalog_items AS catalog
  SET stock_quantity = catalog.stock_quantity - lines.quantity
  FROM _checkout_lines AS lines
  WHERE catalog.id = lines.catalog_item_id
    AND catalog.stock_quantity IS NOT NULL;

  INSERT INTO public.deals (
    account_id, user_id, pipeline_id, stage_id, contact_id, title, value, currency, status
  ) VALUES (
    p_account_id, v_owner_user_id, v_pipeline_id, v_stage_id, p_contact_id,
    'Pedido site', v_total / 100.0, v_currency, 'active'
  )
  RETURNING id INTO v_deal_id;

  UPDATE public.orders SET deal_id = v_deal_id WHERE id = v_order_id;

  RETURN QUERY SELECT v_order_id, v_deal_id, v_total::integer, v_currency;
END;
$$;
