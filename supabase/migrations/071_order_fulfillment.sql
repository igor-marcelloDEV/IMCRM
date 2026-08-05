-- Operational delivery workflow is intentionally separate from financial status.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS fulfillment_status text NOT NULL DEFAULT 'awaiting_payment',
  ADD COLUMN IF NOT EXISTS fulfillment_updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_fulfillment_status_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_fulfillment_status_check CHECK (
  fulfillment_status IN ('awaiting_payment', 'confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered')
);

UPDATE public.orders
SET fulfillment_status = CASE WHEN status = 'paid' THEN 'confirmed' ELSE 'awaiting_payment' END
WHERE fulfillment_status = 'awaiting_payment';

CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_queue
  ON public.orders(account_id, fulfillment_status, created_at DESC)
  WHERE status <> 'canceled';

CREATE OR REPLACE FUNCTION public.sync_paid_order_fulfillment()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid'
     AND NEW.fulfillment_status = 'awaiting_payment' THEN
    NEW.fulfillment_status := 'confirmed';
    NEW.fulfillment_updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_paid_order_fulfillment ON public.orders;
CREATE TRIGGER sync_paid_order_fulfillment
  BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_paid_order_fulfillment();
