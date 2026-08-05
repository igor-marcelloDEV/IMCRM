import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const db = supabaseAdmin();
    const { data } = await db
      .from('delivery_drivers')
      .select('id,name,email,phone,vehicle_type,vehicle_plate,document_number,pix_key,created_at')
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending_review')
      .order('created_at');
    return NextResponse.json({ applications: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** Approve → issues the same invite-token/set-password link the
 *  staff-created flow uses. Reject → deletes the application outright
 *  (no account was ever created for it). */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const driverId = typeof body?.driver_id === 'string' ? body.driver_id : '';
    const action = body?.action === 'approve' ? 'approve' : body?.action === 'reject' ? 'reject' : null;
    if (!driverId || !action) {
      return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
    }
    const db = supabaseAdmin();

    if (action === 'reject') {
      const { error } = await db
        .from('delivery_drivers')
        .delete()
        .eq('id', driverId)
        .eq('account_id', ctx.accountId)
        .eq('status', 'pending_review');
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ ok: true });
    }

    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    const { data, error } = await db
      .from('delivery_drivers')
      .update({
        status: 'invited',
        invite_token_hash: hash,
        invite_expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      })
      .eq('id', driverId)
      .eq('account_id', ctx.accountId)
      .eq('status', 'pending_review')
      .select('id,name,email')
      .maybeSingle();
    if (error || !data) {
      return NextResponse.json({ error: error?.message ?? 'Candidatura não encontrada.' }, { status: 400 });
    }
    return NextResponse.json({
      driver: data,
      invite_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://crm.imdigitalsolutions.com.br'}/entregadores/cadastro?token=${token}`,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
