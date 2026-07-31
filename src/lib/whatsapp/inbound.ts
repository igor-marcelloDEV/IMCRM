/**
 * Provider-agnostic inbound message ingestion.
 *
 * Both the Meta webhook (`/api/whatsapp/webhook`) and the Baileys
 * worker webhook (`/api/whatsapp/worker-webhook`) parse a very
 * different wire format, but once a message is normalised into a
 * `NormalizedInboundMessage` the rest of the pipeline — find/create
 * contact, find/create conversation, persist the message, flag
 * broadcast replies, dispatch Flows/automations/AI auto-reply, fan out
 * the `message.received` webhook — is identical. This module owns
 * that shared tail so it isn't duplicated (and can't drift) between
 * the two entry points.
 *
 * `findOrCreateContact` / `findOrCreateConversation` are also
 * exported standalone: the Meta webhook needs them ahead of its
 * reaction short-circuit (reactions never reach `ingestInboundMessage`
 * — they update `message_reactions`, not `messages`).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import { recordInboundMessage } from '@/lib/messages/record-inbound';
import {
  isWhatsAppOptOutMessage,
  optOutWhatsAppMarketing,
} from '@/lib/privacy/contact-preferences';
import type { WhatsAppProviderType } from '@/types';

export interface NormalizedInboundMessage {
  provider: WhatsAppProviderType;
  /** Provider-native message id (Meta `wamid` or Baileys `key.id`). */
  providerMessageKey: string;
  /** Raw sender phone as delivered by the provider; normalised here. */
  fromPhone: string;
  contactName?: string | null;
  /** Must be one of the values allowed by `messages_content_type_check`. */
  contentType: string;
  contentText: string | null;
  mediaUrl?: string | null;
  /** Set only for a tapped reply-button/list-row (Meta interactive). */
  interactiveReplyId?: string | null;
  /** providerMessageKey of the message this one is replying to, if any. */
  replyToProviderMessageKey?: string | null;
  /** Provider-reported delivery time; defaults to now. */
  createdAt?: string;
}

export interface IngestResult {
  conversationId: string;
  contactId: string;
  contactCreated: boolean;
  isFirstInboundMessage: boolean;
}

/**
 * Resolve a provider-native message key to our internal `messages.id`,
 * scoped to one conversation. Checks the legacy `message_id` column
 * (Meta) and the generalised `provider_message_key` column, since
 * rows written before 037_baileys_integration.sql only have the
 * former. Returns null when the parent was never received (e.g. a
 * reply to a message older than this CRM install).
 */
async function lookupInternalIdByProviderKey(
  db: SupabaseClient,
  key: string,
  conversationId: string,
): Promise<string | null> {
  const { data: byLegacyId } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('message_id', key)
    .maybeSingle();
  if (byLegacyId?.id) return byLegacyId.id;

  const { data: byProviderKey } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('provider_message_key', key)
    .maybeSingle();
  return byProviderKey?.id ?? null;
}

/**
 * If an inbound message's sender is on a still-unreplied
 * broadcast_recipients row, flip it to `replied` so the reply count
 * advances on the parent broadcast. Best-effort — failures here must
 * not break the main inbound-message flow.
 */
async function flagBroadcastReplyIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
) {
  try {
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, status, broadcast_id, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .in('status', ['sent', 'delivered', 'read'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !recs || recs.length === 0) return;

    const row = recs[0];
    const { error: updErr } = await db
      .from('broadcast_recipients')
      .update({ status: 'replied', replied_at: new Date().toISOString() })
      .eq('id', row.id);

    if (updErr) {
      console.error('[inbound] flagBroadcastReplyIfAny update failed:', updErr);
    }
  } catch (err) {
    console.error('[inbound] flagBroadcastReplyIfAny threw:', err);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;

export interface ContactOutcome {
  contact: ContactRow;
  /** True when this call created the row. */
  wasCreated: boolean;
}

/**
 * Find an existing contact for this account by phone, or create one.
 * Shared by every inbound entry point (Meta webhook, Baileys worker
 * webhook) so "same number" dedup logic (issue #212) stays in one
 * place.
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(db, accountId, phone);

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await db
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id);
    }
    return { contact: existingContact, wasCreated: false };
  }

  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent inbound delivery created this contact
    // between our lookup and insert. Re-resolve instead of dropping
    // the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(db, accountId, phone);
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('[inbound] Error creating contact:', createError);
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

/**
 * Find the oldest conversation for this contact, or create one.
 * Ordering oldest-first + taking one row (rather than `.single()`)
 * makes concurrent inbound deliveries converge on the same row
 * instead of spawning duplicate conversations (issue #363).
 */
export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('[inbound] Error finding conversation:', findError);
    return null;
  }

  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error('[inbound] Error creating conversation:', createError);
    return null;
  }

  return { conversation: newConv, created: true };
}

/**
 * Shared tail of inbound processing: find/create contact + conversation,
 * persist the message, flag broadcast replies, dispatch Flows /
 * automations / AI auto-reply, and fan out `message.received`.
 *
 * Mirrors the Meta webhook's `processMessage` (post content-parsing)
 * exactly, generalised over `provider`/`providerMessageKey` instead of
 * assuming a Meta `wamid`.
 */
export async function ingestInboundMessage(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  message: NormalizedInboundMessage,
): Promise<IngestResult | null> {
  const senderPhone = normalizePhone(message.fromPhone);

  const contactOutcome = await findOrCreateContact(
    db,
    accountId,
    configOwnerUserId,
    senderPhone,
    message.contactName || senderPhone,
  );
  if (!contactOutcome) return null;
  const contact = contactOutcome.contact;

  const convResult = await findOrCreateConversation(
    db,
    accountId,
    configOwnerUserId,
    contact.id,
  );
  if (!convResult) return null;
  const conversation = convResult.conversation;

  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    });
  }

  let replyToInternalId: string | null = null;
  if (message.replyToProviderMessageKey) {
    replyToInternalId = await lookupInternalIdByProviderKey(
      db,
      message.replyToProviderMessageKey,
      conversation.id,
    );
    if (!replyToInternalId) {
      console.warn(
        '[inbound] reply context parent not found:',
        message.replyToProviderMessageKey,
      );
    }
  }

  // The RPC atomically claims the provider key, inserts the message,
  // increments unread_count and decides the first-inbound trigger.
  let recorded;
  try {
    recorded = await recordInboundMessage(db, {
      conversationId: conversation.id,
      contentType: message.contentType,
      contentText: message.contentText,
      mediaUrl: message.mediaUrl,
      provider: message.provider,
      providerMessageKey: message.providerMessageKey,
      createdAt: message.createdAt ?? new Date().toISOString(),
      replyToMessageId: replyToInternalId,
      interactiveReplyId: message.interactiveReplyId,
    });
  } catch (error) {
    console.error('[inbound] Error recording message:', error);
    return null;
  }

  // A retry owns the same provider key and returns no row. Stop before
  // triggering Flows, automations, AI or outgoing webhooks again.
  if (!recorded) return null;
  const isFirstInboundMessage = recorded.isFirstInbound;

  await flagBroadcastReplyIfAny(db, accountId, contact.id);

  // An explicit opt-out is an operational command, not automation
  // content. Persist the suppression and stop before any Flow, rule or
  // AI reply can turn "SAIR" into another marketing interaction.
  if (isWhatsAppOptOutMessage(message.contentText)) {
    try {
      await optOutWhatsAppMarketing(db, {
        accountId,
        contactId: contact.id,
        providerMessageKey: message.providerMessageKey,
      });
    } catch (error) {
      // Fail closed for this inbound message: even if persistence is
      // temporarily unavailable, do not answer an opt-out with a bot.
      console.error('[inbound] Error recording WhatsApp opt-out:', error);
    }

    await dispatchWebhookEvent(db, accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contact.id,
      whatsapp_message_id: message.providerMessageKey,
      content_type: message.contentType,
      text: message.contentText,
      marketing_opt_out: true,
    });

    return {
      conversationId: conversation.id,
      contactId: contact.id,
      contactCreated: contactOutcome.wasCreated,
      isFirstInboundMessage,
    };
  }

  // Flow runner dispatch — same semantics as the Meta webhook: a
  // consumed message suppresses the content-level automation triggers
  // below (customer is navigating the bot menu, not sending a fresh
  // trigger word).
  // dispatchInboundToFlows documents "must never throw," but that
  // contract only covers its own top-level try/catch — a step deep in
  // an active run (e.g. a send_buttons/send_list node hitting a
  // provider that doesn't support interactive messages, like Baileys)
  // can still reject a promise outside that scope. Wrapping the call
  // site itself is the belt-and-suspenders version: whatever flows
  // does internally, a failure here must never take down automations
  // / AI auto-reply / the webhook fan-out below it.
  let flowConsumed = false;
  try {
    const flowResult = await dispatchInboundToFlows({
      accountId,
      userId: configOwnerUserId,
      contactId: contact.id,
      conversationId: conversation.id,
      message: message.interactiveReplyId
        ? {
            kind: 'interactive_reply',
            reply_id: message.interactiveReplyId,
            reply_title: message.contentText ?? '',
            meta_message_id: message.providerMessageKey,
          }
        : {
            kind: 'text',
            text: message.contentText ?? '',
            meta_message_id: message.providerMessageKey,
          },
      isFirstInboundMessage,
    });
    flowConsumed = flowResult.consumed;
  } catch (err) {
    console.error('[inbound] dispatchInboundToFlows threw:', err);
  }

  const inboundText = message.contentText ?? '';
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
    | 'interactive_reply'
  )[] = [];
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match');
    if (message.interactiveReplyId) {
      automationTriggers.push('interactive_reply');
    }
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created');
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message');
  // Awaited (as Promise.all, so multiple trigger types still run
  // concurrently) rather than fire-and-forget. This function is always
  // called from behind an `after()` (or equivalent deferred-work)
  // boundary by every caller — the HTTP response is already sent by
  // the time this runs — so there's no ack to protect by detaching
  // these promises, only a false sense of safety: an un-awaited
  // promise here has nothing keeping it alive once `ingestInboundMessage`
  // itself returns, and the serverless function can be frozen the
  // instant that happens, silently dropping the automation run
  // mid-flight (see the comment on worker-webhook/route.ts's
  // `after()` call for the full incident writeup).
  const automationResults = await Promise.all(
    automationTriggers.map((triggerType) =>
      runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId: contact.id,
        context: {
          message_text: inboundText,
          conversation_id: conversation.id,
          interactive_reply_id: message.interactiveReplyId ?? undefined,
        },
      })
        .then((sentMessage) => ({ triggerType, sentMessage }))
        .catch((err) => {
          console.error('[automations] dispatch failed:', err);
          return { triggerType, sentMessage: false };
        }),
    ),
  );

  // Did a per-message auto-responder (as opposed to a relationship
  // trigger like first_inbound_message/new_contact_created) actually
  // send something for THIS inbound? Used to decide whether the AI
  // should cover the gap below — see the comment on
  // dispatchInboundToAiReply's automationHandledMessage param.
  const automationHandledMessage = automationResults.some(
    (r) =>
      r.sentMessage &&
      (r.triggerType === 'new_message_received' || r.triggerType === 'keyword_match'),
  );

  if (!flowConsumed && !message.interactiveReplyId && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contact.id,
      configOwnerUserId,
      inboundProviderMessageKey: message.providerMessageKey,
      automationHandledMessage,
    });
  }

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: message.providerMessageKey,
    content_type: message.contentType,
    text: message.contentText,
  });

  return {
    conversationId: conversation.id,
    contactId: contact.id,
    contactCreated: contactOutcome.wasCreated,
    isFirstInboundMessage,
  };
}
