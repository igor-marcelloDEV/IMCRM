import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaileysWorkerProvider } from './baileys-provider';
import { ProviderError } from './provider';
import type { MessageTemplate } from '@/types';

// ---------------------------------------------------------------------------
// BaileysWorkerProvider is a thin HTTP client for the sibling whatsapp-worker
// service, plus one piece of real logic worth testing in isolation: flattening
// a Meta-style template (header/body/footer + {{n}} variables) into plain
// text, since Baileys has no native template system (see the plan doc).
// ---------------------------------------------------------------------------

function makeProvider() {
  return new BaileysWorkerProvider({
    accountId: 'acct-1',
    workerBaseUrl: 'http://localhost:3100',
    workerSecret: 'shared-secret',
  });
}

describe('BaileysWorkerProvider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sendText posts to /send/:accountId with a bearer auth header', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ providerMessageKey: 'wa-msg-1' }),
    });

    const provider = makeProvider();
    const result = await provider.sendText({ to: '5511999999999', text: 'oi' });

    expect(result).toEqual({ providerMessageKey: 'wa-msg-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:3100/send/acct-1');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer shared-secret' });
    expect(JSON.parse(init.body as string)).toMatchObject({
      type: 'text',
      to: '5511999999999',
      text: 'oi',
    });
  });

  it('throws a ProviderError when the worker responds with a non-2xx status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'socket not connected' }),
    });

    const provider = makeProvider();
    await expect(provider.sendText({ to: '5511999999999', text: 'oi' })).rejects.toMatchObject({
      code: 'baileys_send_failed',
      message: 'socket not connected',
    });
  });

  it('throws a ProviderError when the worker is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const provider = makeProvider();
    await expect(provider.sendText({ to: '5511999999999', text: 'oi' })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it('sendInteractive degrades buttons/lists to a numbered text menu instead of throwing', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ providerMessageKey: 'wa-msg-4' }),
    });

    const provider = makeProvider();
    const result = await provider.sendInteractive({
      to: '5511999999999',
      payload: {
        kind: 'buttons',
        body: 'Pick one',
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'b', title: 'B' },
        ],
      },
    });

    expect(result).toEqual({ providerMessageKey: 'wa-msg-4' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('text');
    expect(body.text).toBe('Pick one\n\n1. A\n2. B\n\nResponda com o número da opção.');
  });

  it('sendTemplate flattens header + body + footer into plain text with variables substituted', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ providerMessageKey: 'wa-msg-2' }),
    });

    const template: MessageTemplate = {
      id: 't-1',
      user_id: 'u-1',
      name: 'order_update',
      category: 'Utility',
      header_type: 'text',
      header_content: 'Order {{1}}',
      body_text: 'Hi {{1}}, your order {{2}} shipped.',
      footer_text: 'Thanks for shopping with us',
      created_at: new Date().toISOString(),
    };

    const provider = makeProvider();
    await provider.sendTemplate({
      to: '5511999999999',
      templateName: 'order_update',
      template,
      messageParams: { headerText: '#1234', body: ['Acme', '#1234'] },
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.type).toBe('text');
    expect(body.text).toBe(
      'Order #1234\n\nHi Acme, your order #1234 shipped.\n\nThanks for shopping with us',
    );
  });

  it('sendTemplate falls back to the template name when no local template row is available', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ providerMessageKey: 'wa-msg-3' }),
    });

    const provider = makeProvider();
    await provider.sendTemplate({ to: '5511999999999', templateName: 'order_update' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe('order_update');
  });
});
