-- ============================================================
-- 064_comandas_and_branding.sql
--
-- Comandas v1 — makes an order something you can actually operate
-- (open one by hand, not just wait for the WhatsApp checkout Flow to
-- create it), plus whitelabel branding (company name + logo) so the
-- documents IMCRM itself generates (receipts today; future reports)
-- carry the tenant's identity instead of IMCRM's.
--
-- Deliberately NOT the full data-model split from the audit
-- (deal_items vs order_items, contact-optional balcão sales) — this
-- reuses the existing orders/order_items tables and adds only what a
-- "record a payment against an order, by hand" flow needs. See
-- docs/architecture.md.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- BRANDING — accounts.name already exists (migration 017) and doubles
-- as the "company name" shown on documents; logo_url is the only new
-- field needed.
-- ============================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS logo_url TEXT;

-- ============================================================
-- ORDERS — allow a comanda opened directly in the dashboard, not just
-- one created by the WhatsApp checkout Flow.
-- ============================================================
ALTER TABLE orders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'whatsapp_checkout';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_source_check;
ALTER TABLE orders ADD CONSTRAINT orders_source_check
  CHECK (source IN ('whatsapp_checkout', 'manual'));

ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;

-- ============================================================
-- ORDER_PAYMENTS — one row per payment recorded against an order.
-- The existing Asaas-automatic flow keeps working unchanged (it marks
-- orders.status = 'paid' directly via the orders webhook); this table
-- is for payments an agent records by hand — cash, card, a PIX paid
-- outside Asaas, split across methods. A manual order is "paid" once
-- its recorded payments cover the total (checked in the API route,
-- not a trigger, so the "mark paid" logic stays in one readable
-- place alongside the payment-recording logic itself).
-- ============================================================
CREATE TABLE IF NOT EXISTS order_payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method       TEXT NOT NULL CHECK (method IN ('cash', 'card', 'pix_manual', 'pix_asaas', 'other')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  notes        TEXT,
  recorded_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);
CREATE INDEX IF NOT EXISTS idx_order_payments_account ON order_payments(account_id, created_at DESC);

ALTER TABLE order_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_payments_select ON order_payments;
CREATE POLICY order_payments_select ON order_payments FOR SELECT
  USING (is_account_member(account_id));

-- No client INSERT/UPDATE/DELETE policy on purpose — same pattern as
-- orders/order_items (migration 046). Only the service-role API
-- routes (/api/orders/[id]/payments) write here, so a payment can
-- never be recorded (or a balance forged) by a direct client write.
