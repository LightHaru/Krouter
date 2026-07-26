import { fetch as undiciFetch } from 'undici'
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIResponseContentPart,
  OpenAIResponseInputItem,
  OpenAIResponsesRequest
} from './types'
import type { ChatGPTAccountState, ChatGPTQuotaWindow } from './chatgptOAuth'

export type ChatGPTModelAvailability = 'unverified' | 'available' | 'unavailable'
export type ChatGPTReasoningEffort =
  | 'auto'
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
export const CHATGPT_REASONING_EFFORTS: ChatGPTReasoningEffort[] = [
  'auto',
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export interface ChatGPTCodexConfig {
  enabled: boolean
  experimental: boolean
  baseUrl: string
  usageUrl: string
  timeoutMs: number
  catalogVersion: string
  reasoningEffort: ChatGPTReasoningEffort
  models?: string[]
}

export interface ChatGPTCodexModel {
  id: string
  name: string
  upstreamModel: string
  capabilities: Array<'chat' | 'reasoning' | 'tools' | 'image'>
  quotaType: 'codex'
  contextWindow?: number
  maxOutputTokens?: number
}

export const DEFAULT_CHATGPT_CODEX_CONFIG: ChatGPTCodexConfig = {
  enabled: false,
  experimental: true,
  baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
  usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
  timeoutMs: 180_000,
  catalogVersion: '2026-07-2',
  reasoningEffort: 'auto'
}

export function normalizeChatGPTReasoningEffort(value: unknown): ChatGPTReasoningEffort {
  return typeof value === 'string' &&
    CHATGPT_REASONING_EFFORTS.includes(value as ChatGPTReasoningEffort)
    ? (value as ChatGPTReasoningEffort)
    : DEFAULT_CHATGPT_CODEX_CONFIG.reasoningEffort
}

export const CHATGPT_CODEX_CATALOG: ChatGPTCodexModel[] = [
  {
    id: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    upstreamModel: 'gpt-5.6-sol',
    capabilities: ['chat', 'reasoning', 'tools', 'image'],
    quotaType: 'codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'gpt-5.6-terra',
    name: 'GPT-5.6 Terra',
    upstreamModel: 'gpt-5.6-terra',
    capabilities: ['chat', 'reasoning', 'tools'],
    quotaType: 'codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'gpt-5.6-luna',
    name: 'GPT-5.6 Luna',
    upstreamModel: 'gpt-5.6-luna',
    capabilities: ['chat', 'reasoning', 'tools'],
    quotaType: 'codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    upstreamModel: 'gpt-5.5',
    capabilities: ['chat', 'reasoning', 'tools', 'image'],
    quotaType: 'codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    upstreamModel: 'gpt-5.4',
    capabilities: ['chat', 'reasoning', 'tools', 'image'],
    quotaType: 'codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    upstreamModel: 'gpt-5.4-mini',
    capabilities: ['chat', 'reasoning', 'tools'],
    quotaType: 'codex',
    contextWindow: 400_000,
    maxOutputTokens: 128_000
  },
  {
    id: 'gpt-5.3-codex-spark',
    name: 'GPT-5.3 Codex Spark',
    upstreamModel: 'gpt-5.3-codex-spark',
    capabilities: ['chat', 'reasoning', 'tools'],
    quotaType: 'codex',
    contextWindow: 272_000,
    maxOutputTokens: 128_000
  }
]

export function chatGPTCodexThinkingEfforts(model: string): ChatGPTReasoningEffort[] {
  const id = stripChatGPTPrefix(model).toLowerCase()
  if (id.includes('gpt-5.6-sol')) return ['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max']
  if (id.includes('codex')) return ['auto', 'low', 'medium', 'high', 'xhigh']
  return ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh']
}

function defaultReasoning(
  model: string,
  effort?: ChatGPTReasoningEffort
): { effort: string } | undefined {
  const selected = !effort || effort === 'auto' ? 'low' : effort
  const normalized = selected === 'max' ? 'xhigh' : selected
  const supported = new Set<string>(
    chatGPTCodexThinkingEfforts(model).map((item) => (item === 'max' ? 'xhigh' : item))
  )
  if (supported.has(normalized)) return { effort: normalized }
  return supported.has('low') ? { effort: 'low' } : undefined
}

function normalizeReasoning(
  value: unknown,
  model: string,
  defaultEffort?: ChatGPTReasoningEffort
): { effort: string; summary: 'auto' } | undefined {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const explicit = typeof source.effort === 'string' ? source.effort : undefined
  const fallback = defaultReasoning(model, defaultEffort)
  const normalizedExplicit = explicit === 'max' ? 'xhigh' : explicit
  const supported = new Set<string>(
    chatGPTCodexThinkingEfforts(model).map((item) => (item === 'max' ? 'xhigh' : item))
  )
  const effort =
    normalizedExplicit && supported.has(normalizedExplicit) ? normalizedExplicit : fallback?.effort
  return effort ? { effort, summary: 'auto' } : undefined
}

function normalizeCodexTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return []
    const item = tool as Record<string, unknown>
    if (item.type !== 'function') return [item]
    const fn =
      item.function && typeof item.function === 'object'
        ? (item.function as Record<string, unknown>)
        : item
    const name = typeof fn.name === 'string' ? fn.name.trim() : ''
    if (!name) return []
    return [
      {
        type: 'function',
        name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        parameters:
          fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters
            : { type: 'object', properties: {} }
      }
    ]
  })
}

function normalizeCodexToolChoice(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const choice = value as Record<string, unknown>
  const fn =
    choice.function && typeof choice.function === 'object'
      ? (choice.function as Record<string, unknown>)
      : undefined
  return choice.type === 'function' && typeof fn?.name === 'string'
    ? { type: 'function', name: fn.name }
    : value
}

function normalizeCodexInput(
  input: OpenAIResponsesRequest['input']
): OpenAIResponsesRequest['input'] {
  if (typeof input !== 'string') {
    return input.length > 0
      ? input
      : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }]
  }
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: input || '...' }]
    }
  ]
}

export class ChatGPTCodexApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'ChatGPTCodexApiError'
  }
}

export function isChatGPTCodexModel(model: string, config?: Partial<ChatGPTCodexConfig>): boolean {
  return Boolean(config?.enabled && model.startsWith('chatgpt/'))
}

export function stripChatGPTPrefix(model: string): string {
  return model.startsWith('chatgpt/') ? model.slice('chatgpt/'.length) : model
}

export function listChatGPTCodexModels(config?: Partial<ChatGPTCodexConfig>): ChatGPTCodexModel[] {
  const configured = config?.models?.map((model) => model.trim()).filter(Boolean)
  if (!configured?.length) return CHATGPT_CODEX_CATALOG
  const known = new Map(CHATGPT_CODEX_CATALOG.map((model) => [model.id, model]))
  return configured.map(
    (id) =>
      known.get(id) || {
        id,
        name: id,
        upstreamModel: id,
        capabilities: ['chat', 'reasoning', 'tools'],
        quotaType: 'codex'
      }
  )
}

function messageText(message: OpenAIMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function chatMessageToResponseInput(message: OpenAIMessage): OpenAIResponseInputItem[] {
  if (message.role === 'tool') {
    return [
      {
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: messageText(message)
      }
    ]
  }

  const result: OpenAIResponseInputItem[] = []
  if (message.role === 'assistant' && message.tool_calls?.length) {
    for (const toolCall of message.tool_calls) {
      result.push({
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
      })
    }
  }

  const text = messageText(message)
  // Ảnh phải được giữ lại. Trước đây content chỉ dựng từ messageText() — hàm này lọc bỏ mọi
  // part không phải 'text' — nên image_url biến mất trước khi request rời tiến trình:
  // upstream trả 200 và model trả lời "tôi không thấy ảnh nào", một lỗi hoàn toàn vô hình.
  // /v1/responses vẫn giữ ảnh (normalizeCodexInput cho đi thẳng) nên cùng model + cùng
  // account lại hành xử khác nhau tuỳ endpoint.
  const imageParts = collectImageParts(message)
  if (text || imageParts.length > 0 || result.length === 0) {
    const content: OpenAIResponseContentPart[] = []
    if (text || imageParts.length === 0) {
      content.push({
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text
      })
    }
    // Ảnh chỉ có nghĩa ở phía input; message assistant không mang input_image.
    if (message.role !== 'assistant') content.push(...imageParts)
    result.unshift({
      type: 'message',
      role: message.role === 'system' ? 'user' : message.role,
      content
    })
  }
  return result
}

/** Lấy các phần ảnh của message chat và đổi sang dạng input_image của Responses API. */
function collectImageParts(message: OpenAIMessage): OpenAIResponseContentPart[] {
  if (!Array.isArray(message.content)) return []
  const parts: OpenAIResponseContentPart[] = []
  for (const part of message.content) {
    if (part.type !== 'image_url') continue
    const url = part.image_url?.url
    if (!url) continue
    parts.push({ type: 'input_image', image_url: url })
  }
  return parts
}

export function buildCodexPayloadFromChat(
  request: OpenAIChatRequest,
  defaultEffort?: ChatGPTReasoningEffort
): OpenAIResponsesRequest & {
  store: false
  stream: true
} {
  const instructions = request.messages
    .filter((message) => message.role === 'system')
    .map(messageText)
    .filter(Boolean)
    .join('\n\n')
  const input = request.messages
    .filter((message) => message.role !== 'system')
    .flatMap(chatMessageToResponseInput)
  const reasoning = normalizeReasoning(
    request.reasoning_effort ? { effort: request.reasoning_effort } : undefined,
    request.model,
    defaultEffort
  )
  const tools = normalizeCodexTools(request.tools)

  return {
    model: stripChatGPTPrefix(request.model),
    input: input.length
      ? input
      : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }],
    instructions: instructions || 'You are a helpful coding assistant.',
    ...(tools?.length ? { tools: tools as OpenAIResponsesRequest['tools'] } : {}),
    ...(request.tool_choice
      ? {
          tool_choice: normalizeCodexToolChoice(
            request.tool_choice
          ) as OpenAIResponsesRequest['tool_choice']
        }
      : {}),
    ...(reasoning ? { reasoning, include: ['reasoning.encrypted_content'] } : {}),
    store: false,
    stream: true
  }
}

export function buildCodexPayloadFromResponses(
  request: OpenAIResponsesRequest,
  defaultEffort?: ChatGPTReasoningEffort
): OpenAIResponsesRequest & {
  store: false
  stream: true
} {
  const raw = request as OpenAIResponsesRequest & Record<string, unknown>
  const reasoning = normalizeReasoning(request.reasoning, request.model, defaultEffort)
  const tools = normalizeCodexTools(request.tools)
  return {
    model: stripChatGPTPrefix(request.model),
    input: normalizeCodexInput(request.input),
    instructions: request.instructions?.trim() || 'You are a helpful coding assistant.',
    ...(tools?.length ? { tools: tools as OpenAIResponsesRequest['tools'] } : {}),
    ...(request.tool_choice
      ? {
          tool_choice: normalizeCodexToolChoice(
            request.tool_choice
          ) as OpenAIResponsesRequest['tool_choice']
        }
      : {}),
    ...(reasoning
      ? {
          reasoning,
          include: Array.from(
            new Set([
              ...(Array.isArray(raw.include)
                ? raw.include.filter((item): item is string => typeof item === 'string')
                : []),
              'reasoning.encrypted_content'
            ])
          )
        }
      : {}),
    ...(raw.service_tier === 'fast' || raw.service_tier === 'priority'
      ? { service_tier: 'priority' }
      : {}),
    ...(typeof raw.prompt_cache_key === 'string' ? { prompt_cache_key: raw.prompt_cache_key } : {}),
    ...(raw.client_metadata && typeof raw.client_metadata === 'object'
      ? { client_metadata: raw.client_metadata }
      : {}),
    ...(raw.text && typeof raw.text === 'object' ? { text: raw.text } : {}),
    stream: true,
    store: false
  }
}

export function buildChatGPTCodexHeaders(account: ChatGPTAccountState): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${account.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'codex-1',
    'User-Agent': 'codex-cli',
    originator: 'krouter'
  }
  if (account.accountId) headers['ChatGPT-Account-ID'] = account.accountId
  if (account.isFedRAMP) headers['X-OpenAI-Fedramp'] = 'true'
  return headers
}

export function extractChatGPTCodexError(status: number, body: string): ChatGPTCodexApiError {
  let detail = body.trim()
  try {
    const value = JSON.parse(body) as {
      error?: { message?: unknown; code?: unknown; type?: unknown }
      message?: unknown
      detail?: unknown
    }
    const candidate =
      value.error?.message ||
      value.message ||
      value.detail ||
      value.error?.code ||
      value.error?.type
    if (typeof candidate === 'string' && candidate.trim()) detail = candidate.trim()
  } catch {
    // Keep short plain-text upstream diagnostics.
  }
  detail = detail
    .replace(/bearer\s+[^\s,;}]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:code|state)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 800)
  return new ChatGPTCodexApiError(
    status,
    `ChatGPT/Codex upstream error (${status}): ${detail || `HTTP ${status}`}`,
    status === 401 || status === 408 || status === 409 || status === 429 || status >= 500
  )
}

export async function requestChatGPTCodex(
  account: ChatGPTAccountState,
  payload: object,
  config: ChatGPTCodexConfig,
  signal?: AbortSignal
): Promise<Response> {
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await undiciFetch(config.baseUrl, {
    method: 'POST',
    headers: buildChatGPTCodexHeaders(account),
    body: JSON.stringify(payload),
    signal: combinedSignal
  })
  return response as unknown as Response
}

export interface CodexSseEvent {
  event?: string
  data: string
  value?: Record<string, unknown>
}

export async function* iterateCodexSse(
  body: AsyncIterable<Uint8Array>
): AsyncGenerator<CodexSseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() || ''
    for (const block of blocks) {
      const lines = block.split(/\r?\n/)
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim()
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      let value: Record<string, unknown> | undefined
      if (data !== '[DONE]') {
        try {
          value = JSON.parse(data) as Record<string, unknown>
        } catch {
          /* Preserve unknown event. */
        }
      }
      yield { event, data, value }
    }
  }
}

function toPercent(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.max(0, Math.min(100, number))
}

function toTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
  if (typeof value === 'string' && value.trim() && !/^\d+(?:\.\d+)?$/.test(value.trim())) {
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : undefined
  }
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return number < 1_000_000_000_000 ? number * 1000 : number
}

export function parseChatGPTUsage(value: unknown): ChatGPTQuotaWindow[] {
  const root = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const windows: ChatGPTQuotaWindow[] = []
  const byLimitId =
    root.rate_limits_by_limit_id && typeof root.rate_limits_by_limit_id === 'object'
      ? (root.rate_limits_by_limit_id as Record<string, unknown>)
      : {}
  const normalSnapshot = root.rate_limit || root.rate_limits || byLimitId.codex || root
  const normalRateLimit =
    normalSnapshot && typeof normalSnapshot === 'object'
      ? (((normalSnapshot as Record<string, unknown>).rate_limit || normalSnapshot) as Record<
          string,
          unknown
        >)
      : {}
  const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : []
  const reviewSnapshot =
    root.code_review_rate_limit ||
    root.review_rate_limit ||
    byLimitId.code_review ||
    byLimitId.codex_review ||
    byLimitId.review ||
    additional.find((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as Record<string, unknown>
      const id = String(item.limit_name || item.metered_feature || item.id || '').toLowerCase()
      return id.includes('review')
    })
  const reviewRateLimit =
    reviewSnapshot && typeof reviewSnapshot === 'object'
      ? (((reviewSnapshot as Record<string, unknown>).rate_limit || reviewSnapshot) as Record<
          string,
          unknown
        >)
      : {}
  const sources: Array<[string, string, unknown]> = [
    [
      'session',
      'Session',
      normalRateLimit.primary_window ||
        normalRateLimit.primary ||
        root.primary_window ||
        root.primary ||
        normalSnapshot
    ],
    [
      'weekly',
      'Weekly',
      normalRateLimit.secondary_window ||
        normalRateLimit.secondary ||
        root.secondary_window ||
        root.secondary
    ],
    [
      'review',
      'Code review',
      reviewRateLimit.primary_window || reviewRateLimit.primary || reviewSnapshot
    ]
  ]

  for (const [key, label, raw] of sources) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const nested = (
      item.limit_window && typeof item.limit_window === 'object' ? item.limit_window : item
    ) as Record<string, unknown>
    const usedPercent = toPercent(
      nested.used_percent ?? nested.percent_used ?? item.used_percent ?? item.percent_used
    )
    const remainingPercent =
      toPercent(nested.remaining_percent ?? item.remaining_percent) ??
      (usedPercent === undefined ? undefined : 100 - usedPercent)
    const resetAt = toTimestamp(
      nested.reset_at ??
        nested.resets_at ??
        nested.resetAt ??
        nested.reset_time ??
        item.reset_at ??
        item.resets_at ??
        item.resetAt ??
        item.reset_time
    )
    const limitWindowSeconds = Number(nested.limit_window_seconds ?? nested.window_seconds)
    if (usedPercent === undefined && remainingPercent === undefined && resetAt === undefined)
      continue
    let normalizedKey = key
    let normalizedLabel = label
    if (key === 'session' && Number.isFinite(limitWindowSeconds)) {
      if (limitWindowSeconds >= 2_419_200) {
        normalizedKey = 'monthly'
        normalizedLabel = 'Monthly'
      } else if (limitWindowSeconds >= 518_400) {
        normalizedKey = 'weekly'
        normalizedLabel = 'Weekly'
      }
    }
    windows.push({
      key: normalizedKey,
      label: normalizedLabel,
      usedPercent,
      remainingPercent,
      resetAt,
      ...(Number.isFinite(limitWindowSeconds) && limitWindowSeconds > 0
        ? { limitWindowSeconds }
        : {})
    })
  }
  return windows
}

export async function fetchChatGPTUsage(
  account: ChatGPTAccountState,
  config: ChatGPTCodexConfig,
  signal?: AbortSignal
): Promise<ChatGPTQuotaWindow[]> {
  const response = await undiciFetch(config.usageUrl, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${account.accessToken}`,
      Accept: 'application/json',
      ...(account.accountId ? { 'ChatGPT-Account-ID': account.accountId } : {})
    },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw extractChatGPTCodexError(response.status, await response.text())
  return parseChatGPTUsage(await response.json())
}
