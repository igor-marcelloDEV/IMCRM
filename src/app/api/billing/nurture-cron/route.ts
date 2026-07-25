import { timingSafeEqual, randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/billing/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { findOrCreateContact } from '@/lib/whatsapp/inbound'

/**
 * Billing retention drip — two passes, same cron, same shared-secret
 * auth pattern as /api/automations/cron and /api/flows/cron:
 *
 *   24h since signup, still no paid/trialing subscription  -> 20% coupon,
 *     valid 24h, sent over WhatsApp.
 *   48h since signup, still nothing -> offer a 24h free trial instead.
 *
 * The actual WhatsApp copy is a normal Automation (trigger_type
 * 'billing_nudge_24h' / 'billing_nudge_48h') on the platform
 * operator's own account/WhatsApp connection — see the seed script
 * referenced in the plan doc. This route only decides WHO is due and
 * WHAT data (coupon code, trial link) to hand the automation via
 * context.vars; it never hardcodes message copy.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron não configurado' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const operatorAccountId = process.env.PLATFORM_OPERATOR_ACCOUNT_ID
  if (!operatorAccountId) {
    return NextResponse.json({ error: 'PLATFORM_OPERATOR_ACCOUNT_ID não configurado' }, { status: 503 })
  }

  const db = supabaseAdmin()
  const { data: operatorAccount } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', operatorAccountId)
    .maybeSingle()
  if (!operatorAccount) {
    return NextResponse.json({ error: 'Conta operadora não encontrada' }, { status: 503 })
  }

  const sent24h = await runPass(db, {
    thresholdHours: 24,
    nudgeColumn: 'nudge_20_sent_at',
    triggerType: 'billing_nudge_24h',
    operatorAccountId,
    operatorOwnerUserId: operatorAccount.owner_user_id,
    buildVars: async (accountId) => {
      const code = `VOLTA20-${randomBytes(3).toString('hex').toUpperCase()}`
      const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000)
      const { error } = await db.from('coupons').insert({
        code,
        discount_type: 'percentage',
        discount_value: 20,
        valid_until: validUntil.toISOString(),
        max_uses: 1,
        source: 'auto_24h',
        account_id: accountId,
      })
      if (error) {
        console.error('[billing nurture-cron] coupon insert failed:', error)
        return null
      }
      return {
        coupon_code: code,
        coupon_expires_at: validUntil.toISOString(),
        checkout_url: `${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/billing`,
      }
    },
  })

  const sent48h = await runPass(db, {
    thresholdHours: 48,
    nudgeColumn: 'trial_offered_at',
    triggerType: 'billing_nudge_48h',
    operatorAccountId,
    operatorOwnerUserId: operatorAccount.owner_user_id,
    buildVars: async (accountId) => {
      const token = randomBytes(24).toString('base64url')
      const { error } = await db
        .from('billing_nudges')
        .upsert({ account_id: accountId, trial_claim_token: token }, { onConflict: 'account_id' })
      if (error) {
        console.error('[billing nurture-cron] trial token upsert failed:', error)
        return null
      }
      return {
        trial_url: `${process.env.NEXT_PUBLIC_SITE_URL ?? ''}/api/billing/claim-trial?token=${token}`,
      }
    },
  })

  return NextResponse.json({ sent24h, sent48h })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any

interface PassConfig {
  thresholdHours: number
  nudgeColumn: 'nudge_20_sent_at' | 'trial_offered_at'
  triggerType: 'billing_nudge_24h' | 'billing_nudge_48h'
  operatorAccountId: string
  operatorOwnerUserId: string
  buildVars: (accountId: string) => Promise<Record<string, string> | null>
}

async function runPass(db: AdminClient, config: PassConfig): Promise<number> {
  const cutoff = new Date(Date.now() - config.thresholdHours * 60 * 60 * 1000).toISOString()

  const { data: candidates } = await db
    .from('accounts')
    .select('id, created_at')
    .lte('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(50)

  if (!candidates || candidates.length === 0) return 0

  let sent = 0
  for (const candidate of candidates as Array<{ id: string; created_at: string }>) {
    // Already converted — nothing to nudge.
    const { data: liveSub } = await db
      .from('subscriptions')
      .select('id')
      .eq('account_id', candidate.id)
      .in('status', ['trialing', 'active'])
      .maybeSingle()
    if (liveSub) continue

    // Already sent this exact nudge.
    const { data: nudgeRow } = await db
      .from('billing_nudges')
      .select(config.nudgeColumn)
      .eq('account_id', candidate.id)
      .maybeSingle()
    if (nudgeRow?.[config.nudgeColumn]) continue

    const { data: ownerProfile } = await db
      .from('profiles')
      .select('phone, full_name')
      .eq('account_id', candidate.id)
      .eq('account_role', 'owner')
      .maybeSingle()
    if (!ownerProfile?.phone) continue

    const vars = await config.buildVars(candidate.id)
    if (!vars) continue

    const contactOutcome = await findOrCreateContact(
      db,
      config.operatorAccountId,
      config.operatorOwnerUserId,
      ownerProfile.phone,
      ownerProfile.full_name || ownerProfile.phone,
    )
    if (!contactOutcome) continue

    await runAutomationsForTrigger({
      accountId: config.operatorAccountId,
      triggerType: config.triggerType,
      contactId: contactOutcome.contact.id,
      context: { vars },
    })

    await db
      .from('billing_nudges')
      .upsert({ account_id: candidate.id, [config.nudgeColumn]: new Date().toISOString() }, { onConflict: 'account_id' })

    sent++
  }

  return sent
}
