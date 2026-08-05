-- Legacy manual orders could already be paid before the dedicated Orders
-- pipeline existed. Link them once under a controlled migration so future
-- fulfillment updates never try to mutate a protected paid order.

CREATE OR REPLACE FUNCTION public.sync_order_to_pipeline()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_pipeline_id uuid;
  v_stage_id uuid;
  v_deal_id uuid;
  v_owner_id uuid;
  v_position integer;
BEGIN
  v_pipeline_id := public.ensure_orders_pipeline(NEW.account_id);
  IF v_pipeline_id IS NULL THEN RETURN NEW; END IF;
  v_position := CASE
    WHEN NEW.fulfillment_status = 'delivered' THEN 2
    WHEN NEW.status = 'paid' THEN 1
    ELSE 0
  END;
  SELECT id INTO v_stage_id FROM public.pipeline_stages
  WHERE pipeline_id = v_pipeline_id AND position = v_position LIMIT 1;

  v_deal_id := NEW.deal_id;
  -- New manual orders are linked while still financially open. Historical
  -- paid rows are handled by the one-time backfill below.
  IF v_deal_id IS NULL AND NEW.contact_id IS NOT NULL
     AND NEW.source = 'manual' AND NEW.status = 'pending_payment' THEN
    SELECT owner_user_id INTO v_owner_id FROM public.accounts WHERE id = NEW.account_id;
    INSERT INTO public.deals(account_id, user_id, pipeline_id, stage_id, contact_id, title, value, currency, status)
    VALUES (NEW.account_id, v_owner_id, v_pipeline_id, v_stage_id, NEW.contact_id,
      'Pedido #' || NEW.order_code, NEW.total_cents / 100.0, NEW.currency, 'open')
    RETURNING id INTO v_deal_id;
    UPDATE public.orders SET deal_id = v_deal_id WHERE id = NEW.id AND deal_id IS NULL;
  ELSIF v_deal_id IS NOT NULL THEN
    UPDATE public.deals SET
      pipeline_id = v_pipeline_id,
      stage_id = v_stage_id,
      title = 'Pedido #' || NEW.order_code,
      value = NEW.total_cents / 100.0,
      currency = NEW.currency,
      status = CASE WHEN v_position = 2 THEN 'won' ELSE 'open' END,
      updated_at = now()
    WHERE id = v_deal_id AND account_id = NEW.account_id;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE public.orders DISABLE TRIGGER protect_order_financial_history;

DO $$
DECLARE
  legacy public.orders%ROWTYPE;
  v_pipeline_id uuid;
  v_stage_id uuid;
  v_owner_id uuid;
  v_deal_id uuid;
  v_position integer;
BEGIN
  FOR legacy IN
    SELECT * FROM public.orders
    WHERE deal_id IS NULL AND contact_id IS NOT NULL AND source = 'manual'
    FOR UPDATE
  LOOP
    v_pipeline_id := public.ensure_orders_pipeline(legacy.account_id);
    v_position := CASE
      WHEN legacy.fulfillment_status = 'delivered' THEN 2
      WHEN legacy.status = 'paid' THEN 1
      ELSE 0
    END;
    SELECT id INTO v_stage_id FROM public.pipeline_stages
    WHERE pipeline_id = v_pipeline_id AND position = v_position LIMIT 1;
    SELECT owner_user_id INTO v_owner_id FROM public.accounts WHERE id = legacy.account_id;

    INSERT INTO public.deals(account_id, user_id, pipeline_id, stage_id, contact_id, title, value, currency, status)
    VALUES (legacy.account_id, v_owner_id, v_pipeline_id, v_stage_id, legacy.contact_id,
      'Pedido #' || legacy.order_code, legacy.total_cents / 100.0, legacy.currency,
      CASE WHEN v_position = 2 THEN 'won' ELSE 'open' END)
    RETURNING id INTO v_deal_id;

    UPDATE public.orders SET deal_id = v_deal_id WHERE id = legacy.id;
  END LOOP;
END;
$$;

ALTER TABLE public.orders ENABLE TRIGGER protect_order_financial_history;
