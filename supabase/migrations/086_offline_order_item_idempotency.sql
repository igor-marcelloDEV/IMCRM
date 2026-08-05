-- Offline order-taking (Fase 6): staff can add items to an already-open
-- comanda while signal is down, queued in an IndexedDB outbox
-- (src/lib/offline/outbox.ts) and replayed once back online. A replay
-- after a partial success (server processed it, client never saw the
-- response before losing connection again) must not double-add — the
-- client tags each offline "add item" with a UUID it generates itself,
-- and the route upserts-or-no-ops on it instead of blindly inserting.
--
-- Scoped to order_items only: PATCH (quantity/add-ons) is naturally
-- idempotent already (setting a value to X twice is a no-op the second
-- time), so only the POST-a-new-line path needs a dedup key. Creating
-- a brand-new order/comanda from scratch while offline is out of scope
-- — that flow depends on searching/creating a contact, which needs a
-- live catalog of contacts to search against anyway.

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS client_request_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_client_request_id
  ON public.order_items(order_id, client_request_id)
  WHERE client_request_id IS NOT NULL;
