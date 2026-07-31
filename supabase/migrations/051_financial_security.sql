-- ============================================================
-- 051_financial_security.sql
--
-- Financial integrity hardening for tenant orders:
--   * payment credentials are readable only by account admins;
--   * a service-role-only RPC atomically confirms a correlated charge;
--   * finalized/charged orders and their line items are immutable;
--   * deleting a contact unlinks, rather than deletes, order history.
--
-- Relationship columns may still move from a UUID to NULL when their
-- referenced CRM row is erased. Monetary/gateway snapshots never do.
-- ============================================================

-- Payment configuration contains credentials, so row-level access
-- must match the admin-only API route instead of every account member.
DROP POLICY IF EXISTS tenant_payment_configs_select
  ON public.tenant_payment_configs;
CREATE POLICY tenant_payment_configs_select
  ON public.tenant_payment_configs
  FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));

-- Preserve the sale when a contact exercises deletion/erasure. The
-- order remains a financial record and its contact link is cleared.
ALTER TABLE public.orders
  ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_contact_id_fkey;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_contact_id_fkey
  FOREIGN KEY (contact_id)
  REFERENCES public.contacts(id)
  ON DELETE SET NULL;

-- Existing paid records pre-date the invariant below. Give any legacy
-- row without paid_at a conservative timestamp before enabling it.
UPDATE public.orders
SET paid_at = COALESCE(paid_at, updated_at, created_at)
WHERE status = 'paid'
  AND paid_at IS NULL;

CREATE OR REPLACE FUNCTION public.protect_order_financial_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  finalized_or_charged boolean;
  contact_unlinked boolean;
  cart_unlinked boolean;
  deal_unlinked boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('paid', 'canceled')
       OR OLD.gateway_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'finalized or charged orders cannot be deleted'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.status = 'paid' AND NEW.paid_at IS NULL THEN
    RAISE EXCEPTION 'paid orders require paid_at'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'paid' AND NEW.paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'only paid orders may have paid_at'
      USING ERRCODE = '23514';
  END IF;

  finalized_or_charged :=
    OLD.status IN ('paid', 'canceled')
    OR OLD.gateway_payment_id IS NOT NULL;

  IF NOT finalized_or_charged THEN
    RETURN NEW;
  END IF;

  -- FK-driven erasure is permitted only as an unlink to NULL. It
  -- preserves the immutable monetary snapshot while honoring removal
  -- of the related CRM entity.
  contact_unlinked :=
    OLD.contact_id IS NOT NULL
    AND NEW.contact_id IS NULL;
  cart_unlinked :=
    OLD.cart_id IS NOT NULL
    AND NEW.cart_id IS NULL;
  deal_unlinked :=
    OLD.deal_id IS NOT NULL
    AND NEW.deal_id IS NULL;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR (
       NEW.contact_id IS DISTINCT FROM OLD.contact_id
       AND NOT contact_unlinked
     )
     OR (
       NEW.cart_id IS DISTINCT FROM OLD.cart_id
       AND NOT cart_unlinked
     )
     OR (
       NEW.deal_id IS DISTINCT FROM OLD.deal_id
       AND NOT deal_unlinked
     )
     OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
     OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.gateway_customer_id IS DISTINCT FROM OLD.gateway_customer_id
     OR NEW.gateway_payment_id IS DISTINCT FROM OLD.gateway_payment_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'financial fields of finalized or charged orders are immutable'
      USING ERRCODE = '23514';
  END IF;

  -- A pending charged order may move to paid/canceled. Once finalized,
  -- neither its status nor paid timestamp can move again.
  IF OLD.status IN ('paid', 'canceled')
     AND (
       NEW.status IS DISTINCT FROM OLD.status
       OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
     ) THEN
    RAISE EXCEPTION 'finalized order status is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_order_financial_history
  ON public.orders;
CREATE TRIGGER protect_order_financial_history
  BEFORE UPDATE OR DELETE ON public.orders
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_order_financial_history();

CREATE OR REPLACE FUNCTION public.protect_order_item_financial_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  old_order_locked boolean;
  new_order_locked boolean;
  catalog_unlinked_only boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.orders
      WHERE id = NEW.order_id
        AND (
          status IN ('paid', 'canceled')
          OR gateway_payment_id IS NOT NULL
        )
    )
    INTO new_order_locked;

    IF new_order_locked THEN
      RAISE EXCEPTION 'line items of finalized or charged orders are immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.orders
    WHERE id = OLD.order_id
      AND (
        status IN ('paid', 'canceled')
        OR gateway_payment_id IS NOT NULL
      )
  )
  INTO old_order_locked;

  IF TG_OP = 'DELETE' THEN
    IF old_order_locked THEN
      RAISE EXCEPTION 'line items of finalized or charged orders are immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  catalog_unlinked_only :=
    OLD.catalog_item_id IS NOT NULL
    AND NEW.catalog_item_id IS NULL
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.order_id IS NOT DISTINCT FROM OLD.order_id
    AND NEW.name_snapshot IS NOT DISTINCT FROM OLD.name_snapshot
    AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity
    AND NEW.unit_price_cents IS NOT DISTINCT FROM OLD.unit_price_cents
    AND NEW.total_cents IS NOT DISTINCT FROM OLD.total_cents
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at;

  IF old_order_locked THEN
    IF catalog_unlinked_only THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'line items of finalized or charged orders are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.order_id IS DISTINCT FROM OLD.order_id THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.orders
      WHERE id = NEW.order_id
        AND (
          status IN ('paid', 'canceled')
          OR gateway_payment_id IS NOT NULL
        )
    )
    INTO new_order_locked;

    IF new_order_locked THEN
      RAISE EXCEPTION 'line items cannot be moved into a finalized or charged order'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_order_item_financial_history
  ON public.order_items;
CREATE TRIGGER protect_order_item_financial_history
  BEFORE INSERT OR UPDATE OR DELETE ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_order_item_financial_history();

-- Atomic idempotency gate for the webhook. The amount/currency and
-- gateway id are part of the WHERE clause so a concurrent edit cannot
-- be confirmed using values validated against an earlier snapshot.
CREATE OR REPLACE FUNCTION public.confirm_tenant_order_payment(
  p_order_id uuid,
  p_gateway_payment_id text,
  p_total_cents integer,
  p_currency text,
  p_paid_at timestamptz
)
RETURNS SETOF public.orders
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  UPDATE public.orders
  SET
    status = 'paid',
    paid_at = p_paid_at
  WHERE id = p_order_id
    AND status = 'pending_payment'
    AND gateway_payment_id = p_gateway_payment_id
    AND total_cents = p_total_cents
    AND upper(currency) = upper(trim(p_currency))
  RETURNING *;
$$;

REVOKE ALL ON FUNCTION public.confirm_tenant_order_payment(
  uuid,
  text,
  integer,
  text,
  timestamptz
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_tenant_order_payment(
  uuid,
  text,
  integer,
  text,
  timestamptz
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_tenant_order_payment(
  uuid,
  text,
  integer,
  text,
  timestamptz
) TO service_role;
