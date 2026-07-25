-- ============================================================
-- 042_billing_cpf_cnpj.sql
--
-- Asaas' production API rejects creating ANY charge (PIX, boleto, or
-- card) for a customer with no CPF/CNPJ on file:
--   "Para criar esta cobrança é necessário preencher o CPF ou CNPJ
--    do cliente."
-- Migration 041 shipped checkout without collecting this, so the
-- first real checkout attempt got a valid Asaas customer + a
-- `subscriptions` row stuck at status='pending' (the charge call
-- itself threw). Collected once at checkout time and stored here so
-- a returning customer (plan change, renewal) isn't asked again.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS cpf_cnpj TEXT;

-- Companion to claim_coupon() (migration 041): when a checkout claims
-- a coupon but the gateway charge itself then fails (see the new
-- try/catch in /api/billing/checkout), the use needs to be given back
-- rather than permanently burned on an attempt that never actually
-- charged anyone. Floors at 0 defensively — should never go negative
-- since a use is only released after a successful claim incremented it.
CREATE OR REPLACE FUNCTION public.release_coupon_use(
  p_coupon_id UUID
)
RETURNS VOID AS $$
  UPDATE coupons
  SET uses_count = GREATEST(0, uses_count - 1)
  WHERE id = p_coupon_id;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION public.release_coupon_use(UUID) TO service_role;
