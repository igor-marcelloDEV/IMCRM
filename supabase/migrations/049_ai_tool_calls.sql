-- ============================================================
-- 049_ai_tool_calls.sql — AI agent tool-calling (add to cart / move
-- stage / mark won-lost)
--
-- The AI reply assistant (migration 029) has been text-only: it reads
-- the conversation and drafts a reply, with no way to act. This adds a
-- small, fixed set of "tools" the model may invoke autonomously while
-- auto-replying — add a catalog item to the contact's cart, move their
-- open deal to another pipeline stage, or mark it won/lost — gated
-- per-tool behind `ai_configs.enabled_tools` so a tenant opts in
-- explicitly per capability rather than getting all-or-nothing.
--
-- Design notes
--   - `enabled_tools` is a plain text[] (not a join table) — same
--     "small fixed vocabulary, no need for referential integrity"
--     reasoning as `catalog_items.media_type`'s CHECK. Empty/NULL means
--     today's behaviour: no tool ever fires.
--   - `ai_tool_calls` is an audit log AND the idempotency guard for the
--     dispatch path. `dispatchInboundToAiReply` (src/lib/ai/auto-reply.ts)
--     has no per-inbound-message dedup today — only a per-conversation
--     reply-count cap — which is harmless for re-sent text but not for
--     a tool that writes to the cart/pipeline. A webhook retry re-runs
--     the same inbound `provider_message_key`; before executing any
--     tool call the dispatcher checks whether that key already has a
--     row here for that tool and skips if so.
--   - RLS mirrors `ai_configs`: any member can read the log (it's
--     useful audit trail — "why did the AI move this deal?"), only the
--     service role writes (the auto-reply dispatcher runs under
--     supabaseAdmin(), no auth.uid()).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS enabled_tools TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS ai_tool_calls (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id       UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id            UUID REFERENCES contacts(id) ON DELETE SET NULL,
  provider_message_key  TEXT NOT NULL,
  tool_name             TEXT NOT NULL CHECK (tool_name IN ('add_to_cart', 'move_deal_stage', 'mark_deal_status')),
  input                 JSONB NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL CHECK (status IN ('success', 'error')),
  result_summary        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency lookup: "has this inbound message already executed this
-- tool?" — the exact query the dispatcher runs before acting.
CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_dedup
  ON ai_tool_calls(provider_message_key, tool_name);

CREATE INDEX IF NOT EXISTS idx_ai_tool_calls_account
  ON ai_tool_calls(account_id, created_at DESC);

ALTER TABLE ai_tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_tool_calls_select ON ai_tool_calls;
CREATE POLICY ai_tool_calls_select ON ai_tool_calls FOR SELECT
  USING (is_account_member(account_id));

-- No client-facing INSERT/UPDATE/DELETE policy on purpose — only the
-- service-role auto-reply dispatcher writes here (same pattern as
-- orders/order_items in migration 046).
