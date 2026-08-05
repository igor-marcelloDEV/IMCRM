CREATE TABLE IF NOT EXISTS public.delivery_drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  auth_user_id uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  name text NOT NULL,
  email text NOT NULL,
  phone text NOT NULL,
  vehicle_type text NOT NULL DEFAULT 'motorcycle' CHECK (vehicle_type IN ('motorcycle','car','bicycle','other')),
  vehicle_plate text,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','inactive')),
  is_available boolean NOT NULL DEFAULT false,
  invite_token_hash text,
  invite_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id, email)
);
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS delivery_address text;
ALTER TABLE public.delivery_drivers ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_drivers_members_select ON public.delivery_drivers FOR SELECT TO authenticated USING (public.is_account_member(account_id));
CREATE POLICY delivery_drivers_self_select ON public.delivery_drivers FOR SELECT TO authenticated USING (auth_user_id = auth.uid());

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS assigned_driver_id uuid REFERENCES public.delivery_drivers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delivery_code_hash text,
  ADD COLUMN IF NOT EXISTS delivery_code_last4 text,
  ADD COLUMN IF NOT EXISTS delivery_assigned_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_picked_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_completed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_orders_assigned_driver ON public.orders(assigned_driver_id, fulfillment_status) WHERE assigned_driver_id IS NOT NULL;
