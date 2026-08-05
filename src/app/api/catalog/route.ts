import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Product/service catalog — sold through the `show_catalog` /
// `checkout` Flow node types. GET lists everything (active + inactive,
// so the manager UI can show/toggle both); POST creates. Mirrors
// src/app/api/quick-replies/route.ts — RLS-scoped read via the user
// client, service-role write after an explicit admin check (catalog
// pricing is a settings-class write, same tier as whatsapp_config).

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('catalog_items')
      .select('*')
      .order('position', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ catalog_items: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: "O campo 'name' é obrigatório" }, { status: 400 })
  }
  const priceCents = Number(body.price_cents)
  if (!Number.isFinite(priceCents) || priceCents < 0) {
    return NextResponse.json({ error: "O campo 'price_cents' deve ser um número >= 0" }, { status: 400 })
  }
  const mediaType = body.media_type === 'image' || body.media_type === 'video' ? body.media_type : null
  if (body.media_url && !mediaType) {
    return NextResponse.json({ error: "'media_type' é obrigatório quando 'media_url' é definido" }, { status: 400 })
  }
  let stockQuantity: number | null = null
  if (body.stock_quantity !== undefined && body.stock_quantity !== null && body.stock_quantity !== '') {
    const parsed = Number(body.stock_quantity)
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      return NextResponse.json({ error: "'stock_quantity' deve ser um número inteiro >= 0" }, { status: 400 })
    }
    stockQuantity = parsed
  }
  const offerType = ['physical_product', 'service', 'subscription'].includes(body.offer_type) ? body.offer_type : 'service'
  const billingCycle = offerType === 'subscription' && ['MONTHLY', 'QUARTERLY', 'SEMIANNUALLY', 'YEARLY'].includes(body.billing_cycle) ? body.billing_cycle : null
  if (offerType === 'subscription' && !billingCycle) return NextResponse.json({ error: 'Selecione a periodicidade da assinatura.' }, { status: 400 })
  const compareAt = body.compare_at_price_cents === null || body.compare_at_price_cents === '' ? null : Number(body.compare_at_price_cents)
  if (compareAt !== null && (!Number.isFinite(compareAt) || compareAt < priceCents)) return NextResponse.json({ error: 'O preço original deve ser maior ou igual ao preço de venda.' }, { status: 400 })

  const { data: account } = await ctx.supabase
    .from('accounts')
    .select('default_currency')
    .eq('id', ctx.accountId)
    .maybeSingle()

  const { data, error } = await supabaseAdmin()
    .from('catalog_items')
    .insert({
      account_id: ctx.accountId,
      name,
      description: typeof body.description === 'string' ? body.description.trim() || null : null,
      price_cents: Math.round(priceCents),
      currency: account?.default_currency ?? 'BRL',
      media_url: typeof body.media_url === 'string' ? body.media_url : null,
      media_type: mediaType,
      is_upsell: body.is_upsell === true,
      is_active: body.is_active !== false,
      position: Number.isFinite(Number(body.position)) ? Number(body.position) : 0,
      stock_quantity: stockQuantity,
      offer_type: offerType,
      billing_cycle: billingCycle,
      compare_at_price_cents: compareAt === null ? null : Math.round(compareAt),
      trial_days: offerType === 'subscription' ? Math.min(Math.max(Number(body.trial_days) || 0, 0), 365) : 0,
      campaign_badge: typeof body.campaign_badge === 'string' ? body.campaign_badge.trim().slice(0, 40) || null : null,
      sku: typeof body.sku === 'string' ? body.sku.trim().slice(0, 80) || null : null,
      ncm: offerType === 'physical_product' && typeof body.ncm === 'string' ? body.ncm.replace(/\D/g, '').slice(0, 8) || null : null,
      cest: offerType === 'physical_product' && typeof body.cest === 'string' ? body.cest.replace(/\D/g, '').slice(0, 7) || null : null,
      cfop: offerType === 'physical_product' && typeof body.cfop === 'string' ? body.cfop.replace(/\D/g, '').slice(0, 4) || null : null,
      fiscal_unit: typeof body.fiscal_unit === 'string' ? body.fiscal_unit.trim().toUpperCase().slice(0, 6) || 'UN' : 'UN',
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ catalog_item: data }, { status: 201 })
}
