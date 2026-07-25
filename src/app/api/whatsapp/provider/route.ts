import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

/**
 * POST /api/whatsapp/provider
 *
 * Switches which WhatsApp provider is active for the caller's account
 * (`accounts.active_whatsapp_provider`). Used by the Settings
 * connection-method cards: picking "Meta Cloud API" calls this
 * directly (reactivating already-saved credentials needs no re-
 * verification); picking "WhatsApp Web" instead goes through
 * `/api/whatsapp/baileys/connect`, which flips the same column as
 * part of starting a pairing.
 */
export async function POST(request: Request) {
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

    const body = await request.json()
    const { provider } = body
    if (provider !== 'meta_cloud_api' && provider !== 'baileys') {
      return NextResponse.json(
        { error: "O campo 'provider' deve ser 'meta_cloud_api' ou 'baileys'." },
        { status: 400 },
      )
    }

    const { error: updateError } = await supabase
      .from('accounts')
      .update({ active_whatsapp_provider: provider })
      .eq('id', accountId)

    if (updateError) {
      console.error('Error updating active_whatsapp_provider:', updateError)
      return NextResponse.json(
        { error: 'Falha ao trocar o provedor de WhatsApp' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, provider })
  } catch (error) {
    console.error('Error in whatsapp/provider POST:', error)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}
