import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  addonsUnitCents,
  insertOrderItemAddons,
  resolveOrderItemAddons,
  type RequestedAddon,
} from '@/lib/orders/order-item-addons';

async function recomputeOrderTotal(dealId: string, orderId: string) {
  const db = supabaseAdmin();
  const { data: items } = await db
    .from('order_items')
    .select('total_cents')
    .eq('order_id', orderId);
  const total = ((items as Array<{ total_cents: number }> | null) ?? []).reduce(
    (s, i) => s + i.total_cents,
    0
  );
  await db
    .from('orders')
    .update({ subtotal_cents: total, total_cents: total })
    .eq('id', orderId);
  await db
    .from('deals')
    .update({ value: total / 100 })
    .eq('id', dealId);
}

async function loadLine(dealId: string, itemId: string) {
  const db = supabaseAdmin();
  const { data: order } = await db
    .from('orders')
    .select('id, account_id, status, gateway_payment_id')
    .eq('deal_id', dealId)
    .maybeSingle();
  if (!order) return null;
  const { data: line } = await db
    .from('order_items')
    .select('id, order_id, catalog_item_id, unit_price_cents, addons:order_item_addons(price_cents_snapshot, quantity)')
    .eq('id', itemId)
    .eq('order_id', order.id)
    .maybeSingle();
  return line ? { order, line } : null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id: dealId, itemId } = await params;
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const quantity = Number(body?.quantity);
  if (!Number.isFinite(quantity) || quantity < 0) {
    return NextResponse.json({ error: 'quantity inválido' }, { status: 400 });
  }
  const hasAddonsUpdate = Array.isArray(body?.add_ons);
  const requestedAddons: RequestedAddon[] = hasAddonsUpdate
    ? body.add_ons
        .filter((a: unknown): a is { addon_id: string; quantity?: number } => typeof (a as { addon_id?: unknown })?.addon_id === 'string')
        .map((a: { addon_id: string; quantity?: number }) => ({ addon_id: a.addon_id, quantity: a.quantity }))
    : [];

  const db = supabaseAdmin();
  const { data: deal } = await db
    .from('deals')
    .select('id')
    .eq('id', dealId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!deal)
    return NextResponse.json(
      { error: 'Negócio não encontrado' },
      { status: 404 }
    );

  const found = await loadLine(dealId, itemId);
  if (!found)
    return NextResponse.json({ error: 'Item não encontrado' }, { status: 404 });
  if (
    found.order.status !== 'pending_payment' ||
    found.order.gateway_payment_id
  ) {
    return NextResponse.json(
      {
        error:
          'Itens de um pedido finalizado ou já cobrado não podem ser alterados',
      },
      { status: 409 }
    );
  }

  if (quantity === 0) {
    await db.from('order_items').delete().eq('id', itemId);
  } else if (hasAddonsUpdate) {
    if (!found.line.catalog_item_id) {
      return NextResponse.json({ error: 'Este item não tem mais um produto de catálogo vinculado.' }, { status: 400 });
    }
    const resolved = await resolveOrderItemAddons(db, found.line.catalog_item_id, requestedAddons);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    await db.from('order_item_addons').delete().eq('order_item_id', itemId);
    await insertOrderItemAddons(db, itemId, resolved.addons);
    await db
      .from('order_items')
      .update({ quantity, total_cents: quantity * (found.line.unit_price_cents + addonsUnitCents(resolved.addons)) })
      .eq('id', itemId);
  } else {
    const existingAddonsUnitCents = (found.line.addons ?? []).reduce(
      (sum: number, a: { price_cents_snapshot: number; quantity: number }) => sum + a.price_cents_snapshot * a.quantity,
      0,
    );
    await db
      .from('order_items')
      .update({ quantity, total_cents: quantity * (found.line.unit_price_cents + existingAddonsUnitCents) })
      .eq('id', itemId);
  }

  await recomputeOrderTotal(dealId, found.order.id);

  const { data: finalItems } = await db
    .from('order_items')
    .select('*, addons:order_item_addons(*)')
    .eq('order_id', found.order.id)
    .order('created_at', { ascending: true });
  return NextResponse.json({
    order_id: found.order.id,
    items: finalItems ?? [],
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; itemId: string }> }
) {
  const { id: dealId, itemId } = await params;
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const db = supabaseAdmin();
  const { data: deal } = await db
    .from('deals')
    .select('id')
    .eq('id', dealId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!deal)
    return NextResponse.json(
      { error: 'Negócio não encontrado' },
      { status: 404 }
    );

  const found = await loadLine(dealId, itemId);
  if (!found)
    return NextResponse.json({ error: 'Item não encontrado' }, { status: 404 });
  if (
    found.order.status !== 'pending_payment' ||
    found.order.gateway_payment_id
  ) {
    return NextResponse.json(
      {
        error:
          'Itens de um pedido finalizado ou já cobrado não podem ser alterados',
      },
      { status: 409 }
    );
  }

  await db.from('order_items').delete().eq('id', itemId);
  await recomputeOrderTotal(dealId, found.order.id);

  const { data: finalItems } = await db
    .from('order_items')
    .select('*')
    .eq('order_id', found.order.id)
    .order('created_at', { ascending: true });
  return NextResponse.json({
    order_id: found.order.id,
    items: finalItems ?? [],
  });
}
