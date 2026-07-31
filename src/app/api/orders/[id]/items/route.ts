import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

// Order-scoped counterpart of /api/deals/[id]/items — same "attach a
// catalog item, keep the total in lockstep" logic, but for a comanda
// that may have no deal at all (a counter sale). When the order DOES
// have a deal_id, the deal's `value` is kept in sync too, so a deal
// opened from the Funil and one opened as a comanda behave the same
// way either way items got added.
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

export async function POST(
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
  const catalogItemId = typeof body?.catalog_item_id === "string" ? body.catalog_item_id : null;
  if (!catalogItemId) {
    return NextResponse.json({ error: "catalog_item_id é obrigatório" }, { status: 400 });
  }

  const db = supabaseAdmin();

  const { data: order } = await db
    .from("orders")
    .select("id, status, gateway_payment_id, contact_id")
    .eq("id", orderId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!order) {
    return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
  }
  if (order.status !== "pending_payment" || order.gateway_payment_id) {
    return NextResponse.json(
      { error: "Itens de um pedido finalizado ou já cobrado não podem ser alterados" },
      { status: 409 },
    );
  }

  const { data: item } = await db
    .from("catalog_items")
    .select("id, name, price_cents, stock_quantity")
    .eq("id", catalogItemId)
    .eq("account_id", ctx.accountId)
    .eq("is_active", true)
    .maybeSingle();
  if (!item) {
    return NextResponse.json({ error: "Item do catálogo não encontrado" }, { status: 404 });
  }

  // Atomic, race-safe decrement: only succeeds if there's still enough
  // stock at the moment of the write. NULL (not tracked) rows are
  // untouched by the `.eq("stock_quantity", ...)` filter never matching
  // — handled by the `item.stock_quantity !== null` branch below instead.
  if (item.stock_quantity !== null) {
    if (item.stock_quantity < 1) {
      return NextResponse.json({ error: "Item sem estoque disponível" }, { status: 409 });
    }
    const { data: decremented } = await db
      .from("catalog_items")
      .update({ stock_quantity: item.stock_quantity - 1 })
      .eq("id", item.id)
      .eq("stock_quantity", item.stock_quantity)
      .select("id")
      .maybeSingle();
    if (!decremented) {
      return NextResponse.json({ error: "Item sem estoque disponível" }, { status: 409 });
    }
  }

  const { data: existingLine } = await db
    .from("order_items")
    .select("id, quantity")
    .eq("order_id", orderId)
    .eq("catalog_item_id", item.id)
    .maybeSingle();

  if (existingLine) {
    const quantity = existingLine.quantity + 1;
    await db
      .from("order_items")
      .update({ quantity, total_cents: quantity * item.price_cents })
      .eq("id", existingLine.id);
  } else {
    await db.from("order_items").insert({
      order_id: orderId,
      catalog_item_id: item.id,
      name_snapshot: item.name,
      quantity: 1,
      unit_price_cents: item.price_cents,
      total_cents: item.price_cents,
    });
  }

  await recomputeOrderTotal(db, orderId);

  const { error: activityError } = await db.rpc("append_activity", {
    p_account_id: ctx.accountId,
    p_actor_id: ctx.userId,
    p_event_type: "order.item_added",
    p_entity_type: "order",
    p_entity_id: orderId,
    p_summary: `1x ${item.name} adicionado`,
    p_order_id: orderId,
    p_contact_id: order.contact_id,
  });
  if (activityError) console.error("[POST /api/orders/[id]/items] append_activity error:", activityError);

  const { data: finalItems } = await db
    .from("order_items")
    .select("*")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  return NextResponse.json({ order_id: orderId, items: finalItems ?? [] });
}
