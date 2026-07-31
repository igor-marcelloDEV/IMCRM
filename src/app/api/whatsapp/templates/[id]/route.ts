import { NextResponse } from 'next/server'
import {
  requireRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  deleteMessageTemplate,
  editMessageTemplate,
} from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit). Used
 *          by the "Edit" action on APPROVED rows and the "Resubmit"
 *          action on REJECTED / PAUSED rows. Meta replaces components
 *          wholesale on edit and bumps status back to PENDING.
 *
 * DELETE — remove the template on Meta (when meta_template_id is set,
 *          scoped to a single language variant via hsm_id) AND drop
 *          the local row. Local-only rows skip the Meta call.
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint — keep this route narrowly about lifecycle of
 * already-submitted templates.
 */

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

// uuid v4 plus the looser shape Postgres gen_random_uuid emits.
// We don't need exhaustive RFC parsing — just enough to reject
// "../etc/passwd"-style payloads before they hit Supabase.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  )
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let ctx: AccountContext
  try {
    ctx = await requireRole('admin')
  } catch (error) {
    return toErrorResponse(error)
  }

  try {
    const { supabase, accountId } = ctx
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'ID de modelo inválido.' },
        { status: 400 },
      )
    }
    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 })
    }

    // RLS handles ownership, but we need the existing row to read
    // meta_template_id and status — fetch explicitly.
    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, status, meta_template_id, language')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Modelo não encontrado.' }, { status: 404 })
    }

    if (!existing.meta_template_id) {
      return NextResponse.json(
        {
          error:
            'Este modelo nunca foi enviado à Meta — use Novo modelo para enviá-lo.',
        },
        { status: 400 },
      )
    }

    if (!EDITABLE_STATUSES.has(existing.status)) {
      return NextResponse.json(
        {
          error: `Modelos com status ${existing.status} não podem ser editados. Permitido: APPROVED, REJECTED, PAUSED.`,
        },
        { status: 400 },
      )
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'Modelos de AUTENTICAÇÃO não podem ser editados aqui — gerencie-os no Meta WhatsApp Manager.',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Falha na validação.' },
        { status: 400 },
      )
    }

    if (!isDryRun()) {
      const { data: config, error: configError } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .single()
      if (configError || !config) {
        return NextResponse.json(
          { error: 'O WhatsApp® não está configurado.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)

      // Image headers need a fresh Resumable-Upload handle on every edit
      // (Meta replaces components wholesale). Derive from header_media_url.
      try {
        await ensureImageHeaderHandle(payload, accessToken)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Falha no upload da imagem do cabeçalho.' },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        await editMessageTemplate({
          metaTemplateId: existing.meta_template_id,
          accessToken,
          components: metaPayload.components,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Falha ao editar no Meta.'
        await supabase
          .from('message_templates')
          .update({
            submission_error: message,
            last_submitted_at: new Date().toISOString(),
          })
          .eq('id', id)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // Meta accepted the edit — status flips back to PENDING for review.
    const { data: row, error: updErr } = await supabase
      .from('message_templates')
      .update({
        category: payload.category,
        header_type: payload.header_type ?? null,
        header_content: payload.header_content ?? null,
        header_media_url: payload.header_media_url ?? null,
        header_handle: payload.header_handle ?? null,
        body_text: payload.body_text,
        footer_text: payload.footer_text ?? null,
        buttons: payload.buttons ?? null,
        sample_values: payload.sample_values ?? null,
        status: 'PENDING',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (updErr) {
      return NextResponse.json(
        {
          error: `Editado na Meta, mas falhou ao salvar localmente: ${updErr.message}. Use "Sincronizar da Meta" para recuperar.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: isDryRun(),
    })
  } catch (error) {
    console.error('Error editing template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Falha ao editar o modelo.',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  let ctx: AccountContext
  try {
    ctx = await requireRole('admin')
  } catch (error) {
    return toErrorResponse(error)
  }

  try {
    const { supabase, accountId } = ctx
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'ID de modelo inválido.' },
        { status: 400 },
      )
    }
    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, meta_template_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Modelo não encontrado.' }, { status: 404 })
    }

    if (existing.meta_template_id && !isDryRun()) {
      const { data: config, error: configError } = await supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .single()
      if (configError || !config || !config.waba_id) {
        return NextResponse.json(
          { error: 'O WhatsApp® não está configurado — não é possível excluir na Meta.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)
      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.meta_template_id,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Falha ao excluir na Meta.'
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    const { error: delErr } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', id)
    if (delErr) {
      return NextResponse.json(
        {
          error: `Excluído na Meta, mas falhou ao excluir localmente: ${delErr.message}.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, dry_run: isDryRun() })
  } catch (error) {
    console.error('Error deleting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Falha ao excluir o modelo.',
      },
      { status: 500 },
    )
  }
}
