/**
 * `WhatsAppProvider` implementation backed by the `whatsapp-worker`
 * service (unofficial WhatsApp Web protocol via Baileys).
 *
 * This class does NOT talk to WhatsApp directly — it's an HTTP client
 * for the sibling worker process, authenticated with a shared secret
 * (`WORKER_API_SECRET`, same value on both sides). The worker owns the
 * actual Baileys socket; see `whatsapp-worker/README.md` for why that
 * process can't live inside this Next.js app (Vercel serverless has no
 * persistent connections, Baileys needs one).
 */

import { extractVariableIndices } from './template-validators';
import { ProviderError } from './provider';
import { renderInteractiveAsText } from './interactive';
import type {
  WhatsAppProvider,
  SendTextParams,
  SendMediaParams,
  SendTemplateParams,
  SendInteractiveParams,
  ProviderSendResult,
} from './provider';

export interface BaileysWorkerProviderConfig {
  accountId: string;
  workerBaseUrl: string;
  workerSecret: string;
}

interface WorkerSendResponse {
  providerMessageKey?: string;
  error?: string;
}

export class BaileysWorkerProvider implements WhatsAppProvider {
  readonly type = 'baileys' as const;

  constructor(private readonly config: BaileysWorkerProviderConfig) {}

  private async postSend(body: Record<string, unknown>): Promise<ProviderSendResult> {
    const url = `${this.config.workerBaseUrl.replace(/\/$/, '')}/send/${this.config.accountId}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.workerSecret}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ProviderError(
        'baileys_worker_unreachable',
        `Não foi possível contatar o worker do WhatsApp Web: ${err instanceof Error ? err.message : err}`,
      );
    }

    let data: WorkerSendResponse = {};
    try {
      data = await response.json();
    } catch {
      // non-JSON body — fall through to the generic error below
    }

    if (!response.ok || !data.providerMessageKey) {
      throw new ProviderError(
        'baileys_send_failed',
        data.error || `Falha ao enviar via WhatsApp Web (worker respondeu ${response.status}).`,
      );
    }
    return { providerMessageKey: data.providerMessageKey };
  }

  async sendText(params: SendTextParams): Promise<ProviderSendResult> {
    return this.postSend({
      type: 'text',
      to: params.to,
      text: params.text,
      contextMessageId: params.contextMessageId,
    });
  }

  async sendMedia(params: SendMediaParams): Promise<ProviderSendResult> {
    return this.postSend({
      type: 'media',
      to: params.to,
      kind: params.kind,
      link: params.link,
      caption: params.caption,
      filename: params.filename,
    });
  }

  /**
   * Baileys has no equivalent of Meta's pre-approved template system —
   * there's no approval step, no `{{1}}` component payload Meta
   * expects. Flatten the template's header/body/footer into a single
   * plain-text message instead (design decision — see the plan doc).
   */
  async sendTemplate(params: SendTemplateParams): Promise<ProviderSendResult> {
    const text = flattenTemplateToText(params);
    return this.postSend({ type: 'text', to: params.to, text });
  }

  /**
   * WhatsApp Web (unofficial) has no real tappable-button/list message
   * type — WhatsApp itself deprecated that outside the official API.
   * Rather than fail the send (which used to break every Flow/
   * automation step that reached a `send_buttons`/`send_list` node on
   * this provider), degrade to a numbered plain-text menu and let
   * `matchReplyText` in the Flows engine recognize a typed "1"/"2"/…
   * as equivalent to a real button tap. See `renderInteractiveAsText`.
   */
  async sendInteractive(params: SendInteractiveParams): Promise<ProviderSendResult> {
    const text = renderInteractiveAsText(params.payload);
    return this.postSend({
      type: 'text',
      to: params.to,
      text,
      contextMessageId: params.contextMessageId,
    });
  }
}

/**
 * Best-effort plain-text rendering of a template for providers with no
 * native template system. Substitutes `{{n}}` body variables from
 * `messageParams.body` (falling back to legacy `params`); a TEXT
 * header/footer are prepended/appended verbatim. Media headers and
 * buttons have no native equivalent, so quick-reply labels are appended
 * as a numbered plain-text menu. The contact can answer with a number or
 * with the option label.
 */
function flattenTemplateToText(params: SendTemplateParams): string {
  const { template, messageParams, params: legacyParams, templateName } = params;
  const bodyValues = messageParams?.body ?? legacyParams ?? [];

  if (!template) {
    // No local template row — nothing to flatten, fall back to the
    // template name itself so the send isn't silently empty.
    return templateName;
  }

  const lines: string[] = [];

  if (template.header_type === 'text' && template.header_content) {
    lines.push(substituteVariables(template.header_content, [messageParams?.headerText ?? '']));
  }

  lines.push(substituteVariables(template.body_text, bodyValues));

  if (template.footer_text) {
    lines.push(template.footer_text);
  }

  const replyOptions = (template.buttons ?? [])
    .filter((button) => button.type === 'QUICK_REPLY')
    .map((button, index) => `${index + 1}. ${button.text}`);
  if (replyOptions.length > 0) {
    lines.push(replyOptions.join('\n'));
  }

  return lines.filter(Boolean).join('\n\n');
}

function substituteVariables(text: string, values: string[]): string {
  const indices = extractVariableIndices(text);
  if (indices.length === 0) return text;
  return text.replace(/\{\{(\d+)\}\}/g, (match, n) => {
    const value = values[Number(n) - 1];
    return value !== undefined ? value : match;
  });
}
