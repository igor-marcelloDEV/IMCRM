/**
 * Price computation shared by the checkout API and UI. Kept separate
 * from `src/lib/currency.ts` on purpose — that formatter deliberately
 * truncates to whole units for deal values, but a plan price like
 * R$49,90 needs its cents shown.
 */

/** PIX pays 10% less than the sticker price — see the plan doc: "10%
 *  de desconto no pix, ou uso de cupom" reads as alternatives, not
 *  stacked, so this only applies when NO coupon is used. */
export const PIX_DISCOUNT_RATE = 0.1

export interface PriceBreakdown {
  /** Sticker price, in cents. */
  baseCents: number
  /** What the customer actually pays, in cents, after PIX/coupon. */
  finalCents: number
  /** Which discount (if any) was applied. */
  discount: 'pix' | 'coupon' | null
  /** Cents saved vs. baseCents. */
  savedCents: number
}

export interface AppliedCoupon {
  discountType: 'percentage' | 'fixed'
  /** Percentage points (0-100) or a flat cents amount, per discountType. */
  discountValue: number
}

/**
 * Computes the final price for a plan given the chosen billing type
 * and an optional coupon. Coupon always wins over the PIX discount
 * (never both) — the server is the only place this runs; the
 * checkout UI mirrors it for display but the API recomputes from
 * scratch rather than trusting a client-sent total.
 */
export function computePrice(
  baseCents: number,
  billingType: 'pix' | 'boleto' | 'credit_card',
  coupon: AppliedCoupon | null,
): PriceBreakdown {
  if (coupon) {
    const discountCents =
      coupon.discountType === 'percentage'
        ? Math.round((baseCents * coupon.discountValue) / 100)
        : Math.round(coupon.discountValue * 100)
    const finalCents = Math.max(0, baseCents - discountCents)
    return { baseCents, finalCents, discount: 'coupon', savedCents: baseCents - finalCents }
  }

  if (billingType === 'pix') {
    const finalCents = Math.round(baseCents * (1 - PIX_DISCOUNT_RATE))
    return { baseCents, finalCents, discount: 'pix', savedCents: baseCents - finalCents }
  }

  return { baseCents, finalCents: baseCents, discount: null, savedCents: 0 }
}

/** cents → reais, for the Asaas API (which takes decimal amounts). */
export function centsToReais(cents: number): number {
  return Math.round(cents) / 100
}

/** Locale-aware "R$ 49,90" style formatting, cents-accurate (unlike
 *  formatCurrency in src/lib/currency.ts, which is whole-unit only). */
export function formatPriceCents(cents: number, currency: string = 'BRL'): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
    }).format(cents / 100)
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`
  }
}
