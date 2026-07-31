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
  const { data, error } = await db
    .from("tenant_payment_configs")
    .select("encrypted_asaas_api_key, asaas_env")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Não foi possível carregar a configuração Asaas da conta: ${error.message}`,
    );
  }
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

// ============================================================
// Nota Fiscal (NFS-e) — a second, separate Asaas API surface from
// payments. Deliberately NOT added to src/lib/billing/asaas.ts (the
// platform's own billing client never touches invoices), so this
// module carries its own tiny fetch wrapper rather than exporting
// asaasFetch out of that file for one extra caller.
//
// IMCRM does NOT reimplement Asaas's fiscal-registration flow
// (POST /fiscalInfo — email, Simples Nacional flag, municipal
// inscription, sometimes a digital certificate upload). That's
// municipality-specific and the tenant does it once, directly in
// their own Asaas dashboard. This module only consumes what's
// already configured there: listing the municipal services the
// tenant can bill under, and scheduling an invoice once payment is
// confirmed.
// ============================================================

function baseUrl(env: AsaasEnv): string {
  return env === "production" ? "https://api.asaas.com/v3" : "https://sandbox.asaas.com/api/v3";
}

async function nfeFetch<T>(config: AsaasClientConfig, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl(config.env)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      access_token: config.apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    let message = `Asaas API error: ${response.status}`;
    try {
      const data = (await response.json()) as { errors?: Array<{ description?: string }> };
      const first = data.errors?.[0];
      if (first?.description) message = first.description;
    } catch {
      // response body wasn't JSON — keep the fallback
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export interface AsaasMunicipalService {
  id: string;
  municipalServiceCode: string;
  municipalServiceName: string;
}

/**
 * Requires the tenant to have ALREADY completed fiscal registration
 * on their own Asaas account — if they haven't, this throws (Asaas
 * responds with a 400 explaining what's missing), which callers
 * surface as-is; there's nothing IMCRM can do to complete that
 * registration on the tenant's behalf.
 */
export async function listMunicipalServices(
  config: AsaasClientConfig,
  description?: string,
): Promise<AsaasMunicipalService[]> {
  const qs = description ? `?description=${encodeURIComponent(description)}` : "";
  const res = await nfeFetch<{ data: AsaasMunicipalService[] }>(config, `/invoices/municipalServices${qs}`);
  return res.data;
}

export interface ScheduleInvoiceArgs {
  config: AsaasClientConfig;
  /** Asaas payment id (the PIX charge just confirmed) to attach the invoice to. */
  paymentId: string;
  /** Reais, not cents. */
  value: number;
  municipalServiceId: string;
  municipalServiceName: string;
  serviceDescription: string;
  /** YYYY-MM-DD. Asaas issues on this date, not immediately. */
  effectiveDate: string;
  /**
   * Municipality/tax-regime-specific — Asaas requires SOME shape here
   * but the exact fields vary enough (retention rules, Simples
   * Nacional vs not) that there's no universal default guaranteed to
   * be correct. `{ retainIss: false }` covers the common small-
   * business case; a tenant whose municipality needs something else
   * sets `tenant_payment_configs.default_taxes` and that overrides
   * this fallback (see the caller in the orders webhook).
   */
  taxes?: Record<string, unknown>;
}

export async function scheduleInvoice(
  args: ScheduleInvoiceArgs,
): Promise<{ id: string; status: string }> {
  return nfeFetch(args.config, "/invoices", {
    method: "POST",
    body: JSON.stringify({
      payment: args.paymentId,
      serviceDescription: args.serviceDescription,
      observations: args.serviceDescription,
      value: args.value,
      deductions: 0,
      effectiveDate: args.effectiveDate,
      municipalServiceId: args.municipalServiceId,
      municipalServiceName: args.municipalServiceName,
      taxes: args.taxes ?? { retainIss: false },
    }),
  });
}

export interface AsaasInvoice {
  id: string;
  status: string;
  /** Null until the city authorizes the NFS-e — issuance is async on
   *  Asaas's side, so this can take minutes to days after scheduling. */
  pdfUrl: string | null;
  nfeNumber?: string | null;
  validationCode?: string | null;
  /** Present when status is 'AUTHORIZATION_ERROR' or similar. */
  observations?: string | null;
}

/**
 * Fetches the CURRENT state of a scheduled invoice — called on-demand
 * from the "Ver NF" button rather than cached, since authorization
 * happens asynchronously on Asaas's/the city's side after
 * `scheduleInvoice` returns.
 */
export async function getInvoice(
  config: AsaasClientConfig,
  invoiceId: string,
): Promise<AsaasInvoice> {
  return nfeFetch(config, `/invoices/${invoiceId}`);
}
