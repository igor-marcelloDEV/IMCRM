import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/whatsapp/baileys/connect
 *
 * Starts (or restarts) a WhatsApp Web pairing for the caller's
 * account: tells the `whatsapp-worker` service to open a Baileys
 * socket and begin generating a QR code, then flips
 * `accounts.active_whatsapp_provider` to `'baileys'` so sends route
 * through it going forward.
 *
 * The worker owns `baileys_connections.status`/`qr_code` directly
 * (it writes there with the service role as pairing progresses) — this
 * route only kicks the process off. The Settings UI polls
 * `baileys_connections` (readable via RLS) for the QR/status, same as
 * any other Supabase-client read; no need for a dedicated status route.
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
    if (!workerBaseUrl || !workerSecret) {
      return NextResponse.json(
        {
          error:
            'O worker do WhatsApp Web não está configurado neste ambiente. Defina WHATSAPP_WORKER_URL e WORKER_API_SECRET.',
        },
        { status: 500 },
      )
    }

    let workerResponse: Response
    try {
      workerResponse = await fetch(
        `${workerBaseUrl.replace(/\/$/, '')}/connect/${accountId}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${workerSecret}` },
        },
      )
    } catch (err) {
      console.error('[baileys/connect] worker unreachable:', err)
      return NextResponse.json(
        { error: 'Não foi possível contatar o worker do WhatsApp Web.' },
        { status: 502 },
      )
    }

    if (!workerResponse.ok) {
      const text = await workerResponse.text().catch(() => '')
      return NextResponse.json(
        { error: text || `Worker respondeu ${workerResponse.status}` },
        { status: 502 },
      )
    }

    // The worker is now the source of truth for status/QR — it writes
    // baileys_connections directly as pairing progresses. Set the
    // account's active provider so sends route through Baileys as soon
    // as the connection lands (matches the Meta save flow, which also
    // considers "credentials saved" the moment of activation).
    const { error: updateError } = await supabase
      .from('accounts')
      .update({ active_whatsapp_provider: 'baileys' })
      .eq('id', accountId)

    if (updateError) {
      console.error('[baileys/connect] failed to activate provider:', updateError)
      return NextResponse.json(
        { error: 'Worker iniciado, mas falha ao ativar o provedor. Tente novamente.' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in baileys/connect POST:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
