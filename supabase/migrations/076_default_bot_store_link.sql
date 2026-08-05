-- Add a tenant-aware "Realizar nova compra" option to the standard
-- welcome/FAQ bots. The engine seeds {{vars.store_url}} at run start.

CREATE OR REPLACE FUNCTION public.attach_store_link_to_default_flow()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.node_key <> 'topics' OR NEW.node_type <> 'send_list' THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.flows f
    WHERE f.id = NEW.flow_id
      AND lower(f.name) IN ('menu de boas-vindas', 'bot de faq')
  ) THEN
    RETURN NEW;
  END IF;

  IF jsonb_path_exists(
    COALESCE(NEW.config, '{}'::jsonb),
    '$.sections[*].rows[*] ? (@.reply_id == "new_purchase")'
  ) THEN
    RETURN NEW;
  END IF;

  NEW.config := jsonb_set(
    COALESCE(NEW.config, '{}'::jsonb),
    '{sections}',
    COALESCE(NEW.config->'sections', '[]'::jsonb) || jsonb_build_array(
      jsonb_build_object(
        'title', 'Comprar',
        'rows', jsonb_build_array(
          jsonb_build_object(
            'reply_id', 'new_purchase',
            'title', 'Realizar nova compra',
            'next_node_key', 'answer_new_purchase'
          )
        )
      )
    ),
    true
  );

  INSERT INTO public.flow_nodes (flow_id, node_key, node_type, config)
  VALUES (
    NEW.flow_id,
    'answer_new_purchase',
    'send_message',
    jsonb_build_object(
      'text', E'Para realizar uma nova compra, acesse nossa loja: {{vars.store_url}}\n\nEscolha os itens e finalize seu pedido por lá.',
      'next_node_key', 'end'
    )
  )
  ON CONFLICT (flow_id, node_key) DO UPDATE SET config = EXCLUDED.config;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS add_store_link_to_default_flow_nodes ON public.flow_nodes;
CREATE TRIGGER add_store_link_to_default_flow_nodes
  BEFORE INSERT OR UPDATE OF config ON public.flow_nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.attach_store_link_to_default_flow();

-- Run the trigger once for standard bots that already exist.
UPDATE public.flow_nodes n
SET config = n.config
FROM public.flows f
WHERE f.id = n.flow_id
  AND n.node_key = 'topics'
  AND n.node_type = 'send_list'
  AND lower(f.name) IN ('menu de boas-vindas', 'bot de faq');
