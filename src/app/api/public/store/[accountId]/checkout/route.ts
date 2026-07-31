import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { findOrCreateContact } from "@/lib/whatsapp/inbound";
import { addContactTagIfAbsent } from "@/lib/contacts/tag-write";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { validateBrazilianTaxId } from "@/lib/brazilian-tax-id";
import { ensureCheckoutPix } from "@/lib/orders/checkout";

// Public, unauthenticated checkout for a tenant's own storefront
// (/loja/[accountId]) — the workaround for a customer IMCRM can't
// reach over WhatsApp right now (outside the 24h window, no approved
// template). No requireRole/session: the caller is a customer, not a
// team member. Every price/currency/stock check happens server-side
// inside create_public_store_order (migration 065) — nothing here
// trusts a client-submitted price or total.
const MAX_LINE_ITEMS = 50;
const MAX_QUANTITY_PER_LINE = 999;
const SITE_TAG_NAME = "Site";
const SITE_TAG_COLOR = "#06b6d4";

interface CheckoutItemInput {
  catalog_item_id: string;
  quantity: number;
}

async function ensureSiteTag(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  ownerUserId: string,
): Promise<string | null> {
  const { data: existing } = await db
    .from("tags")
    .select("id")
    .eq("account_id", accountId)
    .ilike("name", SITE_TAG_NAME)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await db
    .from("tags")
    .insert({ account_id: accountId, user_id: ownerUserId, name: SITE_TAG_NAME, color: SITE_TAG_COLOR })
    .select("id")
    .maybeSingle();
  if (error) {
    // Unique-name race with a concurrent checkout — reselect the winner.
    const { data: raced } = await db
      .from("tags")
      .select("id")
      .eq("account_id", accountId)
      .ilike("name", SITE_TAG_NAME)
      .maybeSingle();
    return raced?.id ?? null;
  }
  return created?.id ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ error: "O carrinho está vazio" }, { status: 400 });
  }
  if (rawItems.length > MAX_LINE_ITEMS) {
    return NextResponse.json({ error: "Carrinho com muitos itens" }, { status: 400 });
  }
  const items: CheckoutItemInput[] = [];
  for (const raw of rawItems) {
    const catalogItemId = typeof raw?.catalog_item_id === "string" ? raw.catalog_item_id : null;
    const quantity = Number(raw?.quantity);
    if (!catalogItemId || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
      return NextResponse.json({ error: "Item do carrinho inválido" }, { status: 400 });
    }
    items.push({ catalog_item_id: catalogItemId, quantity });
  }

  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const name = typeof customer.name === "string" ? customer.name.trim().slice(0, 200) : "";
  const phoneDigits = normalizePhone(typeof customer.phone === "string" ? customer.phone : "");
  const email = typeof customer.email === "string" ? customer.email.trim().slice(0, 200) : "";
  if (!name) {
    return NextResponse.json({ error: "Informe seu nome" }, { status: 400 });
  }
  if (phoneDigits.length < 10 || phoneDigits.length > 13) {
    return NextResponse.json({ error: "Informe um telefone válido com DDD" }, { status: 400 });
  }
  // Required (not just optional) so a lead captured through the
  // storefront always lands with a complete contact record, not just
  // a phone number — an explicit ask, distinct from cpf_cnpj (which
  // stays optional since it's only needed for PIX, not identity).
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Informe um e-mail válido" }, { status: 400 });
  }
  const taxId = typeof customer.cpf_cnpj === "string" && customer.cpf_cnpj.trim()
    ? validateBrazilianTaxId(customer.cpf_cnpj)
    : null;
  if (typeof customer.cpf_cnpj === "string" && customer.cpf_cnpj.trim() && !taxId) {
    return NextResponse.json({ error: "CPF/CNPJ inválido" }, { status: 400 });
  }

  const db = supabaseAdmin();

  const { data: account } = await db
    .from("accounts")
    .select("id, owner_user_id")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) {
    return NextResponse.json({ error: "Loja não encontrada" }, { status: 404 });
  }

  const contactOutcome = await findOrCreateContact(db, accountId, account.owner_user_id, phoneDigits, name);
  if (!contactOutcome) {
    return NextResponse.json({ error: "Não foi possível registrar seus dados. Tente novamente." }, { status: 500 });
  }
  const contact = contactOutcome.contact;

  const contactUpdate: Record<string, unknown> = {};
  if (email) contactUpdate.email = email;
  if (taxId) contactUpdate.cpf_cnpj = taxId.normalized;
  if (Object.keys(contactUpdate).length > 0) {
    await db.from("contacts").update(contactUpdate).eq("id", contact.id);
  }

  const siteTagId = await ensureSiteTag(db, accountId, account.owner_user_id);
  if (siteTagId) {
    await addContactTagIfAbsent(db, { accountId, contactId: contact.id, tagId: siteTagId }).catch(() => {});
  }

  const { data: rpcResult, error: rpcError } = await db
    .rpc("create_public_store_order", {
      p_account_id: accountId,
      p_contact_id: contact.id,
      p_items: items,
    })
    .maybeSingle();

  if (rpcError || !rpcResult) {
    const message = rpcError?.message ?? "";
    const status = message.includes("insufficient stock") ? 409 : 400;
    return NextResponse.json(
      { error: message.includes("insufficient stock") ? "Um dos itens ficou sem estoque" : "Não foi possível fechar o pedido" },
      { status },
    );
  }

  const order = rpcResult as { order_id: string; deal_id: string; total_cents: number; currency: string };

  let pixCopyPaste: string | null = null;
  if (taxId) {
    try {
      const pixResult = await ensureCheckoutPix(db, {
        accountId,
        orderId: order.order_id,
        contactId: contact.id,
      });
      if (pixResult.ok) {
        pixCopyPaste = pixResult.pixCopyPaste;
      }
    } catch {
      // PIX generation is best-effort here — the order already exists
      // and is visible in the dashboard either way; the seller can
      // follow up manually (same fallback Comandas already relies on).
    }
  }

  return NextResponse.json({
    order_id: order.order_id,
    total_cents: order.total_cents,
    currency: order.currency,
    pix_copy_paste: pixCopyPaste,
  });
}
