import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';
import { processBroadcastDeliveryBatch } from '@/lib/whatsapp/broadcast-core';

// This endpoint performs a bounded number of sequential provider calls.
// The queue lease, not the function lifetime, owns durability.
export const maxDuration = 60;

function parseBatchSize(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return 20;
  return Math.max(1, Math.min(parsed, 100));
}

function hasValidCronSecret(request: Request, expected: string): boolean {
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

/**
 * Drain one bounded batch of durable broadcast jobs.
 *
 * Safe to invoke concurrently: the database claim uses SKIP LOCKED,
 * locked_by and lease_expires_at. Invoke on a recurring schedule until
 * campaigns leave `sending`; each call also repairs missing jobs from
 * legacy browser/after()-based campaigns.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'cron não configurado' },
      { status: 503 }
    );
  }
  if (!hasValidCronSecret(request, expected)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
  }

  try {
    const result = await processBroadcastDeliveryBatch(supabaseAdmin(), {
      limit: parseBatchSize(process.env.BROADCAST_CRON_BATCH_SIZE),
      // Longer than this route's maxDuration so a killed invocation's
      // in-flight job cannot be reclaimed while the platform may still
      // be unwinding the provider request.
      leaseSeconds: 300,
    });
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[broadcast-cron] batch failed:', error);
    return NextResponse.json(
      { error: 'Falha ao processar a fila de broadcasts' },
      { status: 500 }
    );
  }
}
