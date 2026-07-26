import crypto from 'crypto'
import { fetch as undiciFetch } from 'undici'
import type {
  ClaudeContentBlock,
  ClaudeRequest,
  ClaudeResponse,
  OpenAIChatRequest,
  OpenAIChatResponse,
  OpenAIContentPart,
  OpenAIMessage
} from './types'
import type { XpixiConfig } from './xpixi'

export type CustomApiProtocol = 'openai' | 'anthropic'
export type CustomApiAuthType = 'bearer' | 'x-api-key'
export type CustomApiReasoningEffort =
  | 'auto'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export const CUSTOM_API_REASONING_EFFORTS: CustomApiReasoningEffort[] = [
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export interface CustomApiKeyConfig {
  id: string
  name: string
  apiKey: string
  enabled: boolean
  createdAt?: number
  lastTestedAt?: number
  lastError?: string
}

export interface CustomApiProviderConfig {
  id: string
  name: string
  enabled: boolean
  protocol: CustomApiProtocol
  authType?: CustomApiAuthType
  apiKey?: string
  baseUrl: string
  routePrefix?: string
  models?: string[]
  customHeaders?: Record<string, string>
  keys?: CustomApiKeyConfig[]
  reasoningEffort?: CustomApiReasoningEffort
  modelDiscoveryMode?: 'auto' | 'manual'
  modelsSyncedAt?: number
  modelsSyncError?: string
}

export interface CustomApiModel {
  id: string
  upstreamId: string
  name?: string
  providerId: string
  providerName: string
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

function apiUrl(baseUrl: string, resource: 'models' | 'chat/completions' | 'messages'): string {
  const base = normalizedBaseUrl(baseUrl)
  return /\/v1$/i.test(base) ? `${base}/${resource}` : `${base}/v1/${resource}`
}

function providerHeaders(
  provider: CustomApiProviderConfig,
  apiKey?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...provider.customHeaders
  }
  const selectedKey = apiKey || provider.apiKey
  if (selectedKey) {
    const authType =
      provider.authType || (provider.protocol === 'anthropic' ? 'x-api-key' : 'bearer')
    if (authType === 'x-api-key') headers['x-api-key'] = selectedKey
    else headers.Authorization = `Bearer ${selectedKey}`
  }
  if (provider.protocol === 'anthropic' && !headers['anthropic-version']) {
    headers['anthropic-version'] = '2023-06-01'
  }
  return headers
}

function safePrefix(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeCustomApiKey(
  key: CustomApiKeyConfig,
  index: number,
  providerId: string
): CustomApiKeyConfig {
  return {
    ...key,
    id: safePrefix(key.id || `${providerId}-key-${index + 1}`) || `${providerId}-key-${index + 1}`,
    name: key.name?.trim() || `Key ${index + 1}`,
    apiKey: key.apiKey?.trim() || '',
    enabled: key.enabled !== false,
    createdAt: key.createdAt || Date.now()
  }
}

export function customApiKeyCandidates(
  providerInput: CustomApiProviderConfig
): CustomApiKeyConfig[] {
  const provider = normalizeCustomProvider(providerInput)
  return (provider.keys || []).filter((key) => key.enabled && key.apiKey)
}

export function normalizeCustomApiReasoningEffort(value: unknown): CustomApiReasoningEffort {
  return typeof value === 'string' &&
    CUSTOM_API_REASONING_EFFORTS.includes(value as CustomApiReasoningEffort)
    ? (value as CustomApiReasoningEffort)
    : 'auto'
}

export function normalizeCustomProvider(
  provider: CustomApiProviderConfig
): CustomApiProviderConfig {
  const id = safePrefix(provider.id || provider.name) || crypto.randomUUID()
  const explicitKeys = Array.isArray(provider.keys)
  const keys = (
    explicitKeys
      ? provider.keys || []
      : provider.apiKey
        ? [{ id: `${id}-key-1`, name: 'Key 1', apiKey: provider.apiKey, enabled: true }]
        : []
  )
    .map((key, index) => normalizeCustomApiKey(key, index, id))
    .filter((key) => key.apiKey)
  const primaryKey = keys.find((key) => key.enabled) || keys[0]
  return {
    ...provider,
    id,
    name: provider.name?.trim() || id,
    baseUrl: normalizedBaseUrl(provider.baseUrl),
    routePrefix: safePrefix(provider.routePrefix || id),
    protocol: provider.protocol || 'openai',
    enabled: provider.enabled !== false,
    apiKey: primaryKey?.apiKey || '',
    keys,
    reasoningEffort: normalizeCustomApiReasoningEffort(provider.reasoningEffort),
    modelDiscoveryMode: provider.modelDiscoveryMode || 'auto',
    models: Array.from(
      new Set((provider.models || []).map((model) => model.trim()).filter(Boolean))
    )
  }
}

export function legacyXpixiProvider(config?: XpixiConfig): CustomApiProviderConfig | undefined {
  if (!config?.enabled || !config.apiKey) return undefined
  return normalizeCustomProvider({
    id: 'xpixi',
    name: 'Xpixi (legacy)',
    enabled: true,
    protocol: 'openai',
    authType: 'bearer',
    apiKey: config.apiKey,
    baseUrl: config.baseUrl || 'https://api.xpiki.com',
    routePrefix: 'xpixi',
    models: config.models
  })
}

export function allCustomProviders(
  providers?: CustomApiProviderConfig[],
  legacyXpixi?: XpixiConfig
): CustomApiProviderConfig[] {
  const normalized = (providers || []).filter(Boolean).map(normalizeCustomProvider)
  const legacy = legacyXpixiProvider(legacyXpixi)
  if (legacy && !normalized.some((provider) => provider.id === legacy.id)) normalized.push(legacy)
  return normalized.filter(
    (provider) =>
      provider.enabled && customApiKeyCandidates(provider).length > 0 && provider.baseUrl
  )
}

export function exposedCustomModelId(
  provider: CustomApiProviderConfig,
  upstreamId: string
): string {
  if (provider.id === 'xpixi' && provider.name.includes('(legacy)')) return upstreamId
  const prefix = safePrefix(provider.routePrefix || provider.id)
  return prefix ? `${prefix}/${upstreamId}` : upstreamId
}

export function findCustomProvider(
  modelId: string,
  providers?: CustomApiProviderConfig[],
  legacyXpixi?: XpixiConfig
): { provider: CustomApiProviderConfig; upstreamModelId: string } | undefined {
  for (const provider of allCustomProviders(providers, legacyXpixi)) {
    if (provider.id === 'xpixi' && provider.name.includes('(legacy)')) {
      const legacyMatch = provider.models?.length
        ? provider.models.includes(modelId)
        : ['kr/', 'notion/', 'zm/', 'cx/'].some((prefix) => modelId.startsWith(prefix))
      if (legacyMatch) return { provider, upstreamModelId: modelId }
    }
    const prefix = safePrefix(provider.routePrefix || provider.id)
    if (prefix && modelId.startsWith(`${prefix}/`)) {
      const upstreamModelId = modelId.slice(prefix.length + 1)
      if (
        !provider.models?.length ||
        provider.models.includes(upstreamModelId) ||
        provider.models.includes(modelId)
      ) {
        return { provider, upstreamModelId }
      }
    }
    if (provider.models?.includes(modelId) && !prefix) return { provider, upstreamModelId: modelId }
  }
  return undefined
}

export async function listCustomApiModels(
  providerInput: CustomApiProviderConfig,
  signal?: AbortSignal
): Promise<CustomApiModel[]> {
  const provider = normalizeCustomProvider(providerInput)
  const keys = customApiKeyCandidates(provider)
  if (!keys.length) throw new Error(`${provider.name}: no enabled API keys`)
  let payload:
    | {
        data?: Array<{ id?: string; name?: string }>
        models?: Array<{ id?: string; name?: string } | string>
      }
    | undefined
  let lastError = `${provider.name} models API failed`
  for (const key of keys) {
    try {
      const response = await undiciFetch(apiUrl(provider.baseUrl, 'models'), {
        method: 'GET',
        headers: providerHeaders(provider, key.apiKey),
        signal
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 500)
        lastError = `${provider.name} (${key.name}) models API ${response.status}: ${detail || response.statusText}`
        continue
      }
      payload = (await response.json()) as typeof payload
      break
    } catch (error) {
      lastError = `${provider.name} (${key.name}) models API: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  if (!payload) throw new Error(lastError)
  const rawModels = payload.data || payload.models || []
  const allowlist = new Set(provider.models || [])
  return rawModels.flatMap((raw) => {
    const upstreamId = typeof raw === 'string' ? raw : raw.id
    if (!upstreamId || (allowlist.size > 0 && !allowlist.has(upstreamId))) return []
    return [
      {
        id: exposedCustomModelId(provider, upstreamId),
        upstreamId,
        name: typeof raw === 'string' ? raw : raw.name,
        providerId: provider.id,
        providerName: provider.name
      }
    ]
  })
}

export async function testCustomApiProvider(
  provider: CustomApiProviderConfig,
  signal?: AbortSignal
): Promise<{ success: boolean; error?: string; models?: CustomApiModel[] }> {
  try {
    if (!customApiKeyCandidates(provider).length)
      return { success: false, error: 'At least one enabled API key is required' }
    if (!provider.baseUrl?.trim()) return { success: false, error: 'Base URL required' }
    return { success: true, models: await listCustomApiModels({ ...provider, models: [] }, signal) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function textFromOpenAIContent(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text || '')
    .join('\n')
}

function openAIContentToClaude(content: OpenAIMessage['content']): string | ClaudeContentBlock[] {
  if (typeof content === 'string') return content
  return content.flatMap((part): ClaudeContentBlock[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text || '' }]
    if (part.type === 'image_url' && part.image_url?.url) {
      const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
      if (match)
        return [{ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }]
      return [{ type: 'image', source: { type: 'url', url: part.image_url.url } }]
    }
    return []
  })
}

function openAIToClaudeRequest(request: OpenAIChatRequest, upstreamModelId: string): ClaudeRequest {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => textFromOpenAIContent(message.content))
    .join('\n\n')
  const messages: ClaudeRequest['messages'] = []
  for (const message of request.messages.filter((item) => item.role !== 'system')) {
    if (message.role === 'tool') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id,
            content: textFromOpenAIContent(message.content)
          }
        ]
      })
      continue
    }
    const blocks = openAIContentToClaude(message.content)
    const content: string | ClaudeContentBlock[] = typeof blocks === 'string' ? blocks : [...blocks]
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const blockList =
        typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
      for (const tool of message.tool_calls) {
        let input: unknown = {}
        try {
          input = JSON.parse(tool.function.arguments || '{}')
        } catch {
          input = { raw: tool.function.arguments }
        }
        blockList.push({ type: 'tool_use', id: tool.id, name: tool.function.name, input })
      }
      messages.push({ role: 'assistant', content: blockList })
    } else {
      messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content })
    }
  }
  return {
    model: upstreamModelId,
    messages,
    max_tokens: request.max_tokens || 4096,
    temperature: request.temperature,
    top_p: request.top_p,
    stream: false,
    system: system || undefined,
    tools: request.tools?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters
    })),
    tool_choice:
      typeof request.tool_choice === 'object'
        ? { type: 'tool', name: request.tool_choice.function.name }
        : undefined
  }
}

function claudeToOpenAIRequest(request: ClaudeRequest, upstreamModelId: string): OpenAIChatRequest {
  const messages: OpenAIMessage[] = []
  if (request.system) {
    const system =
      typeof request.system === 'string'
        ? request.system
        : request.system.map((block) => block.text).join('\n\n')
    messages.push({ role: 'system', content: system })
  }
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content })
      continue
    }
    const textParts: OpenAIContentPart[] = []
    const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = []
    for (const block of message.content) {
      if (block.type === 'text') textParts.push({ type: 'text', text: block.text || '' })
      if (block.type === 'image' && block.source?.type === 'base64') {
        textParts.push({
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
        })
      }
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || crypto.randomUUID(),
          type: 'function',
          function: { name: block.name || 'tool', arguments: JSON.stringify(block.input || {}) }
        })
      }
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content:
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '')
        })
      }
    }
    if (textParts.length || toolCalls.length)
      messages.push({
        role: message.role,
        content: textParts,
        tool_calls: toolCalls.length ? toolCalls : undefined
      })
  }
  return {
    model: upstreamModelId,
    messages,
    max_tokens: request.max_tokens,
    temperature: request.temperature,
    top_p: request.top_p,
    stream: false,
    tools: request.tools?.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema }
    }))
  }
}

function claudeResponseToOpenAI(
  response: ClaudeResponse,
  exposedModelId: string
): OpenAIChatResponse {
  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('')
  const toolCalls = response.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: block.id || crypto.randomUUID(),
      type: 'function' as const,
      function: { name: block.name || 'tool', arguments: JSON.stringify(block.input || {}) }
    }))
  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: exposedModelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.length ? toolCalls : undefined
        },
        finish_reason: toolCalls.length
          ? 'tool_calls'
          : response.stop_reason === 'max_tokens'
            ? 'length'
            : 'stop'
      }
    ],
    usage: {
      prompt_tokens: response.usage.input_tokens || 0,
      completion_tokens: response.usage.output_tokens || 0,
      total_tokens: (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0),
      prompt_tokens_details: { cached_tokens: response.usage.cache_read_input_tokens || 0 }
    }
  }
}

function openAIResponseToClaude(
  response: OpenAIChatResponse,
  exposedModelId: string
): ClaudeResponse {
  const choice = response.choices[0]
  const content: ClaudeContentBlock[] = []
  if (choice?.message.content) content.push({ type: 'text', text: choice.message.content })
  for (const tool of choice?.message.tool_calls || []) {
    let input: unknown = {}
    try {
      input = JSON.parse(tool.function.arguments || '{}')
    } catch {
      input = { raw: tool.function.arguments }
    }
    content.push({ type: 'tool_use', id: tool.id, name: tool.function.name, input })
  }
  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    content,
    model: exposedModelId,
    stop_reason:
      choice?.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice?.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens || 0,
      output_tokens: response.usage?.completion_tokens || 0,
      cache_read_input_tokens: response.usage?.prompt_tokens_details?.cached_tokens || 0
    }
  }
}

async function postJson<T>(
  provider: CustomApiProviderConfig,
  resource: 'chat/completions' | 'messages',
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  const keys = customApiKeyCandidates(provider)
  if (!keys.length) throw new Error(`${provider.name}: no enabled API keys`)
  let lastError = `${provider.name} API failed`
  for (const key of keys) {
    try {
      const response = await undiciFetch(apiUrl(provider.baseUrl, resource), {
        method: 'POST',
        headers: { ...providerHeaders(provider, key.apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 1000)
        lastError = `${provider.name} (${key.name}) API ${response.status}: ${detail || response.statusText}`
        continue
      }
      return (await response.json()) as T
    } catch (error) {
      lastError = `${provider.name} (${key.name}) API: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  throw new Error(lastError)
}

function withCustomReasoning<T extends { reasoning_effort?: string }>(
  request: T,
  provider: CustomApiProviderConfig
): T {
  if (request.reasoning_effort) return request
  const effort = normalizeCustomApiReasoningEffort(provider.reasoningEffort)
  if (effort === 'auto') return request
  return { ...request, reasoning_effort: effort === 'max' ? 'xhigh' : effort }
}

export async function callCustomApiOpenAI(
  request: OpenAIChatRequest,
  providerInput: CustomApiProviderConfig,
  upstreamModelId: string,
  signal?: AbortSignal
): Promise<OpenAIChatResponse> {
  const provider = normalizeCustomProvider(providerInput)
  if (provider.protocol === 'anthropic') {
    const response = await postJson<ClaudeResponse>(
      provider,
      'messages',
      openAIToClaudeRequest(request, upstreamModelId),
      signal
    )
    return claudeResponseToOpenAI(response, request.model)
  }
  const response = await postJson<OpenAIChatResponse>(
    provider,
    'chat/completions',
    withCustomReasoning({ ...request, model: upstreamModelId, stream: false }, provider),
    signal
  )
  return { ...response, model: request.model }
}

export async function callCustomApiClaude(
  request: ClaudeRequest,
  providerInput: CustomApiProviderConfig,
  upstreamModelId: string,
  signal?: AbortSignal
): Promise<ClaudeResponse> {
  const provider = normalizeCustomProvider(providerInput)
  if (provider.protocol === 'anthropic') {
    const response = await postJson<ClaudeResponse>(
      provider,
      'messages',
      { ...request, model: upstreamModelId, stream: false },
      signal
    )
    return { ...response, model: request.model }
  }
  const response = await postJson<OpenAIChatResponse>(
    provider,
    'chat/completions',
    withCustomReasoning(claudeToOpenAIRequest(request, upstreamModelId), provider),
    signal
  )
  return openAIResponseToClaude(response, request.model)
}
