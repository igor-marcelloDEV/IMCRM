import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { AI_TOOL_DEFS, buildToolsContextBlock, executeAiTool, isToolName } from './tools'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** `provider_message_key` of the inbound message that triggered this
   *  dispatch — the idempotency key for any tool call this turn writes
   *  to `ai_tool_calls`, so a webhook retry can't re-execute a
   *  side-effecting action (add to cart, move stage) twice. */
  inboundProviderMessageKey: string
  /**
   * True when a `new_message_received`/`keyword_match` automation
   * actually matched its trigger AND sent a customer-facing message
   * for THIS inbound — computed by the caller (`ingestInboundMessage`,
   * which already runs automation dispatch before this) from
   * `runAutomationsForTrigger`'s return value.
   *
   * Deliberately NOT "does the account have any active automation of
   * that type" — that check used to stand the AI down permanently
   * whenever such an automation existed, even on messages it didn't
   * actually respond to (e.g. a `new_message_received` automation
   * gated behind a tag-presence `condition` step that took the 'no'
   * branch and sent nothing). The AI is meant to cover the gap on
   * exactly those messages, not go silent for the account's whole
   * lifetime.
   */
  automationHandledMessage: boolean
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a message-level automation already sent a reply to this inbound
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundProviderMessageKey,
    automationHandledMessage,
  } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM for
    // THIS message — but only when one actually fired and sent
    // something. See the automationHandledMessage doc comment above.
    if (automationHandledMessage) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    // Tools are opt-in per account (ai_configs.enabled_tools). When any
    // are on, the model needs to know what catalog items / pipeline
    // stages exist to name them — see buildToolsContextBlock.
    const enabledTools = (config.enabledTools ?? []).filter(isToolName)
    const toolsContext =
      enabledTools.length > 0 ? await buildToolsContextBlock(db, accountId) : ''

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
    })
    const fullSystemPrompt = toolsContext
      ? `${systemPrompt}\n\n${toolsContext}`
      : systemPrompt

    const { text, handoff, usage, toolCalls } = await generateReply({
      config,
      systemPrompt: fullSystemPrompt,
      messages,
      tools: enabledTools.length > 0 ? enabledTools.map((n) => AI_TOOL_DEFS[n]) : undefined,
    })
    const calls = toolCalls ?? []

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    // Execute any tool calls before the handoff/text branches below — an
    // action the model decided to take (add to cart, move stage) is
    // valid even on a turn that also hands off to a human. A webhook
    // retry replaying the same inbound message must not re-run these:
    // check whether this provider_message_key already has a logged
    // execution and skip if so (the text reply itself has no equivalent
    // guard today — see auto-reply.ts's module doc — but a duplicate
    // customer-facing message is a much smaller problem than a
    // duplicated cart item or stage move).
    if (calls.length > 0) {
      const { data: alreadyRan } = await db
        .from('ai_tool_calls')
        .select('id')
        .eq('provider_message_key', inboundProviderMessageKey)
        .limit(1)
        .maybeSingle()
      if (!alreadyRan) {
        for (const call of calls) {
          await executeAiTool(
            db,
            {
              accountId,
              contactId,
              conversationId,
              providerMessageKey: inboundProviderMessageKey,
            },
            call,
          )
        }
      }
    }

    if (handoff || (!text && calls.length === 0)) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      return
    }

    // A tool-only turn (an action, no accompanying reply) is a silent
    // success, not a handoff — the customer sees nothing, but nothing
    // needs to be sent either.
    if (!text) return

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
