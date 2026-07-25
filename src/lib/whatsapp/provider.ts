/**
 * Provider-agnostic sending interface.
 *
 * Every call site that used to talk to `meta-api.ts` directly now goes
 * through a `WhatsAppProvider` obtained from `getProviderForAccount`
 * (provider-factory.ts). This is what makes the Baileys (unofficial,
 * WhatsApp-Web-protocol) integration a drop-in alternative to the Meta
 * Cloud API rather than a parallel, duplicated send path: the same
 * `sendMessageToConversation` core, the same automations/flows
 * senders, and the same broadcast route all call the four methods
 * below, and never know which provider is actually behind them.
 *
 * Implementations:
 *   - `MetaCloudApiProvider` (meta-provider.ts) — thin wrapper around
 *     the existing `meta-api.ts` functions.
 *   - `BaileysWorkerProvider` (baileys-provider.ts) — HTTP client for
 *     the sibling `whatsapp-worker/` service (Baileys can't run inside
 *     a Vercel serverless function — see the plan doc for why).
 */

import type { MediaKind } from './meta-api';
import type { MessageTemplate, WhatsAppProviderType } from '@/types';
import type { SendTimeParams } from './template-send-builder';
import type { InteractiveMessagePayload } from './interactive';

export interface ProviderSendResult {
  /** Provider-native message id — Meta's `wamid` or Baileys' `key.id`. */
  providerMessageKey: string;
}

export interface SendTextParams {
  to: string;
  text: string;
  contextMessageId?: string;
}

export interface SendMediaParams {
  to: string;
  kind: MediaKind;
  link: string;
  caption?: string;
  filename?: string;
  contextMessageId?: string;
}

export interface SendTemplateParams {
  to: string;
  templateName: string;
  language?: string;
  /** Template row — lets the provider build the full header/body/button send. */
  template?: MessageTemplate;
  messageParams?: SendTimeParams;
  /** Legacy positional body params, kept for callers that predate `messageParams`. */
  params?: string[];
  contextMessageId?: string;
}

export interface SendInteractiveParams {
  to: string;
  payload: InteractiveMessagePayload;
  contextMessageId?: string;
}

/**
 * Thrown by provider implementations. `code` lets callers (e.g.
 * `send-message.ts`) map to the same `SendMessageError` codes/statuses
 * they already use for Meta failures, so the HTTP-facing error shape
 * doesn't change based on which provider is active.
 */
export class ProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
  }
}

export interface WhatsAppProvider {
  readonly type: WhatsAppProviderType;
  sendText(params: SendTextParams): Promise<ProviderSendResult>;
  sendMedia(params: SendMediaParams): Promise<ProviderSendResult>;
  sendTemplate(params: SendTemplateParams): Promise<ProviderSendResult>;
  /**
   * Reply-button / list messages. `MetaCloudApiProvider` sends them for
   * real; `BaileysWorkerProvider` always throws `ProviderError`
   * `'interactive_not_supported'` — see the plan doc for why (WhatsApp
   * itself deprecated this outside the official API).
   */
  sendInteractive(params: SendInteractiveParams): Promise<ProviderSendResult>;
}
