import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

/**
 * POST /api/orders — open a comanda directly from the dashboard,
 * independent of the WhatsApp checkout Flow (`source: 'manual'`).
 * Deliberately NOT tied to a deal — "a comanda is just an open order"
 * (see the Comandas v1 scope in docs/architecture.md), so a counter
 * sale doesn't force a pipeline entry that means nothing for it.
 */
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const contactId = typeof body?.contact_id === "string" ? body.contact_id : null;
  if (!contactId) {
    return NextResponse.json({ error: "contact_id é obrigatório" }, { status: 400 });
  }

  const db = supabaseAdmin();

  const { data: contact } = await db
    .from("contacts")
    .select("id, name, phone")
    .eq("id", contactId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contato não encontrado" }, { status: 404 });
  }

  const { data: order, error } = await db
    .from("orders")
    .insert({
      account_id: ctx.accountId,
      contact_id: contact.id,
      status: "pending_payment",
      source: "manual",
      subtotal_cents: 0,
      total_cents: 0,
      currency: "BRL",
    })
    .select("*")
    .single();

  if (error || !order) {
    console.error("[POST /api/orders] insert error:", error);
    return NextResponse.json({ error: "Não foi possível abrir a comanda" }, { status: 500 });
  }

  return NextResponse.json({ order });
}
