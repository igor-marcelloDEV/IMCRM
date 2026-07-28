import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { decrypt } from '@/lib/whatsapp/encryption'
import { scheduleInvoice } from '@/lib/orders/tenant-asaas'
import type { AsaasEnv } from '@/lib/billing/asaas'

/**
 * Asaas payment-gateway webhook receiver — for TENANT orders, not the
 * platform's own billing (see src/app/api/billing/webhook/route.ts
 * for that one; same event shapes, deliberately separate route since
 * each is authenticated against a different secret universe).
 *
 * One shared URL for every tenant (no per-account path) — same trick
 * the WhatsApp webhook uses: the payload's `externalReference` (set
 * to `orders.id` at PIX-creation time, see engine.ts's
 * chargeOrderViaAsaas) finds the order FIRST, which reveals the
 * account_id, which is how we find THAT tenant's own webhook_token to
 * validate the `asaas-access-token` header against. Auth therefore
 * happens after a lookup rather than before — deliberate, since each
 * tenant has their own token, not one shared platform secret.
 */

interface AsaasWebhookPayment {
  id: string
  value: number
  status: string
  billingType?: 'PIX' | 'BOLETO' | 'CREDIT_CARD'
  externalReference?: string
}

interface AsaasWebhookBody {
  event: string
  payment?: AsaasWebhookPayment
}

const CONFIRMED_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'])

export async function POST(request: Request) {
  let body: AsaasWebhookBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  if (!body.payment?.externalReference) {
    // Nothing we can correlate — ack so Asaas doesn't retry forever.
    return NextResponse.json({ received: true })
  }

  const db = supabaseAdmin()
  const { data: order } = await db
    .from('orders')
    .select('id, account_id, contact_id, status, total_cents, currency')
    .eq('id', body.payment.externalReference)
    .maybeSingle()
  if (!order) {
    return NextResponse.json({ received: true })
  }

  const { data: tenantConfig } = await db
    .from('tenant_payment_configs')
    .select(
      'webhook_token, encrypted_asaas_api_key, asaas_env, municipal_service_id, municipal_service_name, default_taxes, nfe_enabled',
    )
    .eq('account_id', order.account_id)
    .maybeSingle()
  const expected = tenantConfig?.webhook_token
  const supplied = request.headers.get('asaas-access-token') ?? ''
  if (!expected) {
    return NextResponse.json({ error: 'webhook não configurado para esta conta' }, { status: 503 })
  }
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  try {
    if (CONFIRMED_EVENTS.has(body.event) && order.status !== 'paid') {
      await db
        .from('orders')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', order.id)
      // Deliberately no automatic Pipeline stage change here — the
      // tenant closes the sale manually by dragging the linked Deal,
      // per the confirmed design (see the plan doc).

      // Fire-and-forget — lets a tenant build a post-purchase
      // automation (thank-you message, buyer tag, etc.) without
      // touching the Flow that created the order. Never blocks the
      // webhook's own response.
      void runAutomationsForTrigger({
        accountId: order.account_id,
        triggerType: 'order_paid',
        contactId: order.contact_id,
        context: {
          vars: {
            order_id: order.id,
            total_cents: order.total_cents,
            currency: order.currency,
          },
        },
      }).catch((err) => {
        console.error('[orders webhook] order_paid automation dispatch failed:', err)
      })

      // NFS-e — opt-in per tenant, and only once they've picked a
      // municipal service (implies fiscal registration is already
      // done on their own Asaas account; see the Payments settings
      // tab). A bad/missing config here must NEVER fail the payment
      // confirmation above — it already committed — so failures are
      // recorded on the order and logged, not thrown.
      if (tenantConfig?.nfe_enabled && tenantConfig.municipal_service_id && tenantConfig.encrypted_asaas_api_key) {
        try {
          const apiKey = decrypt(tenantConfig.encrypted_asaas_api_key)
          const invoice = await scheduleInvoice({
            config: { apiKey, env: (tenantConfig.asaas_env as AsaasEnv) ?? 'sandbox' },
            paymentId: body.payment.id,
            value: order.total_cents / 100,
            municipalServiceId: tenantConfig.municipal_service_id,
            municipalServiceName: tenantConfig.municipal_service_name ?? '',
            serviceDescription: 'Pedido via WhatsApp',
            effectiveDate: new Date().toISOString().slice(0, 10),
            taxes: (tenantConfig.default_taxes as Record<string, unknown> | null) ?? undefined,
          })
          await db
            .from('orders')
            .update({ invoice_id: invoice.id, invoice_status: invoice.status })
            .eq('id', order.id)
        } catch (err) {
          console.error('[orders webhook] scheduleInvoice failed:', err)
          await db
            .from('orders')
            .update({ invoice_status: 'error' })
            .eq('id', order.id)
        }
      }
    } else if (body.event === 'PAYMENT_OVERDUE' || body.event === 'PAYMENT_DELETED') {
      // Order stays pending_payment — nothing to do beyond what's
      // already true. Left as an explicit no-op branch (rather than
      // falling into "unhandled") so a future retry-nudge automation
      // has an obvious place to hook in.
    } else {
      console.warn('[orders webhook] unhandled event:', body.event)
    }
  } catch (err) {
    console.error('[orders webhook] processing failed:', body.event, err)
  }

  return NextResponse.json({ received: true })
}
