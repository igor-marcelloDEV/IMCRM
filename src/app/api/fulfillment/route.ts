import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

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
    .select('id, order_number, order_code, contact_id, status, fulfillment_status, fulfillment_updated_at, total_cents, currency, created_at')
    .eq('account_id', ctx.accountId)
    .neq('status', 'canceled')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: 'Não foi possível carregar as entregas' }, { status: 500 });

  const orderIds = (orders ?? []).map((order) => order.id);
  const contactIds = (orders ?? []).flatMap((order) => order.contact_id ? [order.contact_id] : []);
  const [{ data: items }, { data: contacts }] = await Promise.all([
    orderIds.length ? db.from('order_items').select('order_id, name_snapshot, quantity').in('order_id', orderIds) : Promise.resolve({ data: [] }),
    contactIds.length ? db.from('contacts').select('id, name, phone').in('id', contactIds) : Promise.resolve({ data: [] }),
  ]);
  return NextResponse.json({ orders: orders ?? [], items: items ?? [], contacts: contacts ?? [] });
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
    .eq('id', orderId).eq('account_id', ctx.accountId).eq('status', 'paid').select('id, fulfillment_status').maybeSingle();
  if (error || !data) return NextResponse.json({ error: 'Não foi possível atualizar o pedido' }, { status: 409 });
  await db.rpc('append_activity', {
    p_account_id: ctx.accountId, p_actor_id: ctx.userId, p_event_type: 'order.fulfillment_updated',
    p_entity_type: 'order', p_entity_id: orderId, p_summary: `Andamento do pedido: ${STATUS_LABELS[status]}`, p_order_id: orderId,
  });
  return NextResponse.json({ order: data });
}
