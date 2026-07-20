// AWS Bedrock provider for Krouter.
//
// Adds a second upstream provider alongside the Kiro account pool. Requests whose
// model id targets Bedrock are signed with SigV4 and sent to the Bedrock Runtime
// Converse / ConverseStream API, which gives a single uniform request/response
// shape across Anthropic, Amazon Nova, Meta Llama, Mistral, Cohere, etc.
//
// Credentials are never hard-coded: they come from ProxyConfig.bedrock (persisted
// config) or, as a fallback, from the standard AWS_* environment variables.

import crypto from 'crypto'
import { fetch as undiciFetch } from 'undici'
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIContentPart,
  OpenAITool,
  OpenAIChatResponse,
  OpenAIToolCall,
  ClaudeRequest,
  ClaudeMessage,
  ClaudeContentBlock,
  ClaudeResponse,
  KiroUsage
} from './types'

export interface BedrockConfig {
  /** Master switch. When false the provider is completely inert. */
  enabled: boolean
  accessKeyId?: string
  secretAccessKey?: string
  /** Optional STS session token for temporary credentials. */
  sessionToken?: string
  region?: string
  /**
   * Explicit list of Bedrock model ids to expose through /v1/models and to treat
   * as Bedrock-routed. When empty, model detection falls back to well-known
   * provider prefixes (anthropic., amazon., meta., ...).
   */
  models?: string[]
}

export interface BedrockCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}

const BEDROCK_SERVICE = 'bedrock'
const BEDROCK_RUNTIME_SERVICE = 'bedrock'
const DEFAULT_REGION = 'us-east-1'

const BEDROCK_MODEL_PREFIXES = [
  'anthropic.',
  'amazon.',
  'meta.',
  'mistral.',
  'cohere.',
  'ai21.',
  'deepseek.',
  'stability.',
  'nvidia.',
  'qwen.',
  'openai.',
  'moonshot.',
  'moonshotai.',
  'zai.',
  'minimax.',
  'google.',
  'twelvelabs.',
  'writer.',
  'luma.',
  // cross-region inference profile prefixes
  'us.',
  'global.',
  'eu.',
  'apac.',
  'us-gov.'
]

/** Resolve effective credentials from config first, then AWS_* env vars. */
export function resolveBedrockCredentials(config?: BedrockConfig): BedrockCredentials | null {
  const accessKeyId = config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || ''
  const secretAccessKey = config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || ''
  const sessionToken = config?.sessionToken || process.env.AWS_SESSION_TOKEN || undefined
  const region =
    config?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || DEFAULT_REGION
  if (!accessKeyId || !secretAccessKey) return null
  return { accessKeyId, secretAccessKey, sessionToken, region }
}

export function isBedrockConfigured(config?: BedrockConfig): boolean {
  if (!config?.enabled) return false
  return resolveBedrockCredentials(config) !== null
}

/** Strip an explicit "bedrock/" prefix used to force Bedrock routing. */
export function stripBedrockPrefix(model: string): string {
  return model.replace(/^bedrock\//i, '')
}

/**
 * Decide whether a requested model id should be routed to Bedrock.
 * Matches: explicit bedrock/ prefix, ids in the configured model list, or ids
 * beginning with a well-known Bedrock provider prefix.
 */
export function isBedrockModel(model: string | undefined, config?: BedrockConfig): boolean {
  if (!model || !config?.enabled) return false
  if (/^bedrock\//i.test(model)) return true
  const id = model.trim()
  const configured = new Set((config.models || []).map((m) => m.trim()))
  if (configured.has(id)) return true
  const lower = id.toLowerCase()
  return BEDROCK_MODEL_PREFIXES.some((p) => lower.startsWith(p))
}

// ============ Friendly-id <-> Bedrock-id matching ============

interface ParsedClaudeId {
  family: 'opus' | 'sonnet' | 'haiku'
  major: number
  minor: number | null
}

/** Parse a Claude model id (Kiro-style or Bedrock-style) into family + version. */
function parseClaudeModelId(id: string): ParsedClaudeId | null {
  const lower = id.trim().toLowerCase()
  if (!lower.includes('claude')) return null
  // Match claude-<family>-<major>[-.]<minor>. Works for both
  // 'claude-opus-4.1' and 'us.anthropic.claude-opus-4-1-20250805-v1:0'.
  const m = lower.match(/claude-(opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/u)
  if (!m) return null
  return {
    family: m[1] as ParsedClaudeId['family'],
    major: Number(m[2]),
    minor: m[3] !== undefined ? Number(m[3]) : null
  }
}

/**
 * Given a requested friendly model id (e.g. 'claude-opus-4.1', 'claude-sonnet-4.6')
 * and a list of available Bedrock model ids, return the best matching Bedrock id,
 * or null when there is no Anthropic Claude match. Prefers 'us.' regional profiles
 * over 'global.', and requires the family + major version to match. When the
 * requested id has a minor version, it must match too.
 */
export function matchBedrockModelForKiroId(
  requestedModel: string,
  availableBedrockIds: string[]
): string | null {
  const want = parseClaudeModelId(requestedModel)
  if (!want) return null
  const candidates: string[] = []
  for (const id of availableBedrockIds) {
    const got = parseClaudeModelId(id)
    if (!got) continue
    if (got.family !== want.family) continue
    if (got.major !== want.major) continue
    if (want.minor !== null && got.minor !== want.minor) continue
    candidates.push(id)
  }
  if (candidates.length === 0) return null
  // Prefer us. profiles, then global., then anything; within a group prefer the
  // longest id (most specific, e.g. dated version) for determinism.
  const rank = (id: string): number => {
    const lower = id.toLowerCase()
    if (lower.startsWith('us.')) return 0
    if (lower.startsWith('global.')) return 1
    if (lower.startsWith('anthropic.')) return 2
    return 3
  }
  candidates.sort((a, b) => {
    const r = rank(a) - rank(b)
    if (r !== 0) return r
    return b.length - a.length
  })
  return candidates[0]
}

// ============ SigV4 ============

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

function awsUriEncodeSegment(seg: string): string {
  // RFC 3986 unreserved chars are left as-is; everything else is percent-encoded.
  return seg.replace(/[^A-Za-z0-9\-_.~]/g, (c) => {
    const bytes = Buffer.from(c, 'utf8')
    let out = ''
    for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0')
    return out
  })
}

/**
 * SigV4 canonical URI. AWS (non-S3) URI-encodes the path a second time when it
 * recomputes the signature server-side, so a path that already contains
 * percent-encoded characters (e.g. the colon in "...v1:0" -> "%3A") must be
 * double-encoded in the string-to-sign ("%3A" -> "%253A").
 */
function canonicalUriFromPath(path: string): string {
  return path
    .split('/')
    .map((seg) => awsUriEncodeSegment(seg))
    .join('/')
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { amzDate, dateStamp: amzDate.slice(0, 8) }
}

export interface SignedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** Produce SigV4-signed headers for a Bedrock request. */
export function signBedrockRequest(params: {
  creds: BedrockCredentials
  service: string
  method: string
  host: string
  path: string
  query?: string
  body?: string
  extraHeaders?: Record<string, string>
}): SignedRequest {
  const { creds, service, method, host, path, query = '', body = '', extraHeaders = {} } = params
  const { amzDate, dateStamp } = amzDates(new Date())
  const payloadHash = sha256Hex(body)

  const baseHeaders: Record<string, string> = {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...extraHeaders
  }
  if (creds.sessionToken) baseHeaders['x-amz-security-token'] = creds.sessionToken

  const headerKeys = Object.keys(baseHeaders)
    .map((k) => k.toLowerCase())
    .sort()
  const lowerLookup = new Map(Object.keys(baseHeaders).map((k) => [k.toLowerCase(), k]))
  const canonicalHeaders = headerKeys
    .map((k) => `${k}:${String(baseHeaders[lowerLookup.get(k)!]).trim()}\n`)
    .join('')
  const signedHeaders = headerKeys.join(';')

  const canonicalPath = canonicalUriFromPath(path)
  const canonicalRequest = [
    method,
    canonicalPath,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')
  const algorithm = 'AWS4-HMAC-SHA256'
  const scope = `${dateStamp}/${creds.region}/${service}/aws4_request`
  const stringToSign = [algorithm, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, creds.region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const authorization = `${algorithm} Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: `https://${host}${path}${query ? `?${query}` : ''}`,
    method,
    headers: { ...baseHeaders, Authorization: authorization },
    body: body || undefined
  }
}

// ============ Model listing ============

export interface BedrockModelSummary {
  modelId: string
  modelName?: string
  providerName?: string
  inputModalities?: string[]
  outputModalities?: string[]
  responseStreamingSupported?: boolean
  inferenceTypesSupported?: string[]
  status?: string
}

export async function listBedrockModels(
  config: BedrockConfig,
  signal?: AbortSignal
): Promise<BedrockModelSummary[]> {
  const creds = resolveBedrockCredentials(config)
  if (!creds) throw new Error('Bedrock credentials are not configured')
  const host = `bedrock.${creds.region}.amazonaws.com`
  const signed = signBedrockRequest({
    creds,
    service: BEDROCK_SERVICE,
    method: 'GET',
    host,
    path: '/foundation-models'
  })
  const res = await undiciFetch(signed.url, { method: 'GET', headers: signed.headers, signal })
  const text = await res.text()
  if (res.status !== 200) {
    throw new Error(`Bedrock ListFoundationModels failed: HTTP ${res.status} ${text.slice(0, 300)}`)
  }
  const parsed = JSON.parse(text) as { modelSummaries?: Array<Record<string, unknown>> }
  const summaries = parsed.modelSummaries || []
  return summaries.map((m) => ({
    modelId: String(m.modelId),
    modelName: m.modelName as string | undefined,
    providerName: m.providerName as string | undefined,
    inputModalities: (m.inputModalities as string[] | undefined) || [],
    outputModalities: (m.outputModalities as string[] | undefined) || [],
    responseStreamingSupported: Boolean(m.responseStreamingSupported),
    inferenceTypesSupported: (m.inferenceTypesSupported as string[] | undefined) || [],
    status: (m.modelLifecycle as { status?: string } | undefined)?.status
  }))
}

// ============ Inference profiles (cross-region models like Claude Opus) ============

export interface BedrockInferenceProfileSummary {
  inferenceProfileId: string
  inferenceProfileArn?: string
  inferenceProfileName?: string
  status?: string
  type?: string
  models?: string[]
}

/**
 * List inference profiles for the account/region. Cross-region models such as
 * Anthropic Claude Opus 4.x are only reachable through inference profiles
 * (ids like "us.anthropic.claude-opus-4-5-...") and never appear in
 * ListFoundationModels. This surfaces exactly what the IAM identity can see.
 */
export async function listBedrockInferenceProfiles(
  config: BedrockConfig,
  signal?: AbortSignal
): Promise<BedrockInferenceProfileSummary[]> {
  const creds = resolveBedrockCredentials(config)
  if (!creds) throw new Error('Bedrock credentials are not configured')
  const host = `bedrock.${creds.region}.amazonaws.com`
  const results: BedrockInferenceProfileSummary[] = []
  let nextToken: string | undefined
  do {
    const query =
      `maxResults=200` + (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : '')
    const signed = signBedrockRequest({
      creds,
      service: BEDROCK_SERVICE,
      method: 'GET',
      host,
      path: '/inference-profiles',
      query
    })
    const res = await undiciFetch(signed.url, { method: 'GET', headers: signed.headers, signal })
    const text = await res.text()
    if (res.status !== 200) {
      throw new Error(
        `Bedrock ListInferenceProfiles failed: HTTP ${res.status} ${text.slice(0, 300)}`
      )
    }
    const parsed = JSON.parse(text) as {
      inferenceProfileSummaries?: Array<Record<string, unknown>>
      nextToken?: string
    }
    for (const m of parsed.inferenceProfileSummaries || []) {
      results.push({
        inferenceProfileId: String(m.inferenceProfileId),
        inferenceProfileArn: m.inferenceProfileArn as string | undefined,
        inferenceProfileName: m.inferenceProfileName as string | undefined,
        status: m.status as string | undefined,
        type: m.type as string | undefined,
        models: Array.isArray(m.models)
          ? (m.models as Array<Record<string, unknown>>)
              .map((x) => String(x.modelArn || '').split('/').pop() || '')
              .filter(Boolean)
          : undefined
      })
    }
    nextToken = parsed.nextToken
  } while (nextToken)
  return results
}

export interface BedrockAvailableModel {
  id: string
  name?: string
  provider?: string
  /** 'foundation' = on-demand foundation model; 'profile' = inference profile. */
  kind: 'foundation' | 'profile'
}

/**
 * Combined, IAM-scoped view of text models the account can actually call:
 * on-demand text foundation models + ACTIVE text inference profiles
 * (Claude Opus/Sonnet cross-region, etc). Deduplicated by id.
 * 
 * This function is resilient to partial failures: if foundation models fail but
 * inference profiles succeed (or vice versa), it returns what it can.
 */
export async function listBedrockAvailableModels(
  config: BedrockConfig,
  signal?: AbortSignal
): Promise<BedrockAvailableModel[]> {
  const out = new Map<string, BedrockAvailableModel>()

  // Try foundation models (on-demand)
  let foundationError: string | undefined
  try {
    const foundation = await listBedrockModels(config, signal)
    for (const m of foundation) {
      const outputs = m.outputModalities || []
      const inferTypes = m.inferenceTypesSupported || []
      // keep text models that support on-demand invocation
      if (outputs.length && !outputs.includes('TEXT')) continue
      if (inferTypes.length && !inferTypes.includes('ON_DEMAND')) continue
      if (m.status && m.status !== 'ACTIVE') continue
      if (!out.has(m.modelId)) {
        out.set(m.modelId, { id: m.modelId, name: m.modelName, provider: m.providerName, kind: 'foundation' })
      }
    }
  } catch (error) {
    foundationError = error instanceof Error ? error.message : String(error)
    console.error('[Bedrock] Failed to list foundation models:', foundationError)
  }

  // Try inference profiles (cross-region models like Opus)
  let profilesError: string | undefined
  try {
    const profiles = await listBedrockInferenceProfiles(config, signal)
    for (const p of profiles) {
      if (p.status && p.status !== 'ACTIVE') continue
      const id = p.inferenceProfileId
      if (!id) continue
      // profiles cover text chat models; skip obvious non-text (embed/rerank/video) by name
      if (/(embed|rerank|video|image|canvas|reel|speech|tts)/i.test(id)) continue
      const provider = id.split('.').slice(1, 2)[0] || id.split('.')[0]
      if (!out.has(id)) {
        out.set(id, { id, name: p.inferenceProfileName, provider, kind: 'profile' })
      }
    }
  } catch (error) {
    profilesError = error instanceof Error ? error.message : String(error)
    console.error('[Bedrock] Failed to list inference profiles:', profilesError)
  }

  // If BOTH failed, throw an error that combines both messages
  if (out.size === 0 && foundationError && profilesError) {
    throw new Error(
      `Bedrock model listing failed: Foundation models: ${foundationError}; ` +
      `Inference profiles: ${profilesError}`
    )
  }

  return Array.from(out.values())
}

/**
 * Verify Bedrock credentials by listing what the IAM identity can access.
 * Returns the combined available-model list so the UI can let the user pick.
 */
export async function testBedrockCredentials(
  config: BedrockConfig,
  signal?: AbortSignal
): Promise<{ ok: boolean; region: string; models: BedrockAvailableModel[]; error?: string }> {
  const creds = resolveBedrockCredentials(config)
  if (!creds) {
    return { ok: false, region: config.region || DEFAULT_REGION, models: [], error: 'Missing access key or secret' }
  }
  try {
    const models = await listBedrockAvailableModels(config, signal)
    return { ok: true, region: creds.region, models }
  } catch (error) {
    return {
      ok: false,
      region: creds.region,
      models: [],
      error: error instanceof Error ? error.message : 'Bedrock credential test failed'
    }
  }
}

// ============ Converse request/response shapes ============

interface ConverseTextBlock {
  text: string
}
interface ConverseImageBlock {
  image: { format: string; source: { bytes: string } }
}
interface ConverseToolUseBlock {
  toolUse: { toolUseId: string; name: string; input: unknown }
}
interface ConverseToolResultBlock {
  toolResult: {
    toolUseId: string
    content: Array<{ text?: string; json?: unknown }>
    status?: 'success' | 'error'
  }
}
type ConverseContentBlock =
  | ConverseTextBlock
  | ConverseImageBlock
  | ConverseToolUseBlock
  | ConverseToolResultBlock

interface ConverseMessage {
  role: 'user' | 'assistant'
  content: ConverseContentBlock[]
}

export interface ConverseRequestBody {
  messages: ConverseMessage[]
  system?: Array<{ text: string }>
  inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number }
  toolConfig?: {
    tools: Array<{
      toolSpec: { name: string; description?: string; inputSchema: { json: unknown } }
    }>
    toolChoice?: { auto?: object; any?: object; tool?: { name: string } }
  }
}

export interface ConverseResponse {
  output?: { message?: { role: string; content: Array<Record<string, unknown>> } }
  stopReason?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

function extractText(content: string | OpenAIContentPart[]): {
  text: string
  images: ConverseImageBlock[]
} {
  if (typeof content === 'string') return { text: content, images: [] }
  let text = ''
  const images: ConverseImageBlock[] = []
  for (const part of content) {
    if (part.type === 'text' && part.text) text += part.text
    else if (part.type === 'image_url' && part.image_url?.url) {
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(part.image_url.url)
      if (m) {
        const format = m[1].split('/')[1].replace('jpg', 'jpeg')
        images.push({ image: { format, source: { bytes: m[2] } } })
      }
    }
  }
  return { text, images }
}

/** Translate an OpenAI chat request to a Bedrock Converse request body. */
export function openAIToConverse(request: OpenAIChatRequest): ConverseRequestBody {
  const system: Array<{ text: string }> = []
  const messages: ConverseMessage[] = []

  const pushMessage = (role: 'user' | 'assistant', blocks: ConverseContentBlock[]): void => {
    if (blocks.length === 0) return
    const last = messages[messages.length - 1]
    if (last && last.role === role) last.content.push(...blocks)
    else messages.push({ role, content: blocks })
  }

  for (const msg of request.messages as OpenAIMessage[]) {
    if (msg.role === 'system') {
      const { text } = extractText(msg.content)
      if (text) system.push({ text })
      continue
    }
    if (msg.role === 'tool') {
      const block: ConverseToolResultBlock = {
        toolResult: {
          toolUseId: msg.tool_call_id || 'tool_call',
          content: [
            { text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }
          ]
        }
      }
      // Converse requires tool results to be in a user turn.
      pushMessage('user', [block])
      continue
    }
    if (msg.role === 'assistant') {
      const blocks: ConverseContentBlock[] = []
      const { text } = extractText(msg.content ?? '')
      if (text) blocks.push({ text })
      for (const call of msg.tool_calls || []) {
        let input: unknown = {}
        try {
          input = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          input = { _raw: call.function.arguments }
        }
        blocks.push({ toolUse: { toolUseId: call.id, name: call.function.name, input } })
      }
      pushMessage('assistant', blocks)
      continue
    }
    // user
    const { text, images } = extractText(msg.content)
    const blocks: ConverseContentBlock[] = []
    if (text) blocks.push({ text })
    blocks.push(...images)
    if (blocks.length === 0) blocks.push({ text: '' })
    pushMessage('user', blocks)
  }

  // Converse requires the conversation to start with a user turn.
  if (messages.length === 0 || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: [{ text: system.length ? '' : 'Hello' }] })
  }

  const body: ConverseRequestBody = { messages }
  if (system.length) body.system = system

  const inferenceConfig: { maxTokens?: number; temperature?: number; topP?: number } = {}
  if (typeof request.max_tokens === 'number') inferenceConfig.maxTokens = request.max_tokens
  if (typeof request.temperature === 'number') inferenceConfig.temperature = request.temperature
  if (typeof request.top_p === 'number') inferenceConfig.topP = request.top_p
  if (Object.keys(inferenceConfig).length) body.inferenceConfig = inferenceConfig

  if (request.tools && request.tools.length) {
    body.toolConfig = {
      tools: (request.tools as OpenAITool[]).map((t) => ({
        toolSpec: {
          name: t.function.name,
          description: t.function.description,
          inputSchema: { json: t.function.parameters ?? { type: 'object', properties: {} } }
        }
      }))
    }
    if (
      request.tool_choice &&
      typeof request.tool_choice === 'object' &&
      request.tool_choice.function?.name
    ) {
      body.toolConfig.toolChoice = { tool: { name: request.tool_choice.function.name } }
    } else if (request.tool_choice === 'required') {
      body.toolConfig.toolChoice = { any: {} }
    }
  }

  // Bedrock requires toolConfig whenever the conversation contains toolUse /
  // toolResult blocks, even on follow-up turns where the client omits the tool
  // definitions. Synthesize a minimal toolConfig from the tool names already
  // present in the message history so Bedrock does not reject the request.
  if (!body.toolConfig) {
    const toolNames = new Set<string>()
    for (const m of messages) {
      for (const block of m.content) {
        const tu = (block as ConverseToolUseBlock).toolUse
        if (tu?.name) toolNames.add(tu.name)
      }
    }
    if (toolNames.size > 0) {
      body.toolConfig = {
        tools: Array.from(toolNames).map((name) => ({
          toolSpec: {
            name,
            description: `Tool: ${name}`,
            inputSchema: { json: { type: 'object', properties: {} } }
          }
        }))
      }
    }
  }

  return body
}

function mapStopReason(reason?: string): 'stop' | 'length' | 'tool_calls' | null {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
      return 'length'
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    default:
      return reason ? 'stop' : null
  }
}

export function converseUsageToKiro(usage?: ConverseResponse['usage']): KiroUsage {
  return {
    inputTokens: usage?.inputTokens || 0,
    outputTokens: usage?.outputTokens || 0,
    credits: 0
  }
}

/** Translate a Bedrock Converse response to an OpenAI chat.completion. */
export function converseToOpenAI(resp: ConverseResponse, model: string): OpenAIChatResponse {
  const content = resp.output?.message?.content || []
  let text = ''
  let reasoning = ''
  const toolCalls: OpenAIToolCall[] = []
  for (const block of content) {
    if (typeof block.text === 'string') text += block.text
    const rc = (block as { reasoningContent?: { reasoningText?: { text?: string } } })
      .reasoningContent
    if (rc?.reasoningText?.text) reasoning += rc.reasoningText.text
    const toolUse = (block as { toolUse?: { toolUseId: string; name: string; input: unknown } })
      .toolUse
    if (toolUse) {
      toolCalls.push({
        id: toolUse.toolUseId,
        type: 'function',
        function: { name: toolUse.name, arguments: JSON.stringify(toolUse.input ?? {}) }
      })
    }
  }
  const inputTokens = resp.usage?.inputTokens || 0
  const outputTokens = resp.usage?.outputTokens || 0
  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || (toolCalls.length ? null : ''),
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        },
        finish_reason: mapStopReason(resp.stopReason) || 'stop'
      }
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  }
}

// ---- Claude (Anthropic Messages) translation ----

export function claudeToConverse(request: ClaudeRequest): ConverseRequestBody {
  const system: Array<{ text: string }> = []
  if (typeof request.system === 'string' && request.system) system.push({ text: request.system })
  else if (Array.isArray(request.system)) {
    for (const s of request.system) if (s.text) system.push({ text: s.text })
  }

  const messages: ConverseMessage[] = []
  for (const msg of request.messages as ClaudeMessage[]) {
    const role: 'user' | 'assistant' = msg.role === 'assistant' ? 'assistant' : 'user'
    const blocks: ConverseContentBlock[] = []
    if (typeof msg.content === 'string') {
      blocks.push({ text: msg.content })
    } else {
      for (const b of msg.content as ClaudeContentBlock[]) {
        if (b.type === 'text' && b.text) blocks.push({ text: b.text })
        else if (b.type === 'tool_use' && b.id && b.name) {
          blocks.push({ toolUse: { toolUseId: b.id, name: b.name, input: b.input ?? {} } })
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          const resultText =
            typeof b.content === 'string'
              ? b.content
              : Array.isArray(b.content)
                ? b.content.map((c) => c.text || '').join('')
                : ''
          blocks.push({ toolResult: { toolUseId: b.tool_use_id, content: [{ text: resultText }] } })
        } else if (
          b.type === 'image' &&
          b.source &&
          'data' in b.source &&
          b.source.type === 'base64'
        ) {
          const format = (b.source.media_type || 'image/png').split('/')[1].replace('jpg', 'jpeg')
          blocks.push({ image: { format, source: { bytes: b.source.data } } })
        }
      }
    }
    if (blocks.length) messages.push({ role, content: blocks })
  }

  if (messages.length === 0 || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: [{ text: 'Hello' }] })
  }

  const body: ConverseRequestBody = { messages }
  if (system.length) body.system = system
  const inferenceConfig: { maxTokens?: number; temperature?: number; topP?: number } = {}
  if (typeof request.max_tokens === 'number') inferenceConfig.maxTokens = request.max_tokens
  if (typeof request.temperature === 'number') inferenceConfig.temperature = request.temperature
  if (typeof request.top_p === 'number') inferenceConfig.topP = request.top_p
  if (Object.keys(inferenceConfig).length) body.inferenceConfig = inferenceConfig

  if (request.tools && request.tools.length) {
    body.toolConfig = {
      tools: request.tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.input_schema ?? {} }
        }
      }))
    }
  }

  // Synthesize toolConfig from tool names in history when the client omits tool
  // definitions on a follow-up turn (Bedrock rejects toolUse/toolResult without it).
  if (!body.toolConfig) {
    const toolNames = new Set<string>()
    for (const m of messages) {
      for (const block of m.content) {
        const tu = (block as ConverseToolUseBlock).toolUse
        if (tu?.name) toolNames.add(tu.name)
      }
    }
    if (toolNames.size > 0) {
      body.toolConfig = {
        tools: Array.from(toolNames).map((name) => ({
          toolSpec: {
            name,
            description: `Tool: ${name}`,
            inputSchema: { json: { type: 'object', properties: {} } }
          }
        }))
      }
    }
  }
  return body
}

export function converseToClaude(resp: ConverseResponse, model: string): ClaudeResponse {
  const content = resp.output?.message?.content || []
  const blocks: ClaudeContentBlock[] = []
  for (const block of content) {
    if (typeof block.text === 'string' && block.text)
      blocks.push({ type: 'text', text: block.text })
    const toolUse = (block as { toolUse?: { toolUseId: string; name: string; input: unknown } })
      .toolUse
    if (toolUse) {
      blocks.push({
        type: 'tool_use',
        id: toolUse.toolUseId,
        name: toolUse.name,
        input: toolUse.input
      })
    }
  }
  const inputTokens = resp.usage?.inputTokens || 0
  const outputTokens = resp.usage?.outputTokens || 0
  const stop = mapStopReason(resp.stopReason)
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    content: blocks,
    model,
    stop_reason: stop === 'tool_calls' ? 'tool_use' : stop === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
  }
}

// ============ Runtime calls ============

function runtimeHost(region: string): string {
  return `bedrock-runtime.${region}.amazonaws.com`
}

export async function bedrockConverse(
  config: BedrockConfig,
  modelId: string,
  body: ConverseRequestBody,
  signal?: AbortSignal
): Promise<ConverseResponse> {
  const creds = resolveBedrockCredentials(config)
  if (!creds) throw new Error('Bedrock credentials are not configured')
  const host = runtimeHost(creds.region)
  const path = `/model/${encodeURIComponent(modelId)}/converse`
  const payload = JSON.stringify(body)
  const signed = signBedrockRequest({
    creds,
    service: BEDROCK_RUNTIME_SERVICE,
    method: 'POST',
    host,
    path,
    body: payload,
    extraHeaders: { 'content-type': 'application/json' }
  })
  const res = await undiciFetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: payload,
    signal
  })
  const text = await res.text()
  if (res.status !== 200) {
    throw new Error(
      `Bedrock Converse failed (${modelId}): HTTP ${res.status} ${text.slice(0, 400)}`
    )
  }
  return JSON.parse(text) as ConverseResponse
}

// ---- AWS event-stream (application/vnd.amazon.eventstream) decoder ----

export interface BedrockStreamEvent {
  eventType: string
  payload: Record<string, unknown>
}

/**
 * Decode a full AWS event-stream buffer into discrete events.
 * Frame layout: [totalLen:4][headersLen:4][preludeCrc:4][headers][payload][msgCrc:4]
 */
export function decodeEventStream(buffer: Buffer): { events: BedrockStreamEvent[]; rest: Buffer } {
  const events: BedrockStreamEvent[] = []
  let offset = 0
  while (buffer.length - offset >= 12) {
    const totalLen = buffer.readUInt32BE(offset)
    if (totalLen < 16 || buffer.length - offset < totalLen) break
    const headersLen = buffer.readUInt32BE(offset + 4)
    const headersStart = offset + 12
    const headersEnd = headersStart + headersLen
    const payloadStart = headersEnd
    const payloadEnd = offset + totalLen - 4

    const headers: Record<string, string> = {}
    let hp = headersStart
    while (hp < headersEnd) {
      const nameLen = buffer.readUInt8(hp)
      hp += 1
      const name = buffer.toString('utf8', hp, hp + nameLen)
      hp += nameLen
      const valueType = buffer.readUInt8(hp)
      hp += 1
      if (valueType === 7) {
        const valLen = buffer.readUInt16BE(hp)
        hp += 2
        headers[name] = buffer.toString('utf8', hp, hp + valLen)
        hp += valLen
      } else {
        // Other header value types are not needed for Bedrock streaming; skip frame.
        hp = headersEnd
      }
    }

    const payloadRaw = buffer.toString('utf8', payloadStart, payloadEnd)
    let payload: Record<string, unknown> = {}
    try {
      payload = payloadRaw ? JSON.parse(payloadRaw) : {}
    } catch {
      payload = { _raw: payloadRaw }
    }
    events.push({
      eventType: headers[':event-type'] || headers[':exception-type'] || 'unknown',
      payload
    })
    offset += totalLen
  }
  return { events, rest: buffer.subarray(offset) }
}

export interface ConverseStreamHandlers {
  onText?: (text: string) => void
  onToolUseStart?: (index: number, toolUseId: string, name: string) => void
  onToolUseDelta?: (index: number, partialJson: string) => void
  onToolUseStop?: (index: number) => void
  onStop?: (stopReason: string | undefined) => void
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
}

export interface ConverseStreamResult {
  text: string
  toolUses: Array<{ toolUseId: string; name: string; input: unknown }>
  stopReason?: string
  usage: { inputTokens: number; outputTokens: number }
}

export async function bedrockConverseStream(
  config: BedrockConfig,
  modelId: string,
  body: ConverseRequestBody,
  handlers: ConverseStreamHandlers,
  signal?: AbortSignal
): Promise<ConverseStreamResult> {
  const creds = resolveBedrockCredentials(config)
  if (!creds) throw new Error('Bedrock credentials are not configured')
  const host = runtimeHost(creds.region)
  const path = `/model/${encodeURIComponent(modelId)}/converse-stream`
  const payload = JSON.stringify(body)
  const signed = signBedrockRequest({
    creds,
    service: BEDROCK_RUNTIME_SERVICE,
    method: 'POST',
    host,
    path,
    body: payload,
    extraHeaders: { 'content-type': 'application/json' }
  })
  const res = await undiciFetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: payload,
    signal
  })
  if (res.status !== 200 || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `Bedrock ConverseStream failed (${modelId}): HTTP ${res.status} ${text.slice(0, 400)}`
    )
  }

  const result: ConverseStreamResult = {
    text: '',
    toolUses: [],
    usage: { inputTokens: 0, outputTokens: 0 }
  }
  const toolBuffers = new Map<number, { toolUseId: string; name: string; json: string }>()

  let pending: Buffer = Buffer.alloc(0)
  const reader = res.body as unknown as AsyncIterable<Uint8Array>
  for await (const chunk of reader) {
    pending = Buffer.concat([pending, Buffer.from(chunk)])
    const { events, rest } = decodeEventStream(pending)
    pending = Buffer.from(rest)
    for (const ev of events) {
      switch (ev.eventType) {
        case 'contentBlockStart': {
          const start = ev.payload.start as
            | { toolUse?: { toolUseId: string; name: string } }
            | undefined
          const index = Number(ev.payload.contentBlockIndex ?? 0)
          if (start?.toolUse) {
            toolBuffers.set(index, {
              toolUseId: start.toolUse.toolUseId,
              name: start.toolUse.name,
              json: ''
            })
            handlers.onToolUseStart?.(index, start.toolUse.toolUseId, start.toolUse.name)
          }
          break
        }
        case 'contentBlockDelta': {
          const index = Number(ev.payload.contentBlockIndex ?? 0)
          const delta = ev.payload.delta as
            | { text?: string; toolUse?: { input?: string } }
            | undefined
          if (delta?.text) {
            result.text += delta.text
            handlers.onText?.(delta.text)
          }
          if (delta?.toolUse?.input !== undefined) {
            const buf = toolBuffers.get(index)
            if (buf) buf.json += delta.toolUse.input
            handlers.onToolUseDelta?.(index, delta.toolUse.input)
          }
          break
        }
        case 'contentBlockStop': {
          const index = Number(ev.payload.contentBlockIndex ?? 0)
          handlers.onToolUseStop?.(index)
          break
        }
        case 'messageStop': {
          result.stopReason = ev.payload.stopReason as string | undefined
          handlers.onStop?.(result.stopReason)
          break
        }
        case 'metadata': {
          const usage = ev.payload.usage as
            | { inputTokens?: number; outputTokens?: number }
            | undefined
          if (usage) {
            result.usage.inputTokens = usage.inputTokens || 0
            result.usage.outputTokens = usage.outputTokens || 0
            handlers.onUsage?.(result.usage)
          }
          break
        }
        default: {
          const message = ev.payload.message as string | undefined
          if (ev.eventType.toLowerCase().includes('exception') && message) {
            throw new Error(`Bedrock stream error (${ev.eventType}): ${message}`)
          }
        }
      }
    }
  }

  for (const [, buf] of toolBuffers) {
    let input: unknown = {}
    try {
      input = buf.json ? JSON.parse(buf.json) : {}
    } catch {
      input = { _raw: buf.json }
    }
    result.toolUses.push({ toolUseId: buf.toolUseId, name: buf.name, input })
  }
  return result
}
