-- Hosted Asaas card checkout for public store orders.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS payment_url text;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE public.orders ADD CONSTRAINT orders_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('pix', 'card'));

CREATE OR REPLACE FUNCTION public.complete_order_hosted_card_charge(
  p_order_id uuid,
  p_account_id uuid,
  p_gateway_customer_id text,
  p_gateway_payment_id text,
  p_payment_url text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cart_id uuid;
BEGIN
  IF NULLIF(btrim(p_gateway_payment_id), '') IS NULL
     OR p_payment_url !~ '^https://(www\.)?(sandbox\.)?asaas\.com/' THEN
    RAISE EXCEPTION 'valid Asaas payment id and URL are required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.orders AS orders
  SET gateway_customer_id = p_gateway_customer_id,
      gateway_payment_id = p_gateway_payment_id,
      payment_method = 'card',
      payment_url = p_payment_url,
      checkout_error_code = NULL,
      checkout_error_detail = NULL,
      checkout_error_at = NULL
  WHERE orders.id = p_order_id
    AND orders.account_id = p_account_id
    AND orders.status = 'pending_payment'
    AND (orders.gateway_payment_id IS NULL OR orders.gateway_payment_id = p_gateway_payment_id)
  RETURNING orders.cart_id INTO v_cart_id;

  IF NOT FOUND THEN RETURN false; END IF;
  IF v_cart_id IS NULL THEN
    RAISE EXCEPTION 'charged checkout order is not linked to a cart' USING ERRCODE = '23514';
  END IF;

  UPDATE public.carts
  SET status = 'checked_out'
  WHERE id = v_cart_id
    AND account_id = p_account_id
    AND status IN ('open', 'checkout_pending');
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_order_hosted_card_charge(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_order_hosted_card_charge(uuid, uuid, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_order_hosted_card_charge(uuid, uuid, text, text, text) TO service_role;

-- Extend the existing financial-history guard to the new payment fields.
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
    IF OLD.status IN ('paid', 'canceled') OR OLD.gateway_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'finalized or charged orders cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.status = 'paid' AND NEW.paid_at IS NULL THEN
    RAISE EXCEPTION 'paid orders require paid_at' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'paid' AND NEW.paid_at IS NOT NULL THEN
    RAISE EXCEPTION 'only paid orders may have paid_at' USING ERRCODE = '23514';
  END IF;

  finalized_or_charged := OLD.status IN ('paid', 'canceled') OR OLD.gateway_payment_id IS NOT NULL;
  IF NOT finalized_or_charged THEN RETURN NEW; END IF;

  contact_unlinked := OLD.contact_id IS NOT NULL AND NEW.contact_id IS NULL;
  cart_unlinked := OLD.cart_id IS NOT NULL AND NEW.cart_id IS NULL;
  deal_unlinked := OLD.deal_id IS NOT NULL AND NEW.deal_id IS NULL;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NOT contact_unlinked)
     OR (NEW.cart_id IS DISTINCT FROM OLD.cart_id AND NOT cart_unlinked)
     OR (NEW.deal_id IS DISTINCT FROM OLD.deal_id AND NOT deal_unlinked)
     OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
     OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.gateway_customer_id IS DISTINCT FROM OLD.gateway_customer_id
     OR NEW.gateway_payment_id IS DISTINCT FROM OLD.gateway_payment_id
     OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
     OR NEW.payment_url IS DISTINCT FROM OLD.payment_url
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'financial fields of finalized or charged orders are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('paid', 'canceled')
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.paid_at IS DISTINCT FROM OLD.paid_at) THEN
    RAISE EXCEPTION 'finalized order status is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
