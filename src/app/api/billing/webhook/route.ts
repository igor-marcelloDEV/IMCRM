import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/billing/admin-client'

/**
 * Asaas payment-gateway webhook receiver.
 *
 * Auth: Asaas echoes back the "webhook authentication token" you set
 * when configuring the webhook in the Asaas dashboard, via the
 * `asaas-access-token` header on every request — not an HMAC
 * signature like Meta's webhook, just a shared-secret header. Same
 * timing-safe compare pattern as the automations/flows cron routes.
 *
 * Processed synchronously (no `after()`, unlike the WhatsApp webhook)
 * — there's no slow network call in the critical path here, just a
 * couple of indexed DB writes, so there's no risk of the Vercel
 * function freezing mid-work after the response is sent.
 *
 * Payload shape confirmed against Asaas' docs: `{ id, event,
 * dateCreated, payment: {...} }` for payment events, `{ id, event,
 * dateCreated, subscription: {...} }` for subscription events. The
 * `payment`/`subscription` objects echo back `externalReference` —
 * we always set that to our own `subscriptions.id` at creation time
 * (see src/lib/billing/asaas.ts), so it's the correlation key back
 * to our row instead of trying to match on Asaas' own ids.
 */

interface AsaasWebhookPayment {
  id: string
  value: number
  status: string
  billingType?: 'PIX' | 'BOLETO' | 'CREDIT_CARD'
  dueDate?: string
  externalReference?: string
  subscription?: string
}

interface AsaasWebhookSubscription {
  id: string
  externalReference?: string
}

interface AsaasWebhookBody {
  event: string
  payment?: AsaasWebhookPayment
  subscription?: AsaasWebhookSubscription
}

const CONFIRMED_EVENTS = new Set(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'])

export async function POST(request: Request) {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN
  if (!expected) {
    return NextResponse.json({ error: 'billing webhook não configurado' }, { status: 503 })
  }
  const supplied = request.headers.get('asaas-access-token') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  let body: AsaasWebhookBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })
  }

  const db = supabaseAdmin()

  try {
    if (body.payment && CONFIRMED_EVENTS.has(body.event)) {
      await handlePaymentConfirmed(db, body.payment)
    } else if (body.payment && body.event === 'PAYMENT_OVERDUE') {
      await handlePaymentOverdue(db, body.payment)
    } else if (body.subscription && body.event === 'SUBSCRIPTION_DELETED') {
      await handleSubscriptionDeleted(db, body.subscription)
    } else {
      // Unhandled event type — ack anyway so Asaas doesn't retry
      // forever over something we deliberately don't act on.
      console.warn('[billing webhook] unhandled event:', body.event)
    }
  } catch (err) {
    // A processing bug shouldn't make Asaas hammer retries forever
    // either, but IS worth knowing about loudly.
    console.error('[billing webhook] processing failed:', body.event, err)
  }

  return NextResponse.json({ received: true })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any

async function loadSubscriptionByExternalRef(db: AdminClient, externalReference?: string) {
  if (!externalReference) return null
  // Point lookups by id rather than an embedded FK join
  // (`billing_plans(cycle_days)`) — an embed needs PostgREST's schema
  // cache to already know the plan_id -> billing_plans relationship,
  // which can be stale right after a migration adds a new FK (see the
  // same rationale in src/hooks/use-auth.tsx, issue #294).
  const { data: subscription } = await db
    .from('subscriptions')
    .select('id, account_id, plan_id')
    .eq('id', externalReference)
    .maybeSingle()
  if (!subscription) return null

  const { data: plan } = await db
    .from('billing_plans')
    .select('cycle_days')
    .eq('id', subscription.plan_id)
    .maybeSingle()

  return { ...subscription, cycleDays: plan?.cycle_days ?? 30 }
}

async function handlePaymentConfirmed(db: AdminClient, payment: AsaasWebhookPayment) {
  const subscription = await loadSubscriptionByExternalRef(db, payment.externalReference)
  if (!subscription) {
    console.warn('[billing webhook] PAYMENT_CONFIRMED for unknown subscription:', payment.externalReference)
    return
  }

  await db.from('payments').upsert(
    {
      gateway_payment_id: payment.id,
      subscription_id: subscription.id,
      account_id: subscription.account_id,
      amount_cents: Math.round((payment.value ?? 0) * 100),
      currency: 'BRL',
      status: 'confirmed',
      billing_type: payment.billingType ? payment.billingType.toLowerCase() : null,
      due_date: payment.dueDate ?? null,
      paid_at: new Date().toISOString(),
      raw_payload: payment,
    },
    { onConflict: 'gateway_payment_id' },
  )

  const cycleDays = subscription.cycleDays
  const now = new Date()
  const periodEnd = new Date(now.getTime() + cycleDays * 24 * 60 * 60 * 1000)

  await db
    .from('subscriptions')
    .update({
      status: 'active',
      billing_type: payment.billingType ? payment.billingType.toLowerCase() : null,
      gateway_subscription_id: payment.subscription ?? null,
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
    })
    .eq('id', subscription.id)
}

async function handlePaymentOverdue(db: AdminClient, payment: AsaasWebhookPayment) {
  const subscription = await loadSubscriptionByExternalRef(db, payment.externalReference)
  if (!subscription) return

  await db.from('payments').upsert(
    {
      gateway_payment_id: payment.id,
      subscription_id: subscription.id,
      account_id: subscription.account_id,
      amount_cents: Math.round((payment.value ?? 0) * 100),
      currency: 'BRL',
      status: 'overdue',
      billing_type: payment.billingType ? payment.billingType.toLowerCase() : null,
      due_date: payment.dueDate ?? null,
      raw_payload: payment,
    },
    { onConflict: 'gateway_payment_id' },
  )

  await db.from('subscriptions').update({ status: 'past_due' }).eq('id', subscription.id)
}

async function handleSubscriptionDeleted(db: AdminClient, subscription: AsaasWebhookSubscription) {
  const row = await loadSubscriptionByExternalRef(db, subscription.externalReference)
  if (!row) return
  await db
    .from('subscriptions')
    .update({ status: 'canceled', canceled_at: new Date().toISOString() })
    .eq('id', row.id)
}
