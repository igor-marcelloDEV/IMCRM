-- Delivery marketplace: pickup-vs-delivery on orders, structured address +
-- optional GPS, driver self-application, open-jobs claim board, and a
-- simple payout ledger (IMCRM is an intermediary, not the drivers' employer).

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS store_address text,
  ADD COLUMN IF NOT EXISTS store_lat double precision,
  ADD COLUMN IF NOT EXISTS store_lng double precision,
  ADD COLUMN IF NOT EXISTS driver_notify_auto_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS driver_message_template text;

-- Reusable pickup-time slots the store defines (e.g. "11:00 - 11:30").
-- Drivers pick one of today's active slots when they claim a delivery,
-- rather than free-typing an arbitrary time.
CREATE TABLE IF NOT EXISTS public.delivery_time_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  label text NOT NULL,
  start_time time NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.delivery_time_slots ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_time_slots_members_select ON public.delivery_time_slots FOR SELECT TO authenticated
  USING (public.is_account_member(account_id));
CREATE POLICY delivery_time_slots_driver_select ON public.delivery_time_slots FOR SELECT TO authenticated
  USING (account_id IN (SELECT account_id FROM public.delivery_drivers WHERE auth_user_id = auth.uid()));

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS fulfillment_type text,
  ADD COLUMN IF NOT EXISTS delivery_address_line text,
  ADD COLUMN IF NOT EXISTS delivery_number text,
  ADD COLUMN IF NOT EXISTS delivery_complement text,
  ADD COLUMN IF NOT EXISTS delivery_neighborhood text,
  ADD COLUMN IF NOT EXISTS delivery_city text,
  ADD COLUMN IF NOT EXISTS delivery_state text,
  ADD COLUMN IF NOT EXISTS delivery_zip text,
  ADD COLUMN IF NOT EXISTS delivery_lat double precision,
  ADD COLUMN IF NOT EXISTS delivery_lng double precision,
  ADD COLUMN IF NOT EXISTS delivery_fee_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS driver_agreed_pickup_at timestamptz;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_fulfillment_type_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_fulfillment_type_check
  CHECK (fulfillment_type IS NULL OR fulfillment_type IN ('pickup', 'delivery'));

-- Backfill from the only signal that existed before this migration: an order
-- already carrying a delivery address was implicitly a delivery order.
UPDATE public.orders
SET fulfillment_type = CASE WHEN delivery_code_hash IS NOT NULL OR assigned_driver_id IS NOT NULL
                             THEN 'delivery' ELSE 'pickup' END
WHERE fulfillment_type IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_open_delivery_jobs
  ON public.orders(account_id, fulfillment_status)
  WHERE fulfillment_type = 'delivery' AND assigned_driver_id IS NULL AND fulfillment_status = 'ready';

-- Driver profile: payout + document fields, plus a self-application status
-- that doesn't require a staff-issued invite up front.
ALTER TABLE public.delivery_drivers
  ADD COLUMN IF NOT EXISTS pix_key text,
  ADD COLUMN IF NOT EXISTS document_number text,
  ADD COLUMN IF NOT EXISTS document_photo_url text,
  ADD COLUMN IF NOT EXISTS vehicle_photo_url text;

ALTER TABLE public.delivery_drivers DROP CONSTRAINT IF EXISTS delivery_drivers_status_check;
ALTER TABLE public.delivery_drivers ADD CONSTRAINT delivery_drivers_status_check
  CHECK (status IN ('pending_review', 'invited', 'active', 'inactive'));

-- Self-applied drivers have no auth user yet and no invite token yet, so the
-- existing NOT NULL-ish expectations (email/phone required) already hold —
-- only `email` was required before too. No further relaxation needed.

CREATE TABLE IF NOT EXISTS public.delivery_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.delivery_drivers(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);

ALTER TABLE public.delivery_payouts ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_payouts_members_select ON public.delivery_payouts FOR SELECT TO authenticated
  USING (public.is_account_member(account_id));
CREATE POLICY delivery_payouts_driver_select ON public.delivery_payouts FOR SELECT TO authenticated
  USING (driver_id IN (SELECT id FROM public.delivery_drivers WHERE auth_user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_delivery_payouts_driver ON public.delivery_payouts(driver_id, status);

-- Auto-create the payout record the moment a delivery is completed, sized
-- off the order's delivery fee. Staff mark it paid manually from /drivers —
-- IMCRM tracks the passthrough, it doesn't move the money itself (yet).
CREATE OR REPLACE FUNCTION public.create_delivery_payout()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.fulfillment_status = 'delivered' AND OLD.fulfillment_status IS DISTINCT FROM 'delivered'
     AND NEW.assigned_driver_id IS NOT NULL THEN
    INSERT INTO public.delivery_payouts (account_id, driver_id, order_id, amount_cents)
    VALUES (NEW.account_id, NEW.assigned_driver_id, NEW.id, NEW.delivery_fee_cents)
    ON CONFLICT (order_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS create_delivery_payout ON public.orders;
CREATE TRIGGER create_delivery_payout
  AFTER UPDATE OF fulfillment_status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.create_delivery_payout();
