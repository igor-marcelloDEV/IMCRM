import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Update / delete a single catalog item. Mirrors
// src/app/api/quick-replies/[id]/route.ts — every mutation is scoped
// by `account_id` since the service-role client bypasses RLS.

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })

  const update: Record<string, unknown> = {}
  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: "O campo 'name' não pode estar vazio" }, { status: 400 })
    update.name = name
  }
  if ('description' in body) {
    update.description = typeof body.description === 'string' ? body.description.trim() || null : null
  }
  if ('price_cents' in body) {
    const priceCents = Number(body.price_cents)
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      return NextResponse.json({ error: "O campo 'price_cents' deve ser um número >= 0" }, { status: 400 })
    }
    update.price_cents = Math.round(priceCents)
  }
  if ('media_url' in body) update.media_url = typeof body.media_url === 'string' ? body.media_url : null
  if ('media_type' in body) {
    const mediaType = body.media_type === 'image' || body.media_type === 'video' ? body.media_type : null
    update.media_type = mediaType
  }
  if ('is_upsell' in body) update.is_upsell = body.is_upsell === true
  if ('is_active' in body) update.is_active = body.is_active !== false
  if ('position' in body && Number.isFinite(Number(body.position))) update.position = Number(body.position)
  if ('stock_quantity' in body) {
    if (body.stock_quantity === null || body.stock_quantity === '') {
      update.stock_quantity = null
    } else {
      const parsed = Number(body.stock_quantity)
      if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
        return NextResponse.json({ error: "'stock_quantity' deve ser um número inteiro >= 0" }, { status: 400 })
      }
      update.stock_quantity = parsed
    }
  }
  if ('offer_type' in body) update.offer_type = ['physical_product', 'service', 'subscription'].includes(body.offer_type) ? body.offer_type : 'service'
  if ('billing_cycle' in body) update.billing_cycle = ['MONTHLY', 'QUARTERLY', 'SEMIANNUALLY', 'YEARLY'].includes(body.billing_cycle) ? body.billing_cycle : null
  if ('compare_at_price_cents' in body) update.compare_at_price_cents = body.compare_at_price_cents === null || body.compare_at_price_cents === '' ? null : Math.round(Number(body.compare_at_price_cents))
  if ('trial_days' in body) update.trial_days = Math.min(Math.max(Number(body.trial_days) || 0, 0), 365)
  for (const field of ['campaign_badge', 'sku', 'ncm', 'cest', 'cfop', 'fiscal_unit'] as const) {
    if (field in body) update[field] = typeof body[field] === 'string' ? body[field].trim().slice(0, 80) || null : null
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true })
  }

  const { error } = await supabaseAdmin()
    .from('catalog_items')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const { error } = await supabaseAdmin()
    .from('catalog_items')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
