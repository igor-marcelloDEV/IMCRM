-- ============================================================
-- 053_automation_safety.sql
--
-- Starter content must teach the product without ever contacting a
-- real customer with placeholder copy. Migration 044 provisioned the
-- welcome flow as active even though three answers explicitly say
-- "Personalize esta resposta".
--
-- Keep the useful starter pipeline, tag and lead-capture automation,
-- but provision the customer-facing flow as a draft. Existing starter
-- flows are paused only when their placeholder nodes are still present,
-- so an account that already customized the flow is not overwritten.
-- ============================================================

DO $$
BEGIN
  IF to_regprocedure(
    'public.provision_starter_content_v044(uuid,uuid)'
  ) IS NULL THEN
    ALTER FUNCTION public.provision_starter_content(UUID, UUID)
      RENAME TO provision_starter_content_v044;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_starter_content_v044(UUID, UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.provision_starter_content(
  p_account_id UUID,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.provision_starter_content_v044(p_account_id, p_user_id);

  UPDATE public.flows AS f
  SET status = 'draft',
      updated_at = NOW()
  WHERE f.account_id = p_account_id
    AND f.user_id = p_user_id
    AND f.name = 'Menu de Boas-vindas'
    AND f.status = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.flow_nodes AS n
      WHERE n.flow_id = f.id
        AND n.node_key IN ('answer_about', 'answer_hours', 'answer_payment')
        AND COALESCE(n.config->>'text', '') ILIKE 'Personalize esta resposta%'
    );
END;
$$;

ALTER FUNCTION public.provision_starter_content(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.provision_starter_content(UUID, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_starter_content(UUID, UUID)
  TO service_role;

UPDATE public.flows AS f
SET status = 'draft',
    updated_at = NOW()
WHERE f.name = 'Menu de Boas-vindas'
  AND f.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM public.flow_nodes AS n
    WHERE n.flow_id = f.id
      AND n.node_key IN ('answer_about', 'answer_hours', 'answer_payment')
      AND COALESCE(n.config->>'text', '') ILIKE 'Personalize esta resposta%'
  );

-- `time_based` was exposed by the old builder but never had a scheduler.
-- Leaving one marked active creates false confidence that follow-ups will
-- run. Preserve the configuration for future migration, but fail visibly
-- closed until a durable scheduler is implemented.
UPDATE public.automations
SET is_active = FALSE,
    updated_at = NOW()
WHERE trigger_type = 'time_based'
  AND is_active = TRUE;
