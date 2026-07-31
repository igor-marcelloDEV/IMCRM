import { NextResponse } from 'next/server';

import {
  requireRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  BroadcastError,
  createBroadcast,
  type BroadcastRecipientInput,
} from '@/lib/whatsapp/broadcast-core';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * Preferred input:
 * {
 *   name,
 *   recipients: [{
 *     contact_id?, phone, params?, messageParams?
 *   }],
 *   template_name,
 *   template_language,
 *   template_variables?,
 *   audience_filter?,
 *   idempotency_key?
 * }
 *
 * The legacy `phone_numbers` + shared `template_params` shape remains
 * accepted. Both shapes now enqueue durable recipient jobs; this route
 * never performs the provider fan-out inside the HTTP request.
 */
interface RequestRecipient {
  contact_id?: unknown;
  phone?: unknown;
  params?: unknown;
  messageParams?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeRecipients(
  body: Record<string, unknown>
): BroadcastRecipientInput[] | null {
  const preferred = body.recipients;
  if (Array.isArray(preferred) && preferred.length > 0) {
    return preferred.map((raw) => {
      const recipient = asRecord(raw) as RequestRecipient | null;
      return {
        to: typeof recipient?.phone === 'string' ? recipient.phone : '',
        contactId:
          typeof recipient?.contact_id === 'string'
            ? recipient.contact_id
            : undefined,
        params: Array.isArray(recipient?.params)
          ? recipient.params.filter(
              (value): value is string => typeof value === 'string'
            )
          : undefined,
        messageParams: asRecord(recipient?.messageParams) as
          SendTimeParams | undefined,
      };
    });
  }

  if (Array.isArray(body.phone_numbers) && body.phone_numbers.length > 0) {
    const shared = Array.isArray(body.template_params)
      ? body.template_params.filter(
          (value): value is string => typeof value === 'string'
        )
      : [];
    return body.phone_numbers.map((phone) => ({
      to: typeof phone === 'string' ? phone : '',
      params: shared,
    }));
  }

  return null;
}

export async function POST(request: Request) {
  let ctx: AccountContext;
  try {
    ctx = await requireRole('agent');
  } catch (error) {
    return toErrorResponse(error);
  }

  try {
    const limit = checkRateLimit(
      `broadcast:${ctx.userId}`,
      RATE_LIMITS.broadcast
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = asRecord(await request.json().catch(() => null));
    if (!body) {
      return NextResponse.json(
        { error: 'O corpo da requisição deve ser um objeto JSON' },
        { status: 400 }
      );
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name.trim() : '';
    if (!templateName) {
      return NextResponse.json(
        { error: "O campo 'template_name' é obrigatório" },
        { status: 400 }
      );
    }

    const recipients = normalizeRecipients(body);
    if (!recipients) {
      return NextResponse.json(
        {
          error:
            'Forneça `recipients` (preferido) ou `phone_numbers` como uma lista não vazia',
        },
        { status: 400 }
      );
    }

    const headerIdempotencyKey = request.headers.get('idempotency-key');
    const bodyIdempotencyKey =
      typeof body.idempotency_key === 'string' ? body.idempotency_key : null;
    const templateVariables = asRecord(body.template_variables);
    const audienceFilter = asRecord(body.audience_filter);

    // Authorization is already established above. Queue tables and RPCs
    // are service-role-only, so the account id is passed explicitly and
    // the core verifies every supplied contact belongs to that account.
    const queued = await createBroadcast(
      supabaseAdmin(),
      ctx.accountId,
      ctx.userId,
      {
        name: typeof body.name === 'string' ? body.name : null,
        templateName,
        templateLanguage:
          typeof body.template_language === 'string'
            ? body.template_language
            : null,
        recipients,
        templateVariables,
        audienceFilter,
        idempotencyKey: headerIdempotencyKey || bodyIdempotencyKey,
      }
    );

    return NextResponse.json(
      {
        success: true,
        broadcast_id: queued.broadcastId,
        status: queued.status,
        total: queued.totalRecipients,
        queued: queued.accepted,
        accepted: queued.accepted,
        rejected: queued.rejected,
        skipped: queued.skipped,
        replayed: queued.replayed,
        ...(queued.accepted === 0
          ? {
              message:
                'Nenhuma mensagem foi enfileirada; todos os destinatários válidos foram suprimidos por preferência de marketing.',
            }
          : {}),
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof BroadcastError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    console.error('[whatsapp/broadcast] enqueue failed:', error);
    return NextResponse.json(
      { error: 'Falha ao enfileirar o disparo' },
      { status: 500 }
    );
  }
}
