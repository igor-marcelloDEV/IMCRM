import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";

/**
 * GET /api/public/store/[accountId]/orders/[orderId] — the public
 * order-confirmation/receipt page's data source. No session: the
 * order id itself (a UUIDv4, ~122 bits of entropy, handed back only
 * to the customer who just placed it) is the bearer credential — the
 * same trust model as a Stripe/Shopify order-confirmation link. Never
 * lists orders, never accepts anything but an exact id match scoped
 * to `accountId`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ accountId: string; orderId: string }> },
) {
  const { accountId, orderId } = await params;
  const db = supabaseAdmin();

  const { data: order } = await db
    .from("orders")
    .select(
      "id, status, subtotal_cents, total_cents, currency, pix_copy_paste, pix_expires_at, invoice_status, created_at, paid_at",
    )
    .eq("id", orderId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!order) {
    return NextResponse.json({ error: "Pedido não encontrado" }, { status: 404 });
  }

  const { data: items } = await db
    .from("order_items")
    .select("id, name_snapshot, quantity, unit_price_cents, total_cents")
    .eq("order_id", orderId)
    .order("created_at", { ascending: true });

  const { data: account } = await db
    .from("accounts")
    .select("name, logo_url")
    .eq("id", accountId)
    .maybeSingle();

  return NextResponse.json({
    order,
    items: items ?? [],
    account: account ?? null,
  });
}
