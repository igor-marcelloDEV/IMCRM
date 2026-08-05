-- Legal identity used on tenant-generated receipts (not an official NFS-e).
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS legal_name text,
  ADD COLUMN IF NOT EXISTS cnpj text;

UPDATE public.accounts SET legal_name = name WHERE legal_name IS NULL;

UPDATE public.accounts AS account
SET cnpj = regexp_replace(profile.cpf_cnpj, '\D', '', 'g')
FROM public.profiles AS profile
WHERE profile.user_id = account.owner_user_id
  AND account.cnpj IS NULL
  AND length(regexp_replace(COALESCE(profile.cpf_cnpj, ''), '\D', '', 'g')) = 14;

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_cnpj_format;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_cnpj_format
  CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$');
