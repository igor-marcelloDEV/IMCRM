import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { resolvePublicStoreAccount } from "@/lib/store/public-store";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

const LOOKUP_LIMIT = { limit: 8, windowMs: 10 * 60_000 };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  const body = await request.json().catch(() => null);
  const identifier = typeof body?.identifier === "string" ? body.identifier.trim().toLowerCase() : "";
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`store-order-lookup:${forwarded}:${accountId}`, LOOKUP_LIMIT);
  if (!limit.success) return rateLimitResponse(limit);

  const isEmail = identifier.includes("@");
  const phone = isEmail ? "" : normalizePhone(identifier);
  if ((isEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) || (!isEmail && phone.length < 10)) {
    return NextResponse.json({ error: "Informe um telefone ou e-mail válido" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const account = await resolvePublicStoreAccount(db, accountId);
  if (!account) return NextResponse.json({ error: "Loja não encontrada" }, { status: 404 });

  let contactsQuery = db.from("contacts").select("id").eq("account_id", account.id).limit(20);
  contactsQuery = isEmail ? contactsQuery.ilike("email", identifier) : contactsQuery.eq("phone", phone);
  const { data: contacts } = await contactsQuery;
  const contactIds = (contacts ?? []).map((contact) => contact.id);
  if (contactIds.length === 0) return NextResponse.json({ orders: [] });

  const { data: orders } = await db
    .from("orders")
    .select("id, order_code, status, total_cents, currency, created_at, paid_at")
    .eq("account_id", account.id)
    .in("contact_id", contactIds)
    .order("created_at", { ascending: false })
    .limit(3);

  return NextResponse.json({ orders: orders ?? [] });
}
