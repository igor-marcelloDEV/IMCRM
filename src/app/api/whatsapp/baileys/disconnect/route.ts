import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/whatsapp/baileys/disconnect
 *
 * Logs out the account's WhatsApp Web session: tells the worker to
 * destroy the Baileys socket (and its stored auth keys — a fresh QR
 * will be required next time), then marks `baileys_connections` as
 * disconnected. Does NOT change `active_whatsapp_provider` — same as
 * Meta's config DELETE, this leaves the account "configured for X but
 * not connected" rather than silently switching providers underneath
 * the user.
 */
export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id, account_role')
      .eq('user_id', user.id)
      .maybeSingle()

    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Seu perfil não está vinculado a uma conta.' },
        { status: 403 },
      )
    }
    if (profile?.account_role !== 'owner' && profile?.account_role !== 'admin') {
      return NextResponse.json(
        { error: 'Apenas administradores podem alterar a conexão do WhatsApp.' },
        { status: 403 },
      )
    }

    const workerBaseUrl = process.env.WHATSAPP_WORKER_URL
    const workerSecret = process.env.WORKER_API_SECRET
    if (workerBaseUrl && workerSecret) {
      try {
        await fetch(`${workerBaseUrl.replace(/\/$/, '')}/disconnect/${accountId}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${workerSecret}` },
        })
      } catch (err) {
        // Best-effort — still mark disconnected locally below even if
        // the worker is unreachable, so the UI doesn't get stuck.
        console.warn('[baileys/disconnect] worker unreachable:', err)
      }
    }

    const { error: updateError } = await supabase
      .from('baileys_connections')
      .update({
        status: 'disconnected',
        qr_code: null,
        phone_number: null,
      })
      .eq('account_id', accountId)

    if (updateError) {
      console.error('[baileys/disconnect] failed to update status:', updateError)
      return NextResponse.json(
        { error: 'Falha ao atualizar o status da conexão.' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in baileys/disconnect POST:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
