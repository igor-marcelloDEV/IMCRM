import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const db = supabaseAdmin();
    const { data } = await db
      .from('delivery_time_slots')
      .select('id,label,start_time,is_active,position')
      .eq('account_id', ctx.accountId)
      .order('position');
    return NextResponse.json({ time_slots: data ?? [] });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    const startTime = typeof body?.start_time === 'string' ? body.start_time : '';
    if (!label || !/^\d{2}:\d{2}$/.test(startTime)) {
      return NextResponse.json({ error: 'Informe um rótulo e um horário válidos.' }, { status: 400 });
    }
    const db = supabaseAdmin();
    const { data, error } = await db
      .from('delivery_time_slots')
      .insert({ account_id: ctx.accountId, label, start_time: `${startTime}:00` })
      .select('id,label,start_time,is_active,position')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ time_slot: data }, { status: 201 });
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
    const update: Record<string, unknown> = {};
    if (typeof body?.is_active === 'boolean') update.is_active = body.is_active;
    if (typeof body?.label === 'string') update.label = body.label.trim();
    if (typeof body?.start_time === 'string' && /^\d{2}:\d{2}$/.test(body.start_time)) {
      update.start_time = `${body.start_time}:00`;
    }
    const db = supabaseAdmin();
    const { error } = await db.from('delivery_time_slots').update(update).eq('id', id).eq('account_id', ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id') || '';
    if (!id) return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
    const db = supabaseAdmin();
    const { error } = await db.from('delivery_time_slots').delete().eq('id', id).eq('account_id', ctx.accountId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
