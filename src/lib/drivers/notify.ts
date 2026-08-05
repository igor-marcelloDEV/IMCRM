import type { SupabaseClient } from '@supabase/supabase-js';

import { getProviderForAccount } from '@/lib/whatsapp/provider-factory';
import { ProviderError } from '@/lib/whatsapp/provider';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import type { DeliveryDriver } from '@/types';

/**
 * Sends a plain WhatsApp text to a driver's own phone. Drivers aren't CRM
 * contacts, so this bypasses `sendMessageToConversation` (which requires an
 * existing `conversations`/`contacts` row) and talks to the account's active
 * provider directly — no message history is persisted, this is operational
 * dispatch, not a customer conversation.
 */
export async function notifyDriver(
  db: SupabaseClient,
  accountId: string,
  driver: Pick<DeliveryDriver, 'phone'>,
  text: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const phone = sanitizePhoneForMeta(driver.phone);
  if (!isValidE164(phone)) {
    return { ok: false, error: 'Telefone do entregador inválido.' };
  }
  try {
    const provider = await getProviderForAccount(db, accountId);
    await provider.sendText({ to: phone, text });
    return { ok: true };
  } catch (err) {
    const message =
      err instanceof ProviderError || err instanceof Error
        ? err.message
        : 'Falha ao enviar mensagem.';
    return { ok: false, error: message };
  }
}

/** Fills `{{pedido}}`/`{{endereco}}`/`{{loja}}` placeholders in a staff-authored template. */
export function renderDriverMessage(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
}

export const DEFAULT_DRIVER_NEW_JOB_TEMPLATE =
  'Nova entrega disponível: pedido {{pedido}}, entrega em {{endereco}}. Abra o app para aceitar.';
