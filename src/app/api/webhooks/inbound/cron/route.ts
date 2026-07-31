import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/automations/admin-client';

export const maxDuration = 60;

interface ReplayRow {
  provider: 'whatsapp' | 'instagram';
  event_key: string;
  raw_body: string;
}

function hasCronAccess(request: Request, expected: string): boolean {
  const supplied = createHash('sha256')
    .update(request.headers.get('x-cron-secret') ?? '')
    .digest();
  const wanted = createHash('sha256').update(expected).digest();
  return timingSafeEqual(supplied, wanted);
}

function response(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function replayUrl(request: Request, provider: ReplayRow['provider']): URL {
  return new URL(
    provider === 'whatsapp'
      ? '/api/whatsapp/webhook'
      : '/api/instagram/webhook',
    new URL(request.url).origin
  );
}

function metaSignature(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Replays persisted Meta requests that did not finish in the request's
 * `after()` window. The exact original body is POSTed back through the
 * normal signature-verifying route, which owns the processing lease and
 * provider-specific parser.
 */
export async function GET(request: Request) {
  const cronSecret = process.env.AUTOMATION_CRON_SECRET;
  if (!cronSecret) return response({ error: 'cron não configurado' }, 503);
  if (!hasCronAccess(request, cronSecret)) {
    return response({ error: 'Não autorizado' }, 401);
  }

  const metaSecret = process.env.META_APP_SECRET;
  if (!metaSecret) {
    return response({ error: 'META_APP_SECRET não configurado' }, 503);
  }

  const configuredBatch = Number.parseInt(
    process.env.INBOUND_WEBHOOK_CRON_BATCH_SIZE ?? '20',
    10
  );
  const batchSize = Number.isFinite(configuredBatch)
    ? Math.max(1, Math.min(configuredBatch, 100))
    : 20;

  const db = supabaseAdmin();
  const { data, error } = await db.rpc('reserve_inbound_webhook_replays', {
    p_limit: batchSize,
  });
  if (error) {
    console.error('[inbound webhook cron] reserve failed:', error);
    return response({ error: 'Falha ao reservar eventos' }, 503);
  }

  const rows = (data ?? []) as unknown as ReplayRow[];
  if (rows.length === 0) {
    await db.rpc('prune_inbound_webhook_events');
    return response({ reserved: 0, replayed: 0, failed: 0 });
  }

  const outcomes = await Promise.all(
    rows.map(async (row) => {
      if (
        !row.raw_body ||
        (row.provider !== 'whatsapp' && row.provider !== 'instagram')
      ) {
        return false;
      }

      try {
        const result = await fetch(replayUrl(request, row.provider), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': metaSignature(row.raw_body, metaSecret),
          },
          body: row.raw_body,
          cache: 'no-store',
          redirect: 'manual',
          signal: AbortSignal.timeout(15_000),
        });
        if (!result.ok) {
          console.warn(
            `[inbound webhook cron] ${row.provider}/${row.event_key} returned ${result.status}`
          );
        }
        return result.ok;
      } catch (error) {
        console.warn(
          `[inbound webhook cron] ${row.provider}/${row.event_key} replay failed:`,
          error
        );
        return false;
      }
    })
  );

  const replayed = outcomes.filter(Boolean).length;
  const failed = rows.length - replayed;
  const { error: pruneError } = await db.rpc('prune_inbound_webhook_events');
  if (pruneError) {
    console.warn('[inbound webhook cron] prune failed:', pruneError);
  }

  return response({ reserved: rows.length, replayed, failed });
}
