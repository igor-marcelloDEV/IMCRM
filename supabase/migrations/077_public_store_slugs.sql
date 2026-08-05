ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS store_slug text;

UPDATE public.accounts
SET store_slug = trim(both '-' from regexp_replace(
  translate(lower(coalesce(nullif(name, ''), 'loja')),
    'áàâãäéèêëíìîïóòôõöúùûüç',
    'aaaaaeeeeiiiiooooouuuuc'),
  '[^a-z0-9]+', '-', 'g'
)) || '-' || left(replace(id::text, '-', ''), 6)
WHERE store_slug IS NULL;

UPDATE public.accounts
SET store_slug = 'im-digital-solutions'
WHERE id = '553bfeb9-7861-46bd-b19a-c7c22d34fc09';

CREATE UNIQUE INDEX IF NOT EXISTS accounts_store_slug_unique
  ON public.accounts (store_slug)
  WHERE store_slug IS NOT NULL;

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_store_slug_format;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_store_slug_format
  CHECK (store_slug IS NULL OR store_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');
