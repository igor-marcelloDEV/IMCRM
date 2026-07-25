import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { ingestInboundMessage } from '@/lib/whatsapp/inbound'

/**
 * POST /api/whatsapp/worker-webhook
 *
 * Inbound-message delivery endpoint for the `whatsapp-worker` service
 * (Baileys / unofficial WhatsApp Web). Mirrors what `/api/whatsapp/
 * webhook` does for Meta, minus everything Meta-specific (signature
 * verification, media-id resolution, template-lifecycle events,
 * delivery-status ladder) — the worker already resolved media to a
 * fetchable URL and only ever calls this for actual inbound messages.
 *
 * Auth: a shared bearer secret (`WORKER_API_SECRET`, same value
 * configured on the worker) rather than user auth — this endpoint is
 * server-to-server. Connection lifecycle (QR pending / connected /
 * disconnected) is written by the worker directly to
 * `baileys_connections` via its own service-role client; this route
 * only ever carries messages, so `ingestInboundMessage` — the same
 * pipeline the Meta webhook uses — can own contact/conversation
 * creation, persistence, and Flows/automations/AI dispatch.
 *
 * `ingestInboundMessage` fires automation dispatch fire-and-forget
 * (never awaited — matches the Meta webhook's own tail, see
 * inbound.ts) so a slow/failing automation can't block the response.
 * That's only safe because the *caller* keeps the serverless function
 * alive until those trailing promises settle — the Meta webhook does
 * this via `after()` (see /api/whatsapp/webhook/route.ts's POST
 * handler for the full rationale: Vercel can freeze a function the
 * instant its response is sent, silently killing in-flight work).
 * This route used to `await` everything inline and return — which
 * ack'd fast enough, on a fast-enough account, to *usually* work by
 * accident, but had no actual guarantee and silently dropped
 * automation runs once nothing else in the tail (e.g. AI auto-reply,
 * when disabled) gave the fire-and-forget calls enough of a head
 * start. Wrapping in `after()` here removes the accident and makes it
 * a guarantee, exactly like the Meta path.
 */
export const maxDuration = 60

interface WorkerWebhookBody {
  accountId?: string
  fromPhone?: string
  contactName?: string
  providerMessageKey?: string
  contentType?: string
  contentText?: string | null
  mediaUrl?: string | null
  replyToProviderMessageKey?: string | null
  timestamp?: string
}

const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video', 'location',
])

export async function POST(request: Request) {
  const expectedSecret = process.env.WORKER_API_SECRET
  if (!expectedSecret) {
    console.error('[worker-webhook] WORKER_API_SECRET is not configured')
    return NextResponse.json({ error: 'Not configured' }, { status: 500 })
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${expectedSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: WorkerWebhookBody
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { accountId, fromPhone, providerMessageKey, contentType } = body
  if (!accountId || !fromPhone || !providerMessageKey || !contentType) {
    return NextResponse.json(
      { error: 'accountId, fromPhone, providerMessageKey and contentType are required' },
      { status: 400 },
    )
  }
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return NextResponse.json({ error: `Unsupported contentType "${contentType}"` }, { status: 400 })
  }

  const db = supabaseAdmin()

  // Audit FK for contacts/conversations inserts (NOT NULL user_id).
  // baileys_connections carries no user_id of its own (a WhatsApp Web
  // pairing isn't "saved by" one specific member the way Meta
  // credentials are) — the account owner is the stable, always-present
  // default, same rationale the Meta path uses for its config owner.
  const { data: account, error: accountError } = await db
    .from('accounts')
    .select('owner_user_id')
    .eq('id', accountId)
    .maybeSingle()

  if (accountError || !account) {
    return NextResponse.json({ error: 'Unknown account' }, { status: 404 })
  }

  // Ack the worker immediately; the actual ingestion (contact/
  // conversation creation, Flows, automations, AI auto-reply) runs
  // inside `after()` so it isn't racing the response — see the note
  // above the maxDuration export.
  after(async () => {
    try {
      const result = await ingestInboundMessage(db, accountId, account.owner_user_id, {
        provider: 'baileys',
        providerMessageKey,
        fromPhone,
        contactName: body.contactName,
        contentType,
        contentText: body.contentText ?? null,
        mediaUrl: body.mediaUrl ?? null,
        replyToProviderMessageKey: body.replyToProviderMessageKey ?? null,
        createdAt: body.timestamp,
      })
      if (!result) {
        console.error('[worker-webhook] ingestInboundMessage returned null for', accountId, providerMessageKey)
      }
    } catch (err) {
      console.error('[worker-webhook] ingestInboundMessage threw:', err)
    }
  })

  return NextResponse.json({ success: true })
}
