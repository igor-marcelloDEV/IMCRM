/**
 * Instagram inbound event ingestion — the comment/DM-side counterpart
 * of `src/lib/whatsapp/inbound.ts`. Deliberately NOT unified with that
 * module: WhatsApp's `ingestInboundMessage` finds/creates contacts by
 * phone and immediately fans out to Flows + AI auto-reply, both of
 * which assume a phone-based `WhatsAppProvider` send path throughout.
 * Rewiring those for a phoneless, IGSID-keyed contact is out of scope
 * for this phase (see the plan doc) — Instagram contacts are resolved
 * by `instagram_scoped_id` here, and only the channel-agnostic pieces
 * (contact/conversation creation, `runAutomationsForTrigger`) are
 * reused in spirit, not by direct call.
 *
 * Two entry points, matching the two webhook fields Meta sends:
 *   - `ingestInstagramComment` — a comment on a connected post. Not a
 *     message; no `messages` row. Fires the `instagram_comment_keyword`
 *     automation trigger directly.
 *   - `ingestInstagramMessage` — an inbound DM. Persisted to `messages`
 *     (channel='instagram') so it's visible in the inbox, but does NOT
 *     dispatch Flows/AI auto-reply (out of scope this phase).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;

/**
 * Find an existing contact for this account by Instagram-scoped id, or
 * create one. Mirrors `findOrCreateContact` in `whatsapp/inbound.ts`
 * but keyed on `instagram_scoped_id` (migration 050's partial unique
 * index) instead of phone.
 */
export async function findOrCreateInstagramContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  igsid: string,
  username: string | null,
): Promise<{ contact: ContactRow; wasCreated: boolean } | null> {
  const { data: existing } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('instagram_scoped_id', igsid)
    .maybeSingle();

  if (existing) {
    if (username && username !== existing.instagram_username) {
      await db
        .from('contacts')
        .update({ instagram_username: username, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    }
    return { contact: existing, wasCreated: false };
  }

  const { data: created, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      instagram_scoped_id: igsid,
      instagram_username: username,
      name: username || `Instagram ${igsid}`,
    })
    .select()
    .single();

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('contacts')
        .select('*')
        .eq('account_id', accountId)
        .eq('instagram_scoped_id', igsid)
        .maybeSingle();
      if (raced) return { contact: raced, wasCreated: false };
    }
    console.error('[instagram/inbound] Error creating contact:', createError);
    return null;
  }

  return { contact: created, wasCreated: true };
}

/** Find the oldest Instagram-channel conversation for this contact, or
 *  create one. Mirrors `findOrCreateConversation`. */
export async function findOrCreateInstagramConversation(
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
    .eq('channel', 'instagram')
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('[instagram/inbound] Error finding conversation:', findError);
    return null;
  }
  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false };
  }

  const { data: created, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      channel: 'instagram',
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
        .eq('channel', 'instagram')
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) return { conversation: raced[0], created: false };
    }
    console.error('[instagram/inbound] Error creating conversation:', createError);
    return null;
  }

  return { conversation: created, created: true };
}

export interface InstagramCommentEvent {
  commentId: string;
  mediaId: string;
  fromIgsid: string;
  fromUsername: string | null;
  text: string;
}

/**
 * A comment landed on a connected post. Resolves/creates the
 * commenter as a contact, then fires the `instagram_comment_keyword`
 * automation trigger — `triggerMatches` filters by keyword, and a
 * matching automation's `send_instagram_dm` step reads `vars.comment_id`
 * to send the required first-touch private reply.
 */
export async function ingestInstagramComment(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  event: InstagramCommentEvent,
): Promise<void> {
  const contactOutcome = await findOrCreateInstagramContact(
    db,
    accountId,
    configOwnerUserId,
    event.fromIgsid,
    event.fromUsername,
  );
  if (!contactOutcome) return;

  const convResult = await findOrCreateInstagramConversation(
    db,
    accountId,
    configOwnerUserId,
    contactOutcome.contact.id,
  );
  if (!convResult) return;

  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: convResult.conversation.id,
      contact_id: contactOutcome.contact.id,
    });
  }

  await runAutomationsForTrigger({
    accountId,
    triggerType: 'instagram_comment_keyword',
    contactId: contactOutcome.contact.id,
    context: {
      message_text: event.text,
      conversation_id: convResult.conversation.id,
      vars: {
        comment_id: event.commentId,
        media_id: event.mediaId,
      },
    },
  });
}

export interface InstagramMessageEvent {
  senderIgsid: string;
  recipientIgsid: string;
  mid: string;
  text: string | null;
  attachmentUrl: string | null;
  timestamp: number;
}

/**
 * An inbound DM. Persisted so it's visible in the inbox and so a
 * comment-triggered automation's follow-up sends land in the same
 * thread the customer sees — but does NOT dispatch Flows/AI auto-reply
 * (both assume a phone-keyed WhatsApp contact throughout; rewiring
 * them is out of scope for this phase, see the plan doc).
 */
export async function ingestInstagramMessage(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  event: InstagramMessageEvent,
): Promise<void> {
  const contactOutcome = await findOrCreateInstagramContact(
    db,
    accountId,
    configOwnerUserId,
    event.senderIgsid,
    null,
  );
  if (!contactOutcome) return;
  const contact = contactOutcome.contact;

  const convResult = await findOrCreateInstagramConversation(
    db,
    accountId,
    configOwnerUserId,
    contact.id,
  );
  if (!convResult) return;
  const conversation = convResult.conversation;

  if (convResult.created) {
    await dispatchWebhookEvent(db, accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    });
  }

  const contentType = event.attachmentUrl ? 'document' : 'text';
  const { error: msgError } = await db.from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: event.text,
    media_url: event.attachmentUrl,
    provider: 'instagram',
    provider_message_key: event.mid,
    status: 'delivered',
    created_at: new Date(event.timestamp).toISOString(),
  });
  if (msgError) {
    console.error('[instagram/inbound] Error inserting message:', msgError);
    return;
  }

  await db
    .from('conversations')
    .update({
      last_message_text: event.text || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id);

  await dispatchWebhookEvent(db, accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: event.mid,
    content_type: contentType,
    text: event.text,
  });
}
