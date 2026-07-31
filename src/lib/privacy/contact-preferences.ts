import type { SupabaseClient } from '@supabase/supabase-js';

const WHATSAPP_OPT_OUT_PHRASES = new Set([
  'sair',
  'parar',
  'stop',
  'cancelar mensagens',
  'nao quero receber mensagens',
  'nao quero mais mensagens',
  'remover meu numero',
]);

function normalizePreferenceText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isWhatsAppOptOutMessage(value: string | null | undefined): boolean {
  if (!value) return false;
  return WHATSAPP_OPT_OUT_PHRASES.has(normalizePreferenceText(value));
}

export async function optOutWhatsAppMarketing(
  db: SupabaseClient,
  input: {
    accountId: string;
    contactId: string;
    providerMessageKey: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db.from('contact_channel_preferences').upsert(
    {
      account_id: input.accountId,
      contact_id: input.contactId,
      channel: 'whatsapp',
      purpose: 'marketing',
      status: 'opted_out',
      source: 'inbound_keyword',
      proof: { provider_message_key: input.providerMessageKey },
      consented_at: null,
      opted_out_at: now,
      updated_at: now,
    },
    { onConflict: 'contact_id,channel,purpose' },
  );

  if (error) throw error;
}

