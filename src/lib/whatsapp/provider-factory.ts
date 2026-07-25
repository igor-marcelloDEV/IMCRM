/**
 * Resolves the right `WhatsAppProvider` for an account.
 *
 * Every send call site (dashboard send, public v1 API, automations,
 * flows, broadcasts) calls this instead of loading `whatsapp_config`
 * and hand-rolling a Meta client. One provider is active per account
 * at a time (`accounts.active_whatsapp_provider`, 037_baileys_
 * integration.sql) — see the plan doc for why "one at a time" was the
 * chosen scope over true multi-number-per-account.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt, isLegacyFormat } from './encryption';
import { MetaCloudApiProvider } from './meta-provider';
import { BaileysWorkerProvider } from './baileys-provider';
import { ProviderError, type WhatsAppProvider } from './provider';

export async function getProviderForAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppProvider> {
  const { data: account, error: accountError } = await db
    .from('accounts')
    .select('active_whatsapp_provider')
    .eq('id', accountId)
    .single();

  if (accountError || !account) {
    throw new ProviderError('whatsapp_not_configured', 'Conta não encontrada.');
  }

  if (account.active_whatsapp_provider === 'baileys') {
    return getBaileysProvider(db, accountId);
  }
  return getMetaProvider(db, accountId);
}

async function getMetaProvider(
  db: SupabaseClient,
  accountId: string,
): Promise<MetaCloudApiProvider> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single();

  if (error || !config) {
    throw new ProviderError(
      'whatsapp_not_configured',
      'WhatsApp não configurado. Configure sua integração com a API oficial da Meta primeiro.',
    );
  }

  const accessToken = decrypt(config.access_token);

  // Self-heal legacy CBC ciphertexts, same fire-and-forget pattern the
  // manual-send route used to run inline — centralised here so every
  // provider-factory caller benefits, not just that one path.
  if (isLegacyFormat(config.access_token)) {
    void db
      .from('whatsapp_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', config.id)
      .then(({ error: updateError }: { error: { message: string } | null }) => {
        if (updateError) {
          console.warn(
            '[provider-factory] access_token GCM upgrade failed:',
            updateError.message,
          );
        }
      });
  }

  return new MetaCloudApiProvider({
    phoneNumberId: config.phone_number_id,
    accessToken,
  });
}

async function getBaileysProvider(
  db: SupabaseClient,
  accountId: string,
): Promise<BaileysWorkerProvider> {
  const { data: connection, error } = await db
    .from('baileys_connections')
    .select('status')
    .eq('account_id', accountId)
    .maybeSingle();

  if (error || !connection || connection.status !== 'connected') {
    throw new ProviderError(
      'whatsapp_not_configured',
      'WhatsApp Web não está conectado. Escaneie o QR code em Configurações → Conexão WhatsApp.',
    );
  }

  const workerBaseUrl = process.env.WHATSAPP_WORKER_URL;
  const workerSecret = process.env.WORKER_API_SECRET;
  if (!workerBaseUrl || !workerSecret) {
    throw new ProviderError(
      'baileys_worker_not_configured',
      'O worker do WhatsApp Web não está configurado neste ambiente (defina WHATSAPP_WORKER_URL e WORKER_API_SECRET).',
    );
  }

  return new BaileysWorkerProvider({ accountId, workerBaseUrl, workerSecret });
}
