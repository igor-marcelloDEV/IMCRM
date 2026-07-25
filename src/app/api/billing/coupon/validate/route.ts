import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/billing/admin-client'

/**
 * Read-only coupon preview for the checkout UI — does NOT consume a
 * use. The atomic, use-consuming claim happens in POST
 * /api/billing/checkout at the moment the order is actually placed
 * (via the claim_coupon() RPC), so someone previewing a code without
 * completing checkout can't burn a single-use coupon's only use.
 *
 * `coupons` has no client RLS policy at all (see migration 041) —
 * every read goes through the service-role client here, gated by
 * this route's own account-scoping logic instead.
 */
export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => null)) as { code?: unknown } | null
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    if (!code) {
      return NextResponse.json({ valid: false, reason: 'empty' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: coupon } = await db
      .from('coupons')
      .select('id, discount_type, discount_value, valid_until, max_uses, uses_count, is_active, account_id')
      .ilike('code', code)
      .maybeSingle()

    if (!coupon) {
      return NextResponse.json({ valid: false, reason: 'not_found' })
    }
    if (!coupon.is_active) {
      return NextResponse.json({ valid: false, reason: 'inactive' })
    }
    if (new Date(coupon.valid_until).getTime() <= Date.now()) {
      return NextResponse.json({ valid: false, reason: 'expired' })
    }
    if (coupon.uses_count >= coupon.max_uses) {
      return NextResponse.json({ valid: false, reason: 'exhausted' })
    }
    if (coupon.account_id && coupon.account_id !== ctx.accountId) {
      // Deliberately the same "not_found" reason as a missing code —
      // doesn't confirm to the caller that a code tied to someone
      // else's account exists at all.
      return NextResponse.json({ valid: false, reason: 'not_found' })
    }

    return NextResponse.json({
      valid: true,
      discountType: coupon.discount_type as 'percentage' | 'fixed',
      discountValue: Number(coupon.discount_value),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
