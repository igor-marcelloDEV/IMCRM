-- ============================================================
-- 046_catalog_orders.sql
--
-- Per-tenant product/service catalog + WhatsApp shopping cart +
-- orders, so a tenant can sell through a guided Flow (see the new
-- `show_catalog` / `checkout` node types shipped alongside this
-- migration) instead of hand-typing prices in chat.
--
-- Payment is the TENANT's own Asaas account (`tenant_payment_configs`)
-- — separate from the platform's own `ASAAS_API_KEY` env var, which
-- only charges accounts for IMCRM itself (see migration 041). Each
-- tenant pastes their own key; the same encrypt()/decrypt() helper
-- used for whatsapp_config.access_token / ai_configs.api_key
-- (src/lib/whatsapp/encryption.ts) protects it at rest.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- CATALOG_ITEMS — what the tenant sells. Photo/video is a plain
-- Storage URL (flow-media bucket, same as the send_media node) rather
-- than a new bucket — one less RLS surface to maintain.
-- ============================================================
CREATE TABLE IF NOT EXISTS catalog_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'BRL',
  media_url TEXT,
  media_type TEXT CHECK (media_type IN ('image', 'video')),
  -- Surfaced as a suggestion at checkout ("quer adicionar também...")
  -- to lift ticket size — see the `checkout` node.
  is_upsell BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_catalog_items_account
  ON catalog_items(account_id, position) WHERE is_active;

DROP TRIGGER IF EXISTS set_catalog_items_updated_at ON catalog_items;
CREATE TRIGGER set_catalog_items_updated_at
  BEFORE UPDATE ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalog_items_select ON catalog_items FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY catalog_items_insert ON catalog_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY catalog_items_update ON catalog_items FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY catalog_items_delete ON catalog_items FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- CARTS — one open cart per contact, filled by the `show_catalog`
-- flow node. Written only by the flow engine (service-role); members
-- can read for support/visibility, no client write policy needed.
-- ============================================================
CREATE TABLE IF NOT EXISTS carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out', 'abandoned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Mirrors idx_one_active_run_per_contact (migration 010) — a race
-- between two inbound messages can't create two open carts for the
-- same contact; the loser's INSERT just 23505s and the engine retries
-- against the row that won.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_cart_per_contact
  ON carts(contact_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_carts_account ON carts(account_id);

DROP TRIGGER IF EXISTS set_carts_updated_at ON carts;
CREATE TRIGGER set_carts_updated_at
  BEFORE UPDATE ON carts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
CREATE POLICY carts_select ON carts FOR SELECT
  USING (is_account_member(account_id));
-- No client INSERT/UPDATE/DELETE — only the flow engine (service-role)
-- writes carts.

-- ============================================================
-- CART_ITEMS — unit_price_cents is copied at add-time so a later
-- catalog price edit never retroactively changes an open cart.
-- ============================================================
CREATE TABLE IF NOT EXISTS cart_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (cart_id, catalog_item_id)
);

CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id);

ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY cart_items_select ON cart_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM carts WHERE carts.id = cart_items.cart_id AND is_account_member(carts.account_id)
  ));

-- ============================================================
-- ORDERS — created when a cart checks out. `deal_id` links back to
-- the Pipeline (populated by the `checkout` node); manual "closing"
-- of the sale is dragging that Deal to a won stage in the existing
-- Pipeline UI, not something tracked here.
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  cart_id UUID REFERENCES carts(id) ON DELETE SET NULL,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('pending_payment', 'paid', 'canceled')),
  subtotal_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  gateway_customer_id TEXT,
  gateway_payment_id TEXT UNIQUE,
  invoice_id TEXT,
  invoice_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_orders_account ON orders(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_gateway_payment
  ON orders(gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_orders_updated_at ON orders;
CREATE TRIGGER set_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (is_account_member(account_id));
-- No client INSERT/UPDATE/DELETE — the checkout flow node and the
-- orders webhook (both service-role) are the only writers.

-- ============================================================
-- ORDER_ITEMS — frozen snapshot of what was actually bought.
-- catalog_item_id is nullable so deleting a catalog item later never
-- corrupts historical orders; name_snapshot keeps the label readable
-- even after that.
-- ============================================================
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  catalog_item_id UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_items_select ON order_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM orders WHERE orders.id = order_items.order_id AND is_account_member(orders.account_id)
  ));

-- ============================================================
-- TENANT_PAYMENT_CONFIGS — the tenant's OWN Asaas account, used to
-- charge THEIR customers. Distinct from ASAAS_API_KEY (platform env
-- var, migration 041), which only charges tenants for IMCRM itself.
--
-- Same SELECT-any-member / WRITE-admin-only split as whatsapp_config
-- (migration 017) — the encrypted key column is never selected by
-- client code (the Settings panel only ever reads the non-secret
-- columns), but RLS still restricts writes to admins as defense in
-- depth.
-- ============================================================
CREATE TABLE IF NOT EXISTS tenant_payment_configs (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  encrypted_asaas_api_key TEXT,
  asaas_env TEXT NOT NULL DEFAULT 'sandbox' CHECK (asaas_env IN ('sandbox', 'production')),
  municipal_service_id TEXT,
  municipal_service_name TEXT,
  default_taxes JSONB,
  -- Only flips on once the tenant has confirmed their OWN Asaas
  -- account already has municipal/fiscal registration configured —
  -- see the Payments settings tab warning copy. We never attempt NFe
  -- issuance before this is explicitly true.
  nfe_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS set_tenant_payment_configs_updated_at ON tenant_payment_configs;
CREATE TRIGGER set_tenant_payment_configs_updated_at
  BEFORE UPDATE ON tenant_payment_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE tenant_payment_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_payment_configs_select ON tenant_payment_configs FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY tenant_payment_configs_insert ON tenant_payment_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY tenant_payment_configs_update ON tenant_payment_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY tenant_payment_configs_delete ON tenant_payment_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- contacts.cpf_cnpj — Asaas requires it to create any charge or
-- invoice. Captured once via the `checkout` node's free-text prompt
-- (reuses the collect_input capture mechanism, no new Flow node
-- needed) and reused on the contact's next purchase.
-- ============================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS cpf_cnpj TEXT;
