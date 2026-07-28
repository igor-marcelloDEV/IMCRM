-- ============================================================
-- 047_flow_catalog_nodes.sql
--
-- Adds 'show_catalog' and 'checkout' to flow_nodes.node_type — the
-- two new commerce node types (catalog + cart, see src/lib/flows).
-- Same drop-and-recreate pattern migration 016 used to land
-- 'send_media'. Node config still lives in JSONB, shape-checked by
-- the validator + TS types, not the DB.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'show_catalog',
    'checkout',
    'end'
  ));
