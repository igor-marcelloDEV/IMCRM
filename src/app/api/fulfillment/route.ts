import { NextResponse, after } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { notifyDriver, renderDriverMessage, DEFAULT_DRIVER_NEW_JOB_TEMPLATE } from '@/lib/drivers/notify';

interface ReadyOrderForNotify {
  order_code: string;
  delivery_address_line: string | null;
  delivery_neighborhood: string | null;
  delivery_city: string | null;
}

/** Fire-and-forget WhatsApp ping to every available driver — scheduled via
 *  `after()` so the response isn't held up, but the serverless invocation
 *  stays alive long enough for the sends to actually go out. */
async function notifyAvailableDrivers(db: SupabaseClient, accountId: string, order: ReadyOrderForNotify) {
  const { data: account } = await db
    .from('accounts')
    .select('driver_notify_auto_enabled, driver_message_template, name')
    .eq('id', accountId)
    .maybeSingle();
  if (!account?.driver_notify_auto_enabled) return;

  const { data: drivers } = await db
    .from('delivery_drivers')
    .select('id, phone')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .eq('is_available', true);
  if (!drivers?.length) return;

  const address = [order.delivery_address_line, order.delivery_neighborhood, order.delivery_city]
    .filter(Boolean)
    .join(', ');
  const text = renderDriverMessage(account.driver_message_template || DEFAULT_DRIVER_NEW_JOB_TEMPLATE, {
    pedido: order.order_code,
    endereco: address || 'a combinar',
    loja: account.name ?? '',
  });

  await Promise.all(drivers.map((driver) => notifyDriver(db, accountId, driver, text)));
}

const STATUSES = ['confirmed', 'preparing', 'ready', 'out_for_delivery', 'delivered'] as const;
const STATUS_LABELS: Record<(typeof STATUSES)[number], string> = {
  confirmed: 'Pagamento confirmado',
  preparing: 'Em preparo',
  ready: 'Pronto para entrega',
  out_for_delivery: 'Saiu para entrega',
  delivered: 'Entregue',
};

export async function GET() {
  let ctx;
  try { ctx = await requireRole('agent'); } catch (error) { return toErrorResponse(error); }
  const db = supabaseAdmin();
  const { data: orders, error } = await db
    .from('orders')
    .select('id, order_number, order_code, contact_id, status, fulfillment_status, fulfillment_updated_at, total_cents, currency, created_at, fulfillment_type, assigned_driver_id, delivery_neighborhood, delivery_city')
    .eq('account_id', ctx.accountId)
    .neq('status', 'canceled')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: 'Não foi possível carregar as entregas' }, { status: 500 });

  const orderIds = (orders ?? []).map((order) => order.id);
  const contactIds = (orders ?? []).flatMap((order) => order.contact_id ? [order.contact_id] : []);
  const driverIds = [...new Set((orders ?? []).flatMap((order) => order.assigned_driver_id ? [order.assigned_driver_id] : []))];
  const [{ data: items }, { data: contacts }, { data: drivers }] = await Promise.all([
    orderIds.length ? db.from('order_items').select('order_id, name_snapshot, quantity').in('order_id', orderIds) : Promise.resolve({ data: [] }),
    contactIds.length ? db.from('contacts').select('id, name, phone').in('id', contactIds) : Promise.resolve({ data: [] }),
    driverIds.length ? db.from('delivery_drivers').select('id, name').in('id', driverIds) : Promise.resolve({ data: [] }),
  ]);
  return NextResponse.json({ orders: orders ?? [], items: items ?? [], contacts: contacts ?? [], drivers: drivers ?? [] });
}

export async function PATCH(request: Request) {
  let ctx;
  try { ctx = await requireRole('agent'); } catch (error) { return toErrorResponse(error); }
  const body = await request.json().catch(() => null);
  const orderId = typeof body?.order_id === 'string' ? body.order_id : null;
  const status = STATUSES.find((value) => value === body?.fulfillment_status);
  if (!orderId || !status) return NextResponse.json({ error: 'Andamento inválido' }, { status: 400 });
  const db = supabaseAdmin();
  const { data, error } = await db.from('orders').update({ fulfillment_status: status, fulfillment_updated_at: new Date().toISOString() })
    .eq('id', orderId).eq('account_id', ctx.accountId).eq('status', 'paid')
    .select('id, fulfillment_status, fulfillment_type, order_code, assigned_driver_id, delivery_address_line, delivery_neighborhood, delivery_city')
    .maybeSingle();
  if (error || !data) return NextResponse.json({ error: 'Não foi possível atualizar o pedido' }, { status: 409 });
  await db.rpc('append_activity', {
    p_account_id: ctx.accountId, p_actor_id: ctx.userId, p_event_type: 'order.fulfillment_updated',
    p_entity_type: 'order', p_entity_id: orderId, p_summary: `Andamento do pedido: ${STATUS_LABELS[status]}`, p_order_id: orderId,
  });

  // "Bot" toggle: a fresh, unclaimed delivery job just opened up — ping
  // every available driver so the fastest to open the app claims it,
  // instead of waiting for staff to notice and assign manually.
  if (status === 'ready' && data.fulfillment_type === 'delivery' && !data.assigned_driver_id) {
    after(() => notifyAvailableDrivers(db, ctx.accountId, data));
  }

  return NextResponse.json({ order: data });
}
