import { AiError, type ProviderResult, type ToolCall } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] }
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/** Chat Completions' `function.arguments` is a JSON string the model
 *  produced — not guaranteed well-formed. A malformed call is dropped
 *  rather than thrown, so one bad tool call doesn't sink the whole
 *  reply (any accompanying text still gets sent). */
function parseOpenAiToolCalls(raw: OpenAiToolCall[] | undefined): ToolCall[] {
  if (!raw || raw.length === 0) return []
  const out: ToolCall[] = []
  for (const [i, tc] of raw.entries()) {
    const name = tc.function?.name
    if (!name) continue
    let input: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(tc.function?.arguments || '{}')
      if (parsed && typeof parsed === 'object') input = parsed
    } catch {
      // Malformed arguments — skip this call, keep the rest of the turn.
      continue
    }
    out.push({ id: tc.id || `openai-tool-${i}`, name, input })
  }
  return out
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
        ...(tools && tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: 'auto',
            }
          : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content ?? ''
  const toolCalls = parseOpenAiToolCalls(data?.choices?.[0]?.message?.tool_calls)
  // A tool-only turn legitimately has empty/null content — only treat
  // "nothing at all" as an error.
  if ((!text || !text.trim()) && toolCalls.length === 0) {
    throw new AiError('A OpenAI retornou uma resposta vazia.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text: text.trim(), usage, toolCalls: toolCalls.length > 0 ? toolCalls : null }
}
