// ============================================================
// POST /api/v1/broadcasts - enqueue a template broadcast
// (scope: broadcasts:send).
//
// Body:
//   {
//     "name": "July promo",                 // optional label
//     "template_name": "promo_july",        // required
//     "template_language": "en_US",         // optional
//     "recipients": [                        // required, 1..1000
//       { "to": "+14155550123", "params": ["Jane"] },
//       { "to": "+14155550124" }
//     ]
//   }
//
// Broadcast, recipient and delivery-job rows are persisted atomically.
// A protected cron drains the durable queue. Poll
// GET /api/v1/broadcasts/{id} for progress.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import { createBroadcast, BroadcastError } from '@/lib/whatsapp/broadcast-core';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];
    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const queued = await createBroadcast(
      ctx.supabase,
      ctx.accountId,
      auditUserId,
      {
        name: typeof body.name === 'string' ? body.name : null,
        templateName,
        templateLanguage:
          typeof body.template_language === 'string'
            ? body.template_language
            : null,
        recipients: recipients.map((recipient) => ({
          to: typeof recipient?.to === 'string' ? recipient.to : '',
          params: Array.isArray(recipient?.params)
            ? recipient.params.filter(
                (value: unknown): value is string => typeof value === 'string'
              )
            : undefined,
        })),
        idempotencyKey:
          request.headers.get('idempotency-key') ||
          (typeof body.idempotency_key === 'string'
            ? body.idempotency_key
            : null),
      }
    );

    return ok(
      {
        broadcast_id: queued.broadcastId,
        status: queued.status,
        total_recipients: queued.totalRecipients,
        accepted: queued.accepted,
        rejected: queued.rejected,
        skipped: queued.skipped,
        replayed: queued.replayed,
        ...(queued.accepted === 0
          ? {
              message:
                'No messages were queued because every valid recipient has opted out of WhatsApp marketing.',
            }
          : {}),
      },
      202
    );
  } catch (error) {
    if (error instanceof BroadcastError) {
      return fail(error.code, error.message, error.status);
    }
    if (error instanceof ContactError) {
      return fail(
        error.status === 400 ? 'bad_request' : 'internal',
        error.message,
        error.status
      );
    }
    return toApiErrorResponse(error);
  }
}
