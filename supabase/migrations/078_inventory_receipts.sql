ALTER TABLE public.catalog_stock_movements
  ADD COLUMN IF NOT EXISTS receipt_path text,
  ADD COLUMN IF NOT EXISTS receipt_name text,
  ADD COLUMN IF NOT EXISTS receipt_mime_type text;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('inventory-receipts', 'inventory-receipts', false, 10485760,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Members can upload inventory receipts" ON storage.objects;
CREATE POLICY "Members can upload inventory receipts" ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'inventory-receipts'
  AND (storage.foldername(name))[1] LIKE 'account-%'
  AND public.is_account_member(substring((storage.foldername(name))[1] from 9)::uuid)
);

DROP POLICY IF EXISTS "Members can read inventory receipts" ON storage.objects;
CREATE POLICY "Members can read inventory receipts" ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'inventory-receipts'
  AND (storage.foldername(name))[1] LIKE 'account-%'
  AND public.is_account_member(substring((storage.foldername(name))[1] from 9)::uuid)
);

DROP POLICY IF EXISTS "Members can delete inventory receipts" ON storage.objects;
CREATE POLICY "Members can delete inventory receipts" ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'inventory-receipts'
  AND (storage.foldername(name))[1] LIKE 'account-%'
  AND public.is_account_member(substring((storage.foldername(name))[1] from 9)::uuid)
);

CREATE OR REPLACE FUNCTION public.log_catalog_stock_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old integer; v_delta integer; v_type text; v_note text;
  v_receipt_path text; v_receipt_name text; v_receipt_mime text;
BEGIN
  IF NEW.stock_quantity IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.stock_quantity IS NOT DISTINCT FROM OLD.stock_quantity THEN RETURN NEW; END IF;
  v_old := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.stock_quantity, 0) END;
  v_delta := NEW.stock_quantity - v_old;
  IF v_delta = 0 THEN RETURN NEW; END IF;
  v_type := NULLIF(current_setting('app.stock_movement_type', true), '');
  v_note := NULLIF(current_setting('app.stock_movement_note', true), '');
  v_receipt_path := NULLIF(current_setting('app.stock_receipt_path', true), '');
  v_receipt_name := NULLIF(current_setting('app.stock_receipt_name', true), '');
  v_receipt_mime := NULLIF(current_setting('app.stock_receipt_mime', true), '');
  IF v_type IS NULL THEN v_type := CASE WHEN TG_OP = 'INSERT' THEN 'initial' WHEN v_delta > 0 THEN 'stock_entry' ELSE 'sale_or_removal' END; END IF;
  INSERT INTO public.catalog_stock_movements (
    account_id, catalog_item_id, item_name, quantity_delta, balance_after,
    movement_type, note, created_by, receipt_path, receipt_name, receipt_mime_type
  ) VALUES (
    NEW.account_id, NEW.id, NEW.name, v_delta, NEW.stock_quantity,
    v_type, v_note, auth.uid(), v_receipt_path, v_receipt_name, v_receipt_mime
  );
  RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.add_catalog_stock_batch(uuid, jsonb, text);
CREATE FUNCTION public.add_catalog_stock_batch(
  p_account_id uuid, p_adjustments jsonb, p_note text DEFAULT NULL,
  p_receipt_path text DEFAULT NULL, p_receipt_name text DEFAULT NULL,
  p_receipt_mime_type text DEFAULT NULL
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row jsonb; v_count integer := 0; v_quantity integer;
BEGIN
  IF jsonb_typeof(p_adjustments) <> 'array' OR jsonb_array_length(p_adjustments) = 0 THEN RAISE EXCEPTION 'adjustments must be a non-empty array'; END IF;
  PERFORM set_config('app.stock_movement_type', 'stock_entry', true);
  PERFORM set_config('app.stock_movement_note', COALESCE(left(trim(p_note), 500), ''), true);
  PERFORM set_config('app.stock_receipt_path', COALESCE(left(p_receipt_path, 500), ''), true);
  PERFORM set_config('app.stock_receipt_name', COALESCE(left(p_receipt_name, 255), ''), true);
  PERFORM set_config('app.stock_receipt_mime', COALESCE(left(p_receipt_mime_type, 100), ''), true);
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_adjustments) LOOP
    v_quantity := (v_row->>'quantity')::integer;
    IF v_quantity <= 0 THEN RAISE EXCEPTION 'quantity must be positive'; END IF;
    UPDATE public.catalog_items SET stock_quantity = COALESCE(stock_quantity, 0) + v_quantity
      WHERE id = (v_row->>'catalog_item_id')::uuid AND account_id = p_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'catalog item not found'; END IF;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.add_catalog_stock_batch(uuid,jsonb,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_catalog_stock_batch(uuid,jsonb,text,text,text,text) TO service_role;
