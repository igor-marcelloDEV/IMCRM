import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { resolvePublicStoreAccount } from '@/lib/store/public-store';

const VEHICLE_TYPES = new Set(['motorcycle', 'car', 'bicycle', 'other']);

/** Public, unauthenticated self-application — no invite required.
 *  Lands as `status: 'pending_review'`; staff approves from /drivers,
 *  which reuses the existing invite-token → set-password flow. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const accountIdentifier = typeof body?.account_id === 'string' ? body.account_id : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body?.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
  const vehicleType = VEHICLE_TYPES.has(body?.vehicle_type) ? body.vehicle_type : 'motorcycle';
  const vehiclePlate = typeof body?.vehicle_plate === 'string' ? body.vehicle_plate.trim().toUpperCase() || null : null;
  const documentNumber = typeof body?.document_number === 'string' ? body.document_number.replace(/\D/g, '') || null : null;
  const pixKey = typeof body?.pix_key === 'string' ? body.pix_key.trim() || null : null;

  if (!accountIdentifier) {
    return NextResponse.json({ error: 'Loja inválida.' }, { status: 400 });
  }
  if (!name || !/^\S+@\S+\.\S+$/.test(email) || phone.length < 10) {
    return NextResponse.json({ error: 'Informe nome, e-mail e telefone válidos.' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const account = await resolvePublicStoreAccount(db, accountIdentifier);
  if (!account) {
    return NextResponse.json({ error: 'Loja não encontrada.' }, { status: 404 });
  }

  const { data, error } = await db
    .from('delivery_drivers')
    .insert({
      account_id: account.id,
      name,
      email,
      phone,
      vehicle_type: vehicleType,
      vehicle_plate: vehiclePlate,
      document_number: documentNumber,
      pix_key: pixKey,
      status: 'pending_review',
    })
    .select('id,name')
    .single();

  if (error) {
    return NextResponse.json(
      { error: error.code === '23505' ? 'Este e-mail já foi cadastrado por aqui.' : error.message },
      { status: 400 },
    );
  }
  return NextResponse.json({ driver: data }, { status: 201 });
}
