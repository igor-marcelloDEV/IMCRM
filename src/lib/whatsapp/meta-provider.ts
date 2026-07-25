/**
 * `WhatsAppProvider` implementation backed by the Meta Cloud API.
 *
 * Pure wrapper — every method delegates straight to `meta-api.ts`. No
 * behaviour changes vs. the pre-provider-abstraction call sites; this
 * exists only so `send-message.ts` and friends can depend on the
 * generic `WhatsAppProvider` interface instead of importing
 * `meta-api.ts` functions directly.
 */

import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendInteractiveButtons,
  sendInteractiveList,
} from './meta-api';
import type {
  WhatsAppProvider,
  SendTextParams,
  SendMediaParams,
  SendTemplateParams,
  SendInteractiveParams,
  ProviderSendResult,
} from './provider';

export interface MetaCloudApiProviderConfig {
  phoneNumberId: string;
  accessToken: string;
}

export class MetaCloudApiProvider implements WhatsAppProvider {
  readonly type = 'meta_cloud_api' as const;

  constructor(private readonly config: MetaCloudApiProviderConfig) {}

  async sendText(params: SendTextParams): Promise<ProviderSendResult> {
    const result = await sendTextMessage({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: params.to,
      text: params.text,
      contextMessageId: params.contextMessageId,
    });
    return { providerMessageKey: result.messageId };
  }

  async sendMedia(params: SendMediaParams): Promise<ProviderSendResult> {
    const result = await sendMediaMessage({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: params.to,
      kind: params.kind,
      link: params.link,
      caption: params.caption,
      filename: params.filename,
      contextMessageId: params.contextMessageId,
    });
    return { providerMessageKey: result.messageId };
  }

  async sendTemplate(params: SendTemplateParams): Promise<ProviderSendResult> {
    const result = await sendTemplateMessage({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: params.to,
      templateName: params.templateName,
      language: params.language,
      template: params.template,
      messageParams: params.messageParams,
      params: params.params,
      contextMessageId: params.contextMessageId,
    });
    return { providerMessageKey: result.messageId };
  }

  async sendInteractive(params: SendInteractiveParams): Promise<ProviderSendResult> {
    const p = params.payload;
    if (p.kind === 'buttons') {
      const result = await sendInteractiveButtons({
        phoneNumberId: this.config.phoneNumberId,
        accessToken: this.config.accessToken,
        to: params.to,
        bodyText: p.body,
        headerText: p.header || undefined,
        footerText: p.footer || undefined,
        buttons: p.buttons,
        contextMessageId: params.contextMessageId,
      });
      return { providerMessageKey: result.messageId };
    }
    const result = await sendInteractiveList({
      phoneNumberId: this.config.phoneNumberId,
      accessToken: this.config.accessToken,
      to: params.to,
      bodyText: p.body,
      buttonLabel: p.button_label,
      headerText: p.header || undefined,
      footerText: p.footer || undefined,
      sections: p.sections,
      contextMessageId: params.contextMessageId,
    });
    return { providerMessageKey: result.messageId };
  }
}
