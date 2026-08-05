-- Four-character customer-facing code shared by storefront and staff screens.
-- Format: P + two base36 digits + one decimal digit (P001 ... PZZ9).
CREATE OR REPLACE FUNCTION public.order_short_code(p_number integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = '' AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  quotient integer := p_number / 10;
BEGIN
  IF p_number < 0 OR p_number > 12959 THEN
    RAISE EXCEPTION 'order number exceeds four-character code capacity' USING ERRCODE = '22003';
  END IF;
  RETURN 'P' || substr(alphabet, (quotient / 36) + 1, 1)
    || substr(alphabet, (quotient % 36) + 1, 1) || (p_number % 10)::text;
END;
$$;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_code text;
UPDATE public.orders SET order_code = public.order_short_code(order_number) WHERE order_code IS NULL;
ALTER TABLE public.orders ALTER COLUMN order_code SET NOT NULL;
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_order_code_format;
ALTER TABLE public.orders ADD CONSTRAINT orders_order_code_format CHECK (order_code ~ '^P[A-Z0-9]{2}[0-9]$');
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_account_code ON public.orders(account_id, order_code);

CREATE OR REPLACE FUNCTION public.assign_order_code()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.order_code IS NULL THEN NEW.order_code := public.order_short_code(NEW.order_number); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zz_assign_order_code ON public.orders;
CREATE TRIGGER zz_assign_order_code BEFORE INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.assign_order_code();
