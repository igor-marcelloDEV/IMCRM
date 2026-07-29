import {
  AiError,
  type AiConfig,
  type AiToolDef,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type ToolCall,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  /** Tools to offer the model this turn (see `src/lib/ai/tools.ts`). */
  tools?: AiToolDef[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    tools,
  }

  let result: { text: string; usage: AiUsage | null; toolCalls: ToolCall[] | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Provedor de IA não suportado: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage, result.toolCalls)
}

/**
 * Split the raw model output into `{ text, handoff, usage, toolCalls }`.
 * The sentinel can appear alone or trailing a partial reply; either way
 * we treat the turn as a handoff and strip the marker from any
 * remaining text. `usage` is passed straight through (null when the
 * provider didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
  toolCalls: ToolCall[] | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage, toolCalls: toolCalls ?? [] }
}
