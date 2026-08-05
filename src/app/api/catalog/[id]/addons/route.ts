import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

// Add-on groups (+ their options) for one catalog product. GET is any
// member (mirrors catalog_items_select); PUT replaces the whole set —
// simplest correct semantics for a low-cardinality nested form saved
// as one unit from the Catalog Manager, same as how the rest of that
// dialog saves the product in one PATCH.

interface AddonInput {
  id?: string
  name: string
  price_cents: number
  is_active: boolean
}
interface GroupInput {
  id?: string
  name: string
  required: boolean
  min_select: number
  max_select: number
  options: AddonInput[]
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase } = await requireRole('agent')
    const { id } = await params
    const { data, error } = await supabase
      .from('catalog_item_addon_groups')
      .select('id,account_id,catalog_item_id,name,required,min_select,max_select,position,options:catalog_item_addons(id,group_id,name,price_cents,is_active,position)')
      .eq('catalog_item_id', id)
      .order('position', { ascending: true })
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    const groups = (data ?? []).map((g) => ({ ...g, options: (g.options ?? []).sort((a, b) => a.position - b.position) }))
    return NextResponse.json({ addon_groups: groups })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let ctx
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }
  const { id: catalogItemId } = await params

  const body = await request.json().catch(() => null)
  const groups: GroupInput[] = Array.isArray(body?.addon_groups) ? body.addon_groups : null
  if (!groups) return NextResponse.json({ error: 'JSON inválido' }, { status: 400 })

  for (const g of groups) {
    if (typeof g.name !== 'string' || !g.name.trim()) {
      return NextResponse.json({ error: 'Todo grupo de adicionais precisa de um nome.' }, { status: 400 })
    }
    if (!Array.isArray(g.options) || g.options.some((o) => typeof o.name !== 'string' || !o.name.trim())) {
      return NextResponse.json({ error: 'Toda opção de adicional precisa de um nome.' }, { status: 400 })
    }
  }

  const db = supabaseAdmin()

  // Verify the product actually belongs to this account before writing
  // anything — the service-role client bypasses RLS, so this check IS
  // the tenancy guard here.
  const { data: item } = await db
    .from('catalog_items')
    .select('id')
    .eq('id', catalogItemId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!item) return NextResponse.json({ error: 'Produto não encontrado.' }, { status: 404 })

  // Replace-all: delete groups no longer present, then upsert the rest.
  // Cascades to catalog_item_addons via FK ON DELETE CASCADE.
  const keepGroupIds = groups.filter((g) => g.id).map((g) => g.id as string)
  const deleteQuery = db.from('catalog_item_addon_groups').delete().eq('catalog_item_id', catalogItemId)
  const { error: deleteErr } = keepGroupIds.length
    ? await deleteQuery.not('id', 'in', `(${keepGroupIds.join(',')})`)
    : await deleteQuery
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 500 })

  for (const [groupIndex, group] of groups.entries()) {
    const groupPayload = {
      account_id: ctx.accountId,
      catalog_item_id: catalogItemId,
      name: group.name.trim(),
      required: group.required === true,
      min_select: Math.max(0, Math.round(Number(group.min_select) || 0)),
      max_select: Math.max(1, Math.round(Number(group.max_select) || 1)),
      position: groupIndex,
    }

    let groupId = group.id
    if (groupId) {
      const { error } = await db.from('catalog_item_addon_groups').update(groupPayload).eq('id', groupId).eq('account_id', ctx.accountId)
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    } else {
      const { data, error } = await db.from('catalog_item_addon_groups').insert(groupPayload).select('id').single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      groupId = data.id
    }

    const keepOptionIds = group.options.filter((o) => o.id).map((o) => o.id as string)
    const deleteOptionsQuery = db.from('catalog_item_addons').delete().eq('group_id', groupId)
    const { error: deleteOptErr } = keepOptionIds.length
      ? await deleteOptionsQuery.not('id', 'in', `(${keepOptionIds.join(',')})`)
      : await deleteOptionsQuery
    if (deleteOptErr) return NextResponse.json({ error: deleteOptErr.message }, { status: 500 })

    for (const [optionIndex, option] of group.options.entries()) {
      const priceCents = Math.max(0, Math.round(Number(option.price_cents) || 0))
      const optionPayload = {
        group_id: groupId,
        name: option.name.trim(),
        price_cents: priceCents,
        is_active: option.is_active !== false,
        position: optionIndex,
      }
      if (option.id) {
        const { error } = await db.from('catalog_item_addons').update(optionPayload).eq('id', option.id)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      } else {
        const { error } = await db.from('catalog_item_addons').insert(optionPayload)
        if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }
  }

  return NextResponse.json({ ok: true })
}
