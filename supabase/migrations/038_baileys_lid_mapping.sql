-- ============================================================
-- 038_baileys_lid_mapping.sql
--
-- Baileys 7.x introduced a persistent LID↔phone-number mapping store
-- (`SignalRepository.lidMapping`), written through the same
-- `SignalKeyStore` interface as every other auth-state key — but
-- under a new `key_type` value ('lid-mapping') that
-- 037_baileys_integration.sql's CHECK constraint didn't allow yet.
-- Every write attempt was silently rejected (constraint violation,
-- swallowed by the worker's best-effort write path), so the mapping
-- never persisted and WhatsApp's newer LID-addressed chats (accounts
-- with the "hide my phone number" privacy default) could never be
-- resolved to a real phone number — those messages were correctly
-- being skipped rather than mis-filed, but skipped forever instead of
-- resolving after the first lookup.
--
-- Widens the constraint to allow it. Idempotent — DROP+ADD CONSTRAINT
-- is safe to re-run.
-- ============================================================

ALTER TABLE baileys_auth_keys DROP CONSTRAINT IF EXISTS baileys_auth_keys_key_type_check;

ALTER TABLE baileys_auth_keys ADD CONSTRAINT baileys_auth_keys_key_type_check
  CHECK (key_type IN (
    'creds', 'pre-key', 'session', 'sender-key',
    'sender-key-memory', 'app-state-sync-key', 'app-state-sync-version',
    'lid-mapping'
  ));
