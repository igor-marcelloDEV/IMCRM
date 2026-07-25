import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/ai/knowledge/[id] — full document (any member).
 */
export async function GET(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { id } = await params
    const { data, error } = await supabase
      .from('ai_knowledge_documents')
      .select('id, title, content, updated_at')
      .eq('account_id', accountId)
      .eq('id', id)
      .maybeSingle()
    if (error) {
      console.error('[ai/knowledge/[id] GET] error:', error)
      return NextResponse.json({ error: 'Falha ao carregar o documento' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })
    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * PATCH /api/ai/knowledge/[id]  (admin+) — update title/content and
 * re-index when the content changed.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : undefined
    const content = typeof body?.content === 'string' ? body.content.trim() : undefined
    if (title === undefined && content === undefined) {
      return NextResponse.json({ error: 'Nada para atualizar' }, { status: 400 })
    }
    if (title !== undefined && !title) {
      return NextResponse.json({ error: "O campo 'title' não pode estar vazio" }, { status: 400 })
    }
    if (content !== undefined && !content) {
      return NextResponse.json({ error: "O campo 'content' não pode estar vazio" }, { status: 400 })
    }

    const update: Record<string, string> = {}
    if (title !== undefined) update.title = title
    if (content !== undefined) update.content = content

    const { data: updated, error } = await supabase
      .from('ai_knowledge_documents')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[ai/knowledge/[id] PATCH] error:', error)
      return NextResponse.json({ error: 'Falha ao atualizar o documento' }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 })

    if (content !== undefined) {
      const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
        supabase,
        accountId,
      )
      try {
        await ingestDocument(supabase, accountId, { embeddingsApiKey }, id, content)
      } catch (err) {
        const message = err instanceof AiError ? err.message : 'falha na indexação'
        console.error('[ai/knowledge/[id] PATCH] ingest error:', err)
        return NextResponse.json(
          {
            success: true,
            warning: `Atualizado, mas a indexação semântica falhou (${message}). A busca por palavras-chave continua funcionando; use Reindexar para tentar novamente.`,
          },
          { status: 200 },
        )
      }
      if (corrupt) {
        return NextResponse.json({
          success: true,
          warning:
            'Atualizado apenas com busca por palavras-chave — não foi possível descriptografar sua chave de embeddings (verifique ENCRYPTION_KEY e digite a chave novamente).',
        })
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/knowledge/[id]  (admin+) — chunks cascade.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('ai_knowledge_documents')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[ai/knowledge/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Falha ao excluir o documento' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
