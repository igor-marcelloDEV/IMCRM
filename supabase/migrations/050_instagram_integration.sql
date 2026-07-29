-- ============================================================
-- 050_instagram_integration.sql — Instagram connection + comment→DM
--
-- Fase 1 da integração com Instagram (plano aprovado): comentário com
-- palavra-chave num post dispara uma DM automática (com texto ou
-- documento), reaproveitando o motor de automações já existente
-- (add_tag/create_deal/etc já funcionam pra qualquer contact_id,
-- independente do canal). Facebook/Messenger e anúncios pagos ficam
-- para uma fase posterior.
--
-- Design notes
--   - `instagram_configs` mirrors `whatsapp_config` (migration 001) —
--     one row per account, token pasted manually (long-lived Page
--     token) and AES-256-GCM encrypted at rest via the same
--     encrypt()/decrypt() helper (src/lib/whatsapp/encryption.ts).
--     `instagram_business_account_id` is globally unique — same
--     reasoning as `whatsapp_config.phone_number_id` (migration 013):
--     one IG Business Account can only be claimed by one tenant.
--   - `contacts.phone` becomes nullable: an Instagram commenter has no
--     phone number. `instagram_scoped_id` is the equivalent identity
--     column for that channel, with its own partial unique index —
--     same pattern as `phone_normalized` (migration 022) and the
--     Baileys LID mapping (migration 038), which solved the identical
--     "alternate identity, don't force it into phone" problem.
--   - `conversations.channel` lets the inbox and every send helper
--     branch correctly instead of assuming WhatsApp/phone. Existing
--     rows default to 'whatsapp' (unaffected).
--   - `messages.provider` (enum `whatsapp_provider_type`, migration
--     037) gains an `'instagram'` value so inbound/outbound Instagram
--     messages can be tagged the same way Meta/Baileys messages are.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- INSTAGRAM_CONFIGS
-- ============================================================
CREATE TABLE IF NOT EXISTS instagram_configs (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                     UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  page_id                        TEXT NOT NULL,
  instagram_business_account_id  TEXT NOT NULL,
  access_token                   TEXT NOT NULL,   -- AES-256-GCM-encrypted long-lived Page token
  verify_token                   TEXT NOT NULL,   -- AES-256-GCM-encrypted, same handshake as whatsapp_config
  username                       TEXT,
  status                         TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error')),
  last_error                     TEXT,
  connected_at                   TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_instagram_configs_ig_account
  ON instagram_configs(instagram_business_account_id);

ALTER TABLE instagram_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instagram_configs_select ON instagram_configs;
CREATE POLICY instagram_configs_select ON instagram_configs FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS instagram_configs_insert ON instagram_configs;
CREATE POLICY instagram_configs_insert ON instagram_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS instagram_configs_update ON instagram_configs;
CREATE POLICY instagram_configs_update ON instagram_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS instagram_configs_delete ON instagram_configs;
CREATE POLICY instagram_configs_delete ON instagram_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_instagram_configs_updated_at ON instagram_configs;
CREATE TRIGGER set_instagram_configs_updated_at
  BEFORE UPDATE ON instagram_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- CONTACTS — Instagram-scoped identity alongside phone
-- ============================================================
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_scoped_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_instagram_scoped_id
  ON contacts(account_id, instagram_scoped_id)
  WHERE instagram_scoped_id IS NOT NULL;

-- ============================================================
-- CONVERSATIONS — channel discriminator
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'instagram'));

-- ============================================================
-- MESSAGES — widen the provider enum
-- ============================================================
ALTER TYPE whatsapp_provider_type ADD VALUE IF NOT EXISTS 'instagram';
