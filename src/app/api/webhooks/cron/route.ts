import { timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import {
  deliveryBatchSize,
  drainWebhookDeliveries,
} from '@/lib/webhooks/deliver';
import { webhookAdmin } from '@/lib/webhooks/admin-client';

export const maxDuration = 60;

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

function isAuthorized(request: Request): 'ok' | 'missing_config' | 'denied' {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) return 'missing_config';

  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return 'denied';
  }
  return 'ok';
}

/**
 * Drain durable outbound webhook deliveries. Schedule this Route Handler
 * every minute (or similarly frequently) and send AUTOMATION_CRON_SECRET
 * in `x-cron-secret`.
 */
export async function GET(request: Request) {
  const authorization = isAuthorized(request);
  if (authorization === 'missing_config') {
    return NextResponse.json(
      { error: 'cron não configurado' },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }
  if (authorization === 'denied') {
    return NextResponse.json(
      { error: 'Não autorizado' },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  try {
    const result = await drainWebhookDeliveries(webhookAdmin(), {
      batchSize: deliveryBatchSize(
        process.env.WEBHOOK_DELIVERY_BATCH_SIZE
      ),
    });
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error('[webhooks-cron] durable delivery worker failed:', error);
    return NextResponse.json(
      { error: 'Falha ao processar entregas de webhook' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
