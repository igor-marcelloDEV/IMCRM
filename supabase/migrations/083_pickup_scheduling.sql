-- Pickup-slot capacity: when a customer chooses "Retirar na loja", they
-- must book a time slot, capped at a configurable number of concurrent
-- pickups (default 5 people per 20-minute slot) so the counter doesn't
-- get swamped. Capacity is enforced inside create_public_store_order
-- (migration 084) so two concurrent bookings for the last spot can't
-- both succeed.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS pickup_slot_minutes INTEGER NOT NULL DEFAULT 20 CHECK (pickup_slot_minutes > 0),
  ADD COLUMN IF NOT EXISTS pickup_capacity_per_slot INTEGER NOT NULL DEFAULT 5 CHECK (pickup_capacity_per_slot > 0),
  ADD COLUMN IF NOT EXISTS store_opens_at TIME NOT NULL DEFAULT '09:00',
  ADD COLUMN IF NOT EXISTS store_closes_at TIME NOT NULL DEFAULT '18:00';

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS pickup_scheduled_at TIMESTAMPTZ;

-- Fast capacity-count lookups ("how many orders already booked this
-- exact slot for this account").
CREATE INDEX IF NOT EXISTS idx_orders_pickup_slot
  ON public.orders(account_id, pickup_scheduled_at)
  WHERE fulfillment_type = 'pickup' AND pickup_scheduled_at IS NOT NULL;
