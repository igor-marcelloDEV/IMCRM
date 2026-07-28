import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/lib/whatsapp/encryption";
import type { AsaasClientConfig, AsaasEnv } from "@/lib/billing/asaas";

/**
 * Resolves a TENANT's own Asaas credentials — separate from
 * `getAsaasConfig()` in `src/lib/billing/asaas.ts`, which only reads
 * the platform's `ASAAS_API_KEY` env var (used to charge accounts for
 * IMCRM itself). Every function in asaas.ts takes an explicit
 * `AsaasClientConfig`, so this just builds one from the decrypted
 * per-tenant key and passes it into the exact same client — no
 * changes needed there.
 *
 * Returns `null` when the tenant hasn't configured (or has corrupted)
 * a key — callers treat that as "payment collection isn't wired up
 * for this tenant yet" and degrade gracefully rather than throwing.
 */
export async function getTenantAsaasConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<AsaasClientConfig | null> {
  const { data } = await db
    .from("tenant_payment_configs")
    .select("encrypted_asaas_api_key, asaas_env")
    .eq("account_id", accountId)
    .maybeSingle();
  const row = data as { encrypted_asaas_api_key: string | null; asaas_env: AsaasEnv } | null;
  if (!row?.encrypted_asaas_api_key) return null;

  try {
    const apiKey = decrypt(row.encrypted_asaas_api_key);
    return { apiKey, env: row.asaas_env ?? "sandbox" };
  } catch (err) {
    console.error(`[orders] failed to decrypt Asaas key for account ${accountId}:`, err);
    return null;
  }
}
