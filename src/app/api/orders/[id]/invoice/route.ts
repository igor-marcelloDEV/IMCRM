import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { getTenantAsaasConfig, getInvoice } from "@/lib/orders/tenant-asaas";

/**
 * GET /api/orders/[id]/invoice
 *
 * Backs the "Ver NF" button on a paid order/deal — Asaas issues the
 * NFS-e asynchronously after `scheduleInvoice` (orders webhook), so
 * the PDF isn't ready at payment time. This fetches Asaas's CURRENT
 * view of the invoice on every click rather than caching a status.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: orderId } = await params;
  let ctx;
  try {
    ctx = await requireRole("viewer");
  } catch (err) {
    return toErrorResponse(err);
  }

  const db = supabaseAdmin();
  const { data: order } = await db
    .from("orders")
    .select("id, invoice_id, invoice_status")
    .eq("id", orderId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!order) {
    return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
  }
  if (!order.invoice_id) {
    return NextResponse.json(
      { error: "Este pedido ainda não tem nota fiscal agendada" },
      { status: 404 },
    );
  }

  const config = await getTenantAsaasConfig(db, ctx.accountId);
  if (!config) {
    return NextResponse.json(
      { error: "Configuração de pagamentos da conta não encontrada" },
      { status: 404 },
    );
  }

  try {
    const invoice = await getInvoice(config, order.invoice_id);
    if (invoice.status !== order.invoice_status) {
      await db
        .from("orders")
        .update({ invoice_status: invoice.status })
        .eq("id", orderId);
    }
    return NextResponse.json({
      status: invoice.status,
      pdf_url: invoice.pdfUrl,
      nfe_number: invoice.nfeNumber ?? null,
      observations: invoice.observations ?? null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Falha ao consultar a Asaas";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
