import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { ensureCheckoutHostedCard, ensureCheckoutPix } from '@/lib/orders/checkout';
import { resolvePublicStoreAccount } from '@/lib/store/public-store';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string; orderId: string }> },
) {
  const { accountId, orderId } = await params;
  const body = await request.json().catch(() => null);
  const method = body?.payment_method === 'card' ? 'card' : body?.payment_method === 'pix' ? 'pix' : null;
  if (!method) return NextResponse.json({ error: 'Escolha PIX ou cartão' }, { status: 400 });

  const db = supabaseAdmin();
  const account = await resolvePublicStoreAccount(db, accountId);
  if (!account) return NextResponse.json({ error: 'Loja não encontrada' }, { status: 404 });
  const resolvedAccountId = account.id;
  const { data: order } = await db
    .from('orders')
    .select('id, contact_id, status')
    .eq('id', orderId)
    .eq('account_id', resolvedAccountId)
    .maybeSingle();
  if (!order?.contact_id) return NextResponse.json({ error: 'Pedido não encontrado' }, { status: 404 });
  if (order.status !== 'pending_payment') {
    return NextResponse.json({ error: 'Este pedido não está aguardando pagamento' }, { status: 409 });
  }

  try {
    if (method === 'pix') {
      const result = await ensureCheckoutPix(db, { accountId: resolvedAccountId, orderId, contactId: order.contact_id });
      if (!result.ok) return NextResponse.json({ error: result.retryMessage }, { status: 502 });
      return NextResponse.json({ payment_method: 'pix' });
    }
    const result = await ensureCheckoutHostedCard(db, { accountId: resolvedAccountId, orderId, contactId: order.contact_id });
    if (!result.ok) return NextResponse.json({ error: result.retryMessage }, { status: 502 });
    return NextResponse.json({ payment_method: 'card', payment_url: result.paymentUrl });
  } catch {
    return NextResponse.json({ error: 'Não foi possível iniciar o pagamento. Tente novamente.' }, { status: 502 });
  }
}
