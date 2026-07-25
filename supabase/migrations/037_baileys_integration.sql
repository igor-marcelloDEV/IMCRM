-- ============================================================
-- 037_baileys_integration.sql — Unofficial WhatsApp Web provider
-- (Baileys) as a second connection option, alongside the existing
-- Meta Cloud API integration.
--
-- What this migration does
--   1. Introduces `whatsapp_provider_type` ('meta_cloud_api' | 'baileys')
--      and `accounts.active_whatsapp_provider` — which provider is
--      currently live for the account. One active provider at a
--      time (locked design decision, see the plan doc); defaults to
--      'meta_cloud_api' so every existing account keeps behaving
--      exactly as before.
--   2. Generalises `messages.message_id` (which today only ever
--      holds a Meta `wamid`) with provider-tagged columns:
--      `messages.provider` + `messages.provider_message_key`. Both
--      nullable and additive — existing rows are untouched, callers
--      adopt the new columns incrementally.
--   3. `baileys_connections` — one row per account, tracks QR-pairing
--      / connection status for that account's WhatsApp Web session.
--   4. `baileys_auth_keys` — the Baileys "auth state" (Signal-protocol
--      pre-keys / sessions / sender-keys / app-state-sync-keys),
--      persisted encrypted (AES-256-GCM via `src/lib/whatsapp/
--      encryption.ts`, same helper that protects the Meta access
--      token) instead of Baileys' default local-file store — the
--      worker process is stateless across deploys/restarts otherwise.
--
-- Why `baileys_auth_keys` has no client-facing RLS policy at all:
-- these rows ARE the WhatsApp session credentials. They're written
-- and read exclusively by the whatsapp-worker service using the
-- Supabase service-role key (which bypasses RLS by design), never by
-- the dashboard's RLS-scoped client. No policy = no access for
-- `authenticated` role, which is exactly the intent.
--
-- Idempotent — safe to run multiple times, matching the convention
-- established in 017_account_sharing.sql.
-- ============================================================

-- ============================================================
-- TYPES
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'whatsapp_provider_type') THEN
    CREATE TYPE whatsapp_provider_type AS ENUM ('meta_cloud_api', 'baileys');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'baileys_connection_status') THEN
    CREATE TYPE baileys_connection_status AS ENUM ('disconnected', 'qr_pending', 'connected');
  END IF;
END $$;

-- ============================================================
-- ACCOUNTS — active provider
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS active_whatsapp_provider whatsapp_provider_type NOT NULL DEFAULT 'meta_cloud_api';

-- ============================================================
-- MESSAGES — provider-tagged message key
--
-- `message_id` stays as-is (still populated for Meta sends, read by
-- existing reply-context lookups in send-message.ts). New sends set
-- both `message_id` (back-compat) and `provider`/`provider_message_key`
-- going forward; the plan is to fully migrate reads off `message_id`
-- in a later cleanup once every call site is provider-aware.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS provider whatsapp_provider_type,
  ADD COLUMN IF NOT EXISTS provider_message_key TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_provider_message_key
  ON messages(provider_message_key);

-- ============================================================
-- BAILEYS_CONNECTIONS
--
-- One row per account (unique). Tracks the lifecycle of that
-- account's WhatsApp Web pairing so the Settings UI can render a QR
-- code / status without talking to the worker directly.
-- ============================================================
CREATE TABLE IF NOT EXISTS baileys_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status baileys_connection_status NOT NULL DEFAULT 'disconnected',
  phone_number TEXT,
  qr_code TEXT,
  connected_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_baileys_connections_account
  ON baileys_connections(account_id);

ALTER TABLE baileys_connections ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON baileys_connections;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON baileys_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Settings-class visibility/control, mirroring whatsapp_config (017):
-- any member reads; admin+ writes. The worker uses the service role
-- for its own status updates, bypassing RLS.
DROP POLICY IF EXISTS baileys_connections_select ON baileys_connections;
DROP POLICY IF EXISTS baileys_connections_insert ON baileys_connections;
DROP POLICY IF EXISTS baileys_connections_update ON baileys_connections;
DROP POLICY IF EXISTS baileys_connections_delete ON baileys_connections;
CREATE POLICY baileys_connections_select ON baileys_connections FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY baileys_connections_insert ON baileys_connections FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY baileys_connections_update ON baileys_connections FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY baileys_connections_delete ON baileys_connections FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- BAILEYS_AUTH_KEYS
--
-- The Baileys auth-state store, persisted row-per-key instead of the
-- library's default local JSON file (which wouldn't survive a
-- worker restart/redeploy). `key_type` matches Baileys' internal
-- SignalDataTypeMap categories; `key_id` is the identifier Baileys
-- assigns within each type. `encrypted_value` holds the JSON-
-- serialised key material through `encrypt()` from
-- src/lib/whatsapp/encryption.ts.
--
-- No RLS policies are defined on purpose — see the note at the top
-- of this file. RLS is still enabled so a future accidental grant to
-- `authenticated` fails closed rather than open.
-- ============================================================
CREATE TABLE IF NOT EXISTS baileys_auth_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL CHECK (key_type IN (
    'creds', 'pre-key', 'session', 'sender-key',
    'sender-key-memory', 'app-state-sync-key', 'app-state-sync-version'
  )),
  key_id TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_baileys_auth_keys_lookup
  ON baileys_auth_keys(account_id, key_type, key_id);

ALTER TABLE baileys_auth_keys ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON baileys_auth_keys;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON baileys_auth_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
