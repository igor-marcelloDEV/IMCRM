import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';

// The tenant's OWN Asaas account — used to charge THEIR WhatsApp
// customers via the `checkout` Flow node. Separate from the
// platform's ASAAS_API_KEY (IMCRM's own billing, migration 041).
//
// GET never returns either credential, only whether each one is on
// file. An admin can explicitly reveal the webhook token through
// PATCH when it needs to be copied into Asaas; normal settings reads
// never place the secret in a response or cache.

function privateJson(body: unknown, status = 200) {
  const response = NextResponse.json(body, { status });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { data, error } = await supabase
      .from('tenant_payment_configs')
      .select(
        'asaas_env, municipal_service_id, municipal_service_name, nfe_enabled, encrypted_asaas_api_key, webhook_token'
      )
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) {
      console.error('[account payments] failed to load configuration:', error);
      return privateJson(
        { error: 'Não foi possível carregar a configuração de pagamentos' },
        500
      );
    }

    return privateJson({
      config: {
        connected: !!data?.encrypted_asaas_api_key,
        asaas_env: data?.asaas_env ?? 'sandbox',
        municipal_service_id: data?.municipal_service_id ?? null,
        municipal_service_name: data?.municipal_service_name ?? null,
        nfe_enabled: data?.nfe_enabled ?? false,
        webhook_configured: !!data?.webhook_token,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return privateJson({ error: 'JSON inválido' }, 400);
  }

  const { data: existing, error: existingError } = await supabaseAdmin()
    .from('tenant_payment_configs')
    .select('webhook_token, municipal_service_id')
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (existingError) {
    console.error(
      '[account payments] failed to load existing configuration:',
      existingError
    );
    return privateJson(
      { error: 'Não foi possível carregar a configuração de pagamentos' },
      500
    );
  }

  if ('reveal_webhook_token' in body) {
    if (
      body.reveal_webhook_token !== true ||
      Object.keys(body).some((key) => key !== 'reveal_webhook_token')
    ) {
      return privateJson({ error: 'Solicitação de revelação inválida' }, 400);
    }
    if (!existing?.webhook_token) {
      return privateJson({ error: 'Webhook ainda não configurado' }, 404);
    }
    return privateJson({ webhook_token: existing.webhook_token });
  }

  const update: Record<string, unknown> = { account_id: ctx.accountId };
  if (typeof body.api_key === 'string' && body.api_key.trim()) {
    update.encrypted_asaas_api_key = encrypt(body.api_key.trim());
  }
  if (body.asaas_env === 'sandbox' || body.asaas_env === 'production') {
    update.asaas_env = body.asaas_env;
  }
  if (
    typeof body.municipal_service_id === 'string' &&
    typeof body.municipal_service_name === 'string'
  ) {
    update.municipal_service_id = body.municipal_service_id || null;
    update.municipal_service_name = body.municipal_service_name || null;
  }

  // First time this tenant saves ANY payment config — mint the
  // webhook token now so it's ready to paste into Asaas immediately,
  // rather than a separate "generate" step.
  if (!existing?.webhook_token) {
    update.webhook_token = randomBytes(24).toString('hex');
  }

  if (typeof body.nfe_enabled === 'boolean') {
    // Never let NFe issuance turn on without a municipal service
    // picked — the webhook would otherwise call scheduleInvoice()
    // with nothing to bill under.
    const hasService =
      (update.municipal_service_id ?? existing?.municipal_service_id) != null;
    if (body.nfe_enabled && !hasService) {
      return privateJson(
        {
          error:
            'Busque e selecione um serviço municipal antes de habilitar a emissão automática.',
        },
        400
      );
    }
    update.nfe_enabled = body.nfe_enabled;
  }

  const { error } = await supabaseAdmin()
    .from('tenant_payment_configs')
    .upsert(update, { onConflict: 'account_id' });
  if (error) {
    console.error('[account payments] failed to save configuration:', error);
    return privateJson(
      { error: 'Não foi possível salvar a configuração de pagamentos' },
      500
    );
  }
  return privateJson({ ok: true });
}
