-- ============================================================
-- 059_trial_token_security.sql
--
-- Trial links are bearer credentials. Store only a SHA-256 digest,
-- give every offer an expiry, and remove legacy plaintext values after
-- a safe backfill.
-- ============================================================

ALTER TABLE public.billing_nudges
  ADD COLUMN IF NOT EXISTS trial_claim_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS trial_claim_expires_at TIMESTAMPTZ;

-- sha256() is a pg_catalog built-in since PG 14 — no pgcrypto needed.
-- (pgcrypto's digest() lives in the `extensions` schema on Supabase,
-- which isn't on the CLI migration role's search_path — see
-- gen_random_uuid() vs uuid_generate_v4() for the same class of issue.)
UPDATE public.billing_nudges
SET trial_claim_token_hash = encode(
      sha256(trial_claim_token::bytea),
      'hex'
    ),
    trial_claim_expires_at = COALESCE(
      trial_claim_expires_at,
      NOW() + INTERVAL '7 days'
    )
WHERE trial_claim_token IS NOT NULL
  AND trial_claim_token_hash IS NULL;

DROP INDEX IF EXISTS idx_billing_nudges_trial_token;
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_nudges_trial_token_hash
  ON public.billing_nudges(trial_claim_token_hash)
  WHERE trial_claim_token_hash IS NOT NULL;

UPDATE public.billing_nudges
SET trial_claim_token = NULL
WHERE trial_claim_token IS NOT NULL;

