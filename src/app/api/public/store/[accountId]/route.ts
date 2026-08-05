import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { resolvePublicStoreAccount } from "@/lib/store/public-store";

/**
 * GET /api/public/store/[accountId] — unauthenticated storefront read.
 * No `requireRole`/cookie session: the caller is a tenant's own
 * customer, not a signed-in team member. RLS would block this (every
 * `catalog_items`/`accounts` SELECT policy requires
 * `is_account_member`), so this uses the service-role client and
 * hand-scopes to `accountId` — same pattern as the inbound webhook
 * routes, just triggered by a page load instead of a provider POST.
 * Only ever returns fields safe to show an anonymous visitor: no
 * tokens, no other tenants' data, no inactive items.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  const db = supabaseAdmin();

  const account = await resolvePublicStoreAccount(db, accountId);
  if (!account) {
    return NextResponse.json({ error: "Loja não encontrada" }, { status: 404 });
  }

  const { data: items } = await db
    .from("catalog_items")
    .select(
      "id, name, description, price_cents, currency, media_url, media_type, stock_quantity, offer_type, billing_cycle, compare_at_price_cents, trial_days, campaign_badge, addon_groups:catalog_item_addon_groups(id,account_id,catalog_item_id,name,required,min_select,max_select,position,options:catalog_item_addons(id,group_id,name,price_cents,is_active,position))",
    )
    .eq("account_id", account.id)
    .eq("is_active", true)
    .order("position", { ascending: true });

  interface AddonOptionRow { position: number; is_active: boolean; [key: string]: unknown }
  interface AddonGroupRow { position: number; options: AddonOptionRow[] | null; [key: string]: unknown }
  const byPosition = (a: { position: number }, b: { position: number }) => a.position - b.position
  const catalogItems = (items ?? []).map((item) => ({
    ...item,
    addon_groups: ((item.addon_groups ?? []) as AddonGroupRow[])
      .map((g) => ({ ...g, options: [...(g.options ?? [])].filter((o) => o.is_active).sort(byPosition) }))
      .sort(byPosition),
  }));

  return NextResponse.json({
    account: {
      id: account.id,
      name: account.name,
      legal_name: account.legal_name,
      cnpj: account.cnpj,
      logo_url: account.logo_url,
      store_slug: account.store_slug,
      pickup_slot_minutes: account.pickup_slot_minutes,
      pickup_capacity_per_slot: account.pickup_capacity_per_slot,
    },
    catalog_items: catalogItems,
  });
}
