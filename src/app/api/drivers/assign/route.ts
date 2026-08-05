import { createHash, randomInt } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = await request.json().catch(() => null);
    const code = String(randomInt(1000, 10000));
    const codeHash = createHash('sha256').update(`${body?.order_id}:${code}`).digest('hex');
    const db = supabaseAdmin();
    const { data: driver } = await db.from('delivery_drivers').select('id').eq('id', body?.driver_id).eq('account_id', ctx.accountId).eq('status','active').maybeSingle();
    if (!driver) return NextResponse.json({ error: 'Entregador inválido.' }, { status: 400 });
    const { data: order } = await db.from('orders').update({ assigned_driver_id: driver.id, delivery_code_hash: codeHash, delivery_code_last4: code, delivery_assigned_at: new Date().toISOString() }).eq('id', body?.order_id).eq('account_id', ctx.accountId).eq('status','paid').eq('fulfillment_status','ready').select('id,order_code').maybeSingle();
    if (!order) return NextResponse.json({ error: 'Pedido indisponível para atribuição.' }, { status: 409 });
    return NextResponse.json({ order, confirmation_code: code });
  } catch (error) { return toErrorResponse(error); }
}
