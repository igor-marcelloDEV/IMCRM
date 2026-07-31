import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

/**
 * PATCH /api/orders/[id] — notes and cancellation. Never touches
 * status='paid' orders' items/total (immutability is enforced by the
 * items route's own check); this route only ever moves a comanda to
 * 'canceled' or edits its free-text notes.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: orderId } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Corpo da requisição inválido" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: order } = await db
    .from("orders")
    .select("id, status")
    .eq("id", orderId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!order) {
    return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
  }

  const update: Record<string, unknown> = {};

  if ("notes" in body) {
    if (body.notes !== null && typeof body.notes !== "string") {
      return NextResponse.json({ error: "'notes' deve ser string ou null" }, { status: 400 });
    }
    update.notes = body.notes;
  }

  if ("status" in body) {
    if (body.status !== "canceled") {
      return NextResponse.json(
        { error: "Esta rota só permite cancelar (status: 'canceled')" },
        { status: 400 },
      );
    }
    if (order.status === "paid") {
      return NextResponse.json(
        { error: "Um pedido já pago não pode ser cancelado por aqui" },
        { status: 409 },
      );
    }
    update.status = "canceled";
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nada para atualizar" }, { status: 400 });
  }

  const { data: updated, error } = await db
    .from("orders")
    .update(update)
    .eq("id", orderId)
    .select("*")
    .single();
  if (error || !updated) {
    console.error("[PATCH /api/orders/[id]] update error:", error);
    return NextResponse.json({ error: "Não foi possível atualizar o pedido" }, { status: 500 });
  }

  return NextResponse.json({ order: updated });
}
