import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const token = typeof body?.token === 'string' ? body.token : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (token.length !== 64 || password.length < 8) return NextResponse.json({ error: 'Convite ou senha inválidos.' }, { status: 400 });
  const db = supabaseAdmin();
  const hash = createHash('sha256').update(token).digest('hex');
  const { data: driver } = await db.from('delivery_drivers').select('*').eq('invite_token_hash', hash).gt('invite_expires_at', new Date().toISOString()).eq('status','invited').maybeSingle();
  if (!driver) return NextResponse.json({ error: 'Convite inválido ou expirado.' }, { status: 404 });
  const { data: created, error } = await db.auth.admin.createUser({ email: driver.email, password, email_confirm: true, user_metadata: { full_name: driver.name, portal: 'driver' } });
  if (error || !created.user) return NextResponse.json({ error: error?.message ?? 'Não foi possível criar o acesso.' }, { status: 400 });
  await db.from('delivery_drivers').update({ auth_user_id: created.user.id, status: 'active', invite_token_hash: null, invite_expires_at: null }).eq('id', driver.id);
  return NextResponse.json({ ok: true });
}
