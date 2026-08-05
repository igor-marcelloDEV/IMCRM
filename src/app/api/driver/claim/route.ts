import { createHash, randomInt } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { getCurrentDriver } from '@/lib/drivers/auth';

/** Driver self-service claim on an open delivery job — the "Uber accept"
 *  action. The `.is('assigned_driver_id', null)` guard on the UPDATE makes
 *  the claim atomic: if two drivers tap "Aceitar" on the same order within
 *  milliseconds, only the first UPDATE matches a row; the second gets 0 rows
 *  back and surfaces as a 409. */
export async function POST(request: Request) {
  const driver = await getCurrentDriver();
  if (!driver) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const orderId = typeof body?.order_id === 'string' ? body.order_id : '';
  const timeSlotId = typeof body?.time_slot_id === 'string' ? body.time_slot_id : null;
  if (!orderId) return NextResponse.json({ error: 'Pedido inválido.' }, { status: 400 });

  const db = supabaseAdmin();

  let agreedAt: string | null = null;
  if (timeSlotId) {
    const { data: slot } = await db
      .from('delivery_time_slots')
      .select('start_time')
      .eq('id', timeSlotId)
      .eq('account_id', driver.account_id)
      .eq('is_active', true)
      .maybeSingle();
    if (!slot) return NextResponse.json({ error: 'Horário inválido.' }, { status: 400 });
    const today = new Date().toISOString().slice(0, 10);
    agreedAt = new Date(`${today}T${slot.start_time}`).toISOString();
  }

  const code = String(randomInt(1000, 10000));
  const codeHash = createHash('sha256').update(`${orderId}:${code}`).digest('hex');

  const { data: order, error } = await db
    .from('orders')
    .update({
      assigned_driver_id: driver.id,
      delivery_code_hash: codeHash,
      delivery_code_last4: code,
      delivery_assigned_at: new Date().toISOString(),
      driver_agreed_pickup_at: agreedAt,
    })
    .eq('id', orderId)
    .eq('account_id', driver.account_id)
    .eq('fulfillment_type', 'delivery')
    .eq('fulfillment_status', 'ready')
    .is('assigned_driver_id', null)
    .select('id,order_code')
    .maybeSingle();

  if (error || !order) {
    return NextResponse.json({ error: 'Essa corrida já foi aceita por outro entregador.' }, { status: 409 });
  }
  return NextResponse.json({ order, confirmation_code: code });
}
