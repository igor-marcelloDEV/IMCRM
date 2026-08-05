import type { SupabaseClient } from '@supabase/supabase-js'
import { addCatalogItemToCart } from '@/lib/flows/engine'
import type { AiToolDef, ToolCall } from './types'

// ============================================================
// The AI agent's fixed tool vocabulary — add a catalog item to the
// contact's cart, move their open deal to another pipeline stage, or
// mark it won/lost. See migration 049 for `ai_configs.enabled_tools`
// (per-tool opt-in) and `ai_tool_calls` (audit log + idempotency).
//
// Parameters are human-readable names, not UUIDs — the model can't
// reliably produce a `catalog_item_id`/`stage_id` it was never shown,
// so `item_name`/`stage_name` are resolved server-side via
// case-insensitive matching against the account's live catalog/pipeline
// (see `buildToolsContextBlock`, which tells the model what names
// exist).
// ============================================================

export const TOOL_NAMES = ['add_to_cart', 'move_deal_stage', 'mark_deal_status'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolName(v: unknown): v is ToolName {
  return typeof v === 'string' && (TOOL_NAMES as readonly string[]).includes(v)
}

export const AI_TOOL_DEFS: Record<ToolName, AiToolDef> = {
  add_to_cart: {
    name: 'add_to_cart',
    description:
      "Add an item from the business's product/service catalog to the customer's cart. Use the exact item name shown in the catalog context below.",
    parameters: {
      type: 'object',
      properties: {
        item_name: { type: 'string', description: 'The catalog item name to add.' },
        quantity: {
          type: 'integer',
          description: 'How many units to add. Defaults to 1.',
          minimum: 1,
        },
      },
      required: ['item_name'],
    },
  },
  move_deal_stage: {
    name: 'move_deal_stage',
    description:
      "Move the customer's open deal to a different pipeline stage. Use the exact stage name shown in the pipeline context below.",
    parameters: {
      type: 'object',
      properties: {
        stage_name: { type: 'string', description: 'The pipeline stage name to move the deal to.' },
      },
      required: ['stage_name'],
    },
  },
  mark_deal_status: {
    name: 'mark_deal_status',
    description:
      "Close the customer's open deal as won (they confirmed a purchase/agreement) or lost (they declined or walked away).",
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['won', 'lost'], description: 'The final deal status.' },
      },
      required: ['status'],
    },
  },
}

const MAX_ADD_QUANTITY = 20

/**
 * Short catalog + pipeline-stage summary to append to the system prompt
 * whenever any tool is enabled — without it the model has no idea what
 * names it may pass as `item_name`/`stage_name`. Only names + prices,
 * never ids.
 */
export async function buildToolsContextBlock(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  const parts: string[] = []

  const { data: items } = await db
    .from('catalog_items')
    .select('name, price_cents, currency')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .order('position')
    .limit(50)
  const catalogRows = (items ?? []) as { name: string; price_cents: number; currency: string }[]
  if (catalogRows.length > 0) {
    parts.push(
      'Catalog items available to add to the cart:\n' +
        catalogRows
          .map((i) => `- ${i.name} (${(i.price_cents / 100).toFixed(2)} ${i.currency})`)
          .join('\n'),
    )
  }

  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at')
    .limit(1)
    .maybeSingle()
  if (pipeline) {
    const { data: stages } = await db
      .from('pipeline_stages')
      .select('name')
      .eq('pipeline_id', (pipeline as { id: string }).id)
      .order('position')
    const stageRows = (stages ?? []) as { name: string }[]
    if (stageRows.length > 0) {
      parts.push('Pipeline stages available to move a deal to:\n' + stageRows.map((s) => `- ${s.name}`).join('\n'))
    }
  }

  return parts.join('\n\n')
}

interface ToolExecContext {
  accountId: string
  contactId: string
  conversationId: string | null
  /** The inbound message's `provider_message_key` — logged with every
   *  row so the dispatcher can dedup a webhook retry. */
  providerMessageKey: string
}

export interface ToolExecResult {
  ok: boolean
  summary: string
}

async function logToolCall(
  db: SupabaseClient,
  ctx: ToolExecContext,
  toolName: ToolName,
  input: Record<string, unknown>,
  result: ToolExecResult,
): Promise<void> {
  await db.from('ai_tool_calls').insert({
    account_id: ctx.accountId,
    conversation_id: ctx.conversationId,
    contact_id: ctx.contactId,
    provider_message_key: ctx.providerMessageKey,
    tool_name: toolName,
    input,
    status: result.ok ? 'success' : 'error',
    result_summary: result.summary,
  })
}

/** Most recent OPEN deal for this contact — the one the running
 *  conversation is about. `move_deal_stage`/`mark_deal_status` act on
 *  it; there's no way for the model to name a deal directly. */
async function findOpenDeal(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<{ id: string; pipeline_id: string } | null> {
  const { data } = await db
    .from('deals')
    .select('id, pipeline_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: string; pipeline_id: string } | null) ?? null
}

async function execAddToCart(
  db: SupabaseClient,
  ctx: ToolExecContext,
  input: Record<string, unknown>,
): Promise<ToolExecResult> {
  const itemName = typeof input.item_name === 'string' ? input.item_name.trim() : ''
  if (!itemName) return { ok: false, summary: 'item_name ausente' }
  const quantity = Math.min(
    MAX_ADD_QUANTITY,
    Math.max(1, Math.floor(Number(input.quantity) || 1)),
  )

  const { data: item } = await db
    .from('catalog_items')
    .select('id, name')
    .eq('account_id', ctx.accountId)
    .eq('is_active', true)
    .ilike('name', `%${itemName}%`)
    .limit(1)
    .maybeSingle()
  const found = item as { id: string; name: string } | null
  if (!found) return { ok: false, summary: `Nenhum item do catálogo corresponde a "${itemName}"` }

  for (let i = 0; i < quantity; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- quantity is capped and each call must serialize on the same cart row
    await addCatalogItemToCart(db, {
      accountId: ctx.accountId,
      contactId: ctx.contactId,
      conversationId: ctx.conversationId,
      catalogItemId: found.id,
    })
  }
  return { ok: true, summary: `Adicionado ${quantity}x "${found.name}" ao carrinho` }
}

async function execMoveDealStage(
  db: SupabaseClient,
  ctx: ToolExecContext,
  input: Record<string, unknown>,
): Promise<ToolExecResult> {
  const stageName = typeof input.stage_name === 'string' ? input.stage_name.trim() : ''
  if (!stageName) return { ok: false, summary: 'stage_name ausente' }

  const deal = await findOpenDeal(db, ctx.accountId, ctx.contactId)
  if (!deal) return { ok: false, summary: 'Nenhum negócio aberto para este contato' }

  const { data: stage } = await db
    .from('pipeline_stages')
    .select('id, name')
    .eq('pipeline_id', deal.pipeline_id)
    .ilike('name', `%${stageName}%`)
    .limit(1)
    .maybeSingle()
  const found = stage as { id: string; name: string } | null
  if (!found) return { ok: false, summary: `Nenhuma etapa do funil corresponde a "${stageName}"` }

  await db.from('deals').update({ stage_id: found.id }).eq('id', deal.id)
  return { ok: true, summary: `Negócio movido para a etapa "${found.name}"` }
}

async function execMarkDealStatus(
  db: SupabaseClient,
  ctx: ToolExecContext,
  input: Record<string, unknown>,
): Promise<ToolExecResult> {
  const status = input.status === 'won' || input.status === 'lost' ? input.status : null
  if (!status) return { ok: false, summary: 'status inválido (deve ser "won" ou "lost")' }

  const deal = await findOpenDeal(db, ctx.accountId, ctx.contactId)
  if (!deal) return { ok: false, summary: 'Nenhum negócio aberto para este contato' }

  await db.from('deals').update({ status }).eq('id', deal.id)
  return { ok: true, summary: `Negócio marcado como "${status === 'won' ? 'ganho' : 'perdido'}"` }
}

/** Execute one model-requested tool call and log the outcome (success
 *  or error — a resolution failure like "no matching item" is logged,
 *  not thrown, so one bad tool call doesn't take down the rest of the
 *  turn). Unknown tool names are dropped silently — the model offered
 *  something outside `enabled_tools`. */
export async function executeAiTool(
  db: SupabaseClient,
  ctx: ToolExecContext,
  call: ToolCall,
): Promise<ToolExecResult | null> {
  if (!isToolName(call.name)) return null

  let result: ToolExecResult
  switch (call.name) {
    case 'add_to_cart':
      result = await execAddToCart(db, ctx, call.input)
      break
    case 'move_deal_stage':
      result = await execMoveDealStage(db, ctx, call.input)
      break
    case 'mark_deal_status':
      result = await execMarkDealStatus(db, ctx, call.input)
      break
  }

  await logToolCall(db, ctx, call.name, call.input, result)
  return result
}
