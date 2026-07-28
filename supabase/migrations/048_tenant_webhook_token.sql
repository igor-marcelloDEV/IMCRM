-- ============================================================
-- 048_tenant_webhook_token.sql
--
-- tenant_payment_configs.webhook_token — the value the TENANT pastes
-- into their own Asaas dashboard (Integrations → Webhooks →
-- Authentication token) when pointing it at /api/orders/webhook.
-- Same mechanism as the platform's own ASAAS_WEBHOOK_TOKEN (migration
-- 041), just per-tenant and app-generated instead of an env var,
-- since here each tenant self-configures their own webhook.
--
-- Not a secret in the encrypted-at-rest sense (nothing financial is
-- derivable from it alone) — same tier as a webhook signing secret,
-- shown back to the tenant in Settings so they can (re)paste it into
-- Asaas at any time.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE tenant_payment_configs ADD COLUMN IF NOT EXISTS webhook_token TEXT;
