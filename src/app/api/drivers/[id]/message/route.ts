import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { notifyDriver, renderDriverMessage, DEFAULT_DRIVER_NEW_JOB_TEMPLATE } from '@/lib/drivers/notify';

/** Manual "mensagem ao entregador" button — sends the account's saved
 *  template (or an override) straight to the driver's WhatsApp. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const db = supabaseAdmin();

    const [{ data: driver }, { data: account }] = await Promise.all([
      db.from('delivery_drivers').select('id,phone').eq('id', id).eq('account_id', ctx.accountId).maybeSingle(),
      db.from('accounts').select('driver_message_template,name').eq('id', ctx.accountId).maybeSingle(),
    ]);
    if (!driver) return NextResponse.json({ error: 'Entregador não encontrado.' }, { status: 404 });

    const template =
      typeof body?.text === 'string' && body.text.trim()
        ? body.text.trim()
        : account?.driver_message_template || DEFAULT_DRIVER_NEW_JOB_TEMPLATE;
    const text = renderDriverMessage(template, {
      pedido: typeof body?.order_code === 'string' ? body.order_code : '',
      endereco: typeof body?.address === 'string' ? body.address : '',
      loja: account?.name ?? '',
    });

    const result = await notifyDriver(db, ctx.accountId, driver, text);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
