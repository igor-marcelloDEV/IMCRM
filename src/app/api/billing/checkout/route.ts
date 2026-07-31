import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/billing/admin-client'
import {
  getAsaasConfig,
  createOrGetCustomer,
  createPixPayment,
  createBoletoPayment,
  createSubscription,
  getFirstSubscriptionPaymentInvoiceUrl,
} from '@/lib/billing/asaas'
import { computePrice, centsToReais } from '@/lib/billing/pricing'

type BillingType = 'pix' | 'boleto' | 'credit_card'
const BILLING_TYPES: BillingType[] = ['pix', 'boleto', 'credit_card']
const PLAN_CODES = ['weekly', 'monthly', 'annual'] as const

/** Digits-only, 11 (CPF) or 14 (CNPJ) — the exact shape Asaas expects.
 *  Not a full checksum validator; Asaas rejects a structurally-invalid
 *  document on its own, this just avoids an obviously-wrong length
 *  round-tripping to the gateway. */
function normalizeCpfCnpj(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  return digits.length === 11 || digits.length === 14 ? digits : null
}

/**
 * Starts a checkout: creates (or reuses) the Asaas customer, creates
 * the actual charge/subscription on the gateway, and records our own
 * `subscriptions` row as `status='pending'` — the webhook flips it to
 * `active` once Asaas confirms payment.
 *
 * The price is ALWAYS recomputed here from `billing_plans` + the
 * coupon looked up server-side — the client only ever sends a plan
 * code, a billing type, and an optional coupon code, never an amount.
 */
export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()

    const body = (await request.json().catch(() => null)) as {
      planCode?: unknown
      billingType?: unknown
      couponCode?: unknown
      cpfCnpj?: unknown
    } | null

    const planCode = body?.planCode
    const billingType = body?.billingType
    const couponCode = typeof body?.couponCode === 'string' ? body.couponCode.trim() : ''
    const cpfCnpjInput = typeof body?.cpfCnpj === 'string' ? normalizeCpfCnpj(body.cpfCnpj) : null

    if (typeof planCode !== 'string' || !PLAN_CODES.includes(planCode as (typeof PLAN_CODES)[number])) {
      return NextResponse.json({ error: 'Plano inválido' }, { status: 400 })
    }
    if (typeof billingType !== 'string' || !BILLING_TYPES.includes(billingType as BillingType)) {
      return NextResponse.json({ error: 'Forma de pagamento inválida' }, { status: 400 })
    }

    const db = supabaseAdmin()

    const { data: plan, error: planErr } = await db
      .from('billing_plans')
      .select('id, code, name, price_cents, currency, asaas_cycle')
      .eq('code', planCode)
      .eq('is_active', true)
      .maybeSingle()
    if (planErr || !plan) {
      return NextResponse.json({ error: 'Plano não encontrado' }, { status: 404 })
    }

    // Refuse a second checkout while one is already pending/active —
    // the partial unique index would also catch this as a 23505, but
    // checking first gives a much friendlier error than a raw
    // constraint-violation message.
    const { data: existing } = await db
      .from('subscriptions')
      .select('id, status')
      .eq('account_id', ctx.accountId)
      .in('status', ['pending', 'trialing', 'active', 'past_due'])
      .maybeSingle()
    if (existing) {
      return NextResponse.json(
        { error: 'Esta conta já tem uma assinatura em andamento', status: existing.status },
        { status: 409 },
      )
    }

    // Coupon: atomic claim (consumes a use) — never a plain SELECT,
    // see claim_coupon() in migration 041.
    let couponId: string | null = null
    let couponBreakdown: { discountType: 'percentage' | 'fixed'; discountValue: number } | null = null
    if (couponCode) {
      const { data: claimedId, error: claimErr } = await db.rpc('claim_coupon', {
        p_code: couponCode,
        p_account_id: ctx.accountId,
      })
      if (claimErr) {
        console.error('[billing checkout] claim_coupon failed:', claimErr)
        return NextResponse.json({ error: 'Não foi possível validar o cupom' }, { status: 500 })
      }
      if (!claimedId) {
        return NextResponse.json({ error: 'Cupom inválido, expirado ou já utilizado' }, { status: 400 })
      }
      couponId = claimedId as string
      const { data: couponRow } = await db
        .from('coupons')
        .select('discount_type, discount_value')
        .eq('id', couponId)
        .maybeSingle()
      if (couponRow) {
        couponBreakdown = {
          discountType: couponRow.discount_type,
          discountValue: Number(couponRow.discount_value),
        }
      }
    }

    const price = computePrice(plan.price_cents, billingType as BillingType, couponBreakdown)

    const { data: profile } = await db
      .from('profiles')
      .select('full_name, email, phone, cpf_cnpj')
      .eq('user_id', ctx.userId)
      .maybeSingle()
    if (!profile?.phone) {
      return NextResponse.json(
        { error: 'Cadastre um telefone antes de assinar' },
        { status: 400 },
      )
    }

    // Asaas requires a CPF/CNPJ on the customer to create ANY charge
    // (PIX, boleto, or card) — "Para criar esta cobrança é necessário
    // preencher o CPF ou CNPJ do cliente." Take it from the request if
    // freshly typed, otherwise fall back to what's already on file so
    // a returning customer isn't asked twice.
    const cpfCnpj = cpfCnpjInput ?? profile.cpf_cnpj ?? null
    if (!cpfCnpj) {
      return NextResponse.json(
        { error: 'Informe um CPF ou CNPJ válido para gerar a cobrança' },
        { status: 400 },
      )
    }
    if (cpfCnpjInput && cpfCnpjInput !== profile.cpf_cnpj) {
      await db.from('profiles').update({ cpf_cnpj: cpfCnpjInput }).eq('user_id', ctx.userId)
    }

    const asaasConfig = getAsaasConfig()
    const customer = await createOrGetCustomer({
      config: asaasConfig,
      name: profile.full_name || ctx.account.name,
      email: profile.email,
      phone: profile.phone,
      cpfCnpj,
      externalReference: ctx.accountId,
    })

    // Insert the pending row FIRST so its id exists to hand to Asaas
    // as `externalReference` — the webhook and the card-payment step
    // below both correlate back to this row through that field.
    const { data: subscription, error: subErr } = await db
      .from('subscriptions')
      .insert({
        account_id: ctx.accountId,
        plan_id: plan.id,
        status: 'pending',
        billing_type: billingType,
        gateway_customer_id: customer.id,
        coupon_id: couponId,
        expected_amount_cents: price.finalCents,
      })
      .select('id')
      .single()
    if (subErr || !subscription) {
      console.error('[billing checkout] subscription insert failed:', subErr)
      return NextResponse.json({ error: 'Falha ao iniciar a assinatura' }, { status: 500 })
    }

    if (couponId) {
      await db.from('coupon_redemptions').insert({ coupon_id: couponId, account_id: ctx.accountId })
    }

    const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const valueReais = centsToReais(price.finalCents)

    // The gateway call is the one step here that can fail for reasons
    // outside our control (a missing field Asaas rejects, a transient
    // gateway error, ...). Without this try/catch, a failure here left
    // the just-inserted `subscriptions` row stuck at status='pending'
    // forever — and the "one live subscription per account" guard
    // above then permanently blocked every future checkout attempt on
    // that account. Clean up so the customer can just try again.
    try {
      if (billingType === 'pix') {
        const { payment, qrCode } = await createPixPayment({
          config: asaasConfig,
          customerId: customer.id,
          value: valueReais,
          dueDate,
          description: `IMCRM — ${plan.name}`,
          externalReference: subscription.id,
        })
        return NextResponse.json({
          subscriptionId: subscription.id,
          billingType: 'pix',
          pix: { qrCodeImage: qrCode.encodedImage, payload: qrCode.payload, expirationDate: qrCode.expirationDate },
          paymentId: payment.id,
          amountCents: price.finalCents,
        })
      }

      if (billingType === 'boleto') {
        const payment = await createBoletoPayment({
          config: asaasConfig,
          customerId: customer.id,
          value: valueReais,
          dueDate,
          description: `IMCRM — ${plan.name}`,
          externalReference: subscription.id,
        })
        return NextResponse.json({
          subscriptionId: subscription.id,
          billingType: 'boleto',
          redirectUrl: payment.invoiceUrl,
          amountCents: price.finalCents,
        })
      }

      // credit_card — real recurring subscription on the gateway.
      const gatewaySubscription = await createSubscription({
        config: asaasConfig,
        customerId: customer.id,
        cycle: plan.asaas_cycle,
        value: valueReais,
        billingType: 'CREDIT_CARD',
        nextDueDate: dueDate,
        externalReference: subscription.id,
      })
      await db
        .from('subscriptions')
        .update({ gateway_subscription_id: gatewaySubscription.id })
        .eq('id', subscription.id)

      const invoiceUrl = await getFirstSubscriptionPaymentInvoiceUrl(asaasConfig, gatewaySubscription.id)
      return NextResponse.json({
        subscriptionId: subscription.id,
        billingType: 'credit_card',
        redirectUrl: invoiceUrl,
        amountCents: price.finalCents,
      })
    } catch (chargeErr) {
      await db.from('subscriptions').delete().eq('id', subscription.id)
      if (couponId) {
        // Give the use back — the charge never actually happened.
        await db.from('coupon_redemptions').delete().eq('coupon_id', couponId).eq('account_id', ctx.accountId)
        const { error: releaseErr } = await db.rpc('release_coupon_use', { p_coupon_id: couponId })
        if (releaseErr) console.error('[billing checkout] release_coupon_use failed:', releaseErr)
      }
      throw chargeErr
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('ASAAS_API_KEY')) {
      return NextResponse.json({ error: err.message }, { status: 503 })
    }
    return toErrorResponse(err)
  }
}
