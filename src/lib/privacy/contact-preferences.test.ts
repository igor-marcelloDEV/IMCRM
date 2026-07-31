import { describe, expect, it, vi } from 'vitest';
import {
  isWhatsAppOptOutMessage,
  optOutWhatsAppMarketing,
} from './contact-preferences';

describe('isWhatsAppOptOutMessage', () => {
  it.each([
    'SAIR',
    ' parar ',
    'Stop!',
    'Cancelar mensagens',
    'Não quero receber mensagens',
    'Não quero mais mensagens.',
    'Remover meu número',
  ])('recognizes an explicit opt-out phrase: %s', (value) => {
    expect(isWhatsAppOptOutMessage(value)).toBe(true);
  });

  it.each([
    'Quero cancelar meu pedido',
    'Qual é o número?',
    'Não quero esse produto',
    '',
  ])('does not suppress ambiguous customer requests: %s', (value) => {
    expect(isWhatsAppOptOutMessage(value)).toBe(false);
  });
});

describe('optOutWhatsAppMarketing', () => {
  it('upserts the account-scoped marketing suppression', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const from = vi.fn().mockReturnValue({ upsert });

    await optOutWhatsAppMarketing({ from } as never, {
      accountId: 'account-1',
      contactId: 'contact-1',
      providerMessageKey: 'wamid-1',
    });

    expect(from).toHaveBeenCalledWith('contact_channel_preferences');
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'account-1',
        contact_id: 'contact-1',
        channel: 'whatsapp',
        purpose: 'marketing',
        status: 'opted_out',
        source: 'inbound_keyword',
        proof: { provider_message_key: 'wamid-1' },
      }),
      { onConflict: 'contact_id,channel,purpose' },
    );
  });

  it('surfaces persistence errors', async () => {
    const error = new Error('write failed');
    const db = {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockResolvedValue({ error }),
      }),
    };

    await expect(
      optOutWhatsAppMarketing(db as never, {
        accountId: 'account-1',
        contactId: 'contact-1',
        providerMessageKey: 'wamid-1',
      }),
    ).rejects.toBe(error);
  });
});
