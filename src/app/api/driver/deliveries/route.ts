import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { getCurrentDriver } from '@/lib/drivers/auth';

export async function GET() {
  const driver = await getCurrentDriver();
  if (!driver) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  const db = supabaseAdmin();
  const { data: orders } = await db.from('orders').select('id,order_code,fulfillment_status,total_cents,currency,delivery_assigned_at,contact_id').eq('assigned_driver_id', driver.id).eq('status','paid').in('fulfillment_status',['ready','out_for_delivery']).order('delivery_assigned_at');
  const contactIds = (orders ?? []).flatMap((o) => o.contact_id ? [o.contact_id] : []);
  const { data: contacts } = contactIds.length ? await db.from('contacts').select('id,name,phone,delivery_address').in('id', contactIds) : { data: [] };
  return NextResponse.json({ driver: { name: driver.name, vehicle_type: driver.vehicle_type, is_available: driver.is_available }, orders: orders ?? [], contacts: contacts ?? [] });
}

export async function PATCH(request: Request) {
  const driver = await getCurrentDriver();
  if (!driver) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  const body = await request.json().catch(() => null);
  const db = supabaseAdmin();
  if (body?.action === 'availability') {
    const isAvailable = body?.is_available === true;
    const { error } = await db.from('delivery_drivers').update({ is_available: isAvailable, updated_at: new Date().toISOString() }).eq('id', driver.id);
    if (error) return NextResponse.json({ error: 'Não foi possível atualizar sua disponibilidade.' }, { status: 500 });
    return NextResponse.json({ is_available: isAvailable });
  }
  const { data: order } = await db.from('orders').select('id,fulfillment_status,delivery_code_hash').eq('id',body?.order_id).eq('assigned_driver_id',driver.id).eq('status','paid').maybeSingle();
  if (!order) return NextResponse.json({ error: 'Entrega não encontrada.' }, { status: 404 });
  if (body?.action === 'start' && order.fulfillment_status === 'ready') {
    await db.from('orders').update({ fulfillment_status:'out_for_delivery', delivery_picked_up_at:new Date().toISOString(), fulfillment_updated_at:new Date().toISOString() }).eq('id',order.id);
    return NextResponse.json({ status:'out_for_delivery' });
  }
  if (body?.action === 'complete' && order.fulfillment_status === 'out_for_delivery') {
    const code = typeof body?.code === 'string' ? body.code.replace(/\D/g,'') : '';
    const actual = createHash('sha256').update(`${order.id}:${code}`).digest();
    const expected = Buffer.from(order.delivery_code_hash || '', 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) return NextResponse.json({ error: 'Código de confirmação incorreto.' }, { status: 400 });
    await db.from('orders').update({ fulfillment_status:'delivered', delivery_completed_at:new Date().toISOString(), fulfillment_updated_at:new Date().toISOString() }).eq('id',order.id);
    return NextResponse.json({ status:'delivered' });
  }
  return NextResponse.json({ error:'Ação indisponível para o andamento atual.' }, { status:409 });
}
