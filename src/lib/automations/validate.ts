import type { AutomationTriggerType } from '@/types'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'

// ------------------------------------------------------------
// Pre-flight config validation for automations about to be activated.
//
// Activating a broken automation (e.g. an add_tag step with tag_id="")
// used to succeed silently — every trigger then produced a failed log
// row with a cryptic "add_tag needs contact + tag_id" message, and
// users often didn't notice until reviewing logs. This module lets
// the API refuse activation with a useful 400 response instead.
//
// The rules here mirror the runtime checks in engine.ts's runStep;
// they're the same invariants, enforced one step earlier so failures
// surface at save time.
// ------------------------------------------------------------

export interface ValidationIssue {
  /** Dot-path for the UI to highlight; stable enough to build a table. */
  path: string
  /** Canonical English text — kept for tests/logs. The builder UI
   *  renders messageKey instead (see automation-builder.tsx), same
   *  fix as src/lib/flows/validate.ts for the identical bug. */
  message: string
  /** Key under `Automations.validation.messages` — what the UI renders. */
  messageKey: string
  params?: Record<string, string | number>
}

interface StepLike {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: StepLike[]; no?: StepLike[] }
}

export function validateStepsForActivation(steps: StepLike[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!Array.isArray(steps) || steps.length === 0) {
    issues.push({
      path: 'steps',
      message: 'active automations need at least one step',
      messageKey: 'needsOneStep',
    })
    return issues
  }
  walk(steps, '', issues)
  return issues
}

function walk(steps: StepLike[], prefix: string, issues: ValidationIssue[]): void {
  steps.forEach((s, i) => {
    const path = `${prefix}steps[${i}]`
    validateOne(s, path, issues)
    if (s.step_type === 'condition' && s.branches) {
      if (s.branches.yes) walk(s.branches.yes, `${path}.yes.`, issues)
      if (s.branches.no) walk(s.branches.no, `${path}.no.`, issues)
    }
  })
}

function validateOne(step: StepLike, path: string, issues: ValidationIssue[]): void {
  const c = step.step_config ?? {}
  switch (step.step_type) {
    case 'send_message':
      if (!nonEmpty(c.text)) {
        issues.push({ path: `${path}.text`, message: 'message text is required', messageKey: 'sendMessage.textRequired' })
      }
      break
    case 'send_buttons':
    case 'send_list': {
      // The whole step_config IS the interactive payload; validate it
      // against Meta's limits (same check the engine runs before send).
      // `result.error` stays English (src/lib/whatsapp/interactive.ts
      // isn't translated yet) — wrapped so at least the surrounding
      // sentence localizes; the Meta-limit detail rides along as a param.
      const result = validateInteractivePayload(c)
      if (!result.ok) {
        issues.push({
          path: `${path}.interactive`,
          message: result.error,
          messageKey: 'interactivePayloadInvalid',
          params: { detail: result.error },
        })
      }
      break
    }
    case 'send_template':
      if (!nonEmpty(c.template_name)) {
        issues.push({ path: `${path}.template_name`, message: 'template name is required', messageKey: 'sendTemplate.nameRequired' })
      }
      break
    case 'add_tag':
    case 'remove_tag':
      if (!nonEmpty(c.tag_id)) {
        issues.push({ path: `${path}.tag_id`, message: 'tag is required', messageKey: 'tagRequired' })
      }
      break
    case 'assign_conversation':
      if (c.mode === 'specific' && !nonEmpty(c.agent_id)) {
        issues.push({
          path: `${path}.agent_id`,
          message: 'agent is required when mode is "specific"',
          messageKey: 'assignConversation.agentRequired',
        })
      }
      break
    case 'update_contact_field':
      if (!nonEmpty(c.field)) {
        issues.push({ path: `${path}.field`, message: 'field name is required', messageKey: 'updateContactField.fieldRequired' })
      }
      if (c.value === undefined || c.value === null || c.value === '') {
        issues.push({ path: `${path}.value`, message: 'field value is required', messageKey: 'updateContactField.valueRequired' })
      }
      break
    case 'create_deal':
      if (!nonEmpty(c.pipeline_id)) {
        issues.push({ path: `${path}.pipeline_id`, message: 'pipeline is required', messageKey: 'createDeal.pipelineRequired' })
      }
      if (!nonEmpty(c.stage_id)) {
        issues.push({ path: `${path}.stage_id`, message: 'stage is required', messageKey: 'createDeal.stageRequired' })
      }
      if (!nonEmpty(c.title)) {
        issues.push({ path: `${path}.title`, message: 'title is required', messageKey: 'createDeal.titleRequired' })
      }
      break
    case 'wait':
      if (typeof c.amount !== 'number' || !Number.isFinite(c.amount) || c.amount <= 0) {
        issues.push({ path: `${path}.amount`, message: 'wait amount must be greater than 0', messageKey: 'wait.amountInvalid' })
      }
      if (!['minutes', 'hours', 'days'].includes(String(c.unit))) {
        issues.push({
          path: `${path}.unit`,
          message: 'wait unit must be minutes, hours, or days',
          messageKey: 'wait.unitInvalid',
        })
      }
      break
    case 'condition':
      if (!nonEmpty(c.subject)) {
        issues.push({ path: `${path}.subject`, message: 'condition subject is required', messageKey: 'condition.subjectRequired' })
      }
      if (!nonEmpty(c.operand)) {
        issues.push({ path: `${path}.operand`, message: 'condition operand is required', messageKey: 'condition.operandRequired' })
      }
      break
    case 'send_webhook':
      if (!nonEmpty(c.url)) {
        issues.push({ path: `${path}.url`, message: 'webhook URL is required', messageKey: 'sendWebhook.urlRequired' })
        break
      }
      try {
        const u = new URL(String(c.url))
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          issues.push({
            path: `${path}.url`,
            message: 'webhook URL must use http or https',
            messageKey: 'sendWebhook.urlMustBeHttp',
          })
        }
      } catch {
        issues.push({ path: `${path}.url`, message: 'webhook URL is not a valid URL', messageKey: 'sendWebhook.urlInvalid' })
      }
      break
    case 'close_conversation':
      // No config required.
      break
    case 'send_instagram_dm':
      if (c.message_type === 'document') {
        if (!nonEmpty(c.media_url)) {
          issues.push({
            path: `${path}.media_url`,
            message: 'media URL is required',
            messageKey: 'sendInstagramDm.mediaUrlRequired',
          })
        }
      } else if (!nonEmpty(c.text)) {
        issues.push({ path: `${path}.text`, message: 'message text is required', messageKey: 'sendMessage.textRequired' })
      }
      break
    default:
      issues.push({ path, message: `unknown step type: ${step.step_type}`, messageKey: 'unknownStepType', params: { type: step.step_type } })
  }
}

export function validateTriggerForActivation(
  triggerType: AutomationTriggerType | string,
  triggerConfig: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const cfg = (triggerConfig ?? {}) as Record<string, unknown>

  if (triggerType === 'keyword_match') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: 'at least one keyword is required', messageKey: 'trigger.keywordRequired' })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings', messageKey: 'trigger.keywordEmpty' })
    }
    // A missing match_type defaults to "contains" at runtime (see
    // automations/engine.ts and flows/engine.ts, which both read
    // `match_type ?? "contains"`), so only an explicit, unrecognised
    // value is invalid here. This keeps activation validation in step
    // with the engine and with the builder's "Contains" default — an
    // automation that shows the default in the UI must not be rejected.
    if (cfg.match_type != null && cfg.match_type !== 'exact' && cfg.match_type !== 'contains') {
      issues.push({
        path: 'trigger.match_type',
        message: 'match type must be "exact" or "contains"',
        messageKey: 'trigger.matchTypeInvalid',
      })
    }
  } else if (triggerType === 'time_based') {
    // The UI used to expose this trigger even though no dispatcher
    // existed. Reject legacy rows at activation time instead of letting
    // entrepreneurs trust an automation that will never execute.
    issues.push({
      path: 'trigger.type',
      message: 'scheduled triggers are not available yet',
      messageKey: 'trigger.unsupported',
    })
  } else if (triggerType === 'tag_added') {
    if (!nonEmpty(cfg.tag_id)) {
      issues.push({ path: 'trigger.tag_id', message: 'tag is required', messageKey: 'trigger.tagRequired' })
    }
  } else if (triggerType === 'instagram_comment_keyword') {
    const k = cfg.keywords
    if (!Array.isArray(k) || k.length === 0) {
      issues.push({ path: 'trigger.keywords', message: 'at least one keyword is required', messageKey: 'trigger.keywordRequired' })
    } else if (k.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({ path: 'trigger.keywords', message: 'keywords cannot be empty strings', messageKey: 'trigger.keywordEmpty' })
    }
    if (cfg.post_filter === 'specific' && !nonEmpty(cfg.post_id)) {
      issues.push({
        path: 'trigger.post_id',
        message: 'a post id is required when scoping to a specific post',
        messageKey: 'trigger.igPostIdRequired',
      })
    }
  } else if (triggerType === 'interactive_reply') {
    const ids = cfg.reply_ids
    if (!Array.isArray(ids) || ids.length === 0) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
        messageKey: 'trigger.replyIdRequired',
      })
    } else if (ids.some((v) => typeof v !== 'string' || v.trim() === '')) {
      issues.push({
        path: 'trigger.reply_ids',
        message: 'reply ids cannot be empty strings',
        messageKey: 'trigger.replyIdEmpty',
      })
    }
  }

  return issues
}

function nonEmpty(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0
}
