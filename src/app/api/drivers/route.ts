import { createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    const db = supabaseAdmin();
    const [{ data: drivers }, { data: orders }] = await Promise.all([
      db.from('delivery_drivers').select('id,name,email,phone,vehicle_type,vehicle_plate,status,is_available,created_at').eq('account_id', ctx.accountId).order('name'),
      db.from('orders').select('id,order_code,fulfillment_status,assigned_driver_id,contact_id').eq('account_id', ctx.accountId).eq('status','paid').in('fulfillment_status',['ready','out_for_delivery']).order('created_at'),
    ]);
    return NextResponse.json({ drivers: drivers ?? [], orders: orders ?? [] });
  } catch (error) { return toErrorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = await request.json().catch(() => null);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const phone = typeof body?.phone === 'string' ? body.phone.replace(/\D/g,'') : '';
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || phone.length < 10) return NextResponse.json({ error: 'Informe nome, e-mail e telefone válidos.' }, { status: 400 });
    const token = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(token).digest('hex');
    const { data, error } = await supabaseAdmin().from('delivery_drivers').insert({ account_id: ctx.accountId, name, email, phone, vehicle_type: body.vehicle_type || 'motorcycle', vehicle_plate: body.vehicle_plate?.trim().toUpperCase() || null, invite_token_hash: hash, invite_expires_at: new Date(Date.now()+7*86400000).toISOString() }).select('id,name,email').single();
    if (error) return NextResponse.json({ error: error.code === '23505' ? 'Este e-mail já está cadastrado.' : error.message }, { status: 400 });
    return NextResponse.json({ driver: data, invite_url: `${process.env.NEXT_PUBLIC_SITE_URL || 'https://crm.imdigitalsolutions.com.br'}/entregadores/cadastro?token=${token}` }, { status: 201 });
  } catch (error) { return toErrorResponse(error); }
}
