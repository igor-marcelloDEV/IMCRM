-- ============================================================
-- 059_trial_token_security.sql
--
-- Trial links are bearer credentials. Store only a SHA-256 digest,
-- give every offer an expiry, and remove legacy plaintext values after
-- a safe backfill.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.billing_nudges
  ADD COLUMN IF NOT EXISTS trial_claim_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS trial_claim_expires_at TIMESTAMPTZ;

UPDATE public.billing_nudges
SET trial_claim_token_hash = encode(
      digest(trial_claim_token, 'sha256'),
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

