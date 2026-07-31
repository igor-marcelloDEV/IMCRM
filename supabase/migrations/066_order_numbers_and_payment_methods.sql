-- ============================================================
-- 066_order_numbers_and_payment_methods.sql
--
-- Two independent, small additions to Comandas:
--   * orders.order_number — a per-account, human-readable sequence
--     ("Pedido #1", "#2", ...) instead of asking a shop owner to read
--     out a UUID. Assigned atomically via a counter column on
--     `accounts` (locked implicitly by the UPDATE...RETURNING inside
--     the trigger) rather than a MAX(order_number)+1 query, which
--     would race under concurrent inserts.
--   * order_payments.method gains 'card_debit'/'card_credit' — a
--     tenant recording a card payment by hand wants to say which,
--     same distinction their card machine already prints. The old
--     generic 'card' value stays valid (existing rows, and simpler
--     than a data migration) but is no longer offered as a new choice
--     in the UI.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS next_order_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number INTEGER;

-- Backfill existing rows in creation order, per account, then point
-- each account's counter past whatever it just assigned.
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY account_id ORDER BY created_at, id) AS rn
  FROM orders
  WHERE order_number IS NULL
)
UPDATE orders SET order_number = numbered.rn
FROM numbered
WHERE orders.id = numbered.id;

UPDATE accounts
SET next_order_number = COALESCE(
  (SELECT max(order_number) + 1 FROM orders WHERE orders.account_id = accounts.id),
  1
)
WHERE next_order_number = 1;

CREATE OR REPLACE FUNCTION public.assign_order_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_number integer;
BEGIN
  IF NEW.order_number IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.accounts
  SET next_order_number = next_order_number + 1
  WHERE id = NEW.account_id
  RETURNING next_order_number - 1 INTO v_number;

  NEW.order_number := v_number;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assign_order_number ON orders;
CREATE TRIGGER assign_order_number
  BEFORE INSERT ON orders
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_order_number();

ALTER TABLE orders ALTER COLUMN order_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_account_number
  ON orders(account_id, order_number);

ALTER TABLE order_payments DROP CONSTRAINT IF EXISTS order_payments_method_check;
ALTER TABLE order_payments ADD CONSTRAINT order_payments_method_check
  CHECK (method IN ('cash', 'card', 'card_debit', 'card_credit', 'pix_manual', 'pix_asaas', 'other'));
