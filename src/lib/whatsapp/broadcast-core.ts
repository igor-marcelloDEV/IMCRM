// ============================================================
// Durable broadcast core.
//
// HTTP routes only validate, resolve recipients and atomically enqueue
// one persisted job per recipient. A protected cron claims jobs with a
// database lease and performs provider calls outside the request that
// created the campaign.
//
// Delivery is intentionally at-least-once: the unique recipient job +
// lease prevent concurrent sends, while retries recover from worker
// death. No WhatsApp provider offers a caller-supplied idempotency key
// that can close the tiny "provider accepted, DB unavailable" window.
// ============================================================

import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

import { findOrCreateContact } from '@/lib/api/v1/contacts';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { getProviderForAccount } from '@/lib/whatsapp/provider-factory';
import { ProviderError, type WhatsAppProvider } from '@/lib/whatsapp/provider';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import type { MessageTemplate } from '@/types';

/** Thrown by createBroadcast on a caller-visible failure; routes map it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /**
   * Dashboard callers may supply an already-resolved contact. The core
   * re-reads it under account scope and never trusts the browser phone.
   */
  contactId?: string;
  /** Positional body params for the template ({{1}}, {{2}}...). */
  params?: string[];
  /** Header/body/button values for rich templates. */
  messageParams?: SendTimeParams;
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  templateVariables?: Record<string, unknown> | null;
  audienceFilter?: Record<string, unknown> | null;
  /** Stable across an HTTP retry. Generated when omitted. */
  idempotencyKey?: string | null;
}

export interface EnqueuedBroadcast {
  broadcastId: string;
  status: 'sending' | 'sent' | 'failed';
  totalRecipients: number;
  /** Recipient jobs that were actually queued. */
  accepted: number;
  /** Invalid phones rejected before a recipient row could be created. */
  rejected: number;
  /** Marketing opt-outs recorded as recipient rows without a send job. */
  skipped: number;
  replayed: boolean;
}

/** Backward-compatible name for code that previously consumed a send plan. */
export type BroadcastPlan = EnqueuedBroadcast;

interface ResolvedRecipient {
  contactId: string;
  phone: string;
  params: string[];
  messageParams?: SendTimeParams;
}

interface EnqueueRpcRow {
  broadcast_id: string;
  total_recipients: number;
  rejected_recipients: number;
  skipped_count: number;
  replayed: boolean;
}

interface BroadcastDeliveryJobRow {
  id: string;
  account_id: string;
  broadcast_id: string;
  recipient_id: string;
  destination: string;
  template_params: unknown;
  message_params: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
}

interface BroadcastContextRow {
  account_id: string;
  template_name: string;
  template_language: string;
  template_variables: Record<string, unknown> | null;
}

type JobOutcome = 'sent' | 'retried' | 'failed' | 'skipped' | 'stale';

export interface ProcessBroadcastBatchResult {
  resumed: number;
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
  stale: number;
}

const MAX_RECIPIENTS = 1000;
const MARKETING_OPT_OUT_REASON = 'marketing_opt_out';

class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function normalizeMessageParams(value: unknown): SendTimeParams | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const result: SendTimeParams = {};

  if (Array.isArray(raw.body)) {
    result.body = normalizeStringArray(raw.body);
  }
  if (typeof raw.headerText === 'string') {
    result.headerText = raw.headerText;
  }
  if (typeof raw.headerMediaUrl === 'string') {
    result.headerMediaUrl = raw.headerMediaUrl;
  }
  if (typeof raw.headerMediaId === 'string') {
    result.headerMediaId = raw.headerMediaId;
  }
  if (
    raw.buttonParams &&
    typeof raw.buttonParams === 'object' &&
    !Array.isArray(raw.buttonParams)
  ) {
    const buttonParams: Record<number, string> = {};
    for (const [key, buttonValue] of Object.entries(raw.buttonParams)) {
      const index = Number(key);
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        typeof buttonValue === 'string'
      ) {
        buttonParams[index] = buttonValue;
      }
    }
    result.buttonParams = buttonParams;
  }

  return result;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function rpcRow<T>(data: T[] | T | null): T | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data;
}

async function assertProviderConfigured(
  db: SupabaseClient,
  accountId: string
): Promise<void> {
  try {
    await getProviderForAccount(db, accountId);
  } catch (error) {
    const message =
      error instanceof ProviderError
        ? error.message
        : 'WhatsApp is not configured for this account.';
    throw new BroadcastError('whatsapp_not_configured', message, 400);
  }
}

async function loadAndValidateTemplate(
  db: SupabaseClient,
  accountId: string,
  templateName: string,
  templateLanguage: string
): Promise<MessageTemplate | null> {
  const { data: rawTemplateRow, error } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', accountId)
    .eq('name', templateName)
    .eq('language', templateLanguage)
    .maybeSingle();

  if (error) {
    throw new BroadcastError(
      'internal',
      'Failed to validate the selected message template',
      500
    );
  }
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally - run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  return (rawTemplateRow as MessageTemplate | null) ?? null;
}

async function resolveRecipients(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  recipients: BroadcastRecipientInput[]
): Promise<{ recipients: ResolvedRecipient[]; rejected: number }> {
  const suppliedContactIds = [
    ...new Set(
      recipients
        .map((recipient) => recipient.contactId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
    ),
  ];
  const contactById = new Map<string, { id: string; phone: string | null }>();

  if (suppliedContactIds.length > 0) {
    const { data, error } = await db
      .from('contacts')
      .select('id, phone')
      .eq('account_id', accountId)
      .in('id', suppliedContactIds);
    if (error) {
      throw new BroadcastError(
        'internal',
        'Failed to resolve broadcast contacts',
        500
      );
    }
    for (const contact of data ?? []) {
      contactById.set(contact.id as string, {
        id: contact.id as string,
        phone: (contact.phone as string | null) ?? null,
      });
    }
  }

  const resolved: ResolvedRecipient[] = [];
  let rejected = 0;

  for (const recipient of recipients) {
    let contactId: string;
    let rawPhone = recipient.to;

    if (recipient.contactId) {
      const contact = contactById.get(recipient.contactId);
      if (!contact) {
        throw new BroadcastError(
          'bad_request',
          'A recipient contact does not belong to this account',
          400
        );
      }
      contactId = contact.id;
      rawPhone = contact.phone ?? '';
    } else {
      const sanitizedInput = sanitizePhoneForMeta(
        typeof recipient.to === 'string' ? recipient.to : ''
      );
      if (!isValidE164(sanitizedInput)) {
        rejected++;
        continue;
      }
      const contact = await findOrCreateContact(db, accountId, auditUserId, {
        phone: sanitizedInput,
      });
      contactId = contact.id;
    }

    const phone = sanitizePhoneForMeta(
      typeof rawPhone === 'string' ? rawPhone : ''
    );
    if (!isValidE164(phone)) {
      rejected++;
      continue;
    }

    resolved.push({
      contactId,
      phone,
      params: normalizeStringArray(recipient.params),
      messageParams: normalizeMessageParams(recipient.messageParams),
    });
  }

  // One persisted job per contact. Keep the first parameter set so a
  // duplicated phone in an API payload cannot send twice.
  const seen = new Set<string>();
  return {
    recipients: resolved.filter((recipient) => {
      if (seen.has(recipient.contactId)) return false;
      seen.add(recipient.contactId);
      return true;
    }),
    rejected,
  };
}

async function findMarketingOptOuts(
  db: SupabaseClient,
  accountId: string,
  contactIds: string[]
): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set();

  const { data, error } = await db
    .from('contact_channel_preferences')
    .select('contact_id')
    .in('contact_id', contactIds)
    .eq('account_id', accountId)
    .eq('channel', 'whatsapp')
    .eq('purpose', 'marketing')
    .eq('status', 'opted_out');

  // Consent checks fail closed. A transient DB/schema-cache issue must
  // delay a campaign, never silently send through an unknown preference.
  if (error) {
    console.error('[broadcast-core] marketing preference check failed:', error);
    throw new BroadcastError(
      'consent_check_failed',
      'Could not verify recipient marketing preferences; no messages were queued.',
      503
    );
  }

  return new Set((data ?? []).map((row) => row.contact_id as string));
}

/**
 * Validate, resolve and atomically persist a campaign. No provider call
 * happens here. The database RPC creates broadcast, recipient and job
 * rows in one transaction and replays the same idempotency key safely.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<EnqueuedBroadcast> {
  const { name, templateName, recipients } = params;
  const templateLanguage = params.templateLanguage || 'en_US';
  const idempotencyKey = params.idempotencyKey?.trim() || randomUUID();

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }
  if (idempotencyKey.length > 200) {
    throw new BroadcastError(
      'bad_request',
      'Idempotency key cannot exceed 200 characters',
      400
    );
  }

  // Fingerprint the caller's normalized request, not mutable contact or
  // preference state. An HTTP retry must replay the original enqueue
  // even if a contact edits their phone or opts out milliseconds later.
  const fingerprint = requestFingerprint({
    accountId,
    name: name || `API broadcast (${templateName})`,
    templateName,
    templateLanguage,
    templateVariables: params.templateVariables ?? null,
    audienceFilter: params.audienceFilter ?? null,
    recipients: recipients.map((recipient) => ({
      contactId: recipient.contactId ?? null,
      to: sanitizePhoneForMeta(
        typeof recipient.to === 'string' ? recipient.to : ''
      ),
      params: normalizeStringArray(recipient.params),
      messageParams: normalizeMessageParams(recipient.messageParams) ?? null,
    })),
  });

  const { data: existing, error: existingError } = await db
    .from('broadcasts')
    .select(
      'id, status, total_recipients, rejected_recipients, skipped_count, enqueue_fingerprint'
    )
    .eq('account_id', accountId)
    .eq('enqueue_key', idempotencyKey)
    .maybeSingle();
  if (existingError) {
    throw new BroadcastError(
      'internal',
      'Failed to check broadcast idempotency',
      500
    );
  }
  if (existing) {
    if (existing.enqueue_fingerprint !== fingerprint) {
      throw new BroadcastError(
        'idempotency_conflict',
        'This idempotency key was already used for a different broadcast',
        409
      );
    }
    const totalRecipients = Number(existing.total_recipients) || 0;
    const skipped = Number(existing.skipped_count) || 0;
    return {
      broadcastId: existing.id as string,
      status:
        existing.status === 'failed'
          ? 'failed'
          : existing.status === 'sent'
            ? 'sent'
            : 'sending',
      totalRecipients,
      accepted: Math.max(0, totalRecipients - skipped),
      rejected: Number(existing.rejected_recipients) || 0,
      skipped,
      replayed: true,
    };
  }

  await assertProviderConfigured(db, accountId);
  await loadAndValidateTemplate(db, accountId, templateName, templateLanguage);

  const resolved = await resolveRecipients(
    db,
    accountId,
    auditUserId,
    recipients
  );
  if (resolved.recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  const optedOut = await findMarketingOptOuts(
    db,
    accountId,
    resolved.recipients.map((recipient) => recipient.contactId)
  );
  const enqueueRecipients = resolved.recipients.map((recipient) => {
    const skipped = optedOut.has(recipient.contactId);
    return {
      contact_id: recipient.contactId,
      destination: recipient.phone,
      status: skipped ? 'skipped' : 'pending',
      ...(skipped ? { error_message: MARKETING_OPT_OUT_REASON } : {}),
      template_params: recipient.params,
      ...(recipient.messageParams
        ? { message_params: recipient.messageParams }
        : {}),
    };
  });

  const { data, error } = await db.rpc('enqueue_broadcast_delivery', {
    p_account_id: accountId,
    p_user_id: auditUserId,
    p_name: name || `API broadcast (${templateName})`,
    p_template_name: templateName,
    p_template_language: templateLanguage,
    p_template_variables: params.templateVariables ?? null,
    p_audience_filter: params.audienceFilter ?? null,
    p_enqueue_key: idempotencyKey,
    p_enqueue_fingerprint: fingerprint,
    p_rejected_recipients: resolved.rejected,
    p_recipients: enqueueRecipients,
  });

  if (error) {
    console.error('[broadcast-core] atomic enqueue failed:', error);
    const conflict = /different request|enqueue key/i.test(error.message);
    throw new BroadcastError(
      conflict ? 'idempotency_conflict' : 'internal',
      conflict
        ? 'This idempotency key was already used for a different broadcast'
        : 'Failed to enqueue broadcast',
      conflict ? 409 : 500
    );
  }

  const row = rpcRow(data as EnqueueRpcRow[] | EnqueueRpcRow | null);
  if (!row) {
    throw new BroadcastError('internal', 'Failed to enqueue broadcast', 500);
  }

  const skipped = Number(row.skipped_count) || 0;
  const totalRecipients = Number(row.total_recipients) || 0;
  return {
    broadcastId: row.broadcast_id,
    status: skipped === totalRecipients ? 'sent' : 'sending',
    totalRecipients,
    accepted: Math.max(0, totalRecipients - skipped),
    rejected: Number(row.rejected_recipients) || 0,
    skipped,
    replayed: Boolean(row.replayed),
  };
}

async function loadBroadcastContext(
  db: SupabaseClient,
  job: BroadcastDeliveryJobRow
): Promise<BroadcastContextRow> {
  const { data, error } = await db
    .from('broadcasts')
    .select('account_id, template_name, template_language, template_variables')
    .eq('id', job.broadcast_id)
    .eq('account_id', job.account_id)
    .maybeSingle();

  if (error) {
    throw new DeliveryError(
      `Could not load broadcast context: ${error.message}`,
      true
    );
  }
  if (!data) {
    throw new DeliveryError('Broadcast no longer exists', false);
  }
  return {
    account_id: data.account_id as string,
    template_name: data.template_name as string,
    template_language: data.template_language as string,
    template_variables:
      (data.template_variables as Record<string, unknown> | null) ?? null,
  };
}

async function loadRecipientContactId(
  db: SupabaseClient,
  recipientId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('broadcast_recipients')
    .select('contact_id')
    .eq('id', recipientId)
    .maybeSingle();
  if (error) {
    throw new DeliveryError(
      `Could not load broadcast recipient: ${error.message}`,
      true
    );
  }
  if (!data) {
    throw new DeliveryError('Broadcast recipient no longer exists', false);
  }
  return (data.contact_id as string | null) ?? null;
}

async function isMarketingOptedOutNow(
  db: SupabaseClient,
  accountId: string,
  contactId: string | null
): Promise<boolean> {
  if (!contactId) return false;
  const { data, error } = await db
    .from('contact_channel_preferences')
    .select('status')
    .eq('contact_id', contactId)
    .eq('account_id', accountId)
    .eq('channel', 'whatsapp')
    .eq('purpose', 'marketing')
    .eq('status', 'opted_out')
    .maybeSingle();
  if (error) {
    throw new DeliveryError(
      `Could not recheck marketing preference: ${error.message}`,
      true
    );
  }
  return Boolean(data);
}

interface StoredVariableMapping {
  type?: unknown;
  value?: unknown;
}

function sortedVariableKeys(variables: Record<string, unknown>): string[] {
  return Object.keys(variables).sort((left, right) => {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      return leftNumber - rightNumber;
    }
    return left.localeCompare(right);
  });
}

async function deriveLegacyTemplateParams(
  db: SupabaseClient,
  contactId: string | null,
  variables: Record<string, unknown> | null
): Promise<string[]> {
  if (!variables || Object.keys(variables).length === 0) return [];
  if (!contactId) {
    throw new DeliveryError(
      'Cannot derive template variables because the contact was deleted',
      false
    );
  }

  const { data: contact, error: contactError } = await db
    .from('contacts')
    .select('name, phone, email, company')
    .eq('id', contactId)
    .maybeSingle();
  if (contactError) {
    throw new DeliveryError(
      `Could not load contact variables: ${contactError.message}`,
      true
    );
  }
  if (!contact) {
    throw new DeliveryError(
      'Cannot derive template variables because the contact was deleted',
      false
    );
  }

  const { data: customRows, error: customError } = await db
    .from('contact_custom_values')
    .select('custom_field_id, value')
    .eq('contact_id', contactId);
  if (customError) {
    throw new DeliveryError(
      `Could not load custom field variables: ${customError.message}`,
      true
    );
  }
  const customValues = new Map(
    (customRows ?? []).map((row) => [
      row.custom_field_id as string,
      (row.value as string | null) ?? '',
    ])
  );

  return sortedVariableKeys(variables).map((key) => {
    const mapping = variables[key] as StoredVariableMapping | null;
    if (!mapping || typeof mapping !== 'object') return '';
    const value = typeof mapping.value === 'string' ? mapping.value : '';
    if (mapping.type === 'static') return value;
    if (mapping.type === 'custom_field') return customValues.get(value) ?? '';
    if (mapping.type === 'field') {
      const fields: Record<string, string> = {
        name: (contact.name as string | null) ?? '',
        phone: (contact.phone as string | null) ?? '',
        email: (contact.email as string | null) ?? '',
        company: (contact.company as string | null) ?? '',
      };
      return fields[value] ?? '';
    }
    return '';
  });
}

function templateCacheKey(context: BroadcastContextRow): string {
  return [
    context.account_id,
    context.template_name,
    context.template_language,
  ].join(':');
}

async function loadWorkerTemplate(
  db: SupabaseClient,
  context: BroadcastContextRow
): Promise<MessageTemplate | null> {
  const { data, error } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', context.account_id)
    .eq('name', context.template_name)
    .eq('language', context.template_language)
    .maybeSingle();
  if (error) {
    throw new DeliveryError(
      `Could not load message template: ${error.message}`,
      true
    );
  }
  if (data && !isMessageTemplate(data)) {
    throw new DeliveryError(
      'Template row is malformed locally; sync it from Meta before retrying',
      false
    );
  }
  return (data as MessageTemplate | null) ?? null;
}

function isRetryableProviderFailure(error: unknown): boolean {
  if (error instanceof DeliveryError) return error.retryable;
  const message = error instanceof Error ? error.message : String(error);

  // These are deterministic input/template failures. Network, provider
  // 5xx/rate limits and disconnected workers remain retryable.
  return !(
    isRecipientNotAllowedError(message) ||
    /requires a value|requires a media|variable\(s\)|invalid phone|malformed locally|unsupported template/i.test(
      message
    )
  );
}

function backoffSeconds(attempt: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
}

async function completeClaimedJob(
  db: SupabaseClient,
  jobId: string,
  workerId: string,
  providerMessageId: string
): Promise<boolean> {
  let lastError: { message: string } | null = null;

  // If the provider accepted the message, prefer retrying only the
  // atomic completion write before ever allowing another provider send.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await db.rpc('complete_broadcast_delivery_job', {
      p_job_id: jobId,
      p_worker_id: workerId,
      p_provider_message_id: providerMessageId,
    });
    if (!error) return Boolean(data);
    lastError = error;
  }

  throw new DeliveryError(
    `Provider accepted the message but completion could not be persisted: ${
      lastError?.message ?? 'unknown database error'
    }`,
    true
  );
}

async function processClaimedJob(
  db: SupabaseClient,
  job: BroadcastDeliveryJobRow,
  workerId: string,
  providerCache: Map<string, Promise<WhatsAppProvider>>,
  templateCache: Map<string, Promise<MessageTemplate | null>>
): Promise<JobOutcome> {
  try {
    const context = await loadBroadcastContext(db, job);
    const contactId = await loadRecipientContactId(db, job.recipient_id);

    // Recheck at send time: a contact may opt out after the campaign was
    // enqueued but before its durable job is claimed.
    if (await isMarketingOptedOutNow(db, context.account_id, contactId)) {
      const { data, error } = await db.rpc('skip_broadcast_delivery_job', {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_reason: MARKETING_OPT_OUT_REASON,
      });
      if (error) {
        throw new DeliveryError(
          `Could not persist consent suppression: ${error.message}`,
          true
        );
      }
      return data ? 'skipped' : 'stale';
    }

    const destination = sanitizePhoneForMeta(job.destination);
    if (!isValidE164(destination)) {
      throw new DeliveryError('Recipient has an invalid phone number', false);
    }

    const params =
      job.template_params === null
        ? await deriveLegacyTemplateParams(
            db,
            contactId,
            context.template_variables
          )
        : normalizeStringArray(job.template_params);
    if (job.template_params !== null && !Array.isArray(job.template_params)) {
      throw new DeliveryError(
        'Persisted template parameters are malformed',
        false
      );
    }
    const messageParams = normalizeMessageParams(job.message_params);
    if (
      job.message_params !== null &&
      job.message_params !== undefined &&
      !messageParams
    ) {
      throw new DeliveryError(
        'Persisted structured message parameters are malformed',
        false
      );
    }

    let providerPromise = providerCache.get(context.account_id);
    if (!providerPromise) {
      providerPromise = getProviderForAccount(db, context.account_id);
      providerCache.set(context.account_id, providerPromise);
    }

    const cacheKey = templateCacheKey(context);
    let templatePromise = templateCache.get(cacheKey);
    if (!templatePromise) {
      templatePromise = loadWorkerTemplate(db, context);
      templateCache.set(cacheKey, templatePromise);
    }
    const [provider, template] = await Promise.all([
      providerPromise,
      templatePromise,
    ]);

    let providerMessageId: string | null = null;
    let lastError: unknown = null;
    for (const variant of phoneVariants(destination)) {
      try {
        const result = await provider.sendTemplate({
          to: variant,
          templateName: context.template_name,
          language: context.template_language,
          template: template ?? undefined,
          params,
          messageParams,
        });
        providerMessageId = result.providerMessageKey;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!isRecipientNotAllowedError(message)) break;
      }
    }
    if (!providerMessageId) {
      throw lastError ?? new Error('Provider returned no message id');
    }

    const completed = await completeClaimedJob(
      db,
      job.id,
      workerId,
      providerMessageId
    );
    return completed ? 'sent' : 'stale';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const { data, error: outcomeError } = await db.rpc(
      'fail_or_retry_broadcast_delivery_job',
      {
        p_job_id: job.id,
        p_worker_id: workerId,
        p_error: message,
        p_retryable: isRetryableProviderFailure(error),
        p_delay_seconds: backoffSeconds(job.attempts),
      }
    );
    if (outcomeError) {
      console.error(
        '[broadcast-core] failed to persist delivery outcome:',
        outcomeError
      );
      return 'stale';
    }
    if (data === 'retry') return 'retried';
    if (data === 'failed') return 'failed';
    if (data === 'skipped') return 'skipped';
    if (data === 'succeeded') return 'sent';
    return 'stale';
  }
}

/**
 * Resume legacy `sending` campaigns, atomically claim a bounded batch,
 * and process each recipient. Safe for overlapping cron invocations:
 * SKIP LOCKED + locked_by make each claimed lease exclusive.
 */
export async function processBroadcastDeliveryBatch(
  db: SupabaseClient,
  options: {
    workerId?: string;
    limit?: number;
    leaseSeconds?: number;
  } = {}
): Promise<ProcessBroadcastBatchResult> {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const leaseSeconds = Math.max(30, Math.min(options.leaseSeconds ?? 120, 900));
  const workerId = (options.workerId || `broadcast-cron:${randomUUID()}`).slice(
    0,
    128
  );

  const { data: resumedData, error: resumeError } = await db.rpc(
    'resume_sending_broadcast_jobs',
    { p_limit: Math.min(limit * 4, 1000) }
  );
  if (resumeError) {
    throw new Error(
      `Could not resume durable broadcast jobs: ${resumeError.message}`
    );
  }

  const result: ProcessBroadcastBatchResult = {
    resumed: Number(resumedData) || 0,
    claimed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    skipped: 0,
    stale: 0,
  };
  const providerCache = new Map<string, Promise<WhatsAppProvider>>();
  const templateCache = new Map<string, Promise<MessageTemplate | null>>();

  // Claim immediately before each sequential provider call. Claiming
  // the whole batch up front would start every lease at once; a slow
  // first send could let later leases expire before this worker reaches
  // them, allowing a second cron to double-claim those recipients.
  for (let slot = 0; slot < limit; slot++) {
    const { data: claimedData, error: claimError } = await db.rpc(
      'claim_broadcast_delivery_jobs',
      {
        p_worker_id: workerId,
        p_limit: 1,
        p_lease_seconds: leaseSeconds,
      }
    );
    if (claimError) {
      throw new Error(`Could not claim broadcast jobs: ${claimError.message}`);
    }
    const job = ((claimedData ?? []) as BroadcastDeliveryJobRow[])[0];
    if (!job) break;
    result.claimed++;

    const outcome = await processClaimedJob(
      db,
      job,
      workerId,
      providerCache,
      templateCache
    );
    result[outcome]++;
  }

  return result;
}
