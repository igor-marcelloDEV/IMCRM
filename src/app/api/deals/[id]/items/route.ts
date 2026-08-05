import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  addonsUnitCents,
  applyAddonsToOtherLines,
  computeAddonsSignature,
  findMatchingOrderLine,
  insertOrderItemAddons,
  resolveOrderItemAddons,
  type RequestedAddon,
} from '@/lib/orders/order-item-addons';

// Attaches catalog items to a Deal so its value can be built from the
// same product catalog the checkout Flow node sells from, instead of
// a hand-typed number — same "orders + order_items" schema (migration
// 046), just created manually here rather than by a WhatsApp
// checkout. Locked to service-role writes (see migration 046's RLS
// notes), hence a route rather than a direct client insert.

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
  // Keep the Deal's value in lockstep — it's the number shown on the
  // kanban card and everywhere else in the pipeline UI.
  await db
    .from('deals')
    .update({ value: total / 100 })
    .eq('id', dealId);
  return total;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: dealId } = await params;
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  const catalogItemId =
    typeof body?.catalog_item_id === 'string' ? body.catalog_item_id : null;
  if (!catalogItemId) {
    return NextResponse.json(
      { error: 'catalog_item_id é obrigatório' },
      { status: 400 }
    );
  }
  const requestedAddons: RequestedAddon[] = Array.isArray(body?.add_ons)
    ? body.add_ons
        .filter((a: unknown): a is { addon_id: string; quantity?: number } => typeof (a as { addon_id?: unknown })?.addon_id === 'string')
        .map((a: { addon_id: string; quantity?: number }) => ({ addon_id: a.addon_id, quantity: a.quantity }))
    : [];
  const applyToAll = body?.apply_to_all === true;
  const clientRequestId = typeof body?.client_request_id === 'string' ? body.client_request_id : null;

  const db = supabaseAdmin();

  const { data: deal } = await db
    .from('deals')
    .select('id, contact_id, currency')
    .eq('id', dealId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!deal)
    return NextResponse.json(
      { error: 'Negócio não encontrado' },
      { status: 404 }
    );
  if (!deal.contact_id) {
    return NextResponse.json(
      { error: 'Este negócio não tem um contato vinculado' },
      { status: 400 }
    );
  }

  const { data: item } = await db
    .from('catalog_items')
    .select('id, name, price_cents')
    .eq('id', catalogItemId)
    .eq('account_id', ctx.accountId)
    .eq('is_active', true)
    .maybeSingle();
  if (!item)
    return NextResponse.json(
      { error: 'Item do catálogo não encontrado' },
      { status: 404 }
    );

  let { data: order } = await db
    .from('orders')
    .select('id, status, gateway_payment_id')
    .eq('deal_id', dealId)
    .maybeSingle();
  if (
    order &&
    (order.status !== 'pending_payment' || order.gateway_payment_id)
  ) {
    return NextResponse.json(
      {
        error:
          'Itens de um pedido finalizado ou já cobrado não podem ser alterados',
      },
      { status: 409 }
    );
  }
  if (!order) {
    const { data: created, error } = await db
      .from('orders')
      .insert({
        account_id: ctx.accountId,
        contact_id: deal.contact_id,
        deal_id: dealId,
        status: 'pending_payment',
        subtotal_cents: 0,
        total_cents: 0,
        currency: deal.currency || 'BRL',
      })
      .select('id, status, gateway_payment_id')
      .maybeSingle();
    if (error || !created) {
      return NextResponse.json(
        { error: error?.message ?? 'Não foi possível criar o pedido' },
        { status: 500 }
      );
    }
    order = created;
  }

  if (clientRequestId) {
    const { data: alreadyApplied } = await db
      .from('order_items')
      .select('id')
      .eq('order_id', order.id)
      .eq('client_request_id', clientRequestId)
      .maybeSingle();
    if (alreadyApplied) {
      const { data: finalItems } = await db
        .from('order_items')
        .select('*, addons:order_item_addons(*)')
        .eq('order_id', order.id)
        .order('created_at', { ascending: true });
      return NextResponse.json({ order_id: order.id, items: finalItems ?? [] });
    }
  }

  const resolved = await resolveOrderItemAddons(db, item.id, requestedAddons);
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
  const extraUnitCents = addonsUnitCents(resolved.addons);
  const signature = computeAddonsSignature(
    resolved.addons.map((a) => ({ catalog_item_addon_id: a.catalog_item_addon_id, quantity: a.quantity })),
  );

  const existingLine = clientRequestId ? null : await findMatchingOrderLine(db, order.id, item.id, signature);
  let touchedLineId: string;

  if (existingLine) {
    const quantity = existingLine.quantity + 1;
    await db
      .from('order_items')
      .update({ quantity, total_cents: quantity * (existingLine.unit_price_cents + extraUnitCents) })
      .eq('id', existingLine.id);
    touchedLineId = existingLine.id;
  } else {
    const { data: newLine } = await db
      .from('order_items')
      .insert({
        order_id: order.id,
        catalog_item_id: item.id,
        name_snapshot: item.name,
        quantity: 1,
        unit_price_cents: item.price_cents,
        total_cents: item.price_cents + extraUnitCents,
        client_request_id: clientRequestId,
      })
      .select('id')
      .single();
    touchedLineId = newLine!.id;
    await insertOrderItemAddons(db, touchedLineId, resolved.addons);
  }

  if (applyToAll) {
    await applyAddonsToOtherLines(db, order.id, touchedLineId, resolved.addons);
  }

  await recomputeOrderTotal(dealId, order.id);

  const { data: finalItems } = await db
    .from('order_items')
    .select('*, addons:order_item_addons(*)')
    .eq('order_id', order.id)
    .order('created_at', { ascending: true });
  return NextResponse.json({ order_id: order.id, items: finalItems ?? [] });
}
