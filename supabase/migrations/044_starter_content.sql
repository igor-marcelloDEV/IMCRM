-- ============================================================
-- 044_starter_content.sql
--
-- Every new account starts completely empty — no pipeline, no flow,
-- no automation, no templates. A brand-new signup lands on a blank
-- dashboard with nothing to look at, which undersells what the
-- product actually does and leaves the owner unsure where to start.
--
-- This migration seeds a generic, provider-agnostic starter kit into
-- every new account, atomically, in the same trigger that already
-- creates the account + profile (`handle_new_user`, migration 017,
-- last touched in 041 for the phone field):
--
--   - A "Vendas" pipeline with 4 stages, so the starter automation's
--     create_deal step has somewhere real to file leads.
--   - A "Lead" tag.
--   - A "Menu de Boas-vindas" Flow (active, trigger
--     first_inbound_message) — a generic FAQ-style welcome menu. The
--     answer nodes are deliberately written as "customize me"
--     placeholders — IMCRM has no way to know what a brand-new
--     account's business actually sells.
--   - A "Captura de novo lead" Automation (active, same trigger) —
--     tags the contact and files a deal, working alongside the Flow
--     exactly like the tag-based patterns built for real accounts
--     this session (first_inbound_message fires unconditionally
--     regardless of Flow consumption — see inbound.ts).
--   - Three DRAFT message templates (boas_vindas, confirmacao,
--     promocao) — usable immediately over an unofficial (Baileys)
--     connection, need Meta approval first over the official API
--     (see the new notice in template-manager.tsx).
--
-- Deliberately NOT seeded: a broadcast. A "starter" broadcast would
-- need to target real contacts a fresh account doesn't have yet —
-- an empty-audience broadcast row would just be confusing clutter,
-- not a working example. The templates above are what a broadcast
-- needs; the Broadcasts page's own empty state points users at them.
--
-- Idempotent function (safe to re-run); the trigger itself only ever
-- fires once per new `auth.users` row, same as before.
-- ============================================================

CREATE OR REPLACE FUNCTION public.provision_starter_content(
  p_account_id UUID,
  p_user_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pipeline_id UUID;
  v_stage_new_lead UUID;
  v_tag_lead UUID;
  v_flow_id UUID;
  v_automation_id UUID;
BEGIN
  -- ---- Pipeline ----
  INSERT INTO pipelines (account_id, user_id, name)
  VALUES (p_account_id, p_user_id, 'Vendas')
  RETURNING id INTO v_pipeline_id;

  -- Plain multi-row INSERT — `RETURNING ... INTO` requires exactly one
  -- returned row in PL/pgSQL, so the "Novo Lead" stage id is looked up
  -- separately right after, by name, instead.
  INSERT INTO pipeline_stages (pipeline_id, name, position, color)
  VALUES
    (v_pipeline_id, 'Novo Lead', 0, '#3b82f6'),
    (v_pipeline_id, 'Em Contato', 1, '#eab308'),
    (v_pipeline_id, 'Proposta', 2, '#f97316'),
    (v_pipeline_id, 'Fechado', 3, '#22c55e');

  SELECT id INTO v_stage_new_lead
  FROM pipeline_stages
  WHERE pipeline_id = v_pipeline_id AND name = 'Novo Lead';

  -- ---- Tag ----
  INSERT INTO tags (account_id, user_id, name, color)
  VALUES (p_account_id, p_user_id, 'Lead', '#3b82f6')
  RETURNING id INTO v_tag_lead;

  -- ---- Flow: "Menu de Boas-vindas" ----
  INSERT INTO flows (account_id, user_id, name, description, status, trigger_type, trigger_config, entry_node_id, fallback_policy)
  VALUES (
    p_account_id, p_user_id, 'Menu de Boas-vindas',
    'Criado automaticamente — personalize as respostas com informações reais do seu negócio.',
    'active', 'first_inbound_message', '{}'::jsonb, 'start',
    '{"on_unknown_reply": "reprompt", "max_reprompts": 2, "on_timeout_hours": 24, "on_exhaust": "handoff"}'::jsonb
  )
  RETURNING id INTO v_flow_id;

  INSERT INTO flow_nodes (flow_id, node_key, node_type, config) VALUES
    (v_flow_id, 'start', 'start', '{"next_node_key": "topics"}'::jsonb),
    (v_flow_id, 'topics', 'send_list', (
      '{"text": "Olá! Bem-vindo(a). Como posso te ajudar?", "button_label": "Ver opções", "sections": [' ||
      '{"title": "Perguntas frequentes", "rows": [' ||
        '{"reply_id": "about", "title": "Nossos produtos/serviços", "next_node_key": "answer_about"},' ||
        '{"reply_id": "hours", "title": "Horário de atendimento", "next_node_key": "answer_hours"},' ||
        '{"reply_id": "payment", "title": "Formas de pagamento", "next_node_key": "answer_payment"}' ||
      ']},' ||
      '{"title": "Outros", "rows": [' ||
        '{"reply_id": "human", "title": "Falar com um atendente", "next_node_key": "human_handoff"}' ||
      ']}' ||
      ']}'
    )::jsonb),
    (v_flow_id, 'answer_about', 'send_message', '{"text": "Personalize esta resposta em Fluxos → Menu de Boas-vindas, contando o que a sua empresa oferece.", "next_node_key": "end"}'::jsonb),
    (v_flow_id, 'answer_hours', 'send_message', '{"text": "Personalize esta resposta com o horário real de atendimento da sua empresa.", "next_node_key": "end"}'::jsonb),
    (v_flow_id, 'answer_payment', 'send_message', '{"text": "Personalize esta resposta com as formas de pagamento que sua empresa aceita.", "next_node_key": "end"}'::jsonb),
    (v_flow_id, 'human_handoff', 'handoff', '{"note": "Cliente pediu para falar com um atendente a partir do menu de boas-vindas."}'::jsonb),
    (v_flow_id, 'end', 'end', '{}'::jsonb);

  -- ---- Automation: "Captura de novo lead" ----
  INSERT INTO automations (account_id, user_id, name, description, trigger_type, trigger_config, is_active)
  VALUES (
    p_account_id, p_user_id, 'Captura de novo lead',
    'Criado automaticamente — marca o contato como Lead e registra um negócio no funil Vendas sempre que alguém escreve pela primeira vez.',
    'first_inbound_message', '{}'::jsonb, TRUE
  )
  RETURNING id INTO v_automation_id;

  INSERT INTO automation_steps (automation_id, parent_step_id, branch, step_type, position, step_config)
  VALUES (v_automation_id, NULL, NULL, 'add_tag', 0, jsonb_build_object('tag_id', v_tag_lead));

  INSERT INTO automation_steps (automation_id, parent_step_id, branch, step_type, position, step_config)
  VALUES (
    v_automation_id, NULL, NULL, 'create_deal', 1,
    jsonb_build_object(
      'pipeline_id', v_pipeline_id,
      'stage_id', v_stage_new_lead,
      'title', 'Novo lead via WhatsApp: {{message.text}}',
      'value', 0
    )
  );

  -- ---- Message templates (DRAFT — see the notice added to
  -- template-manager.tsx explaining the Meta-approval-vs-Baileys split) ----
  INSERT INTO message_templates (account_id, user_id, name, category, language, body_text, status) VALUES
    (p_account_id, p_user_id, 'boas_vindas', 'Utility', 'pt_BR',
      'Olá {{1}}! Bem-vindo(a) à {{2}}. Como podemos te ajudar hoje?', 'DRAFT'),
    (p_account_id, p_user_id, 'confirmacao_agendamento', 'Utility', 'pt_BR',
      'Olá {{1}}, confirmando seu agendamento para {{2}} às {{3}}. Nos vemos lá!', 'DRAFT'),
    (p_account_id, p_user_id, 'promocao', 'Marketing', 'pt_BR',
      '{{1}}, temos uma novidade especial pra você! Aproveite {{2}} por tempo limitado.', 'DRAFT');
EXCEPTION WHEN OTHERS THEN
  -- Same fail-open contract as handle_new_user itself — a broken seed
  -- must never block account creation. The account just starts empty,
  -- same as before this migration existed.
  RAISE WARNING 'Failed to provision starter content for account %: %', p_account_id, SQLERRM;
END;
$$;

ALTER FUNCTION public.provision_starter_content(UUID, UUID) OWNER TO postgres;

-- ---- Wire it into signup ----
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_phone TEXT;
  v_account_id UUID;
BEGIN
  v_full_name := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  v_phone := NULLIF(NEW.raw_user_meta_data->>'phone', '');

  INSERT INTO public.accounts (name, owner_user_id)
  VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
  RETURNING id INTO v_account_id;

  INSERT INTO public.profiles (user_id, full_name, email, phone, account_id, account_role)
  VALUES (NEW.id, v_full_name, NEW.email, v_phone, v_account_id, 'owner');

  PERFORM public.provision_starter_content(v_account_id, NEW.id);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account\profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
