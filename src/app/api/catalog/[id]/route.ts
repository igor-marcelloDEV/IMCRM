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
