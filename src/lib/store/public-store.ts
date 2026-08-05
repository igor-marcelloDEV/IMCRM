import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolvePublicStoreAccount(db: SupabaseClient, identifier: string) {
  const normalized = decodeURIComponent(identifier).trim().toLowerCase();
  const query = db
    .from("accounts")
    .select(
      "id, owner_user_id, name, legal_name, cnpj, logo_url, store_slug, store_lat, store_lng, pickup_slot_minutes, pickup_capacity_per_slot, store_opens_at, store_closes_at",
    );

  const { data } = UUID_PATTERN.test(normalized)
    ? await query.eq("id", normalized).maybeSingle()
    : await query.eq("store_slug", normalized).maybeSingle();

  return data;
}
