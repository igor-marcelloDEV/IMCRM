import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 1000);
    const { data, error } = await supabase
      .from('catalog_stock_movements')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const admin = supabaseAdmin();
    const movements = await Promise.all((data ?? []).map(async (movement) => {
      if (!movement.receipt_path) return { ...movement, receipt_url: null };
      const { data: signed } = await admin.storage.from('inventory-receipts').createSignedUrl(movement.receipt_path, 3600);
      return { ...movement, receipt_url: signed?.signedUrl ?? null };
    }));
    return NextResponse.json({ movements });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (error) {
    return toErrorResponse(error);
  }

  const body = await request.json().catch(() => null);
  const raw = Array.isArray(body?.adjustments) ? body.adjustments : [];
  if (raw.length === 0 || raw.length > 100) {
    return NextResponse.json({ error: 'Informe entre 1 e 100 itens.' }, { status: 400 });
  }
  const adjustments = [];
  for (const entry of raw) {
    const catalogItemId = typeof entry?.catalog_item_id === 'string' ? entry.catalog_item_id : '';
    const quantity = Number(entry?.quantity);
    if (!catalogItemId || !Number.isInteger(quantity) || quantity <= 0 || quantity > 999999) {
      return NextResponse.json({ error: 'Item ou quantidade inválida.' }, { status: 400 });
    }
    adjustments.push({ catalog_item_id: catalogItemId, quantity });
  }

  const receiptPath = typeof body?.receipt_path === 'string' ? body.receipt_path.trim() : '';
  const receiptName = typeof body?.receipt_name === 'string' ? body.receipt_name.trim().slice(0, 255) : '';
  const receiptMime = typeof body?.receipt_mime_type === 'string' ? body.receipt_mime_type.trim() : '';
  const allowedMimes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  if (receiptPath && (!receiptPath.startsWith(`account-${ctx.accountId}/`) || !receiptName || !allowedMimes.has(receiptMime))) {
    return NextResponse.json({ error: 'Comprovante inválido.' }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin().rpc('add_catalog_stock_batch', {
    p_account_id: ctx.accountId,
    p_adjustments: adjustments,
    p_note: typeof body?.note === 'string' ? body.note.trim().slice(0, 500) || null : null,
    p_receipt_path: receiptPath || null,
    p_receipt_name: receiptName || null,
    p_receipt_mime_type: receiptMime || null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ updated: data });
}
