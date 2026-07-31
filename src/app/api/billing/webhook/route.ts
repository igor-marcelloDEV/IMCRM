import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/billing/admin-client';

interface AsaasWebhookPayment {
  id?: unknown;
  value?: unknown;
  externalReference?: unknown;
  billingType?: unknown;
  dueDate?: unknown;
  subscription?: unknown;
}

interface AsaasWebhookSubscription {
  externalReference?: unknown;
}

interface AsaasWebhookBody {
  id?: unknown;
  event?: unknown;
  payment?: AsaasWebhookPayment;
  subscription?: AsaasWebhookSubscription;
}

interface RecordedBillingEvent {
  outcome_status: 'pending' | 'processing' | 'processed' | 'ignored' | 'failed';
  should_process: boolean;
}

interface ProcessedBillingEvent {
  outcome_status: 'processed' | 'ignored' | 'failed';
  error_message: string | null;
}

const PAYMENT_EVENTS = new Set([
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
]);
const MAX_BILLING_WEBHOOK_BYTES = 262_144;
const MAX_PAYMENT_VALUE = 21_474_836.47;

function json(
  body: Record<string, unknown>,
  init: ResponseInit = {}
): NextResponse {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  return NextResponse.json(body, { ...init, headers });
}

function hasValidToken(request: Request, expected: string): boolean {
  const supplied = request.headers.get('asaas-access-token') ?? '';
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();

  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function validateEvent(
  body: AsaasWebhookBody
): { eventId: string; eventType: string } | { error: string } {
  const eventId = typeof body.id === 'string' ? body.id.trim() : '';
  const eventType = typeof body.event === 'string' ? body.event.trim() : '';

  if (
    !eventId ||
    eventId.length > 255 ||
    !eventType ||
    eventType.length > 100
  ) {
    return { error: 'Evento inválido' };
  }

  if (PAYMENT_EVENTS.has(eventType)) {
    const paymentId =
      typeof body.payment?.id === 'string' ? body.payment.id.trim() : '';
    const externalReference =
      typeof body.payment?.externalReference === 'string'
        ? body.payment.externalReference.trim()
        : '';
    const value = body.payment?.value;

    if (
      !paymentId ||
      paymentId.length > 255 ||
      !externalReference ||
      externalReference.length > 255 ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_PAYMENT_VALUE
    ) {
      return { error: 'Evento de pagamento inválido' };
    }
  }

  if (eventType === 'SUBSCRIPTION_DELETED') {
    const externalReference =
      typeof body.subscription?.externalReference === 'string'
        ? body.subscription.externalReference.trim()
        : '';
    if (!externalReference || externalReference.length > 255) {
      return { error: 'Evento de assinatura inválido' };
    }
  }

  return { eventId, eventType };
}

function persistedPayload(
  body: AsaasWebhookBody,
  eventType: string
): Record<string, unknown> {
  if (PAYMENT_EVENTS.has(eventType)) {
    const payment = body.payment!;
    const persistedPayment: Record<string, unknown> = {
      id: (payment.id as string).trim(),
      value: payment.value,
      externalReference: (payment.externalReference as string).trim(),
    };

    for (const field of ['billingType', 'dueDate', 'subscription'] as const) {
      const value = payment[field];
      if (typeof value === 'string' && value.length <= 255) {
        persistedPayment[field] = value.trim();
      }
    }
    return { payment: persistedPayment };
  }

  if (eventType === 'SUBSCRIPTION_DELETED') {
    return {
      subscription: {
        externalReference: (
          body.subscription!.externalReference as string
        ).trim(),
      },
    };
  }

  // Unknown event types are still recorded and acknowledged, but their
  // unrelated gateway fields (which can include customer PII) are not.
  return {};
}

/**
 * Platform Asaas webhook.
 *
 * The event is persisted before the billing transition.  The SQL processor
 * serializes replays by Asaas event id and by gateway payment id, so
 * PAYMENT_CONFIRMED + PAYMENT_RECEIVED for one charge cannot grant two
 * periods.  Database failures return 503 and remain recorded as `failed`;
 * Asaas can safely retry the same event.
 */
export async function POST(request: Request) {
  const expected = process.env.ASAAS_WEBHOOK_TOKEN;
  if (!expected) {
    return json(
      { error: 'Webhook de cobrança não configurado' },
      { status: 503 }
    );
  }

  if (!hasValidToken(request, expected)) {
    return json({ error: 'Não autorizado' }, { status: 401 });
  }

  const declaredLength = Number.parseInt(
    request.headers.get('content-length') ?? '',
    10
  );
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_BILLING_WEBHOOK_BYTES
  ) {
    return json({ error: 'Payload muito grande' }, { status: 413 });
  }

  let body: AsaasWebhookBody;
  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BILLING_WEBHOOK_BYTES) {
      return json({ error: 'Payload muito grande' }, { status: 413 });
    }
    const parsed = JSON.parse(rawBody) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ error: 'Evento inválido' }, { status: 400 });
    }
    body = parsed as AsaasWebhookBody;
  } catch {
    return json({ error: 'JSON inválido' }, { status: 400 });
  }

  const validated = validateEvent(body);
  if ('error' in validated) {
    return json({ error: validated.error }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: recordedData, error: recordError } = await db
    .rpc('record_asaas_billing_event', {
      p_event_id: validated.eventId,
      p_event_type: validated.eventType,
      p_payload: persistedPayload(body, validated.eventType),
    })
    .maybeSingle();
  const recorded = recordedData as RecordedBillingEvent | null;

  if (recordError || !recorded) {
    console.error('[billing webhook] event persistence failed:', recordError);
    return json(
      { error: 'Falha temporária ao registrar evento' },
      { status: 503 }
    );
  }

  if (!recorded.should_process) {
    return json({
      received: true,
      processed: recorded.outcome_status === 'processed',
      duplicate: true,
    });
  }

  const { data: resultData, error: processError } = await db
    .rpc('process_asaas_billing_event', {
      p_event_id: validated.eventId,
    })
    .maybeSingle();
  const result = resultData as ProcessedBillingEvent | null;

  if (processError || !result || result.outcome_status === 'failed') {
    console.error(
      '[billing webhook] event processing failed:',
      processError ?? result?.error_message
    );
    return json(
      { error: 'Falha temporária ao processar evento' },
      { status: 503 }
    );
  }

  return json({
    received: true,
    processed: result.outcome_status === 'processed',
    ignored: result.outcome_status === 'ignored',
  });
}
