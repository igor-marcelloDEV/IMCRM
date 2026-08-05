import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  addonsUnitCents,
  insertOrderItemAddons,
  resolveOrderItemAddons,
  type RequestedAddon,
} from "@/lib/orders/order-item-addons";

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
    .select("id, order_id, catalog_item_id, quantity, unit_price_cents, addons:order_item_addons(price_cents_snapshot, quantity)")
    .eq("id", itemId)
    .eq("order_id", orderId)
    .maybeSingle();
  return line;
}

// Positive `delta` reserves stock (checked, can fail); negative `delta`
// returns stock (always succeeds). No-ops for items with no
// catalog_item_id (deleted from the catalog since) or untracked stock.
async function adjustStock(
  db: ReturnType<typeof supabaseAdmin>,
  catalogItemId: string | null,
  delta: number,
): Promise<{ ok: true } | { ok: false }> {
  if (!catalogItemId || delta === 0) return { ok: true };

  const { data: item } = await db
    .from("catalog_items")
    .select("id, stock_quantity")
    .eq("id", catalogItemId)
    .maybeSingle();
  if (!item || item.stock_quantity === null) return { ok: true };

  const next = item.stock_quantity - delta;
  if (next < 0) return { ok: false };

  const { data: updated } = await db
    .from("catalog_items")
    .update({ stock_quantity: next })
    .eq("id", item.id)
    .eq("stock_quantity", item.stock_quantity)
    .select("id")
    .maybeSingle();
  return updated ? { ok: true } : { ok: false };
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
  const hasAddonsUpdate = Array.isArray(body?.add_ons);
  const requestedAddons: RequestedAddon[] = hasAddonsUpdate
    ? body.add_ons
        .filter((a: unknown): a is { addon_id: string; quantity?: number } => typeof (a as { addon_id?: unknown })?.addon_id === "string")
        .map((a: { addon_id: string; quantity?: number }) => ({ addon_id: a.addon_id, quantity: a.quantity }))
    : [];

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

  const delta = quantity - line.quantity;
  const stockResult = await adjustStock(db, line.catalog_item_id, delta);
  if (!stockResult.ok) {
    return NextResponse.json({ error: "Item sem estoque disponível" }, { status: 409 });
  }

  if (quantity === 0) {
    await db.from("order_items").delete().eq("id", itemId);
  } else if (hasAddonsUpdate) {
    if (!line.catalog_item_id) {
      return NextResponse.json({ error: "Este item não tem mais um produto de catálogo vinculado." }, { status: 400 });
    }
    const resolved = await resolveOrderItemAddons(db, line.catalog_item_id, requestedAddons);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    await db.from("order_item_addons").delete().eq("order_item_id", itemId);
    await insertOrderItemAddons(db, itemId, resolved.addons);
    await db
      .from("order_items")
      .update({ quantity, total_cents: quantity * (line.unit_price_cents + addonsUnitCents(resolved.addons)) })
      .eq("id", itemId);
  } else {
    const existingAddonsUnitCents = (line.addons ?? []).reduce(
      (sum: number, a: { price_cents_snapshot: number; quantity: number }) => sum + a.price_cents_snapshot * a.quantity,
      0,
    );
    await db
      .from("order_items")
      .update({ quantity, total_cents: quantity * (line.unit_price_cents + existingAddonsUnitCents) })
      .eq("id", itemId);
  }

  await recomputeOrderTotal(db, orderId);

  const { data: finalItems } = await db
    .from("order_items")
    .select("*, addons:order_item_addons(*)")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });
  return NextResponse.json({ order_id: orderId, items: finalItems ?? [] });
}
