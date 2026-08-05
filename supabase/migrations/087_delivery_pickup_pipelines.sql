-- ============================================================
-- 087_delivery_pickup_pipelines.sql
--
-- Splits the single "Pedidos" sales pipeline (migration 073) into
-- three purpose-built pipelines, chosen per order by
-- orders.fulfillment_type:
--   - 'delivery' -> "Entrega"            (pipeline_kind = 'orders_delivery')
--   - 'pickup'   -> "Retirada in loco"   (pipeline_kind = 'orders_pickup')
--   - NULL       -> "Pedidos"            (pipeline_kind = 'orders', unchanged —
--                    covers subscriptions/services, which have no
--                    physical fulfillment_type)
--
-- ensure_orders_pipeline(account_id) becomes ensure_order_pipeline
-- (account_id, kind), parameterized so the three funnels share one
-- seeding function instead of triplicating it. No TypeScript code
-- calls either function by name (grep confirms) — both are only
-- ever invoked from sync_order_to_pipeline() below — so the rename
-- is safe.
-- ============================================================

ALTER TABLE public.pipelines DROP CONSTRAINT IF EXISTS pipelines_kind_check;
ALTER TABLE public.pipelines ADD CONSTRAINT pipelines_kind_check
  CHECK (pipeline_kind IN ('custom', 'orders', 'orders_delivery', 'orders_pickup'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_one_delivery_per_account
  ON public.pipelines(account_id) WHERE pipeline_kind = 'orders_delivery';
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipelines_one_pickup_per_account
  ON public.pipelines(account_id) WHERE pipeline_kind = 'orders_pickup';

DROP FUNCTION IF EXISTS public.ensure_orders_pipeline(uuid);

CREATE OR REPLACE FUNCTION public.ensure_order_pipeline(p_account_id uuid, p_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_pipeline_id uuid;
  v_owner_id uuid;
  v_name text;
BEGIN
  IF p_kind NOT IN ('orders', 'orders_delivery', 'orders_pickup') THEN
    RAISE EXCEPTION 'unsupported order pipeline kind: %', p_kind USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_pipeline_id FROM public.pipelines
  WHERE account_id = p_account_id AND pipeline_kind = p_kind LIMIT 1;

  IF v_pipeline_id IS NULL THEN
    SELECT owner_user_id INTO v_owner_id FROM public.accounts WHERE id = p_account_id;
    IF v_owner_id IS NULL THEN RETURN NULL; END IF;

    v_name := CASE p_kind
      WHEN 'orders_delivery' THEN 'Entrega'
      WHEN 'orders_pickup' THEN 'Retirada in loco'
      ELSE 'Pedidos'
    END;

    -- ON CONFLICT's partial-index inference needs a predicate that's a
    -- constant at plan time — `WHERE pipeline_kind = p_kind` (a plpgsql
    -- variable) can't be matched against any of the three partial
    -- unique indexes, so each kind needs its own literal-predicate
    -- INSERT rather than one parameterized statement.
    IF p_kind = 'orders' THEN
      INSERT INTO public.pipelines(account_id, user_id, name, pipeline_kind)
      VALUES (p_account_id, v_owner_id, v_name, p_kind)
      ON CONFLICT (account_id) WHERE pipeline_kind = 'orders' DO NOTHING
      RETURNING id INTO v_pipeline_id;
    ELSIF p_kind = 'orders_delivery' THEN
      INSERT INTO public.pipelines(account_id, user_id, name, pipeline_kind)
      VALUES (p_account_id, v_owner_id, v_name, p_kind)
      ON CONFLICT (account_id) WHERE pipeline_kind = 'orders_delivery' DO NOTHING
      RETURNING id INTO v_pipeline_id;
    ELSE
      INSERT INTO public.pipelines(account_id, user_id, name, pipeline_kind)
      VALUES (p_account_id, v_owner_id, v_name, p_kind)
      ON CONFLICT (account_id) WHERE pipeline_kind = 'orders_pickup' DO NOTHING
      RETURNING id INTO v_pipeline_id;
    END IF;
    IF v_pipeline_id IS NULL THEN
      SELECT id INTO v_pipeline_id FROM public.pipelines
      WHERE account_id = p_account_id AND pipeline_kind = p_kind LIMIT 1;
    END IF;
  END IF;

  INSERT INTO public.pipeline_stages(pipeline_id, name, position, color)
  SELECT v_pipeline_id, stage.name, stage.position, stage.color
  FROM (
    SELECT * FROM (VALUES
      ('Aguardando pagamento', 0, '#f59e0b'),
      ('Pago / em atendimento', 1, '#3b82f6'),
      ('Entregue', 2, '#22c55e')
    ) AS s(name, position, color) WHERE p_kind = 'orders'
    UNION ALL
    SELECT * FROM (VALUES
      ('Aguardando pagamento', 0, '#f59e0b'),
      ('Em preparo', 1, '#3b82f6'),
      ('Saiu para entrega', 2, '#8b5cf6'),
      ('Entregue', 3, '#22c55e')
    ) AS s(name, position, color) WHERE p_kind = 'orders_delivery'
    UNION ALL
    SELECT * FROM (VALUES
      ('Aguardando pagamento', 0, '#f59e0b'),
      ('Em preparo', 1, '#3b82f6'),
      ('Pronto para retirada', 2, '#8b5cf6'),
      ('Retirado', 3, '#22c55e')
    ) AS s(name, position, color) WHERE p_kind = 'orders_pickup'
  ) AS stage
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
  v_kind text;
  v_pipeline_id uuid;
  v_stage_id uuid;
  v_deal_id uuid;
  v_owner_id uuid;
  v_position integer;
BEGIN
  v_kind := CASE NEW.fulfillment_type
    WHEN 'delivery' THEN 'orders_delivery'
    WHEN 'pickup' THEN 'orders_pickup'
    ELSE 'orders'
  END;
  v_pipeline_id := public.ensure_order_pipeline(NEW.account_id, v_kind);
  IF v_pipeline_id IS NULL THEN RETURN NEW; END IF;

  v_position := CASE
    WHEN v_kind = 'orders' THEN
      CASE WHEN NEW.fulfillment_status = 'delivered' THEN 2
           WHEN NEW.status = 'paid' THEN 1
           ELSE 0 END
    ELSE
      -- Both delivery and pickup funnels share the same 4-stage shape
      -- (Aguardando pagamento / Em preparo / [Saiu | Pronto] / [Entregue | Retirado]),
      -- just relabelled — so one mapping from the six-state operational
      -- fulfillment_status covers both.
      CASE NEW.fulfillment_status
        WHEN 'awaiting_payment' THEN 0
        WHEN 'confirmed' THEN 1
        WHEN 'preparing' THEN 1
        WHEN 'ready' THEN 2
        WHEN 'out_for_delivery' THEN 2
        WHEN 'delivered' THEN 3
        ELSE 0
      END
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
      status = CASE WHEN NEW.fulfillment_status = 'delivered' THEN 'won' ELSE 'open' END,
      updated_at = now()
    WHERE id = v_deal_id AND account_id = NEW.account_id;
  END IF;
  RETURN NEW;
END;
$$;

-- Seed the two new funnels for every existing account (so they show
-- up in Pipelines immediately, even before the next order lands),
-- then move existing delivery/pickup order-deals into the right one.
SELECT public.ensure_order_pipeline(id, 'orders_delivery') FROM public.accounts;
SELECT public.ensure_order_pipeline(id, 'orders_pickup') FROM public.accounts;

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
  ON pipeline.account_id = orders.account_id
 AND pipeline.pipeline_kind = CASE orders.fulfillment_type
       WHEN 'delivery' THEN 'orders_delivery'
       WHEN 'pickup' THEN 'orders_pickup'
       ELSE 'orders'
     END
JOIN public.pipeline_stages AS stage
  ON stage.pipeline_id = pipeline.id
 AND stage.position = CASE
     WHEN orders.fulfillment_type IS NULL THEN
       CASE WHEN orders.fulfillment_status = 'delivered' THEN 2
            WHEN orders.status = 'paid' THEN 1
            ELSE 0 END
     ELSE
       CASE orders.fulfillment_status
         WHEN 'awaiting_payment' THEN 0
         WHEN 'confirmed' THEN 1
         WHEN 'preparing' THEN 1
         WHEN 'ready' THEN 2
         WHEN 'out_for_delivery' THEN 2
         WHEN 'delivered' THEN 3
         ELSE 0
       END
     END
WHERE deals.id = orders.deal_id
  AND deals.account_id = orders.account_id
  AND orders.fulfillment_type IN ('delivery', 'pickup');

REVOKE ALL ON FUNCTION public.ensure_order_pipeline(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_order_to_pipeline() FROM PUBLIC, anon, authenticated;
