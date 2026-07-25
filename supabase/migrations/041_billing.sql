-- ============================================================
-- 041_billing.sql
--
-- IMCRM becomes a paid product: IM Digital Solutions (the platform
-- operator) charges every `accounts` row a recurring fee (weekly /
-- monthly / annual) to keep using the CRM. Until an account has a
-- valid subscription, the app gates it down to the /billing page
-- (see src/middleware.ts + dashboard-shell.tsx, added in the same
-- change as this migration).
--
-- Design notes (see the plan doc for the full reasoning):
--   - `billing_plans` / `coupons` are PLATFORM-global tables (no
--     account_id) — there is one operator (you) selling access to
--     many tenant accounts, not each tenant selling to their own
--     customers. Coupon/plan management is therefore gated in the
--     app by a hardcoded PLATFORM_OPERATOR_ACCOUNT_ID env var, not a
--     new role system.
--   - `subscriptions` is the single source of truth for "can this
--     account use the app" — no billing columns were added to
--     `accounts` itself, keeping that table's shape unchanged.
--   - One non-terminal subscription per account, enforced the same
--     way migration 010 enforces one active flow_run per contact: a
--     partial UNIQUE index rather than an application-level check
--     (race-safe under concurrent webhook deliveries).
--   - `claim_coupon()` mirrors `claim_ai_reply_slot()` (migration
--     029): a single guarded UPDATE...RETURNING, so concurrent
--     redemption attempts can't both succeed past max_uses.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- profiles.phone — needed to reach a signed-up-but-unpaid account
-- over WhatsApp for the 24h/48h retention nudges. Signup now collects
-- it (src/app/(auth)/signup/page.tsx) and passes it through
-- auth.signUp()'s options.data, same mechanism already used for
-- full_name — so handle_new_user() needs to read it too.
-- ============================================================
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone TEXT;

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

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to bootstrap account\profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

-- ============================================================
-- BILLING_PLANS — platform-global, seeded below. Editable later by
-- hand (service-role) if pricing changes; not exposed to tenant CRUD.
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE CHECK (code IN ('weekly', 'monthly', 'annual')),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  cycle_days INTEGER NOT NULL,
  -- Asaas subscription `cycle` enum value for this plan.
  asaas_cycle TEXT NOT NULL CHECK (asaas_cycle IN ('WEEKLY', 'MONTHLY', 'YEARLY')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO billing_plans (code, name, price_cents, currency, cycle_days, asaas_cycle)
VALUES
  ('weekly',  'Semanal', 4990,   'BRL', 7,   'WEEKLY'),
  ('monthly', 'Mensal',  14990,  'BRL', 30,  'MONTHLY'),
  ('annual',  'Anual',   119900, 'BRL', 365, 'YEARLY')
ON CONFLICT (code) DO UPDATE
SET name = EXCLUDED.name,
    price_cents = EXCLUDED.price_cents,
    currency = EXCLUDED.currency,
    cycle_days = EXCLUDED.cycle_days,
    asaas_cycle = EXCLUDED.asaas_cycle;

ALTER TABLE billing_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Plans are readable by any authenticated user" ON billing_plans;
CREATE POLICY "Plans are readable by any authenticated user"
  ON billing_plans FOR SELECT
  USING (auth.role() = 'authenticated');

-- ============================================================
-- COUPONS — platform-global. No client SELECT policy: redemption
-- and validation always go through claim_coupon()/API routes so a
-- client can never enumerate codes or usage counts directly.
-- ============================================================
CREATE TABLE IF NOT EXISTS coupons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL UNIQUE,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percentage', 'fixed')),
  discount_value NUMERIC(10, 2) NOT NULL CHECK (discount_value > 0),
  valid_until TIMESTAMPTZ NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses_count INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto_24h', 'auto_48h_trial')),
  -- Non-null restricts redemption to one specific account — how the
  -- 24h auto-generated coupon stays personal instead of shareable.
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_coupons_code_lower ON coupons (lower(code));
CREATE INDEX IF NOT EXISTS idx_coupons_account ON coupons(account_id);

ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
-- No policies at all — service-role (checkout/validate API routes,
-- claim_coupon RPC) is the only reader/writer. Intentional.

-- ============================================================
-- SUBSCRIPTIONS — one per account; account access is gated on this.
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES billing_plans(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'trialing', 'active', 'past_due', 'canceled', 'expired')),
  billing_type TEXT CHECK (billing_type IN ('pix', 'boleto', 'credit_card')),
  gateway TEXT NOT NULL DEFAULT 'asaas',
  gateway_customer_id TEXT,
  gateway_subscription_id TEXT,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  coupon_id UUID REFERENCES coupons(id),
  canceled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Linchpin of the access gate: at most one non-terminal subscription
-- per account. Mirrors idx_one_active_run_per_contact (migration 010)
-- — a concurrent checkout double-submit collides here (23505) instead
-- of creating two competing subscriptions.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_live_subscription_per_account
  ON subscriptions(account_id)
  WHERE status IN ('pending', 'trialing', 'active', 'past_due');

CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(account_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_gateway_subscription
  ON subscriptions(gateway_subscription_id) WHERE gateway_subscription_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER set_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can read their account's subscription" ON subscriptions;
CREATE POLICY "Members can read their account's subscription"
  ON subscriptions FOR SELECT
  USING (is_account_member(account_id));
-- No client INSERT/UPDATE — only the checkout API and the Asaas
-- webhook (both service-role) ever write this table.

-- ============================================================
-- PAYMENTS — invoice/renewal history, one row per gateway charge.
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  gateway_payment_id TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'overdue', 'refunded', 'failed')),
  billing_type TEXT CHECK (billing_type IN ('pix', 'boleto', 'credit_card')),
  due_date DATE,
  paid_at TIMESTAMPTZ,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_account ON payments(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_subscription ON payments(subscription_id);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can read their account's payments" ON payments;
CREATE POLICY "Members can read their account's payments"
  ON payments FOR SELECT
  USING (is_account_member(account_id));

-- ============================================================
-- COUPON_REDEMPTIONS — audit trail + reuse guard alongside uses_count.
-- ============================================================
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  coupon_id UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);
ALTER TABLE coupon_redemptions ENABLE ROW LEVEL SECURITY;
-- Service-role only, same rationale as `coupons`.

-- ============================================================
-- BILLING_NUDGES — one row per account, tracks retention-drip
-- progress so the nurture cron never double-sends.
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_nudges (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  nudge_20_sent_at TIMESTAMPTZ,
  trial_offered_at TIMESTAMPTZ,
  -- Opaque bearer token sent in the 48h WhatsApp message's trial link
  -- (/api/billing/claim-trial?token=...). Not a JWT — just a random
  -- 24-byte value from crypto.randomBytes, unique enough on its own
  -- that a lookup-by-value is the only verification needed.
  trial_claim_token TEXT,
  trial_claimed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_nudges_trial_token
  ON billing_nudges(trial_claim_token) WHERE trial_claim_token IS NOT NULL;

ALTER TABLE billing_nudges ENABLE ROW LEVEL SECURITY;
-- Service-role only (cron + claim-trial route) — nothing here is
-- rendered to the tenant directly.

-- ============================================================
-- claim_coupon() — atomic redemption, mirrors claim_ai_reply_slot()
-- (migration 029). A single guarded UPDATE means two concurrent
-- checkout submissions racing the same code can't both win past
-- max_uses; the loser's WHERE clause simply matches zero rows.
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_coupon(
  p_code TEXT,
  p_account_id UUID
)
RETURNS UUID AS $$
  WITH claimed AS (
    UPDATE coupons
    SET uses_count = uses_count + 1
    WHERE lower(code) = lower(p_code)
      AND is_active
      AND valid_until > NOW()
      AND uses_count < max_uses
      AND (account_id IS NULL OR account_id = p_account_id)
    RETURNING id
  )
  SELECT id FROM claimed;
$$ LANGUAGE sql SECURITY DEFINER SET search_path = public;

-- Called from the checkout API (service-role, no auth.uid()) — same
-- grant rationale as claim_ai_reply_slot (migration 031).
GRANT EXECUTE ON FUNCTION public.claim_coupon(TEXT, UUID) TO service_role;
