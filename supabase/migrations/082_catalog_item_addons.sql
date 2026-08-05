-- ============================================================
-- Priced add-ons ("adicionais") on catalog products — e.g. a pizza's
-- "Queijo extra +R$5". Configured per product (group of options with
-- min/max-select rules), selected per order line across all three
-- sales channels (internal orders, public storefront, WhatsApp bot).
--
-- order_items/cart_items snapshot the chosen add-ons' name + price at
-- selection time (name_snapshot/price_cents_snapshot), same convention
-- as order_items.name_snapshot/unit_price_cents — a later catalog edit
-- must never retroactively change an already-placed order.
-- ============================================================

CREATE TABLE IF NOT EXISTS catalog_item_addon_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  catalog_item_id UUID NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT FALSE,
  min_select INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
  max_select INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catalog_item_addon_groups_item
  ON catalog_item_addon_groups(catalog_item_id, position);

ALTER TABLE catalog_item_addon_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalog_item_addon_groups_select ON catalog_item_addon_groups FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY catalog_item_addon_groups_insert ON catalog_item_addon_groups FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY catalog_item_addon_groups_update ON catalog_item_addon_groups FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY catalog_item_addon_groups_delete ON catalog_item_addon_groups FOR DELETE
  USING (is_account_member(account_id, 'admin'));

CREATE TABLE IF NOT EXISTS catalog_item_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES catalog_item_addon_groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_catalog_item_addons_group ON catalog_item_addons(group_id, position);

ALTER TABLE catalog_item_addons ENABLE ROW LEVEL SECURITY;
CREATE POLICY catalog_item_addons_select ON catalog_item_addons FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM catalog_item_addon_groups g
    WHERE g.id = catalog_item_addons.group_id AND is_account_member(g.account_id)
  ));
CREATE POLICY catalog_item_addons_insert ON catalog_item_addons FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM catalog_item_addon_groups g
    WHERE g.id = catalog_item_addons.group_id AND is_account_member(g.account_id, 'admin')
  ));
CREATE POLICY catalog_item_addons_update ON catalog_item_addons FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM catalog_item_addon_groups g
    WHERE g.id = catalog_item_addons.group_id AND is_account_member(g.account_id, 'admin')
  ));
CREATE POLICY catalog_item_addons_delete ON catalog_item_addons FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM catalog_item_addon_groups g
    WHERE g.id = catalog_item_addons.group_id AND is_account_member(g.account_id, 'admin')
  ));

-- order_items / cart_items — nullable FK to the source add-on (SET NULL
-- if the product config changes later) + a frozen snapshot, same
-- pattern as order_items.catalog_item_id/name_snapshot.
CREATE TABLE IF NOT EXISTS order_item_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  catalog_item_addon_id UUID REFERENCES catalog_item_addons(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL,
  price_cents_snapshot INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_item_addons_item ON order_item_addons(order_item_id);

ALTER TABLE order_item_addons ENABLE ROW LEVEL SECURITY;
CREATE POLICY order_item_addons_select ON order_item_addons FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = order_item_addons.order_item_id AND is_account_member(o.account_id)
  ));

CREATE TABLE IF NOT EXISTS cart_item_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_item_id UUID NOT NULL REFERENCES cart_items(id) ON DELETE CASCADE,
  catalog_item_addon_id UUID REFERENCES catalog_item_addons(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL,
  price_cents_snapshot INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cart_item_addons_item ON cart_item_addons(cart_item_id);

ALTER TABLE cart_item_addons ENABLE ROW LEVEL SECURITY;
CREATE POLICY cart_item_addons_select ON cart_item_addons FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM cart_items ci
    JOIN carts c ON c.id = ci.cart_id
    WHERE ci.id = cart_item_addons.cart_item_id AND is_account_member(c.account_id)
  ));

-- Relax cart_items' one-line-per-product constraint: the WhatsApp bot
-- needs two differently-configured lines of the same product to
-- coexist (e.g. one pizza with extra cheese, another without).
-- `addons_signature` is a plain deterministic string the app computes
-- (sorted "addon_id:qty" pairs joined by "," — empty string for "no
-- add-ons"), not a hash, so it stays debuggable in a support query.
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_cart_id_catalog_item_id_key;
ALTER TABLE cart_items ADD COLUMN IF NOT EXISTS addons_signature TEXT NOT NULL DEFAULT '';
ALTER TABLE cart_items DROP CONSTRAINT IF EXISTS cart_items_cart_catalog_addons_key;
ALTER TABLE cart_items ADD CONSTRAINT cart_items_cart_catalog_addons_key
  UNIQUE (cart_id, catalog_item_id, addons_signature);
