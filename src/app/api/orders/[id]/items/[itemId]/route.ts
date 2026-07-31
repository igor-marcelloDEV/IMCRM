import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

async function recomputeOrderTotal(db: ReturnType<typeof supabaseAdmin>, orderId: string) {
  const { data: items } = await db
    .from("order_items")
    .select("total_cents")
    .eq("order_id", orderId);
  const total = ((items as Array<{ total_cents: number }> | null) ?? []).reduce(
    (s, i) => s + i.total_cents,
    0,
  );
  const { data: order } = await db
    .from("orders")
    .update({ subtotal_cents: total, total_cents: total })
    .eq("id", orderId)
    .select("deal_id")
    .maybeSingle();
  if (order?.deal_id) {
    await db.from("deals").update({ value: total / 100 }).eq("id", order.deal_id);
  }
  return total;
}

async function loadLine(db: ReturnType<typeof supabaseAdmin>, orderId: string, itemId: string) {
  const { data: line } = await db
    .from("order_items")
    .select("id, order_id, unit_price_cents")
    .eq("id", itemId)
    .eq("order_id", orderId)
    .maybeSingle();
  return line;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  const { id: orderId, itemId } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const quantity = Number(body?.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) {
    return NextResponse.json({ error: "quantity inválido" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: order } = await db
    .from("orders")
    .select("id, status, gateway_payment_id")
    .eq("id", orderId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!order) return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
  if (order.status !== "pending_payment" || order.gateway_payment_id) {
    return NextResponse.json(
      { error: "Itens de um pedido finalizado ou já cobrado não podem ser alterados" },
      { status: 409 },
    );
  }

  const line = await loadLine(db, orderId, itemId);
  if (!line) return NextResponse.json({ error: "Item não encontrado" }, { status: 404 });

  if (quantity === 0) {
    await db.from("order_items").delete().eq("id", itemId);
  } else {
    await db
      .from("order_items")
      .update({ quantity, total_cents: quantity * line.unit_price_cents })
      .eq("id", itemId);
  }

  await recomputeOrderTotal(db, orderId);

  const { data: finalItems } = await db
    .from("order_items")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  return NextResponse.json({ order_id: orderId, items: finalItems ?? [] });
}
