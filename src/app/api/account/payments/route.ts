import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { encrypt } from "@/lib/whatsapp/encryption";

// The tenant's OWN Asaas account — used to charge THEIR WhatsApp
// customers via the `checkout` Flow node. Separate from the
// platform's ASAAS_API_KEY (IMCRM's own billing, migration 041).
//
// GET never returns the encrypted API key itself, only whether one is
// on file — same "connected: true/false, never the secret" shape as
// /api/whatsapp/config. `webhook_token` IS returned — the tenant needs
// it to paste into their own Asaas dashboard (Integrations → Webhooks
// → Authentication token), so it's tenant-facing by design rather
// than a platform-only secret.

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("tenant_payment_configs")
      .select("asaas_env, municipal_service_id, municipal_service_name, nfe_enabled, encrypted_asaas_api_key, webhook_token")
      .eq("account_id", accountId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({
      config: {
        connected: !!data?.encrypted_asaas_api_key,
        asaas_env: data?.asaas_env ?? "sandbox",
        municipal_service_id: data?.municipal_service_id ?? null,
        municipal_service_name: data?.municipal_service_name ?? null,
        nfe_enabled: data?.nfe_enabled ?? false,
        webhook_token: data?.webhook_token ?? null,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

  const update: Record<string, unknown> = { account_id: ctx.accountId };

  if (typeof body.api_key === "string" && body.api_key.trim()) {
    update.encrypted_asaas_api_key = encrypt(body.api_key.trim());
  }
  if (body.asaas_env === "sandbox" || body.asaas_env === "production") {
    update.asaas_env = body.asaas_env;
  }
  if (typeof body.municipal_service_id === "string" && typeof body.municipal_service_name === "string") {
    update.municipal_service_id = body.municipal_service_id || null;
    update.municipal_service_name = body.municipal_service_name || null;
  }

  // First time this tenant saves ANY payment config — mint the
  // webhook token now so it's ready to paste into Asaas immediately,
  // rather than a separate "generate" step.
  const { data: existing } = await supabaseAdmin()
    .from("tenant_payment_configs")
    .select("webhook_token, municipal_service_id")
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!existing?.webhook_token) {
    update.webhook_token = randomBytes(24).toString("hex");
  }

  if (typeof body.nfe_enabled === "boolean") {
    // Never let NFe issuance turn on without a municipal service
    // picked — the webhook would otherwise call scheduleInvoice()
    // with nothing to bill under.
    const hasService = (update.municipal_service_id ?? existing?.municipal_service_id) != null;
    if (body.nfe_enabled && !hasService) {
      return NextResponse.json(
        { error: "Busque e selecione um serviço municipal antes de habilitar a emissão automática." },
        { status: 400 },
      );
    }
    update.nfe_enabled = body.nfe_enabled;
  }

  const { error } = await supabaseAdmin()
    .from("tenant_payment_configs")
    .upsert(update, { onConflict: "account_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
