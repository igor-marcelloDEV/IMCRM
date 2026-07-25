import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/billing/admin-client'

/**
 * Landing page for the 48h "want a free trial instead?" WhatsApp
 * link. No login required — the token itself (see nurture-cron)
 * IS the credential, same trust model as an email magic-link.
 * Provisions a 24h trial subscription for the account tied to that
 * token, then bounces the browser into the app. If the token's
 * account already has a live subscription (they converted through
 * some other path in the meantime) or the token was already used,
 * this is a no-op redirect rather than an error page — a customer
 * clicking an old link shouldn't hit a dead end.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token')
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? ''

  if (!token) {
    return NextResponse.redirect(`${siteUrl}/billing`)
  }

  const db = supabaseAdmin()
  const { data: nudge } = await db
    .from('billing_nudges')
    .select('account_id, trial_claimed_at')
    .eq('trial_claim_token', token)
    .maybeSingle()

  if (!nudge || nudge.trial_claimed_at) {
    return NextResponse.redirect(`${siteUrl}/billing`)
  }

  const { data: liveSub } = await db
    .from('subscriptions')
    .select('id')
    .eq('account_id', nudge.account_id)
    .in('status', ['pending', 'trialing', 'active', 'past_due'])
    .maybeSingle()

  if (!liveSub) {
    const { data: plan } = await db
      .from('billing_plans')
      .select('id')
      .eq('code', 'monthly')
      .maybeSingle()

    if (plan) {
      await db.from('subscriptions').insert({
        account_id: nudge.account_id,
        plan_id: plan.id,
        status: 'trialing',
        trial_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
    }
  }

  await db
    .from('billing_nudges')
    .update({ trial_claimed_at: new Date().toISOString() })
    .eq('account_id', nudge.account_id)

  return NextResponse.redirect(`${siteUrl}/login`)
}
