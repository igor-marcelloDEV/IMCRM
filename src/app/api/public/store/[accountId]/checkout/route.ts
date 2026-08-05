import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { findOrCreateContact } from "@/lib/whatsapp/inbound";
import { addContactTagIfAbsent } from "@/lib/contacts/tag-write";
import { normalizePhone } from "@/lib/whatsapp/phone-utils";
import { validateBrazilianTaxId } from "@/lib/brazilian-tax-id";
import { ensureCheckoutHostedCard, ensureCheckoutPix } from "@/lib/orders/checkout";
import { resolvePublicStoreAccount } from "@/lib/store/public-store";
import { createOrGetCustomer, createSubscription, getFirstSubscriptionPaymentInvoiceUrl } from "@/lib/billing/asaas";
import { getTenantAsaasConfig } from "@/lib/orders/tenant-asaas";

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

const MAX_ADDONS_PER_LINE = 20;

interface CheckoutAddonInput {
  addon_id: string;
  quantity: number;
}
interface CheckoutItemInput {
  catalog_item_id: string;
  quantity: number;
  addons: CheckoutAddonInput[];
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
  const paymentMethod = body.payment_method === "card" ? "card" : body.payment_method === "pix" ? "pix" : null;
  if (!paymentMethod) return NextResponse.json({ error: "Escolha PIX ou cartão" }, { status: 400 });

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
    const rawAddons = Array.isArray(raw?.addons) ? raw.addons : [];
    if (rawAddons.length > MAX_ADDONS_PER_LINE) {
      return NextResponse.json({ error: "Muitos adicionais em um item" }, { status: 400 });
    }
    const addons: CheckoutAddonInput[] = [];
    for (const rawAddon of rawAddons) {
      const addonId = typeof rawAddon?.addon_id === "string" ? rawAddon.addon_id : null;
      const addonQuantity = Number(rawAddon?.quantity ?? 1);
      if (!addonId || !Number.isInteger(addonQuantity) || addonQuantity < 1 || addonQuantity > MAX_QUANTITY_PER_LINE) {
        return NextResponse.json({ error: "Adicional inválido" }, { status: 400 });
      }
      addons.push({ addon_id: addonId, quantity: addonQuantity });
    }
    items.push({ catalog_item_id: catalogItemId, quantity, addons });
  }

  const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
  const name = typeof customer.name === "string" ? customer.name.trim().slice(0, 200) : "";
  const phoneDigits = normalizePhone(typeof customer.phone === "string" ? customer.phone : "");
  const email = typeof customer.email === "string" ? customer.email.trim().slice(0, 200) : "";

  const fulfillmentType = body.fulfillment_type === "pickup" ? "pickup" : body.fulfillment_type === "delivery" ? "delivery" : null;
  const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const deliveryAddressLine = str(customer.delivery_address_line, 200);
  const deliveryNumber = str(customer.delivery_number, 20);
  const deliveryComplement = str(customer.delivery_complement, 100);
  const deliveryNeighborhood = str(customer.delivery_neighborhood, 100);
  const deliveryCity = str(customer.delivery_city, 100);
  const deliveryState = str(customer.delivery_state, 2).toUpperCase();
  const deliveryZip = str(customer.delivery_zip, 12);
  const deliveryLat = typeof body.delivery_lat === "number" ? body.delivery_lat : null;
  const deliveryLng = typeof body.delivery_lng === "number" ? body.delivery_lng : null;
  const pickupScheduledAt =
    typeof body.pickup_scheduled_at === "string" && !Number.isNaN(Date.parse(body.pickup_scheduled_at))
      ? body.pickup_scheduled_at
      : null;
  // Legacy free-text mirror kept on `contacts` for the driver app's
  // existing address display — structured fields above are the source
  // of truth on the order itself.
  const deliveryAddress = [deliveryAddressLine && `${deliveryAddressLine}, ${deliveryNumber}`, deliveryComplement, deliveryNeighborhood, deliveryCity && deliveryState ? `${deliveryCity}/${deliveryState}` : deliveryCity]
    .filter(Boolean)
    .join(" - ");
  if (!name) {
    return NextResponse.json({ error: "Informe seu nome" }, { status: 400 });
  }
  if (phoneDigits.length < 10 || phoneDigits.length > 13) {
    return NextResponse.json({ error: "Informe um telefone válido com DDD" }, { status: 400 });
  }
  // Required so every storefront order creates a complete contact record.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Informe um e-mail válido" }, { status: 400 });
  }
  const taxId = typeof customer.cpf_cnpj === "string"
    ? validateBrazilianTaxId(customer.cpf_cnpj)
    : null;
  if (!taxId) {
    return NextResponse.json({ error: "Informe um CPF/CNPJ válido" }, { status: 400 });
  }

  const db = supabaseAdmin();

  const account = await resolvePublicStoreAccount(db, accountId);
  if (!account) {
    return NextResponse.json({ error: "Loja não encontrada" }, { status: 404 });
  }

  const resolvedAccountId = account.id;
  const { data: selectedCatalogItems } = await db.from('catalog_items').select('id, offer_type, billing_cycle').eq('account_id', resolvedAccountId).in('id', items.map((item) => item.catalog_item_id));
  const subscriptionItems = (selectedCatalogItems ?? []).filter((item) => item.offer_type === 'subscription');
  const hasPhysicalProduct = (selectedCatalogItems ?? []).some((item) => item.offer_type === 'physical_product');
  if (hasPhysicalProduct && !fulfillmentType) {
    return NextResponse.json({ error: 'Escolha entrega ou retirada na loja.' }, { status: 400 });
  }
  if (hasPhysicalProduct && fulfillmentType === 'delivery' && (!deliveryAddressLine || !deliveryNumber || !deliveryNeighborhood || !deliveryCity)) {
    return NextResponse.json({ error: 'Informe o endereço completo para entrega.' }, { status: 400 });
  }
  if (hasPhysicalProduct && fulfillmentType === 'pickup' && !pickupScheduledAt) {
    return NextResponse.json({ error: 'Escolha um horário para retirada.' }, { status: 400 });
  }
  if (subscriptionItems.length > 0 && (items.length !== 1 || items[0].quantity !== 1)) {
    return NextResponse.json({ error: 'Planos por assinatura devem ser contratados separadamente, uma unidade por vez.' }, { status: 400 });
  }
  if (subscriptionItems.length > 0 && paymentMethod !== 'card') {
    return NextResponse.json({ error: 'Assinaturas recorrentes exigem pagamento por cartão.' }, { status: 400 });
  }
  const contactOutcome = await findOrCreateContact(db, resolvedAccountId, account.owner_user_id, phoneDigits, name);
  if (!contactOutcome) {
    return NextResponse.json({ error: "Não foi possível registrar seus dados. Tente novamente." }, { status: 500 });
  }
  const contact = contactOutcome.contact;

  const contactUpdate: Record<string, unknown> = {};
  if (email) contactUpdate.email = email;
  contactUpdate.cpf_cnpj = taxId.normalized;
  if (deliveryAddress) contactUpdate.delivery_address = deliveryAddress;
  if (Object.keys(contactUpdate).length > 0) {
    await db.from("contacts").update(contactUpdate).eq("id", contact.id);
  }

  const siteTagId = await ensureSiteTag(db, resolvedAccountId, account.owner_user_id);
  if (siteTagId) {
    await addContactTagIfAbsent(db, { accountId: resolvedAccountId, contactId: contact.id, tagId: siteTagId }).catch(() => {});
  }

  const { data: rpcResult, error: rpcError } = await db
    .rpc("create_public_store_order", {
      p_account_id: resolvedAccountId,
      p_contact_id: contact.id,
      p_items: items,
      p_fulfillment_type: fulfillmentType,
      p_delivery_address_line: fulfillmentType === 'delivery' ? deliveryAddressLine || null : null,
      p_delivery_number: fulfillmentType === 'delivery' ? deliveryNumber || null : null,
      p_delivery_complement: fulfillmentType === 'delivery' ? deliveryComplement || null : null,
      p_delivery_neighborhood: fulfillmentType === 'delivery' ? deliveryNeighborhood || null : null,
      p_delivery_city: fulfillmentType === 'delivery' ? deliveryCity || null : null,
      p_delivery_state: fulfillmentType === 'delivery' ? deliveryState || null : null,
      p_delivery_zip: fulfillmentType === 'delivery' ? deliveryZip || null : null,
      p_delivery_lat: fulfillmentType === 'delivery' ? deliveryLat : null,
      p_delivery_lng: fulfillmentType === 'delivery' ? deliveryLng : null,
      p_pickup_scheduled_at: fulfillmentType === 'pickup' ? pickupScheduledAt : null,
    })
    .maybeSingle();

  if (rpcError || !rpcResult) {
    const message = rpcError?.message ?? "";
    const status = message.includes("insufficient stock") || message.includes("pickup slot is full") ? 409 : 400;
    const friendlyMessage = message.includes("insufficient stock")
      ? "Um dos itens ficou sem estoque"
      : message.includes("pickup slot is full")
        ? "Esse horário de retirada acabou de lotar. Escolha outro."
        : message.includes("add-on")
          ? "Selecione os adicionais corretamente."
          : "Não foi possível fechar o pedido";
    return NextResponse.json({ error: friendlyMessage }, { status });
  }

  const order = rpcResult as { order_id: string; deal_id: string; total_cents: number; currency: string };

  if (subscriptionItems.length === 1) {
    try {
      const tenantConfig = await getTenantAsaasConfig(db, resolvedAccountId);
      if (!tenantConfig) throw new Error('Configure sua conta Asaas antes de vender assinaturas.');
      const gatewayCustomer = await createOrGetCustomer({ config: tenantConfig, name, email, phone: phoneDigits, cpfCnpj: taxId.normalized, externalReference: contact.id });
      const gatewaySubscription = await createSubscription({
        config: tenantConfig, customerId: gatewayCustomer.id,
        cycle: subscriptionItems[0].billing_cycle,
        value: order.total_cents / 100, billingType: 'CREDIT_CARD',
        nextDueDate: new Date().toISOString().slice(0, 10), externalReference: order.order_id,
      });
      await db.from('orders').update({ gateway_customer_id: gatewayCustomer.id, gateway_subscription_id: gatewaySubscription.id, payment_method: 'card', fiscal_document_type: 'NFS-e' }).eq('id', order.order_id);
      const subscriptionPaymentUrl = await getFirstSubscriptionPaymentInvoiceUrl(tenantConfig, gatewaySubscription.id);
      if (!subscriptionPaymentUrl) throw new Error('O Asaas ainda não disponibilizou o pagamento da assinatura.');
      return NextResponse.json({ order_id: order.order_id, total_cents: order.total_cents, currency: order.currency, payment_url: subscriptionPaymentUrl, subscription: true });
    } catch (error) {
      await db.from('orders').update({ status: 'canceled' }).eq('id', order.order_id);
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Não foi possível criar a assinatura.' }, { status: 502 });
    }
  }

  let pixCopyPaste: string | null = null;
  let paymentUrl: string | null = null;
  if (taxId && paymentMethod === "pix") {
    try {
      const pixResult = await ensureCheckoutPix(db, {
        accountId: resolvedAccountId,
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

  if (paymentMethod === "card") {
    try {
      const result = await ensureCheckoutHostedCard(db, { accountId: resolvedAccountId, orderId: order.order_id, contactId: contact.id });
      if (result.ok) paymentUrl = result.paymentUrl;
      else return NextResponse.json({ error: result.retryMessage, order_id: order.order_id }, { status: 502 });
    } catch {
      return NextResponse.json({ error: "Não foi possível iniciar o pagamento. Tente novamente.", order_id: order.order_id }, { status: 502 });
    }
  }

  return NextResponse.json({
    order_id: order.order_id,
    total_cents: order.total_cents,
    currency: order.currency,
    pix_copy_paste: pixCopyPaste,
    payment_url: paymentUrl,
  });
}
