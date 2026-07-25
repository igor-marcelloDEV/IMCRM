-- ============================================================
-- 039_baileys_key_type_open.sql
--
-- 037's `key_type` CHECK constraint enumerated the Baileys auth-state
-- categories known at the time. 038 added one more ('lid-mapping')
-- that Baileys 7.x introduced — but 7.x actually added several
-- ('device-list', 'identity-key', 'tctoken', and others), each
-- rejected the same way, which broke session bootstrap far more
-- broadly than just LID resolution (identity-key failing to persist
-- corrupts the Signal session; the worker logs showed
-- "critical_block blocked on missing key" / app-state sync failures
-- as a direct consequence).
--
-- `baileys_auth_keys` is a generic `SignalKeyStore` — its whole
-- contract is "persist whatever category string the library hands
-- you." Hard-coding an exhaustive allow-list fights that contract and
-- silently breaks on every library upgrade that adds a category.
-- Drop the enumeration; keep a cheap non-empty sanity check.
-- ============================================================

ALTER TABLE baileys_auth_keys DROP CONSTRAINT IF EXISTS baileys_auth_keys_key_type_check;

ALTER TABLE baileys_auth_keys ADD CONSTRAINT baileys_auth_keys_key_type_check
  CHECK (key_type <> '');
