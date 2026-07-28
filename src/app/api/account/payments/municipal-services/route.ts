import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { getTenantAsaasConfig, listMunicipalServices } from "@/lib/orders/tenant-asaas";

// "Buscar configuração municipal" in the Payments tab — lists the
// municipal services the tenant can bill under. Requires the tenant
// to have ALREADY completed fiscal registration directly in their own
// Asaas dashboard (POST /fiscalInfo, municipality-specific — IMCRM
// doesn't reimplement that). A tenant who hasn't done this yet gets
// Asaas's own error message back verbatim, which is the clearest
// available pointer to what's missing.

export async function GET(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const config = await getTenantAsaasConfig(ctx.supabase, ctx.accountId);
  if (!config) {
    return NextResponse.json({ error: "Configure sua API key da Asaas antes de buscar os serviços municipais." }, { status: 400 });
  }

  const description = new URL(request.url).searchParams.get("q") ?? undefined;

  try {
    const services = await listMunicipalServices(config, description);
    return NextResponse.json({ services });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Não foi possível buscar os serviços municipais.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
