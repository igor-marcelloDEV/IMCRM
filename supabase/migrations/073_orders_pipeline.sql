-- Dedicated order-service pipeline, synchronized from order/payment/delivery state.
ALTER TABLE public.pipelines ADD COLUMN IF NOT EXISTS pipeline_kind text NOT NULL DEFAULT 'custom';
ALTER TABLE public.pipelines DROP CONSTRAINT IF EXISTS pipelines_kind_check;
ALTER TABLE public.pipelines ADD CONSTRAINT pipelines_kind_check CHECK (pipeline_kind IN ('custom', 'orders'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_one_orders_per_account
  ON public.pipelines(account_id) WHERE pipeline_kind = 'orders';

CREATE OR REPLACE FUNCTION public.ensure_orders_pipeline(p_account_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_pipeline_id uuid;
  v_owner_id uuid;
BEGIN
  SELECT id INTO v_pipeline_id FROM public.pipelines
  WHERE account_id = p_account_id AND pipeline_kind = 'orders' LIMIT 1;
  IF v_pipeline_id IS NULL THEN
    SELECT owner_user_id INTO v_owner_id FROM public.accounts WHERE id = p_account_id;
    IF v_owner_id IS NULL THEN RETURN NULL; END IF;
    INSERT INTO public.pipelines(account_id, user_id, name, pipeline_kind)
    VALUES (p_account_id, v_owner_id, 'Pedidos', 'orders')
    ON CONFLICT (account_id) WHERE pipeline_kind = 'orders' DO NOTHING
    RETURNING id INTO v_pipeline_id;
    IF v_pipeline_id IS NULL THEN
      SELECT id INTO v_pipeline_id FROM public.pipelines
      WHERE account_id = p_account_id AND pipeline_kind = 'orders' LIMIT 1;
    END IF;
  END IF;

  INSERT INTO public.pipeline_stages(pipeline_id, name, position, color)
  SELECT v_pipeline_id, stage.name, stage.position, stage.color
  FROM (VALUES
    ('Aguardando pagamento', 0, '#f59e0b'),
    ('Pago / em atendimento', 1, '#3b82f6'),
    ('Entregue', 2, '#22c55e')
  ) AS stage(name, position, color)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.pipeline_stages existing
    WHERE existing.pipeline_id = v_pipeline_id AND existing.position = stage.position
  );
  RETURN v_pipeline_id;
END;
$$;

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
  IF v_deal_id IS NULL AND NEW.contact_id IS NOT NULL AND NEW.source = 'manual' THEN
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

DROP TRIGGER IF EXISTS sync_order_to_pipeline ON public.orders;
CREATE TRIGGER sync_order_to_pipeline
  AFTER INSERT OR UPDATE OF deal_id, status, total_cents, fulfillment_status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.sync_order_to_pipeline();

-- Seed every account, then move existing linked order deals without
-- rewriting protected financial order rows.
SELECT public.ensure_orders_pipeline(id) FROM public.accounts;
UPDATE public.deals AS deals
SET pipeline_id = pipeline.id,
    stage_id = stage.id,
    title = 'Pedido #' || orders.order_code,
    value = orders.total_cents / 100.0,
    currency = orders.currency,
    status = CASE WHEN orders.fulfillment_status = 'delivered' THEN 'won' ELSE 'open' END,
    updated_at = now()
FROM public.orders AS orders
JOIN public.pipelines AS pipeline
  ON pipeline.account_id = orders.account_id AND pipeline.pipeline_kind = 'orders'
JOIN public.pipeline_stages AS stage
  ON stage.pipeline_id = pipeline.id
 AND stage.position = CASE
   WHEN orders.fulfillment_status = 'delivered' THEN 2
   WHEN orders.status = 'paid' THEN 1
   ELSE 0
 END
WHERE deals.id = orders.deal_id
  AND deals.account_id = orders.account_id;

REVOKE ALL ON FUNCTION public.ensure_orders_pipeline(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_order_to_pipeline() FROM PUBLIC, anon, authenticated;
