import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { getCurrentDriver } from '@/lib/drivers/auth';

/** Straight-line distance in km — good enough to sort/display "how far",
 *  not turn-by-turn routing. */
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET() {
  const driver = await getCurrentDriver();
  if (!driver) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  const db = supabaseAdmin();

  const [{ data: account }, { data: orders }, { data: slots }] = await Promise.all([
    db.from('accounts').select('store_lat,store_lng,store_address').eq('id', driver.account_id).maybeSingle(),
    db
      .from('orders')
      .select(
        'id,order_code,total_cents,currency,delivery_fee_cents,delivery_address_line,delivery_number,delivery_neighborhood,delivery_city,delivery_lat,delivery_lng,created_at',
      )
      .eq('account_id', driver.account_id)
      .eq('status', 'paid')
      .eq('fulfillment_type', 'delivery')
      .eq('fulfillment_status', 'ready')
      .is('assigned_driver_id', null)
      .order('created_at'),
    db
      .from('delivery_time_slots')
      .select('id,label,start_time')
      .eq('account_id', driver.account_id)
      .eq('is_active', true)
      .order('position'),
  ]);

  const jobs = (orders ?? []).map((o) => ({
    ...o,
    distance_km:
      account?.store_lat != null && account?.store_lng != null && o.delivery_lat != null && o.delivery_lng != null
        ? Math.round(distanceKm(account.store_lat, account.store_lng, o.delivery_lat, o.delivery_lng) * 10) / 10
        : null,
  }));

  return NextResponse.json({
    jobs,
    time_slots: slots ?? [],
    store_address: account?.store_address ?? null,
  });
}
