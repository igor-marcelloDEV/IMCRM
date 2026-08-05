ALTER TABLE public.catalog_items
  ADD COLUMN IF NOT EXISTS offer_type text NOT NULL DEFAULT 'service',
  ADD COLUMN IF NOT EXISTS billing_cycle text,
  ADD COLUMN IF NOT EXISTS compare_at_price_cents integer,
  ADD COLUMN IF NOT EXISTS trial_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS campaign_badge text,
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS ncm text,
  ADD COLUMN IF NOT EXISTS cest text,
  ADD COLUMN IF NOT EXISTS cfop text,
  ADD COLUMN IF NOT EXISTS fiscal_unit text NOT NULL DEFAULT 'UN';

ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_offer_type_check;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_offer_type_check
  CHECK (offer_type IN ('physical_product','service','subscription'));
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_billing_cycle_check;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_billing_cycle_check
  CHECK ((offer_type = 'subscription' AND billing_cycle IN ('MONTHLY','QUARTERLY','SEMIANNUALLY','YEARLY')) OR (offer_type <> 'subscription' AND billing_cycle IS NULL));
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_trial_days_check;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_trial_days_check CHECK (trial_days BETWEEN 0 AND 365);
ALTER TABLE public.catalog_items DROP CONSTRAINT IF EXISTS catalog_items_compare_price_check;
ALTER TABLE public.catalog_items ADD CONSTRAINT catalog_items_compare_price_check CHECK (compare_at_price_cents IS NULL OR compare_at_price_cents >= price_cents);

ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS offer_type_snapshot text NOT NULL DEFAULT 'service',
  ADD COLUMN IF NOT EXISTS billing_cycle_snapshot text;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS fiscal_document_type text,
  ADD COLUMN IF NOT EXISTS merchandise_fiscal_status text,
  ADD COLUMN IF NOT EXISTS gateway_subscription_id text;

ALTER TABLE public.tenant_payment_configs
  ADD COLUMN IF NOT EXISTS merchandise_invoice_provider text,
  ADD COLUMN IF NOT EXISTS encrypted_merchandise_invoice_api_key text,
  ADD COLUMN IF NOT EXISTS merchandise_invoice_env text NOT NULL DEFAULT 'sandbox';

COMMENT ON COLUMN public.orders.fiscal_document_type IS 'NFS-e for services, NF-e/NFC-e for merchandise, or mixed when separate documents are required.';
