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
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ catalog_item: data }, { status: 201 })
}
