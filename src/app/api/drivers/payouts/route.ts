import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const db = supabaseAdmin();
    const { data } = await db
      .from('delivery_payouts')
      .select('id,driver_id,order_id,amount_cents,status,paid_at,created_at,driver:delivery_drivers(name),order:orders(order_code)')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });
    return NextResponse.json({ payouts: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const id = typeof body?.id === 'string' ? body.id : '';
    if (!id) return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
    const db = supabaseAdmin();
    const { error } = await db
      .from('delivery_payouts')
      .update({ status: 'paid', paid_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending');
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
