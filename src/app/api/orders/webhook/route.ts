import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { decrypt } from '@/lib/whatsapp/encryption';
import { scheduleInvoice } from '@/lib/orders/tenant-asaas';
import type { AsaasEnv } from '@/lib/billing/asaas';

/**
 * Asaas payment-gateway webhook receiver for tenant orders. The
 * payload's externalReference resolves the order/account first, then
 * that tenant's token authenticates the request.
 */

interface AsaasWebhookPayment {
  id?: string;
  value?: number;
  currency?: string;
  status?: string;
  billingType?: 'PIX' | 'BOLETO' | 'CREDIT_CARD';
  externalReference?: string;
}

interface AsaasWebhookBody {
  event: string;
  payment?: AsaasWebhookPayment;
}

interface OrderForPayment {
  id: string;
  account_id: string;
  contact_id: string | null;
  status: 'pending_payment' | 'paid' | 'canceled';
  total_cents: number;
  currency: string;
  gateway_payment_id: string | null;
}

interface TenantInvoiceConfig {
  encrypted_asaas_api_key: string | null;
  asaas_env: AsaasEnv | null;
  municipal_service_id: string | null;
  municipal_service_name: string | null;
  default_taxes: Record<string, unknown> | null;
  nfe_enabled: boolean;
}

const CONFIRMED_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED']);
const NOOP_EVENTS = new Set(['PAYMENT_OVERDUE', 'PAYMENT_DELETED']);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function webhookJson(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function tokensMatch(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const suppliedDigest = createHash('sha256').update(supplied, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function paymentValueToCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

function retryablePersistenceError(context: string, error: unknown) {
  console.error(`[orders webhook] ${context}:`, error);
  return webhookJson(
    { error: 'Falha temporária ao processar o pagamento; tente novamente' },
    503
  );
}

async function persistInvoiceState(
  db: SupabaseClient,
  orderId: string,
  update: { invoice_id?: string; invoice_status: string }
) {
  const { error } = await db.from('orders').update(update).eq('id', orderId);
  return error;
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return webhookJson({ error: 'JSON inválido' }, 400);
  }

  if (
    !rawBody ||
    typeof rawBody !== 'object' ||
    Array.isArray(rawBody) ||
    typeof (rawBody as { event?: unknown }).event !== 'string'
  ) {
    return webhookJson({ error: 'Payload inválido' }, 400);
  }

  const body = rawBody as AsaasWebhookBody;
  const payment = body.payment;
  if (!payment?.externalReference) {
    // Nothing we can correlate — acknowledge so the provider does not
    // retry a payload that can never belong to a tenant order.
    return webhookJson({ received: true, processed: false });
  }
  if (!UUID_PATTERN.test(payment.externalReference)) {
    return webhookJson({ error: 'Referência externa inválida' }, 400);
  }

  const db = supabaseAdmin();
  const { data: orderData, error: orderError } = await db
    .from('orders')
    .select(
      'id, account_id, contact_id, status, total_cents, currency, gateway_payment_id'
    )
    .eq('id', payment.externalReference)
    .maybeSingle();
  if (orderError) {
    return retryablePersistenceError('order lookup failed', orderError);
  }
  if (!orderData) {
    return webhookJson({ received: true, processed: false });
  }
  const order = orderData as OrderForPayment;

  const { data: authConfig, error: authConfigError } = await db
    .from('tenant_payment_configs')
    .select('webhook_token')
    .eq('account_id', order.account_id)
    .maybeSingle();
  if (authConfigError) {
    return retryablePersistenceError(
      'payment configuration lookup failed',
      authConfigError
    );
  }

  const expectedToken =
    typeof authConfig?.webhook_token === 'string'
      ? authConfig.webhook_token
      : '';
  if (!expectedToken) {
    return webhookJson(
      { error: 'Webhook não configurado para esta conta' },
      503
    );
  }
  const suppliedToken = request.headers.get('asaas-access-token') ?? '';
  if (!tokensMatch(suppliedToken, expectedToken)) {
    return webhookJson({ error: 'Não autorizado' }, 401);
  }

  if (typeof payment.id !== 'string' || !payment.id) {
    return webhookJson({ error: 'Identificador do pagamento ausente' }, 400);
  }
  if (!order.gateway_payment_id) {
    // The charge may have been created moments before the engine
    // persisted its gateway id. Asking Asaas to retry closes that race
    // without accepting an uncorrelated payment.
    return webhookJson(
      { error: 'Pedido ainda não possui cobrança correlacionada' },
      503
    );
  }
  if (payment.id !== order.gateway_payment_id) {
    return webhookJson(
      { error: 'Evento de pagamento não corresponde ao pedido' },
      409
    );
  }

  let eventTotalCents = order.total_cents;
  if (payment.value !== undefined) {
    const cents = paymentValueToCents(payment.value);
    if (cents === null) {
      return webhookJson({ error: 'Valor do pagamento inválido' }, 400);
    }
    if (cents !== order.total_cents) {
      return webhookJson(
        { error: 'Valor do pagamento não corresponde ao pedido' },
        409
      );
    }
    eventTotalCents = cents;
  }

  let eventCurrency = order.currency.toUpperCase();
  if (payment.currency !== undefined) {
    if (typeof payment.currency !== 'string' || !payment.currency.trim()) {
      return webhookJson({ error: 'Moeda do pagamento inválida' }, 400);
    }
    eventCurrency = payment.currency.trim().toUpperCase();
    if (eventCurrency !== order.currency.toUpperCase()) {
      return webhookJson(
        { error: 'Moeda do pagamento não corresponde ao pedido' },
        409
      );
    }
  }

  if (!CONFIRMED_EVENTS.has(body.event)) {
    if (!NOOP_EVENTS.has(body.event)) {
      console.warn('[orders webhook] unhandled event:', body.event);
    }
    return webhookJson({ received: true, processed: false });
  }

  if (order.status === 'paid') {
    return webhookJson({ received: true, processed: false });
  }
  if (order.status !== 'pending_payment') {
    return webhookJson({ error: 'Pedido não está aguardando pagamento' }, 409);
  }

  // Load optional fiscal configuration before committing payment. A
  // database read failure is retriable and must not leave a paid order
  // whose one-time effects were skipped.
  const { data: invoiceConfigData, error: invoiceConfigError } = await db
    .from('tenant_payment_configs')
    .select(
      'encrypted_asaas_api_key, asaas_env, municipal_service_id, municipal_service_name, default_taxes, nfe_enabled'
    )
    .eq('account_id', order.account_id)
    .maybeSingle();
  if (invoiceConfigError) {
    return retryablePersistenceError(
      'invoice configuration lookup failed',
      invoiceConfigError
    );
  }
  const invoiceConfig = invoiceConfigData as TenantInvoiceConfig | null;

  // The SECURITY DEFINER RPC is executable only by service_role. Its
  // conditional UPDATE is the idempotency gate: exactly one concurrent
  // delivery receives a row and is therefore allowed to run effects.
  const { data: transitionedData, error: transitionError } = await db
    .rpc('confirm_tenant_order_payment', {
      p_order_id: order.id,
      p_gateway_payment_id: payment.id,
      p_total_cents: eventTotalCents,
      p_currency: eventCurrency,
      p_paid_at: new Date().toISOString(),
    })
    .maybeSingle();
  if (transitionError) {
    return retryablePersistenceError(
      'atomic payment transition failed',
      transitionError
    );
  }
  if (!transitionedData) {
    // Usually another concurrent delivery won. Return a retriable
    // response once; the retry will observe status=paid and ack without
    // executing effects.
    return retryablePersistenceError(
      'atomic payment transition affected no rows',
      { orderId: order.id }
    );
  }
  const transitioned = transitionedData as OrderForPayment;

  const { data: fiscalItems } = await db
    .from('order_items')
    .select('total_cents, catalog_items(offer_type)')
    .eq('order_id', transitioned.id);
  let serviceTotalCents = 0;
  let physicalTotalCents = 0;
  for (const item of fiscalItems ?? []) {
    const catalog = item.catalog_items as unknown as { offer_type?: string } | null;
    if (catalog?.offer_type === 'physical_product') physicalTotalCents += item.total_cents;
    else serviceTotalCents += item.total_cents;
  }
  await db.from('orders').update({
    fiscal_document_type: physicalTotalCents > 0 && serviceTotalCents > 0 ? 'mixed' : physicalTotalCents > 0 ? 'NF-e/NFC-e' : 'NFS-e',
    merchandise_fiscal_status: physicalTotalCents > 0 ? 'pending_provider_configuration' : null,
  }).eq('id', transitioned.id);

  // Deliberately no automatic Pipeline stage change here — the tenant
  // closes the sale manually by dragging the linked Deal.
  if (transitioned.contact_id) {
    void runAutomationsForTrigger({
      accountId: transitioned.account_id,
      triggerType: 'order_paid',
      contactId: transitioned.contact_id,
      context: {
        vars: {
          order_id: transitioned.id,
          total_cents: transitioned.total_cents,
          currency: transitioned.currency,
        },
      },
    }).catch((error) => {
      console.error(
        '[orders webhook] order_paid automation dispatch failed:',
        error
      );
    });
  }

  if (
    serviceTotalCents > 0 && invoiceConfig?.nfe_enabled &&
    invoiceConfig.municipal_service_id &&
    invoiceConfig.encrypted_asaas_api_key
  ) {
    try {
      const apiKey = decrypt(invoiceConfig.encrypted_asaas_api_key);
      const invoice = await scheduleInvoice({
        config: {
          apiKey,
          env: invoiceConfig.asaas_env ?? 'sandbox',
        },
        paymentId: payment.id,
        value: serviceTotalCents / 100,
        municipalServiceId: invoiceConfig.municipal_service_id,
        municipalServiceName: invoiceConfig.municipal_service_name ?? '',
        serviceDescription: 'Pedido via WhatsApp',
        effectiveDate: new Date().toISOString().slice(0, 10),
        taxes: invoiceConfig.default_taxes ?? undefined,
      });
      const invoicePersistError = await persistInvoiceState(
        db,
        transitioned.id,
        { invoice_id: invoice.id, invoice_status: invoice.status }
      );
      if (invoicePersistError) {
        return retryablePersistenceError(
          'invoice state persistence failed',
          invoicePersistError
        );
      }
    } catch (error) {
      console.error('[orders webhook] scheduleInvoice failed:', error);
      const invoiceErrorPersist = await persistInvoiceState(
        db,
        transitioned.id,
        { invoice_status: 'error' }
      );
      if (invoiceErrorPersist) {
        return retryablePersistenceError(
          'invoice error persistence failed',
          invoiceErrorPersist
        );
      }
    }
  }

  return webhookJson({ received: true, processed: true });
}
