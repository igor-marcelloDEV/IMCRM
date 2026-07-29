/**
 * Instagram Graph API helpers — mirrors `src/lib/whatsapp/meta-api.ts`
 * (same named-params style, same "no OAuth flow, tenant pastes a
 * long-lived Page token" model as `whatsapp_config`).
 *
 * Every send call needs the PAGE's access token (not a user token) —
 * Instagram messaging is authenticated as the connected Facebook Page,
 * even though the conversation itself is on the IG Business Account.
 *
 * NOTE: exact permission/attachment-type names are Meta's to change.
 * Verify `instagram_business_manage_messages`/`instagram_business_manage_comments`
 * and the `file` attachment type against current docs before the App
 * Review submission — see the plan doc's external-dependency callout.
 */

const GRAPH_API_VERSION = 'v21.0'
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`

interface GraphErrorResponse {
  error?: { message?: string; code?: number; type?: string }
}

async function throwGraphError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as GraphErrorResponse
    if (data.error?.message) message = data.error.message
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

// ============================================================
// Account verification (Settings "save" / "test connection")
// ============================================================

export interface VerifyInstagramAccountArgs {
  instagramBusinessAccountId: string
  accessToken: string
}

export interface InstagramAccountInfo {
  id: string
  username?: string
  name?: string
}

/** Verify an IG Business Account id + Page token by fetching public
 *  metadata — same "validate before save" discipline as
 *  `verifyPhoneNumber` for WhatsApp. */
export async function verifyInstagramAccount(
  args: VerifyInstagramAccountArgs,
): Promise<InstagramAccountInfo> {
  const { instagramBusinessAccountId, accessToken } = args
  const url = `${GRAPH_API_BASE}/${instagramBusinessAccountId}?fields=id,username,name`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    await throwGraphError(response, `Instagram API error: ${response.status}`)
  }
  return response.json()
}

// ============================================================
// Sending
// ============================================================

export interface InstagramSendResult {
  messageId: string
}

export interface SendPrivateReplyArgs {
  /** The connected Facebook Page id — private replies are sent as the
   *  Page, addressed at the comment, not at a recipient id directly. */
  pageId: string
  accessToken: string
  commentId: string
  text: string
}

/**
 * First-touch send triggered by a comment. This is the ONLY way to
 * message someone who has never DMed the account before — Meta does
 * not allow a cold `recipient: { id: igsid }` send. Valid once per
 * comment, within a limited window after it was posted.
 * https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies
 */
export async function sendPrivateReplyToComment(
  args: SendPrivateReplyArgs,
): Promise<InstagramSendResult> {
  const { pageId, accessToken, commentId, text } = args
  const url = `${GRAPH_API_BASE}/${pageId}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { comment_id: commentId },
      message: { text },
    }),
  })
  if (!response.ok) {
    await throwGraphError(response, `Instagram API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.message_id ?? data.id ?? '' }
}

export interface SendInstagramTextArgs {
  /** The IG Business Account id — once a thread exists, sends are
   *  addressed through the IG account, not the Page. */
  instagramBusinessAccountId: string
  accessToken: string
  /** Recipient's Instagram-scoped id (IGSID). */
  recipientId: string
  text: string
}

/** Plain text DM within an existing thread (post-first-touch, or a
 *  reply to an inbound DM that opened the conversation itself). */
export async function sendInstagramText(
  args: SendInstagramTextArgs,
): Promise<InstagramSendResult> {
  const { instagramBusinessAccountId, accessToken, recipientId, text } = args
  const url = `${GRAPH_API_BASE}/${instagramBusinessAccountId}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  })
  if (!response.ok) {
    await throwGraphError(response, `Instagram API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.message_id ?? data.id ?? '' }
}

export interface SendInstagramDocumentArgs {
  instagramBusinessAccountId: string
  accessToken: string
  recipientId: string
  /** Public URL Meta fetches at send time — same contract as WhatsApp's
   *  `sendMediaMessage`. */
  mediaUrl: string
}

/** Document DM — the "mandar documentos" half of the comment→DM
 *  mechanic. Uses the same `attachment` shape as Messenger's Send API
 *  (Instagram messaging is modelled after it). */
export async function sendInstagramDocument(
  args: SendInstagramDocumentArgs,
): Promise<InstagramSendResult> {
  const { instagramBusinessAccountId, accessToken, recipientId, mediaUrl } = args
  if (!mediaUrl) throw new Error('sendInstagramDocument requires a mediaUrl.')
  const url = `${GRAPH_API_BASE}/${instagramBusinessAccountId}/messages`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: {
        attachment: { type: 'file', payload: { url: mediaUrl } },
      },
    }),
  })
  if (!response.ok) {
    await throwGraphError(response, `Instagram API error: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.message_id ?? data.id ?? '' }
}
