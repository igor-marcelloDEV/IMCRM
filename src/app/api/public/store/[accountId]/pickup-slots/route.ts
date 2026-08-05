import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { resolvePublicStoreAccount } from "@/lib/store/public-store";

/** Generates the day's pickup slots (store hours stepped by
 *  `pickup_slot_minutes`) with remaining capacity, so the storefront
 *  can only offer times that aren't already full. Final race-safety
 *  still lives in the checkout RPC — this is just what the customer
 *  sees before submitting. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  const { searchParams } = new URL(request.url);
  const dateParam = searchParams.get("date");
  if (!dateParam || !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return NextResponse.json({ error: "Informe uma data válida (YYYY-MM-DD)." }, { status: 400 });
  }

  const db = supabaseAdmin();
  const account = await resolvePublicStoreAccount(db, accountId);
  if (!account) return NextResponse.json({ error: "Loja não encontrada" }, { status: 404 });

  const opens = account.store_opens_at ?? "09:00:00";
  const closes = account.store_closes_at ?? "18:00:00";
  const stepMinutes = account.pickup_slot_minutes ?? 20;
  const capacity = account.pickup_capacity_per_slot ?? 5;

  const dayStart = new Date(`${dateParam}T00:00:00`);
  const [openH, openM] = opens.split(":").map(Number);
  const [closeH, closeM] = closes.split(":").map(Number);
  const rangeStart = new Date(dayStart);
  rangeStart.setHours(openH, openM, 0, 0);
  const rangeEnd = new Date(dayStart);
  rangeEnd.setHours(closeH, closeM, 0, 0);

  const { data: booked } = await db
    .from("orders")
    .select("pickup_scheduled_at")
    .eq("account_id", account.id)
    .eq("fulfillment_type", "pickup")
    .neq("status", "canceled")
    .gte("pickup_scheduled_at", rangeStart.toISOString())
    .lt("pickup_scheduled_at", rangeEnd.toISOString());

  const bookedCounts = new Map<string, number>();
  for (const row of booked ?? []) {
    if (!row.pickup_scheduled_at) continue;
    const key = new Date(row.pickup_scheduled_at).toISOString();
    bookedCounts.set(key, (bookedCounts.get(key) ?? 0) + 1);
  }

  const now = new Date();
  const slots: { time: string; iso: string; available: number }[] = [];
  for (let t = new Date(rangeStart); t < rangeEnd; t = new Date(t.getTime() + stepMinutes * 60000)) {
    if (t <= now) continue;
    const iso = t.toISOString();
    const available = capacity - (bookedCounts.get(iso) ?? 0);
    slots.push({ time: t.toTimeString().slice(0, 5), iso, available: Math.max(0, available) });
  }

  return NextResponse.json({ slots });
}
