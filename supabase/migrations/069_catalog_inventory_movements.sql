-- Dedicated inventory ledger for the Catalog module.
CREATE TABLE IF NOT EXISTS public.catalog_stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  catalog_item_id UUID REFERENCES public.catalog_items(id) ON DELETE SET NULL,
  item_name TEXT NOT NULL,
  quantity_delta INTEGER NOT NULL CHECK (quantity_delta <> 0),
  balance_after INTEGER,
  movement_type TEXT NOT NULL DEFAULT 'adjustment'
    CHECK (movement_type IN ('initial', 'stock_entry', 'sale_or_removal', 'adjustment')),
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_stock_movements_account_created
  ON public.catalog_stock_movements(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_stock_movements_item_created
  ON public.catalog_stock_movements(catalog_item_id, created_at DESC);

ALTER TABLE public.catalog_stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_stock_movements_select ON public.catalog_stock_movements;
CREATE POLICY catalog_stock_movements_select ON public.catalog_stock_movements
  FOR SELECT TO authenticated
  USING (public.is_account_member(account_id));

-- Establish an opening balance for stock that existed before the ledger.
INSERT INTO public.catalog_stock_movements (
  account_id, catalog_item_id, item_name, quantity_delta,
  balance_after, movement_type, note
)
SELECT
  item.account_id, item.id, item.name, item.stock_quantity,
  item.stock_quantity, 'initial', 'Saldo inicial importado'
FROM public.catalog_items AS item
WHERE item.stock_quantity IS NOT NULL
  AND item.stock_quantity > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.catalog_stock_movements AS movement
    WHERE movement.catalog_item_id = item.id
  );

CREATE OR REPLACE FUNCTION public.log_catalog_stock_movement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old INTEGER;
  v_delta INTEGER;
  v_type TEXT;
  v_note TEXT;
BEGIN
  IF NEW.stock_quantity IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.stock_quantity IS NOT DISTINCT FROM OLD.stock_quantity THEN
    RETURN NEW;
  END IF;

  v_old := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.stock_quantity, 0) END;
  v_delta := NEW.stock_quantity - v_old;
  IF v_delta = 0 THEN RETURN NEW; END IF;

  v_type := NULLIF(current_setting('app.stock_movement_type', true), '');
  v_note := NULLIF(current_setting('app.stock_movement_note', true), '');
  IF v_type IS NULL THEN
    v_type := CASE
      WHEN TG_OP = 'INSERT' THEN 'initial'
      WHEN v_delta > 0 THEN 'stock_entry'
      ELSE 'sale_or_removal'
    END;
  END IF;

  INSERT INTO public.catalog_stock_movements (
    account_id, catalog_item_id, item_name, quantity_delta,
    balance_after, movement_type, note, created_by
  ) VALUES (
    NEW.account_id, NEW.id, NEW.name, v_delta,
    NEW.stock_quantity, v_type, v_note, auth.uid()
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS catalog_stock_movement_trigger ON public.catalog_items;
CREATE TRIGGER catalog_stock_movement_trigger
  AFTER INSERT OR UPDATE OF stock_quantity ON public.catalog_items
  FOR EACH ROW EXECUTE FUNCTION public.log_catalog_stock_movement();

CREATE OR REPLACE FUNCTION public.add_catalog_stock_batch(
  p_account_id UUID,
  p_adjustments JSONB,
  p_note TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row JSONB;
  v_count INTEGER := 0;
  v_quantity INTEGER;
BEGIN
  IF jsonb_typeof(p_adjustments) <> 'array' OR jsonb_array_length(p_adjustments) = 0 THEN
    RAISE EXCEPTION 'adjustments must be a non-empty array';
  END IF;
  PERFORM set_config('app.stock_movement_type', 'stock_entry', true);
  PERFORM set_config('app.stock_movement_note', COALESCE(left(trim(p_note), 500), ''), true);

  FOR v_row IN SELECT value FROM jsonb_array_elements(p_adjustments)
  LOOP
    v_quantity := (v_row->>'quantity')::INTEGER;
    IF v_quantity <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
    UPDATE public.catalog_items
      SET stock_quantity = COALESCE(stock_quantity, 0) + v_quantity
      WHERE id = (v_row->>'catalog_item_id')::UUID
        AND account_id = p_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'catalog item not found'; END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.add_catalog_stock_batch(UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_catalog_stock_batch(UUID, JSONB, TEXT) TO service_role;
