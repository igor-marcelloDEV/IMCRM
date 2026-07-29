import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { verifyInstagramAccount } from '@/lib/instagram/graph-api'

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/instagram/config
 *
 * Any member may read (mirrors /api/ai/config and /api/whatsapp/config)
 * — the encrypted token is never returned, only a `has_token` flag.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('instagram_configs')
      .select(
        'page_id, instagram_business_account_id, username, status, last_error, connected_at, access_token',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[instagram/config GET] fetch error:', error)
      return NextResponse.json({ error: 'Falha ao carregar a configuração do Instagram' }, { status: 500 })
    }

    if (!data) return NextResponse.json({ configured: false })
    const { access_token, ...safe } = data
    return NextResponse.json({ configured: true, has_token: !!access_token, ...safe })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/instagram/config  (admin+)
 *
 * Validates the Page id / IG Business Account id / access token against
 * the Graph API before persisting — same "verify before save" discipline
 * as the WhatsApp and AI configs. `access_token`/`verify_token` are
 * omitted when the form didn't change them (reuses the stored value).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Corpo da requisição inválido')

    const pageId = typeof body.page_id === 'string' ? body.page_id.trim() : ''
    const igAccountId =
      typeof body.instagram_business_account_id === 'string'
        ? body.instagram_business_account_id.trim()
        : ''
    if (!pageId) return bad("O campo 'page_id' é obrigatório")
    if (!igAccountId) return bad("O campo 'instagram_business_account_id' é obrigatório")

    const rawToken = typeof body.access_token === 'string' ? body.access_token.trim() : ''
    const rawVerifyToken =
      typeof body.verify_token === 'string' ? body.verify_token.trim() : ''

    const { data: existing } = await supabase
      .from('instagram_configs')
      .select('id, access_token, verify_token')
      .eq('account_id', accountId)
      .maybeSingle()

    let accessTokenPlain: string
    if (rawToken) {
      accessTokenPlain = rawToken
    } else if (existing?.access_token) {
      try {
        accessTokenPlain = decrypt(existing.access_token)
      } catch {
        return bad('Não foi possível descriptografar o token salvo — cole o token novamente.')
      }
    } else {
      return bad("O campo 'access_token' é obrigatório")
    }

    let verifyTokenPlain: string
    if (rawVerifyToken) {
      verifyTokenPlain = rawVerifyToken
    } else if (existing?.verify_token) {
      try {
        verifyTokenPlain = decrypt(existing.verify_token)
      } catch {
        return bad('Não foi possível descriptografar o verify token salvo — digite-o novamente.')
      }
    } else {
      return bad("O campo 'verify_token' é obrigatório")
    }

    // Verify against the Graph API before persisting — a wrong token or
    // id surfaces here as a clear 400, not as a silently-dead webhook.
    let accountInfo
    try {
      accountInfo = await verifyInstagramAccount({
        instagramBusinessAccountId: igAccountId,
        accessToken: accessTokenPlain,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha ao validar com a Graph API'
      return bad(`Não foi possível confirmar a conta do Instagram: ${message}`)
    }

    // instagram_business_account_id is globally unique (migration 050) —
    // surface a clear conflict instead of a raw DB constraint error.
    const { data: claimedBy } = await supabase
      .from('instagram_configs')
      .select('account_id')
      .eq('instagram_business_account_id', igAccountId)
      .neq('account_id', accountId)
      .maybeSingle()
    if (claimedBy) {
      return bad('Esta conta do Instagram já está conectada a outra conta do IMCRM.')
    }

    const shared = {
      page_id: pageId,
      instagram_business_account_id: igAccountId,
      access_token: encrypt(accessTokenPlain),
      verify_token: encrypt(verifyTokenPlain),
      username: accountInfo.username ?? null,
      status: 'connected' as const,
      last_error: null,
      connected_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('instagram_configs')
        .update(shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[instagram/config POST] update error:', upErr)
        return NextResponse.json({ error: 'Falha ao salvar a configuração do Instagram' }, { status: 500 })
      }
    } else {
      const { error: insErr } = await supabase.from('instagram_configs').insert({
        account_id: accountId,
        created_by: userId,
        ...shared,
      })
      if (insErr) {
        console.error('[instagram/config POST] insert error:', insErr)
        return NextResponse.json({ error: 'Falha ao salvar a configuração do Instagram' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true, username: accountInfo.username ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/instagram/config  (admin+)
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase.from('instagram_configs').delete().eq('account_id', accountId)
    if (error) {
      console.error('[instagram/config DELETE] error:', error)
      return NextResponse.json({ error: 'Falha ao desconectar o Instagram' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
