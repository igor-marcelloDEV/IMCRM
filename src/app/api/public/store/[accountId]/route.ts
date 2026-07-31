import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";

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

  const { data: account } = await db
    .from("accounts")
    .select("id, name, logo_url")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) {
    return NextResponse.json({ error: "Loja não encontrada" }, { status: 404 });
  }

  const { data: items } = await db
    .from("catalog_items")
    .select("id, name, description, price_cents, currency, media_url, media_type, stock_quantity")
    .eq("account_id", accountId)
    .eq("is_active", true)
    .order("position", { ascending: true });

  return NextResponse.json({
    account: { id: account.id, name: account.name, logo_url: account.logo_url },
    catalog_items: items ?? [],
  });
}
