// Kiro Proxy HTTP/HTTPS 服务器
import http from 'http'
import https from 'https'
import fs from 'fs'
import crypto from 'crypto'
import { v4 as uuidv4 } from 'uuid'
import type { Socket } from 'net'
import type {
  OpenAIChatRequest,
  OpenAIMessage,
  OpenAIResponsesRequest,
  ClaudeRequest,
  ClaudeContentBlock,
  ClaudeCacheControl,
  ProxyConfig,
  ProxyStats,
  ProxyAccount,
  KiroPayload,
  KiroToolUse,
  KiroUsage,
  TokenRefreshCallback
} from './types'
import { AccountPool, ErrorType, classifyError, isBillingOrQuotaError, isThrottleError } from './accountPool'
import { callKiroApiStream, callKiroApi, fetchKiroModels, setModelContextWindow, type KiroModel } from './kiroApi'
import { proxyLogger } from './logger'
import { getKProxyService, generateDeviceId } from '../kproxy'
import {
  openaiToKiro,
  claudeToKiro,
  kiroToOpenaiResponse,
  kiroToClaudeResponse,
  createOpenaiStreamChunk,
  createClaudeStreamEvent,
  responsesToOpenAIChat,
  openAIChatToResponsesResponse
} from './translator'
import { ToolNameRegistry } from './toolNameRegistry'
import { promptCacheTracker } from './promptCacheTracker'
import { getRuntimeUserDataPath } from '../runtimePaths'
import { KIRO_PROXY_MODEL_PRESETS, normalizeKiroModelIdForCompare } from './modelCatalog'

type ProxyAttemptError = Error & {
  proxyAccountId?: string
  proxyFailureRecorded?: boolean
}

export interface ProxyServerEvents {
  onRequest?: (info: { path: string; method: string; accountId?: string }) => void
  onResponse?: (info: { path: string; model?: string; status: number; tokens?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; credits?: number; responseTime?: number; error?: string }) => void
  onError?: (error: Error) => void
  onConfigChanged?: (config: ProxyConfig) => void  // API Key 用量更新时触发
  onStatusChange?: (running: boolean, port: number) => void
  onTokenRefresh?: TokenRefreshCallback
  onAccountUpdate?: (account: ProxyAccount) => void
  // 账号被 Kiro 后端长期封禁（如 TEMPORARILY_SUSPENDED / AccountSuspendedException）
  // 不同于临时 token 失效，需人工解封
  onAccountSuspended?: (info: { accountId: string; email?: string; reason: string; message: string }) => void
  onCreditsUpdate?: (totalCredits: number) => void
  onTokensUpdate?: (inputTokens: number, outputTokens: number) => void
  onRequestStatsUpdate?: (totalRequests: number, successRequests: number, failedRequests: number) => void
  onPoolEmpty?: () => Promise<void> // 账号池为空时触发（冷启动懒加载）
}

type ModelModality = 'text' | 'audio' | 'image' | 'video' | 'pdf'

type ClientModel = {
  id: string
  object: 'model'
  created: number
  owned_by: string
  name: string
  description: string
  model_name?: string
  family: string
  release_date: string
  attachment: boolean
  reasoning: boolean
  temperature: boolean
  tool_call: boolean
  interleaved: boolean | { field: 'reasoning_content' }
  cost: { input: number; output: number; cache_read: number; cache_write: number }
  limit: { context: number; input?: number; output: number }
  modalities: { input: ModelModality[]; output: ModelModality[] }
  capabilities: {
    temperature: boolean
    reasoning: boolean
    attachment: boolean
    toolcall: boolean
    input: Record<ModelModality, boolean>
    output: Record<ModelModality, boolean>
    interleaved: boolean | { field: 'reasoning_content' }
  }
  context_length: number
  max_tokens: number
  max_input_tokens?: number
  max_output_tokens: number
  inputTypes?: string[]
  rateMultiplier?: number
  rateUnit?: string
  supportsThinking?: boolean
  thinkingEfforts?: string[]
  supportsPromptCaching?: boolean
  modelProvider?: string
  permission: unknown[]
  root: string
  parent: null
}

function modelDisplayName(id: string, modelName?: string): string {
  if (modelName?.trim()) return modelName
  return id
    .split('-')
    .filter(Boolean)
    .map(part => part === 'gpt' ? 'GPT' : part === 'ai' ? 'AI' : part[0]?.toUpperCase() + part.slice(1))
    .join(' ')
}

function modelFamily(id: string): string {
  const lower = id.toLowerCase()
  if (lower.includes('opus')) return 'claude-opus'
  if (lower.includes('sonnet')) return 'claude-sonnet'
  if (lower.includes('haiku')) return 'claude-haiku'
  if (lower.includes('gpt-4o')) return 'gpt-4o'
  if (lower.includes('gpt-4')) return 'gpt-4'
  if (lower.includes('gpt-3.5')) return 'gpt-3.5'
  if (lower.includes('glm')) return 'glm'
  if (lower === 'auto') return 'auto'
  return lower.split(/[.-]/).slice(0, 2).join('-') || lower
}

function modelOutputLimit(id: string, output?: number | null): number {
  if (typeof output === 'number' && output > 0) return output
  const lower = id.toLowerCase()
  if (lower.includes('haiku') || lower.includes('gpt-3.5')) return 8192
  return 32000
}

function modelInputModalities(inputTypes?: string[]): ModelModality[] {
  const values = new Set<ModelModality>(['text'])
  for (const item of inputTypes ?? []) {
    const lower = item.toLowerCase()
    if (lower.includes('image')) values.add('image')
    if (lower.includes('pdf') || lower.includes('document') || lower.includes('file')) values.add('pdf')
    if (lower.includes('audio')) values.add('audio')
    if (lower.includes('video')) values.add('video')
  }
  return Array.from(values)
}

function modelCapabilityMap(modalities: ModelModality[]): Record<ModelModality, boolean> {
  return {
    text: modalities.includes('text'),
    audio: modalities.includes('audio'),
    image: modalities.includes('image'),
    video: modalities.includes('video'),
    pdf: modalities.includes('pdf')
  }
}

function extractThinkingEfforts(schema?: Record<string, unknown> | null): string[] | undefined {
  if (!schema) return undefined
  const props = schema.properties as Record<string, unknown> | undefined
  if (!props?.thinking) return undefined
  const thinking = props.thinking as Record<string, unknown>
  const thinkingProps = thinking.properties as Record<string, unknown> | undefined
  const typeField = thinkingProps?.type as Record<string, unknown> | undefined
  const enumValues = typeField?.enum as string[] | undefined
  if (enumValues?.includes('adaptive') || enumValues?.includes('disabled')) {
    const effortField = (props.output_config as Record<string, unknown> | undefined)?.properties as Record<string, unknown> | undefined
    const effortEnum = (effortField?.effort as Record<string, unknown> | undefined)?.enum as string[] | undefined
    return effortEnum || undefined
  }
  return undefined
}

function buildClientModel(input: {
  id: string
  created: number
  ownedBy: string
  description?: string
  modelName?: string
  supportedInputTypes?: string[]
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
  rateMultiplier?: number
  rateUnit?: string
  promptCaching?: { supportsPromptCaching: boolean; maximumCacheCheckpointsPerRequest?: number | null; minimumTokensPerCacheCheckpoint?: number | null } | null
  additionalModelRequestFieldsSchema?: Record<string, unknown> | null
  modelProvider?: string | null
}): ClientModel {
  const name = modelDisplayName(input.id, input.modelName)
  const inputModalities = modelInputModalities(input.supportedInputTypes)
  const outputModalities: ModelModality[] = ['text']
  const output = modelOutputLimit(input.id, input.maxOutputTokens)
  const context = typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? input.maxInputTokens : 200000
  const reasoning = false
  const interleaved = false

  return {
    id: input.id,
    object: 'model',
    created: input.created,
    owned_by: input.ownedBy,
    name,
    description: input.description || name,
    model_name: input.modelName || name,
    family: modelFamily(input.id),
    release_date: '',
    attachment: inputModalities.some(item => item !== 'text'),
    reasoning,
    temperature: true,
    tool_call: true,
    interleaved,
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    limit: {
      context,
      ...(typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? { input: input.maxInputTokens } : {}),
      output
    },
    modalities: { input: inputModalities, output: outputModalities },
    capabilities: {
      temperature: true,
      reasoning,
      attachment: inputModalities.some(item => item !== 'text'),
      toolcall: true,
      input: modelCapabilityMap(inputModalities),
      output: modelCapabilityMap(outputModalities),
      interleaved
    },
    context_length: context,
    max_tokens: output,
    ...(typeof input.maxInputTokens === 'number' && input.maxInputTokens > 0 ? { max_input_tokens: input.maxInputTokens } : {}),
    max_output_tokens: output,
    inputTypes: input.supportedInputTypes,
    rateMultiplier: input.rateMultiplier,
    rateUnit: input.rateUnit,
    supportsThinking: !!(input.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)?.thinking,
    thinkingEfforts: extractThinkingEfforts(input.additionalModelRequestFieldsSchema),
    supportsPromptCaching: input.promptCaching?.supportsPromptCaching || false,
    modelProvider: input.modelProvider || undefined,
    permission: [],
    root: input.id,
    parent: null
  }
}

// 请求体超限错误（统一识别用，触发 413 响应）
function buildKiroPresetClientModel(preset: (typeof KIRO_PROXY_MODEL_PRESETS)[number], created: number): ClientModel {
  return buildClientModel({
    id: preset.id,
    created,
    ownedBy: 'kiro-api',
    description: preset.description,
    modelName: preset.name,
    supportedInputTypes: preset.inputTypes,
    maxInputTokens: preset.maxInputTokens,
    maxOutputTokens: preset.maxOutputTokens,
    modelProvider: preset.modelProvider
  })
}

function buildKiroPresetModel(preset: (typeof KIRO_PROXY_MODEL_PRESETS)[number]): KiroModel {
  return {
    modelId: preset.id,
    modelName: preset.name,
    description: preset.description,
    supportedInputTypes: preset.inputTypes,
    tokenLimits: {
      maxInputTokens: preset.maxInputTokens,
      maxOutputTokens: preset.maxOutputTokens
    },
    modelProvider: preset.modelProvider
  } as KiroModel
}

class BodyTooLargeError extends Error {
  constructor(public readonly received: number, public readonly limit: number) {
    super(`Request body too large: ${received} bytes exceeds limit of ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

export type AccountTier = 'power' | 'free' | 'unknown'

export type NoAccountReason = 'model_unsupported' | 'quota_exhausted' | 'throttled'

export interface NoAccountDiagnosis {
  reason: NoAccountReason
  message: string
  eligibleTotal: number
  exhausted: number
  cooldown: number
}

export class ProxyServer {
  private server: http.Server | https.Server | null = null
  private fallbackServer: http.Server | null = null  // HTTPS 启用时同时监听 HTTP（可选）
  private accountPool: AccountPool
  private config: ProxyConfig
  private stats: ProxyStats
  private sessionStats: { totalRequests: number; successRequests: number; failedRequests: number; startTime: number }
  private events: ProxyServerEvents
  private refreshingTokens: Set<string> = new Set() // 防止并发刷新
  private isHttps: boolean = false
  private isStopping: boolean = false
  private activeRequests: Set<AbortController> = new Set()
  private sockets: Set<Socket> = new Set()
  /** P1-7 按 API Key/IP 的滑动窗口限流（每分钟桶） */
  private rateLimitBuckets: Map<string, { count: number; windowStart: number }> = new Map()
  /** P1-8 会话粘性：session hint → accountId 的映射（10 分钟 TTL） */
  private sessionAffinity: Map<string, { accountId: string; lastAt: number }> = new Map()
  private modelLoadBalanceState: Map<string, number> = new Map()
  private accountModelCapabilityCache: Map<string, { timestamp: number; modelIds: Set<string> }> = new Map()
  private modelPaceQueues: Map<string, Promise<void>> = new Map()
  private modelPaceReadyAt: Map<string, number> = new Map()
  private readonly MODEL_CAPABILITY_CACHE_TTL = 5 * 60 * 1000
  private readonly OPUS_MODEL_PACE_MS = 10 * 1000
  private readonly MAX_COMPATIBLE_COOLDOWN_WAIT_MS = 65 * 1000
  /** P2-17 审计日志（最近 200 条） */
  private auditLog: Array<{ ts: number; type: string; data: Record<string, unknown> }> = []
  /** Webhook 触发回调（由外部注入，避免 main → renderer 循环依赖） */
  private webhookTrigger?: (event: string, payload: Record<string, unknown>) => void
  /** 定期清理 timer */
  private cleanupTimer: NodeJS.Timeout | null = null

  /**
   * 从请求中提取 session hint，用于稳定 conversationId
   * 优先级 1：显式稳定 ID（header）
   * 优先级 2：请求体中的会话相关字段（body）
   * 优先级 3：返回 undefined（由 kiroApi 用 history fingerprint 兜底）
   */
  static extractSessionHint(req: http.IncomingMessage, body: unknown): string | undefined {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
    const h = req.headers
    // 优先级 1：显式稳定 header
    const headerHint =
      (h['x-claude-code-session-id'] as string) ||
      (h['x-opencode-session'] as string) ||
      (h['x-session-affinity'] as string) ||
      (h['x-conversation-id'] as string)
    if (headerHint) return headerHint

    // 优先级 2：body 中可靠的会话字段
    const bodyHint =
      (b.prompt_cache_key as string) ||
      (b.promptCacheKey as string) ||
      (b.conversation_id as string) ||
      (b.conversationId as string) ||
      (b.thread_id as string) ||
      (b.threadId as string) ||
      (b.session_id as string) ||
      (b.sessionId as string)
    if (bodyHint) return bodyHint

    // 优先级 2.5：metadata 中的 session/conversation
    const metadata = b.metadata as Record<string, unknown> | undefined
    if (metadata) {
      const metaHint =
        (metadata.session_id as string) ||
        (metadata.conversation_id as string)
      if (metaHint) return metaHint
    }

    // 优先级 3：无显式 ID，返回 undefined（kiroApi 用 history fingerprint 兜底）
    return undefined
  }

  constructor(config: Partial<ProxyConfig> = {}, events: ProxyServerEvents = {}) {
    this.config = {
      enabled: false,
      port: 5580,
      host: '127.0.0.1',
      enableMultiAccount: true,
      selectedAccountIds: [],
      logRequests: true,
      maxConcurrent: 10,
      maxRetries: 3,
      retryDelayMs: 1000,
      tokenRefreshBeforeExpiry: 300, // 5分钟提前刷新
      autoStart: false, // 是否自动启动
      clientDrivenToolExecution: true,
      accountSelectionStrategy: 'smart',
      sessionAffinityEnabled: false,
      ...config
    }
    this.normalizeAccountBalancingConfig()
    this.accountPool = new AccountPool()
    this.accountPool.setStrategy(this.config.accountSelectionStrategy || 'smart')
    this.stats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      totalTokens: 0,
      totalCredits: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      startTime: Date.now(),
      accountStats: new Map(),
      endpointStats: new Map(),
      modelStats: new Map(),
      recentRequests: []
    }
    this.sessionStats = {
      totalRequests: 0,
      successRequests: 0,
      failedRequests: 0,
      startTime: 0
    }
    this.events = events
  }

  /**
   * 检测当前绑定地址是否会暴露到本机以外
   * 0.0.0.0 / :: / 网卡地址 → true；127.0.0.1 / ::1 / localhost → false
   */
  private isBindingExternal(host?: string): boolean {
    if (!host) return false
    const h = host.toLowerCase().trim()
    return h === '0.0.0.0' || h === '::' || h === '*' || (
      h !== '127.0.0.1' && h !== '::1' && h !== 'localhost'
    )
  }

  // 启动服务器
  async start(): Promise<void> {
    if (this.server) {
      console.log('[ProxyServer] Server already running')
      return
    }

    // P0-2 安全护栏：外网绑定 + 无 API Key → 拒绝启动（用户可以显式 allowExternalWithoutApiKey 解除）
    if (this.isBindingExternal(this.config.host)) {
      const hasAnyKey = (this.config.apiKeys?.some(k => k.enabled && k.key) ?? false) || !!this.config.apiKey
      if (!hasAnyKey && !this.config.allowExternalWithoutApiKey) {
        const err = new Error(
          `[Security] Refused to start: host=${this.config.host} exposes to network but no API Key configured. ` +
          `Set at least one API Key, or change host to 127.0.0.1, or set allowExternalWithoutApiKey=true (NOT RECOMMENDED).`
        )
        console.error('[ProxyServer]', err.message)
        this.events.onError?.(err)
        throw err
      }
      if (!hasAnyKey) {
        console.warn(`[ProxyServer] [Security] WARNING: binding to ${this.config.host} without API Key (allowExternalWithoutApiKey=true). This exposes your accounts to the network!`)
      }
    }

    return new Promise((resolve, reject) => {
      this.isStopping = false
      const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => 
        this.handleRequest(req, res)

      // 检查是否启用 TLS
      if (this.config.tls?.enabled) {
        try {
          const tlsOptions = this.getTlsOptions()
          this.server = https.createServer(tlsOptions, requestHandler)
          this.isHttps = true
        } catch (error) {
          reject(new Error(`TLS configuration error: ${(error as Error).message}`))
          return
        }
      } else {
        this.server = http.createServer(requestHandler)
        this.isHttps = false
      }

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[ProxyServer] Port ${this.config.port} is already in use`)
          reject(new Error(`Port ${this.config.port} is already in use`))
        } else {
          console.error('[ProxyServer] Server error:', error)
          reject(error)
        }
        this.events.onError?.(error)
      })

      this.server.on('connection', (socket: Socket) => {
        this.sockets.add(socket)
        socket.on('close', () => this.sockets.delete(socket))
        // P1-10 backpressure 监控：socket 写入缓冲区超过 1MB 时记录警告
        socket.on('drain', () => {
          if (socket.writableLength > 0) {
            proxyLogger.debug('ProxyServer', `Socket drain: bufferedLen=${socket.writableLength}`)
          }
        })
      })

      // 服务器关闭时尝试自动重启
      this.server.on('close', () => {
        if (!this.isStopping && this.config.autoStart && this.config.enabled) {
          console.log('[ProxyServer] Server closed unexpectedly, attempting restart in 3s...')
          setTimeout(() => {
            if (!this.isStopping && this.config.autoStart && !this.isRunning()) {
              console.log('[ProxyServer] Auto-restarting...')
              this.start().catch(err => {
                console.error('[ProxyServer] Auto-restart failed:', err)
              })
            }
          }, 3000)
        }
      })

      // P1-11 keep-alive / headers 空闲超时（避免长连接占用资源）
      const keepAliveMs = this.config.keepAliveTimeoutMs ?? 65_000
      const headersMs = this.config.headersTimeoutMs ?? 60_000
      this.server.keepAliveTimeout = keepAliveMs
      this.server.headersTimeout = Math.max(headersMs, keepAliveMs + 1000) // headers 必须 > keepAlive，否则 Node 会 warn
      this.server.requestTimeout = 0  // 流式响应可能很长，禁用 request 总超时

      // 启动定期清理（每 5 分钟）
      if (this.cleanupTimer) clearInterval(this.cleanupTimer)
      this.cleanupTimer = setInterval(() => this.cleanupExpiredCaches(), 5 * 60_000)
      // 让 timer 在 Node 退出时不阻塞
      this.cleanupTimer.unref?.()

      const protocol = this.isHttps ? 'https' : 'http'
      this.server.listen(this.config.port, this.config.host, () => {
        proxyLogger.info('ProxyServer', `Started on ${protocol}://${this.config.host}:${this.config.port} (keepAlive=${keepAliveMs}ms)`)
        this.stats.startTime = Date.now()
        // 重置会话统计
        this.sessionStats = {
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          startTime: Date.now()
        }
        this.events.onStatusChange?.(true, this.config.port)
        resolve()
      })

      // D4 启用 TLS 时同时监听 HTTP fallback 端口（如果配置了 fallbackPort）
      if (this.isHttps && this.config.fallbackPort && this.config.fallbackPort !== this.config.port) {
        const fallback = http.createServer(requestHandler)
        fallback.keepAliveTimeout = keepAliveMs
        fallback.headersTimeout = Math.max(headersMs, keepAliveMs + 1000)
        fallback.requestTimeout = 0
        fallback.on('connection', (socket) => {
          this.sockets.add(socket)
          socket.on('close', () => this.sockets.delete(socket))
        })
        fallback.on('error', (err) => proxyLogger.warn('ProxyServer', `Fallback HTTP error: ${err.message}`))
        fallback.listen(this.config.fallbackPort, this.config.host, () => {
          proxyLogger.info('ProxyServer', `Fallback HTTP listening on http://${this.config.host}:${this.config.fallbackPort}`)
        })
        this.fallbackServer = fallback
      }
    })
  }

  // 获取 TLS 配置选项
  // P1-13 当 tls.enabled 但未提供 cert/key 时，自动生成自签证书
  private getTlsOptions(): https.ServerOptions {
    const tls = this.config.tls!
    
    let cert: string
    let key: string

    // 优先使用直接提供的 PEM 内容
    if (tls.cert && tls.key) {
      cert = tls.cert
      key = tls.key
    } else if (tls.certPath && tls.keyPath) {
      // 从文件读取
      cert = fs.readFileSync(tls.certPath, 'utf8')
      key = fs.readFileSync(tls.keyPath, 'utf8')
    } else {
      // 自动生成自签证书（位于 userData/proxy-tls/）
      try {
        const { ensureProxySelfSignedCert } = require('./selfSignedCert')
        const hostnames = [this.config.host || '127.0.0.1']
        const result = ensureProxySelfSignedCert(getRuntimeUserDataPath(), hostnames)
        proxyLogger.info('ProxyServer', `Using self-signed TLS cert (SAN=${result.altNames.join(',')}, fingerprint=${result.fingerprint.slice(0, 19)}...)`)
        cert = result.cert
        key = result.key
      } catch (err) {
        throw new Error(`TLS enabled but no certificate/key provided and auto-generation failed: ${(err as Error).message}`)
      }
    }

    return { cert, key }
  }

  /**
   * 获取（或生成）反代自签证书信息（供 UI 显示/导出 PEM）
   */
  getSelfSignedCertInfo(): import('./selfSignedCert').ProxySelfSignedCert | null {
    try {
      const { ensureProxySelfSignedCert } = require('./selfSignedCert')
      return ensureProxySelfSignedCert(getRuntimeUserDataPath(), [this.config.host || '127.0.0.1'])
    } catch (err) {
      proxyLogger.warn('ProxyServer', `getSelfSignedCertInfo failed: ${(err as Error).message}`)
      return null
    }
  }

  /** 强制重新生成自签证书（用户在 UI 上点"重新生成"） */
  regenerateSelfSignedCert(): import('./selfSignedCert').ProxySelfSignedCert | null {
    try {
      const { ensureProxySelfSignedCert } = require('./selfSignedCert')
      this.appendAuditLog('regenerate_self_signed_cert', { host: this.config.host })
      return ensureProxySelfSignedCert(getRuntimeUserDataPath(), [this.config.host || '127.0.0.1'], true)
    } catch (err) {
      proxyLogger.warn('ProxyServer', `regenerateSelfSignedCert failed: ${(err as Error).message}`)
      return null
    }
  }

  /**
   * 优雅停止服务器
   * - 立刻拒绝新连接（server.close）
   * - 给正在进行中的请求 5 秒完成；超时后强制 destroy socket
   * - 同时停 fallback HTTP 服务器
   */
  async stop(gracefulMs: number = 5000): Promise<void> {
    if (!this.server) {
      return
    }

    this.isStopping = true

    const main = this.server
    const fallback = this.fallbackServer

    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        proxyLogger.info('ProxyServer', 'Stopped')
        this.server = null
        this.fallbackServer = null
        this.isStopping = false
        this.activeRequests.clear()
        this.sockets.clear()
        if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null }
        this.events.onStatusChange?.(false, this.config.port)
        resolve()
      }

      // 先停止接受新连接
      main.close(() => {
        fallback?.close(() => finish()) || finish()
      })
      fallback?.close()

      // P1-14 优雅停止：给正在进行中的请求时间完成，超时再强制
      this.activeRequests.forEach(controller => {
        // 给客户端一个明确的 stop 信号，但不立即中断已发送的响应流
        try { controller.abort(new Error('Proxy server stopped')) } catch { /* ignore */ }
      })

      // 超时强制 destroy
      setTimeout(() => {
        this.sockets.forEach(socket => { try { socket.destroy() } catch { /* ignore */ } })
        finish()
      }, Math.max(0, gracefulMs))
    })
  }

  // 更新配置
  // P2-18 检测到 port/host/tls 变更时，标记 needsRestart=true，UI 可读取并提示
  private _needsRestart = false
  updateConfig(config: Partial<ProxyConfig>): void {
    // 标记需要重启的字段
    const restartTriggerFields: Array<keyof ProxyConfig> = ['port', 'host', 'tls', 'fallbackPort']
    const willRestart = restartTriggerFields.some(k => k in config && JSON.stringify(this.config[k]) !== JSON.stringify(config[k]))
    if (willRestart && this.isRunning()) {
      this._needsRestart = true
      proxyLogger.warn('ProxyServer', `Config change requires restart: ${restartTriggerFields.filter(k => k in config).join(', ')}`)
    }
    this.appendAuditLog('config_changed', { fields: Object.keys(config), needsRestart: willRestart })
    if (config.modelMappings) {
      this.modelLoadBalanceState.clear()
    }
    this.config = { ...this.config, ...config }
    this.normalizeAccountBalancingConfig()
    // 同步账号选择策略到 accountPool
    this.accountPool.setStrategy(this.config.accountSelectionStrategy || 'smart')
  }

  private normalizeAccountBalancingConfig(): void {
    const strategy = this.config.accountSelectionStrategy || 'smart'
    this.config.accountSelectionStrategy = strategy

    if (this.config.enableMultiAccount && strategy !== 'sticky') {
      this.config.sessionAffinityEnabled = false
    }
  }

  private isSessionAffinityActive(): boolean {
    return Boolean(
      this.config.sessionAffinityEnabled &&
      (this.config.accountSelectionStrategy || 'smart') === 'sticky'
    )
  }

  /** UI 可用此判断是否需提示用户重启 */
  needsRestart(): boolean {
    return this._needsRestart
  }

  /** 重启后调用清除 needsRestart 标记 */
  async restartServer(): Promise<void> {
    if (!this.isRunning()) {
      await this.start()
      this._needsRestart = false
      return
    }
    await this.stop()
    await this.start()
    this._needsRestart = false
  }

  // 获取配置
  getConfig(): ProxyConfig {
    return { ...this.config }
  }

  private validateCacheControl(cacheControl?: ClaudeCacheControl): void {
    if (!cacheControl) return
    if (cacheControl.type !== 'ephemeral') {
      throw new Error(`Unsupported cache_control type: ${cacheControl.type}`)
    }
  }


  private validateClaudeContentBlocks(blocks: ClaudeContentBlock[]): void {
    blocks.forEach(block => {
      this.validateCacheControl(block.cache_control)
      if (Array.isArray(block.content)) {
        this.validateClaudeContentBlocks(block.content)
      }
    })
  }

  private validateOpenAICacheControls(request: OpenAIChatRequest): void {
    request.messages.forEach(message => {
      this.validateCacheControl(message.cache_control)
      if (Array.isArray(message.content)) {
        message.content.forEach(part => this.validateCacheControl(part.cache_control))
      }
    })
    request.tools?.forEach(tool => this.validateCacheControl(tool.cache_control))
  }

  private validateClaudeCacheControls(request: ClaudeRequest): void {
    if (Array.isArray(request.system)) {
      request.system.forEach(block => this.validateCacheControl(block.cache_control))
    }
    request.messages.forEach(message => {
      this.validateCacheControl(message.cache_control)
      if (Array.isArray(message.content)) {
        this.validateClaudeContentBlocks(message.content)
      }
    })
    request.tools?.forEach(tool => this.validateCacheControl(tool.cache_control))
  }

  private async downloadImageDataUrl(url: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const abort = () => controller.abort(this.getAbortError(signal))
    try {
      if (signal?.aborted) throw this.getAbortError(signal)
      signal?.addEventListener('abort', abort, { once: true })
      const agent = (() => {
        const { getSystemProxy, safeCreateProxyAgent } = require('./systemProxy')
        const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
        const envAgent = safeCreateProxyAgent(envProxy)
        if (envAgent) return envAgent
        return safeCreateProxyAgent(getSystemProxy())
      })()
      const { fetch: undiciFetch } = require('undici')
      const response = agent
        ? await undiciFetch(url, { signal: controller.signal, dispatcher: agent }) as unknown as globalThis.Response
        : await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        throw new Error(`Failed to download image: HTTP ${response.status}`)
      }
      const contentType = response.headers.get('content-type')?.split(';')[0]?.toLowerCase()
      if (!contentType || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
        throw new Error(`Unsupported image content-type: ${contentType || 'unknown'}`)
      }
      const arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > 10 * 1024 * 1024) {
        throw new Error('Image exceeds 10MB limit')
      }
      return `data:${contentType};base64,${Buffer.from(arrayBuffer).toString('base64')}`
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }
  }

  private async resolveOpenAIHttpImages(request: OpenAIChatRequest, signal?: AbortSignal): Promise<OpenAIChatRequest> {
    await Promise.all(request.messages.map(async message => {
      if (!Array.isArray(message.content)) return
      await Promise.all(message.content.map(async part => {
        if (part.type !== 'image_url' || !part.image_url?.url.startsWith('http')) return
        part.image_url.url = await this.downloadImageDataUrl(part.image_url.url, signal)
      }))
    }))
    return request
  }

  private async resolveClaudeHttpImages(request: ClaudeRequest, signal?: AbortSignal): Promise<ClaudeRequest> {
    await Promise.all(request.messages.map(async message => {
      if (!Array.isArray(message.content)) return
      await Promise.all(message.content.map(async block => {
        if (block.type !== 'image' || block.source?.type !== 'url') return
        const dataUrl = await this.downloadImageDataUrl(block.source.url, signal)
        const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
        if (!match) {
          throw new Error('Downloaded image produced invalid data URL')
        }
        block.source = { type: 'base64', media_type: match[1], data: match[2] }
      }))
    }))
    return request
  }

  private prepareOpenAIRequest(request: OpenAIChatRequest): OpenAIChatRequest {
    this.validateOpenAICacheControls(request)

    if (this.config.disableTools || request.tool_choice === 'none') {
      return { ...request, tools: undefined, tool_choice: undefined }
    }

    if (request.tool_choice && typeof request.tool_choice === 'object' && request.tool_choice.type === 'function' && !request.tool_choice.function?.name) {
      throw new Error('tool_choice function requires a tool name')
    }

    if (request.tool_choice && typeof request.tool_choice === 'object' && request.tool_choice.function?.name) {
      const selectedToolName = request.tool_choice.function.name
      if (!request.tools?.some(tool => tool.function.name === selectedToolName)) {
        throw new Error(`tool_choice references unknown tool: ${selectedToolName}`)
      }
      return {
        ...request,
        tools: request.tools?.filter(tool => tool.function.name === selectedToolName)
      }
    }

    return request
  }

  private prepareClaudeRequest(request: ClaudeRequest): ClaudeRequest {
    this.validateClaudeCacheControls(request)

    if (this.config.disableTools || request.tool_choice?.type === 'none') {
      return { ...request, tools: undefined, tool_choice: undefined }
    }

    if (request.tool_choice?.type === 'tool' && !request.tool_choice.name) {
      throw new Error('tool_choice tool requires a tool name')
    }

    if (request.tool_choice?.name) {
      const selectedToolName = request.tool_choice.name
      if (!request.tools?.some(tool => tool.name === selectedToolName)) {
        throw new Error(`tool_choice references unknown tool: ${selectedToolName}`)
      }
      return {
        ...request,
        tools: request.tools?.filter(tool => tool.name === selectedToolName)
      }
    }

    return request
  }

  // 获取统计信息
  getStats(): ProxyStats {
    const poolStats = this.accountPool.getStats()
    // 返回可序列化的统计信息（Map 对象在 IPC 中无法正确序列化）
    return {
      totalRequests: this.stats.totalRequests,
      successRequests: this.stats.successRequests,
      failedRequests: this.stats.failedRequests,
      totalTokens: this.stats.totalTokens,
      totalCredits: this.stats.totalCredits,
      inputTokens: this.stats.inputTokens,
      outputTokens: this.stats.outputTokens,
      cacheReadTokens: this.stats.cacheReadTokens,
      cacheWriteTokens: this.stats.cacheWriteTokens,
      reasoningTokens: this.stats.reasoningTokens,
      startTime: this.stats.startTime,
      accountStats: poolStats.accounts,
      endpointStats: this.stats.endpointStats,
      modelStats: this.stats.modelStats,
      recentRequests: this.stats.recentRequests
    }
  }

  // 获取账号池
  getAccountPool(): AccountPool {
    return this.accountPool
  }

  // 设置初始累计 credits（用于从持久化存储恢复）
  setTotalCredits(credits: number): void {
    this.stats.totalCredits = credits
  }

  // 重置累计 credits
  resetTotalCredits(): void {
    this.stats.totalCredits = 0
    this.events.onCreditsUpdate?.(0)
  }

  // 设置初始累计 tokens（用于从持久化存储恢复）
  setTotalTokens(inputTokens: number, outputTokens: number): void {
    this.stats.inputTokens = inputTokens
    this.stats.outputTokens = outputTokens
    this.stats.totalTokens = inputTokens + outputTokens
  }

  // 重置累计 tokens
  resetTotalTokens(): void {
    this.stats.inputTokens = 0
    this.stats.outputTokens = 0
    this.stats.totalTokens = 0
  }

  // 设置请求统计（用于从持久化存储恢复）
  setRequestStats(totalRequests: number, successRequests: number, failedRequests: number): void {
    this.stats.totalRequests = totalRequests
    this.stats.successRequests = successRequests
    this.stats.failedRequests = failedRequests
  }

  // 重置请求统计
  resetRequestStats(): void {
    this.stats.totalRequests = 0
    this.stats.successRequests = 0
    this.stats.failedRequests = 0
    this.notifyRequestStatsUpdate()
  }

  // 通知请求统计更新
  private notifyRequestStatsUpdate(): void {
    this.events.onRequestStatsUpdate?.(
      this.stats.totalRequests,
      this.stats.successRequests,
      this.stats.failedRequests
    )
  }

  // 记录请求成功
  private recordRequestSuccess(): void {
    this.stats.successRequests++
    this.sessionStats.successRequests++
    this.notifyRequestStatsUpdate()
  }

  // 记录请求失败
  private recordRequestFailed(): void {
    this.stats.failedRequests++
    this.sessionStats.failedRequests++
    this.notifyRequestStatsUpdate()
  }

  // 记录新请求
  private recordNewRequest(): void {
    this.stats.totalRequests++
    this.sessionStats.totalRequests++
    this.notifyRequestStatsUpdate()
  }

  // 获取会话统计（当前服务运行期间的统计）
  getSessionStats(): { totalRequests: number; successRequests: number; failedRequests: number; startTime: number } {
    return { ...this.sessionStats }
  }

  // 是否运行中
  isRunning(): boolean {
    return this.server !== null
  }

  private getAbortError(signal?: AbortSignal): Error {
    if (signal?.reason instanceof Error) return signal.reason
    if (signal?.reason) return new Error(String(signal.reason))
    return new Error('Request aborted')
  }

  private isAbortError(error: unknown, signal?: AbortSignal): boolean {
    return signal?.aborted === true
      || (error instanceof Error && (error.message.includes('Client disconnected') || error.message.includes('Proxy server stopped')))
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.getAbortError(signal)
  }

  private throwIfResponseClosed(res: http.ServerResponse, signal?: AbortSignal): void {
    this.throwIfAborted(signal)
    if (res.writableEnded || res.destroyed) throw new Error('Client disconnected')
  }

  private isResponseClosed(res: http.ServerResponse): boolean {
    return res.writableEnded || res.destroyed
  }

  // 检测错误消息中是否包含账号被长期封禁的特征
  // 返回 { reason, message } 表示需要标记 suspended；返回 null 表示非封禁错误
  // 覆盖：
  //   - Kiro 后端 HTTP 403 + body: { reason: "TEMPORARILY_SUSPENDED", message: "..." }
  //   - CodeWhisperer AccountSuspendedException
  //   - 423 Locked
  private detectSuspendedError(errMsg: string): { reason: string; message: string } | null {
    if (!errMsg) return null

    // 1) 显式 reason: "TEMPORARILY_SUSPENDED" (Kiro 风控)
    const reasonMatch = errMsg.match(/"reason"\s*:\s*"(TEMPORARILY_SUSPENDED|ACCOUNT_SUSPENDED|PERMANENTLY_SUSPENDED)"/i)
    if (reasonMatch) {
      // 尝试提取 message 字段
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: reasonMatch[1].toUpperCase(), message: msgMatch?.[1] || errMsg }
    }

    // 2) 文本特征 "temporarily suspended" / "user id is ... suspended"
    if (/User\s+ID\s+is\s+(temporarily\s+)?suspended/i.test(errMsg) || /temporarily\s+suspended/i.test(errMsg)) {
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: 'TEMPORARILY_SUSPENDED', message: msgMatch?.[1] || errMsg }
    }

    // 3) AccountSuspendedException (CodeWhisperer)
    if (errMsg.includes('AccountSuspendedException') || errMsg.includes('Account suspended')) {
      const msgMatch = errMsg.match(/"message"\s*:\s*"([^"]+)"/)
      return { reason: 'AccountSuspendedException', message: msgMatch?.[1] || errMsg }
    }

    // 4) HTTP 423 Locked
    if (/\b423\b/.test(errMsg) && /locked|suspended/i.test(errMsg)) {
      return { reason: 'ACCOUNT_LOCKED', message: errMsg }
    }

    return null
  }

  private waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }, ms)
      const abort = () => {
        clearTimeout(timeout)
        reject(this.getAbortError(signal))
      }
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private getPacedModelGroup(modelId?: string): string | null {
    if (!modelId) return null
    const normalized = normalizeKiroModelIdForCompare(modelId)
    if (normalized.includes('opus')) return 'opus'
    return null
  }

  private async runWithModelPacing<T>(
    account: ProxyAccount,
    modelId: string | undefined,
    signal: AbortSignal | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const group = this.getPacedModelGroup(modelId)
    if (!group) return await work()

    const key = `${account.id}:${group}`
    const paceMs = group === 'opus' ? this.OPUS_MODEL_PACE_MS : 0
    const previous = this.modelPaceQueues.get(key) || Promise.resolve()
    const queued = previous.catch(() => undefined).then(async () => {
      this.throwIfAborted(signal)
      const waitMs = Math.max(0, (this.modelPaceReadyAt.get(key) || 0) - Date.now())
      if (waitMs > 0) {
        proxyLogger.info('ProxyServer', `Pacing ${modelId || group} on ${account.email || account.id.slice(0, 8)} for ${waitMs}ms`)
        await this.waitForRetry(waitMs, signal)
      }
      try {
        return await work()
      } finally {
        this.modelPaceReadyAt.set(key, Date.now() + paceMs)
      }
    })
    const marker = queued.then(() => undefined, () => undefined)
    this.modelPaceQueues.set(key, marker)
    try {
      return await queued
    } finally {
      if (this.modelPaceQueues.get(key) === marker) this.modelPaceQueues.delete(key)
    }
  }

  private async abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    this.throwIfAborted(signal)
    if (!signal) return promise
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        const abort = () => reject(this.getAbortError(signal))
        signal.addEventListener('abort', abort, { once: true })
        promise.then(
          () => signal.removeEventListener('abort', abort),
          () => signal.removeEventListener('abort', abort)
        )
      })
    ])
  }

  // 清除模型缓存，强制下次请求重新获取
  clearModelCache(): void {
    this.modelCache = null
    console.log('[ProxyServer] Model cache cleared')
  }

  // 获取可用模型列表
  private static mapKiroModelToApi(m: KiroModel) {
    return {
      id: m.modelId,
      name: m.modelName,
      description: m.description,
      inputTypes: m.supportedInputTypes,
      maxInputTokens: m.tokenLimits?.maxInputTokens,
      maxOutputTokens: m.tokenLimits?.maxOutputTokens,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      supportsThinking: !!(m.additionalModelRequestFieldsSchema?.properties as Record<string, unknown> | undefined)?.thinking,
      thinkingEfforts: extractThinkingEfforts(m.additionalModelRequestFieldsSchema),
      supportsPromptCaching: m.promptCaching?.supportsPromptCaching || false,
      modelProvider: m.modelProvider || undefined
    }
  }

  async getAvailableModels(signal?: AbortSignal): Promise<{ models: ReturnType<typeof ProxyServer.mapKiroModelToApi>[]; fromCache: boolean }> {
    const now = Date.now()
    
    let kiroModels: KiroModel[]
    let fromCache = false

    if (this.modelCache && (now - this.modelCache.timestamp) < this.MODEL_CACHE_TTL) {
      kiroModels = this.modelCache.models
      fromCache = true
    } else {
      this.throwIfAborted(signal)
      const account = await this.getAvailableAccount(signal)
      this.throwIfAborted(signal)
      if (!account) {
        return { models: [], fromCache: false }
      }

      try {
        kiroModels = await fetchKiroModels(account, signal)
        if (kiroModels.length > 0) {
          this.modelCache = { models: kiroModels, timestamp: now }
          // 同步到 kiroApi 的 ctx cache, 供 token 裁剪逻辑使用
          for (const m of kiroModels) {
            if (m.tokenLimits?.maxInputTokens) {
              setModelContextWindow(m.modelId, m.tokenLimits.maxInputTokens)
            }
          }
        }
      } catch (error) {
        if (this.isAbortError(error, signal)) throw error
        console.error('[ProxyServer] Failed to fetch models:', error)
        return { models: [], fromCache: false }
      }
    }

    // 合并隐藏模型（与 /v1/models 端点一致）
    const modelIds = new Set(kiroModels.map(m => m.modelId))
    const presetModels = KIRO_PROXY_MODEL_PRESETS.map(buildKiroPresetModel)
    const hiddenModels: KiroModel[] = [
      { modelId: 'claude-3.7-sonnet', modelName: 'Claude 3.7 Sonnet', description: 'Claude 3.7 Sonnet (hidden)', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } } as KiroModel,
      { modelId: 'simple-task', modelName: 'Simple Task', description: 'Kiro fast model (routes to Haiku)', supportedInputTypes: ['TEXT'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 4096 } } as KiroModel,
      { modelId: 'CLAUDE_SONNET_4_20250514_V1_0', modelName: 'Claude Sonnet 4 (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } } as KiroModel,
      { modelId: 'CLAUDE_HAIKU_4_5_20251001_V1_0', modelName: 'Claude Haiku 4.5 (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } } as KiroModel,
      { modelId: 'CLAUDE_3_7_SONNET_20250219_V1_0', modelName: 'Claude 3.7 Sonnet (CW)', description: 'CodeWhisperer internal ID', supportedInputTypes: ['TEXT', 'IMAGE'], tokenLimits: { maxInputTokens: 200000, maxOutputTokens: 64000 } } as KiroModel
    ]
    const merged = [...kiroModels]
    for (const model of [...presetModels, ...hiddenModels]) {
      if (!modelIds.has(model.modelId)) {
        modelIds.add(model.modelId)
        merged.push(model)
      }
    }

    return { models: merged.map(ProxyServer.mapKiroModelToApi), fromCache }
  }

  // 检查 Token 是否需要刷新
  private isTokenExpiringSoon(account: ProxyAccount): boolean {
    if (!account.expiresAt) return false
    const refreshBeforeMs = (this.config.tokenRefreshBeforeExpiry || 300) * 1000
    return Date.now() + refreshBeforeMs >= account.expiresAt
  }

  // 刷新 Token
  private async refreshToken(account: ProxyAccount, signal?: AbortSignal): Promise<boolean> {
    this.throwIfAborted(signal)
    if (!this.events.onTokenRefresh) {
      console.warn('[ProxyServer] No token refresh callback configured')
      return false
    }

    // 防止并发刷新
    if (this.refreshingTokens.has(account.id)) {
      console.log(`[ProxyServer] Token refresh already in progress for ${account.email || account.id}`)
      // 等待刷新完成
      await this.waitForRetry(1000, signal)
      return !this.isTokenExpiringSoon(this.accountPool.getAccount(account.id) || account)
    }

    this.refreshingTokens.add(account.id)
    console.log(`[ProxyServer] Refreshing token for ${account.email || account.id}`)

    try {
      // 随机延迟 0-3 秒，避免多账号同时刷新被识别为批量操作
      const jitter = Math.floor(Math.random() * 3000)
      if (jitter > 0) await this.waitForRetry(jitter, signal)
      
      const result = await this.abortable(this.events.onTokenRefresh(account), signal)
      if (result.success && result.accessToken) {
        // 更新账号池中的 Token
        this.accountPool.updateAccount(account.id, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt: result.expiresAt
        })
        // 通知外部更新
        this.events.onAccountUpdate?.({
          ...account,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || account.refreshToken,
          expiresAt: result.expiresAt
        })
        console.log(`[ProxyServer] Token refreshed for ${account.email || account.id}`)
        return true
      } else {
        console.error(`[ProxyServer] Token refresh failed for ${account.email || account.id}: ${result.error}`)
        this.accountPool.markNeedsRefresh(account.id)
        return false
      }
    } catch (error) {
      if (this.isAbortError(error, signal)) throw error
      console.error(`[ProxyServer] Token refresh error for ${account.email || account.id}:`, error)
      this.accountPool.markNeedsRefresh(account.id)
      return false
    } finally {
      this.refreshingTokens.delete(account.id)
    }
  }

  /**
   * 计算 API Key 允许使用的账号 ID 集合（P2-21）
   * 返回 undefined = 不限制（允许所有账号）
   */
  private getAllowedAccountIds(apiKeyId?: string): Set<string> | undefined {
    if (!apiKeyId) return undefined
    const bindings = this.config.apiKeyAccountBindings?.[apiKeyId]
    if (!bindings || bindings.length === 0) return undefined
    return new Set(bindings)
  }

  private isAccountAllowedForRequest(account: ProxyAccount | null, apiKeyId?: string): boolean {
    if (!account) return true
    const allowedIds = this.getAllowedAccountIds(apiKeyId)
    if (allowedIds && !allowedIds.has(account.id)) return false
    if (this.config.multiAccountSelectionMode === 'groups') {
      const allowedGroupIds = new Set(this.config.multiAccountGroupIds || [])
      const groupId = account.groupId || '__ungrouped__'
      if (!allowedGroupIds.has(groupId)) return false
    }
    return true
  }

  private getNextAccountForRequest(excludeIds: Set<string> = new Set(), apiKeyId?: string): ProxyAccount | null {
    const excluded = new Set(excludeIds)
    for (const account of this.accountPool.getAllAccounts()) {
      if (!this.isAccountAllowedForRequest(account, apiKeyId)) excluded.add(account.id)
    }
    return this.accountPool.getNextAccount(excluded)
  }

  // 获取可用账号（包含 Token 刷新检查）
  // P1-8 sessionHint：相同会话尽量复用同一账号（命中 prompt cache + 防风控）
  // P2-21 apiKeyId：用于过滤 API Key 允许使用的账号子集
  private requiresModelCapabilitySelection(modelId?: string): boolean {
    if (!modelId) return false
    const normalized = normalizeKiroModelIdForCompare(modelId)
    return normalized.startsWith('claude-opus-')
      || normalized === 'claude-sonnet-4.6'
      || normalized === 'deepseek-3.2'
      || normalized === 'qwen3-coder-next'
      || normalized === 'glm-5'
      || normalized.startsWith('minimax-')
  }

  private async accountSupportsModel(account: ProxyAccount, modelId: string, signal?: AbortSignal): Promise<boolean> {
    const normalizedModelId = normalizeKiroModelIdForCompare(modelId)
    const cached = this.accountModelCapabilityCache.get(account.id)
    if (cached && Date.now() - cached.timestamp < this.MODEL_CAPABILITY_CACHE_TTL) {
      return cached.modelIds.has(normalizedModelId)
    }

    try {
      let currentAccount = account
      let models = await fetchKiroModels(currentAccount, signal)
      if (models.length === 0 && currentAccount.refreshToken) {
        const refreshed = await this.refreshToken(currentAccount, signal)
        if (refreshed) {
          currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
          models = await fetchKiroModels(currentAccount, signal)
        }
      }
      const modelIds = new Set(models.map(model => normalizeKiroModelIdForCompare(model.modelId)))
      this.accountModelCapabilityCache.set(currentAccount.id, { timestamp: Date.now(), modelIds })
      for (const model of models) {
        if (model.tokenLimits?.maxInputTokens) setModelContextWindow(model.modelId, model.tokenLimits.maxInputTokens)
      }
      return modelIds.has(normalizedModelId)
    } catch (error) {
      if (this.isAbortError(error, signal)) throw error
      proxyLogger.warn('ProxyServer', `Failed to inspect models for ${account.email || account.id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`)
      this.accountModelCapabilityCache.set(account.id, { timestamp: Date.now(), modelIds: new Set() })
      return false
    }
  }

  private accountTier(account: ProxyAccount): AccountTier {
    const cached = this.accountModelCapabilityCache.get(account.id)
    if (!cached || Date.now() - cached.timestamp >= this.MODEL_CAPABILITY_CACHE_TTL) return 'unknown'
    for (const id of cached.modelIds) {
      if (id.startsWith('claude-opus-')) return 'power'
    }
    return 'free'
  }

  private isPowerAccount(account: ProxyAccount): boolean {
    return this.accountTier(account) === 'power'
  }

  private async isEligibleForModel(
    account: ProxyAccount, modelId: string | undefined, apiKeyId?: string, signal?: AbortSignal
  ): Promise<boolean> {
    if (!this.isAccountAllowedForRequest(account, apiKeyId)) return false
    if (!modelId || !this.requiresModelCapabilitySelection(modelId)) return true
    if (!await this.accountSupportsModel(account, modelId, signal)) return false
    // strictTierRouting: với model Opus, chỉ chấp nhận Power_Account (tier suy ra
    // từ capability cache đã được accountSupportsModel làm ấm ở trên).
    if (this.config.strictTierRouting && normalizeKiroModelIdForCompare(modelId).startsWith('claude-opus-')) {
      if (!this.isPowerAccount(account)) {
        proxyLogger.info('ProxyServer', `strictTierRouting: skip ${account.email || account.id.slice(0, 8)} (not a power account) for ${modelId}`)
        return false
      }
    }
    return true
  }

  private async buildEligibleSet(
    modelId: string | undefined, apiKeyId?: string, signal?: AbortSignal
  ): Promise<ProxyAccount[]> {
    const out: ProxyAccount[] = []
    for (const account of this.accountPool.getAllAccounts()) {
      if (await this.isEligibleForModel(account, modelId, apiKeyId, signal)) out.push(account)
    }
    return out
  }

  /**
   * 当 getAvailableAccount 对某个 Requested_Model 返回 null 时调用，
   * 按互斥优先级判定唯一原因 (R6.4)：
   *   1. Eligible_Account_Set 为空 -> model_unsupported (R6.1)
   *   2. 否则所有 eligible 账号都已配额耗尽 -> quota_exhausted (R6.2)
   *   3. 否则 (尚有配额但都在 cooldown / 不可选) -> throttled (R6.3)
   */
  private async classifyNoAccountReason(
    modelId: string | undefined, apiKeyId?: string, signal?: AbortSignal
  ): Promise<NoAccountDiagnosis> {
    this.throwIfAborted(signal)
    const eligible = await this.buildEligibleSet(modelId, apiKeyId, signal)
    const eligibleTotal = eligible.length

    const now = Date.now()
    let exhausted = 0
    let cooldown = 0
    for (const account of eligible) {
      const isExhausted = this.accountPool.isQuotaExhausted(account, now)
      if (isExhausted) {
        exhausted++
        continue
      }
      if (
        !this.accountPool.isSuspended(account) &&
        typeof account.cooldownUntil === 'number' &&
        account.cooldownUntil > now
      ) {
        cooldown++
      }
    }

    // 1. 没有任何账号支持该 model
    if (eligibleTotal === 0) {
      return {
        reason: 'model_unsupported',
        message: `Không có tài khoản nào hỗ trợ model "${modelId ?? ''}"`,
        eligibleTotal,
        exhausted,
        cooldown
      }
    }

    // 2. 所有 eligible 账号都已配额耗尽
    if (exhausted === eligibleTotal) {
      return {
        reason: 'quota_exhausted',
        message: `Tất cả tài khoản phù hợp đã hết quota (${exhausted}/${eligibleTotal})`,
        eligibleTotal,
        exhausted,
        cooldown
      }
    }

    // 3. 仍有账号有配额，但都在 cooldown / 超过等待阈值
    return {
      reason: 'throttled',
      message: 'Tất cả tài khoản phù hợp đang bị giới hạn tốc độ, vui lòng thử lại sau',
      eligibleTotal,
      exhausted,
      cooldown
    }
  }

  private async getNextAccountForModel(excludeIds: Set<string> = new Set(), apiKeyId?: string, modelId?: string, signal?: AbortSignal): Promise<ProxyAccount | null> {
    if (!modelId || !this.requiresModelCapabilitySelection(modelId)) {
      return this.getNextAccountForRequest(excludeIds, apiKeyId)
    }

    const tried = new Set(excludeIds)
    const total = Math.max(this.accountPool.size, 1)
    for (let attempt = 0; attempt < total; attempt++) {
      this.throwIfAborted(signal)
      const account = this.getNextAccountForRequest(tried, apiKeyId)
      if (!account || tried.has(account.id)) break
      tried.add(account.id)
      if (await this.isEligibleForModel(account, modelId, apiKeyId, signal)) {
        const selectedAccount = this.accountPool.getAccount(account.id) || account
        proxyLogger.info('ProxyServer', `Selected ${selectedAccount.email || selectedAccount.id.slice(0, 8)} for model ${modelId}`)
        return selectedAccount
      }
      proxyLogger.info('ProxyServer', `Skipping ${account.email || account.id.slice(0, 8)} because model ${modelId} is not available`)
    }

    const cooldownWaitMs = await this.getCompatibleModelCooldownWaitMs(excludeIds, apiKeyId, modelId, signal)
    if (cooldownWaitMs !== null && cooldownWaitMs <= this.MAX_COMPATIBLE_COOLDOWN_WAIT_MS) {
      const waitMs = Math.max(250, cooldownWaitMs + 100)
      proxyLogger.info('ProxyServer', `Waiting ${waitMs}ms for a compatible ${modelId} account to leave cooldown`)
      await this.waitForRetry(waitMs, signal)
      return await this.getNextAccountForModel(excludeIds, apiKeyId, modelId, signal)
    }

    return null
  }

  private async getCompatibleModelCooldownWaitMs(excludeIds: Set<string>, apiKeyId: string | undefined, modelId: string, signal?: AbortSignal): Promise<number | null> {
    const now = Date.now()
    let best: number | null = null
    for (const account of this.accountPool.getAllAccounts()) {
      this.throwIfAborted(signal)
      if (excludeIds.has(account.id)) continue
      if (!this.isAccountAllowedForRequest(account, apiKeyId)) continue
      if (this.accountPool.isSuspended(account) || this.accountPool.isQuotaExhausted(account, now)) continue
      if (!account.cooldownUntil || account.cooldownUntil <= now) continue
      if (account.isAvailable === false) continue
      if (!await this.accountSupportsModel(account, modelId, signal)) continue
      const waitMs = account.cooldownUntil - now
      best = best === null ? waitMs : Math.min(best, waitMs)
    }
    return best
  }

  private async getAvailableAccount(signal?: AbortSignal, sessionHint?: string, apiKeyId?: string, modelId?: string): Promise<ProxyAccount | null> {
    const isAllowed = (acc: ProxyAccount | null): boolean => this.isAccountAllowedForRequest(acc, apiKeyId)
    const supportsRequestedModel = async (acc: ProxyAccount): Promise<boolean> => {
      return !modelId || !this.requiresModelCapabilitySelection(modelId) || await this.accountSupportsModel(acc, modelId, signal)
    }
    this.throwIfAborted(signal)
    // 如果 pool 为空，触发懒加载回调尝试同步账号（冷启动场景）
    if (this.accountPool.size === 0 && this.events.onPoolEmpty) {
      console.log('[ProxyServer] Account pool empty, triggering lazy sync...')
      await this.abortable(this.events.onPoolEmpty(), signal)
    }
    this.throwIfAborted(signal)

    // P1-8 会话粘性：优先复用已绑定的账号（同时受 API Key 绑定过滤）
    if (this.isSessionAffinityActive() && sessionHint) {
      const sticky = this.pickAccountWithAffinity(sessionHint)
      if (sticky && isAllowed(sticky) && await supportsRequestedModel(sticky)) {
        proxyLogger.debug('ProxyServer', `Session affinity hit: ${sessionHint.slice(0, 16)} → ${sticky.email || sticky.id.slice(0, 8)}`)
        // 仍需检查 token 是否需要刷新
        if (this.isTokenExpiringSoon(sticky)) {
          const refreshed = await this.refreshToken(sticky, signal)
          if (refreshed) {
            return this.accountPool.getAccount(sticky.id) || sticky
          }
        } else {
          return sticky
        }
      }
    }

    let account: ProxyAccount | null

    if (this.config.enableMultiAccount) {
      account = await this.getNextAccountForModel(new Set(), apiKeyId, modelId, signal)
      if (!account) {
        const status = this.accountPool.getQuotaStatus()
        if (status.exhausted > 0 && status.available === 0) {
          console.log(`[ProxyServer] All accounts quota exhausted (${status.exhausted}/${status.total}), no available accounts`)
        }
      }
    } else {
      // 禁用多账号轮询时，优先使用指定的账号
      if (this.config.selectedAccountIds && this.config.selectedAccountIds.length > 0) {
        // 使用指定的第一个账号
        account = this.accountPool.getAccount(this.config.selectedAccountIds[0])
        // 检查指定账号是否配额耗尽，若是则尝试自动切换
        if (account && this.accountPool.isQuotaExhausted(account) && this.config.autoSwitchOnQuotaExhausted) {
          const nextAccount = this.accountPool.getNextAvailableAccount(account.id)
          if (nextAccount) {
            console.log(`[ProxyServer] Selected account ${account.email || account.id} quota exhausted, auto-switching to ${nextAccount.email || nextAccount.id}`)
            this.config.selectedAccountIds = [nextAccount.id]
            this.events.onAccountUpdate?.(nextAccount)
            account = nextAccount
          }
        }
        if (!account) {
          console.log(`[ProxyServer] Selected account ${this.config.selectedAccountIds[0]} not found, using first available`)
          const allAccounts = this.accountPool.getAllAccounts()
          account = allAccounts.length > 0 ? allAccounts[0] : null
        }
      } else {
        // 没有指定账号，使用第一个可用账号
        const allAccounts = this.accountPool.getAllAccounts()
        account = allAccounts.length > 0 ? allAccounts[0] : null
      }
    }
    
    if (!account) return null

    // 自动切换 K-Proxy 设备 ID（如果 K-Proxy 服务可用）
    this.syncKProxyDeviceId(account)

    // 检查是否需要刷新 Token
    if (this.isTokenExpiringSoon(account)) {
      const refreshed = await this.refreshToken(account, signal)
      if (!refreshed) {
        // 刷新失败，如果启用多账号才尝试获取下一个账号
        if (this.config.enableMultiAccount) {
          return await this.getNextAccountForModel(new Set([account.id]), apiKeyId, modelId, signal)
        }
        return null
      }
      // 返回更新后的账号
      const refreshedAccount = this.accountPool.getAccount(account.id)
      if (refreshedAccount && sessionHint) this.rememberAffinity(sessionHint, refreshedAccount.id)
      return refreshedAccount
    }

    if (sessionHint) this.rememberAffinity(sessionHint, account.id)
    return account
  }

  // 同步 K-Proxy 设备 ID（根据账号自动切换）
  private syncKProxyDeviceId(account: ProxyAccount): void {
    const kproxyService = getKProxyService()
    if (!kproxyService || !kproxyService.isRunning()) {
      return // K-Proxy 未初始化或未运行
    }

    // 尝试切换到账号绑定的设备 ID
    const switched = kproxyService.switchToAccount(account.id)
    
    if (!switched) {
      // 账号没有绑定设备 ID，自动生成并绑定
      const newDeviceId = generateDeviceId()
      kproxyService.addDeviceIdMapping({
        accountId: account.id,
        deviceId: newDeviceId,
        description: account.email || `Account ${account.id.substring(0, 8)}`,
        createdAt: Date.now()
      })
      kproxyService.setDeviceId(newDeviceId)
      proxyLogger.info('ProxyServer', `Auto-generated device ID for account ${account.email || account.id.substring(0, 8)}`)
    } else {
      proxyLogger.debug('ProxyServer', `Switched to device ID for account ${account.email || account.id.substring(0, 8)}`)
    }
  }

  // 带重试的 API 调用
  private async callWithRetry<T>(
    account: ProxyAccount,
    apiCall: (acc: ProxyAccount, endpointIndex: number) => Promise<T>,
    _path: string,
    signal?: AbortSignal,
    apiKeyId?: string,
    modelId?: string
  ): Promise<{ result: T; account: ProxyAccount }> {
    const configuredRetries = Math.max(0, this.config.maxRetries ?? 3)
    const maxAttempts = Math.min(100, Math.max(configuredRetries + 1, this.accountPool.size))
    const retryDelay = this.config.retryDelayMs || 1000
    let lastError: Error | null = null
    let currentAccount = account
    // 本次请求累计已尝试的账号 ID，避免重试时循环命中已经失败过的账号
    const triedIds = new Set<string>([account.id])
    /** 切到下一个可用账号；多账号模式带 triedIds 排除，单账号场景退化为旧逻辑 */
    const switchToNextAccount = async (): Promise<ProxyAccount | null> => {
      if (this.config.enableMultiAccount) {
        return await this.getNextAccountForModel(triedIds, apiKeyId, modelId, signal)
      }
      if (this.config.autoSwitchOnQuotaExhausted) {
        const next = this.accountPool.getNextAvailableAccount(triedIds)
        return this.isAccountAllowedForRequest(next, apiKeyId) ? next : null
      }
      return null
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this.throwIfAborted(signal)
      try {
        const result = await this.runWithModelPacing(currentAccount, modelId, signal, () => apiCall(currentAccount, 0))
        return { result, account: currentAccount }
      } catch (error) {
        if (this.isAbortError(error, signal)) throw error
        lastError = error as Error
        const errMsg = lastError.message || ''

        console.log(`[ProxyServer] API call failed (attempt ${attempt + 1}/${maxAttempts}, account=${currentAccount.email || currentAccount.id.slice(0, 8)}): ${errMsg}`)

        // 优先检测账号被长期封禁（不是 token 问题，刷新也没用）
        // 特征：HTTP 403 + reason: "TEMPORARILY_SUSPENDED" 或 AccountSuspendedException / 423
        const suspendInfo = this.detectSuspendedError(errMsg)
        if (suspendInfo) {
          const newlyMarked = this.accountPool.markSuspended(currentAccount.id, suspendInfo.reason, suspendInfo.message)
          if (newlyMarked) {
            this.events.onAccountSuspended?.({
              accountId: currentAccount.id,
              email: currentAccount.email,
              reason: suspendInfo.reason,
              message: suspendInfo.message
            })
            // P1-6 关键事件 → 触发 webhook
            this.appendAuditLog('account_suspended', {
              accountId: currentAccount.id,
              email: currentAccount.email,
              reason: suspendInfo.reason
            })
            this.triggerWebhook('proxy-account-suspended', {
              title: '反代账号被风控',
              message: `账号 ${currentAccount.email || currentAccount.id.slice(0, 8)} 被 Kiro 后端标记为 ${suspendInfo.reason}，需要人工解封`,
              level: 'error',
              fields: {
                邮箱: currentAccount.email || '-',
                账号ID: currentAccount.id.slice(0, 8),
                封禁原因: suspendInfo.reason,
                详情: this.sanitizeErrorMessage(suspendInfo.message || '').slice(0, 200)
              }
            })
          }
          console.warn(`[ProxyServer] Account ${currentAccount.email || currentAccount.id} suspended (${suspendInfo.reason}), switching to next available account`)
          // 切到下个可用账号（跳过被 suspended 的 + 本请求已试过的）
          const nextAccount = await switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            if (!this.config.enableMultiAccount) {
              this.config.selectedAccountIds = [nextAccount.id]
              this.events.onAccountUpdate?.(nextAccount)
            }
            continue
          }
          // 无可切换的账号 → 直接抛出错误给客户端
          break
        }

        if (isThrottleError(errMsg)) {
          console.log(`[ProxyServer] Throttle error on ${currentAccount.email || currentAccount.id.slice(0, 8)}, switching account`)
          this.accountPool.recordError(currentAccount.id, ErrorType.RECOVERABLE, 429)
          ;(lastError as ProxyAttemptError).proxyFailureRecorded = true
          const nextAccount = await switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            continue
          }
          if (attempt < configuredRetries) {
            const cooledAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
            const cooldownWaitMs = cooledAccount.cooldownUntil && cooledAccount.cooldownUntil > Date.now()
              ? cooledAccount.cooldownUntil - Date.now()
              : retryDelay * (attempt + 1)
            const waitMs = Math.min(this.MAX_COMPATIBLE_COOLDOWN_WAIT_MS, Math.max(1000, cooldownWaitMs + 100))
            proxyLogger.info('ProxyServer', `No alternate ${modelId || 'model'} account after throttle; waiting ${waitMs}ms before retrying ${cooledAccount.email || cooledAccount.id.slice(0, 8)}`)
            await this.waitForRetry(waitMs, signal)
            currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
            continue
          }
          break
        }

        if (isBillingOrQuotaError(errMsg)) {
          console.log(`[ProxyServer] Billing/quota exhausted on ${currentAccount.email || currentAccount.id.slice(0, 8)}, switching account immediately`)
          this.accountPool.markQuotaExhausted(currentAccount.id)
          ;(lastError as ProxyAttemptError).proxyFailureRecorded = true
          const nextAccount = await switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            if (!this.config.enableMultiAccount) {
              this.config.selectedAccountIds = [nextAccount.id]
              this.events.onAccountUpdate?.(nextAccount)
            }
            continue
          }
          break
        }

        // 401/403: 尝试刷新 Token
        if (this.isInvalidModelForAccountError(errMsg)) {
          console.log(`[ProxyServer] Model not available on ${currentAccount.email || currentAccount.id.slice(0, 8)}, switching account`)
          const nextAccount = await switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            continue
          }
          break
        }

        if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('Auth')) {
          console.log('[ProxyServer] Auth error, attempting token refresh')
          const refreshed = await this.refreshToken(currentAccount, signal)
          if (refreshed) {
            currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
            continue
          }
          // 刷新失败 → 切到没试过的下个账号
          const nextAccount = await switchToNextAccount()
          if (nextAccount && !triedIds.has(nextAccount.id)) {
            currentAccount = nextAccount
            triedIds.add(nextAccount.id)
            continue
          }
        }

        // 5xx: 同账号短退避重试一次；再次 5xx 直接 fallback 到没试过的账号（瞬时故障跨账号绕过）
        if (errMsg.includes('500') || errMsg.includes('502') || errMsg.includes('503') || errMsg.includes('504')) {
          console.log('[ProxyServer] Server error, retrying')
          // 第二次及以后的 5xx → 切换账号（旧逻辑会同账号撞死）
          if (attempt > 0) {
            const nextAccount = await switchToNextAccount()
            if (nextAccount && !triedIds.has(nextAccount.id)) {
              this.accountPool.recordError(currentAccount.id, ErrorType.RECOVERABLE, 503)
              console.log(`[ProxyServer] Persistent 5xx on ${currentAccount.email || currentAccount.id.slice(0, 8)}, switching account`)
              currentAccount = nextAccount
              triedIds.add(nextAccount.id)
              continue
            }
          }
          await this.waitForRetry(retryDelay * (attempt + 1), signal)
          continue
        }

        // 其他错误，不重试
        break
      }
    }

    const finalError = (lastError || new Error('Unknown error')) as ProxyAttemptError
    finalError.proxyAccountId = currentAccount.id
    throw finalError
  }

  private recordAccountFailure(account: ProxyAccount, error: Error): void {
    const message = error.message || ''
    const statusMatch = message.match(/\b(\d{3})\b/)
    const statusCode = statusMatch ? Number(statusMatch[1]) : undefined
    if (isThrottleError(message)) {
      this.accountPool.recordError(account.id, ErrorType.RECOVERABLE, 429)
      return
    }
    if (isBillingOrQuotaError(message)) {
      if (!this.accountPool.isQuotaExhausted(account)) this.accountPool.markQuotaExhausted(account.id)
      return
    }
    this.accountPool.recordError(
      account.id,
      statusCode && statusCode >= 500 ? ErrorType.RECOVERABLE : classifyError(statusCode || 500, message),
      statusCode
    )
  }

  private recordAccountSuccess(account: ProxyAccount, usage: KiroUsage): ProxyAccount {
    const updated = this.accountPool.recordSuccess(
      account.id,
      usage.inputTokens + usage.outputTokens,
      usage.credits || 0
    )
    if (updated) {
      this.events.onAccountUpdate?.(updated)
      return updated
    }
    return account
  }

  private isInvalidModelForAccountError(message: string): boolean {
    return /invalid_model_id|invalid model id|please select a different model/i.test(message)
  }

  /**
   * Retry streaming requests before the first client-visible chunk. Once a
   * chunk is emitted the stream is committed and cannot safely change account.
   */
  private async callStreamWithFailover(
    initialAccount: ProxyAccount,
    payload: KiroPayload,
    onChunk: (account: ProxyAccount, text: string, toolUse?: KiroToolUse, isThinking?: boolean, reasoningSignature?: string, redactedContent?: string) => void,
    onComplete: (account: ProxyAccount, usage: KiroUsage) => void,
    onError: (account: ProxyAccount, error: Error) => void,
    path: string,
    signal?: AbortSignal,
    apiKeyId?: string,
    modelId?: string
  ): Promise<void> {
    const configuredRetries = Math.max(0, this.config.maxRetries ?? 3)
    const maxAttempts = Math.min(100, Math.max(configuredRetries + 1, this.accountPool.size))
    const triedIds = new Set<string>([initialAccount.id])
    let currentAccount = initialAccount
    let streamCommitted = false
    let lastError = new Error('Unknown stream error')

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this.throwIfAborted(signal)
      const outcome = await this.runWithModelPacing(currentAccount, modelId, signal, () => new Promise<{ completed: boolean; error?: Error }>((resolve) => {
        callKiroApiStream(
          currentAccount,
          payload,
          (text, toolUse, isThinking, reasoningSignature, redactedContent) => {
            streamCommitted = true
            onChunk(currentAccount, text, toolUse, isThinking, reasoningSignature, redactedContent)
          },
          (usage) => {
            streamCommitted = true
            onComplete(currentAccount, usage)
            resolve({ completed: true })
          },
          (error) => resolve({ completed: false, error }),
          signal,
          this.config.preferredEndpoint
        ).catch((error) => resolve({ completed: false, error: error as Error }))
      }))

      if (outcome.completed) return
      if (this.isAbortError(outcome.error, signal)) throw outcome.error
      lastError = outcome.error || lastError

      if (streamCommitted) {
        this.recordAccountFailure(currentAccount, lastError)
        onError(currentAccount, lastError)
        return
      }

      const message = lastError.message || ''
      const invalidModelError = this.isInvalidModelForAccountError(message)
      const suspendInfo = this.detectSuspendedError(message)
      if (suspendInfo) {
        const newlyMarked = this.accountPool.markSuspended(currentAccount.id, suspendInfo.reason, suspendInfo.message)
        if (newlyMarked) {
          this.events.onAccountSuspended?.({
            accountId: currentAccount.id,
            email: currentAccount.email,
            reason: suspendInfo.reason,
            message: suspendInfo.message
          })
        }
      } else if (isBillingOrQuotaError(message) || isThrottleError(message) || /\b5\d\d\b/.test(message)) {
        this.recordAccountFailure(currentAccount, lastError)
      } else if (message.includes('401') || message.includes('403') || message.includes('Auth')) {
        const refreshed = await this.refreshToken(currentAccount, signal)
        if (refreshed) {
          currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
          continue
        }
      } else if (invalidModelError) {
        proxyLogger.info('ProxyServer', `Streaming model not available on ${currentAccount.email || currentAccount.id.slice(0, 8)}, switching account`)
      } else {
        this.recordAccountFailure(currentAccount, lastError)
      }

      const retryable = Boolean(suspendInfo)
        || isBillingOrQuotaError(message)
        || isThrottleError(message)
        || message.includes('401')
        || message.includes('403')
        || message.includes('Auth')
        || invalidModelError
        || /\b5\d\d\b/.test(message)
      if (!retryable) break

      const nextAccount = await this.getNextAccountForModel(triedIds, apiKeyId, modelId, signal)
      if (!nextAccount || triedIds.has(nextAccount.id)) {
        if (isThrottleError(message) && attempt < configuredRetries) {
          const cooledAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
          const cooldownWaitMs = cooledAccount.cooldownUntil && cooledAccount.cooldownUntil > Date.now()
            ? cooledAccount.cooldownUntil - Date.now()
            : (this.config.retryDelayMs || 1000) * (attempt + 1)
          const waitMs = Math.min(this.MAX_COMPATIBLE_COOLDOWN_WAIT_MS, Math.max(1000, cooldownWaitMs + 100))
          proxyLogger.info('ProxyServer', `No alternate streaming ${modelId || 'model'} account after throttle; waiting ${waitMs}ms before retrying ${cooledAccount.email || cooledAccount.id.slice(0, 8)}`)
          await this.waitForRetry(waitMs, signal)
          currentAccount = this.accountPool.getAccount(currentAccount.id) || currentAccount
          continue
        }
        break
      }
      console.log(`[ProxyServer] Streaming failover ${path}: ${currentAccount.email || currentAccount.id.slice(0, 8)} -> ${nextAccount.email || nextAccount.id.slice(0, 8)}`)
      currentAccount = nextAccount
      triedIds.add(nextAccount.id)
    }

    onError(currentAccount, lastError)
  }

  /**
   * 常数时间字符串比较（防时序攻击）
   * 长度不同时返回 false 但仍走一次 timingSafeEqual 防止旁路
   */
  private safeStringEq(a: string, b: string): boolean {
    // Buffer.from 处理 UTF-8 编码
    const ab = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ab.length !== bb.length) {
      // 仍执行一次比较保证常数时间（用 a 自身比，结果不影响）
      try { crypto.timingSafeEqual(ab, ab) } catch { /* ignore */ }
      return false
    }
    try {
      return crypto.timingSafeEqual(ab, bb)
    } catch {
      return false
    }
  }

  // 验证 API Key 并返回匹配的 Key（用于统计）
  // P0-3 使用 timingSafeEqual 防止时序攻击逐字猜 Key
  private validateApiKey(req: http.IncomingMessage): { valid: boolean; apiKey?: import('./types').ApiKey; reason?: string } {
    // 如果没有配置任何 API Key，则跳过验证
    const hasApiKeys = this.config.apiKeys && this.config.apiKeys.length > 0
    const hasLegacyKey = !!this.config.apiKey
    if (!hasApiKeys && !hasLegacyKey) return { valid: true }

    // 从 Authorization 头或 X-Api-Key 头获取 API Key
    const authHeader = req.headers['authorization'] || ''
    const apiKeyHeader = (req.headers['x-api-key'] as string) || ''

    let providedKey = ''
    // Bearer token 格式
    if (authHeader.startsWith('Bearer ')) {
      providedKey = authHeader.slice(7)
    }
    // 直接 API Key 格式
    if (!providedKey && apiKeyHeader) {
      providedKey = apiKeyHeader
    }

    if (!providedKey) return { valid: false }

    // 检查多 API Key（常数时间比较）
    if (hasApiKeys) {
      let matched: import('./types').ApiKey | undefined
      for (const k of this.config.apiKeys!) {
        if (!k.enabled || !k.key) continue
        if (this.safeStringEq(k.key, providedKey)) {
          matched = k
          // 不 break：继续遍历保持时间一致（小数量数组 OK）
        }
      }
      if (matched) {
        if (matched.creditsLimit && matched.usage.totalCredits >= matched.creditsLimit) {
          return { valid: false, reason: 'Credits limit exceeded' }
        }
        return { valid: true, apiKey: matched }
      }
    }

    // 兼容旧的单 API Key（常数时间比较）
    if (hasLegacyKey && this.safeStringEq(this.config.apiKey!, providedKey)) {
      return { valid: true }
    }

    return { valid: false }
  }

  /**
   * P0-4 IP 访问控制
   * - deniedIPs 优先：命中即拒绝
   * - allowedIPs 配置后：必须在列表内（白名单模式）
   * - 都未配置：允许
   * 支持单 IP 和 CIDR（IPv4 / IPv6 简化处理）
   */
  private isClientIPAllowed(clientIP: string): { allowed: boolean; reason?: string } {
    if (!clientIP) return { allowed: true }
    // 规范化（::ffff:1.2.3.4 → 1.2.3.4）
    const ip = clientIP.startsWith('::ffff:') ? clientIP.slice(7) : clientIP

    const matchEntry = (entry: string): boolean => {
      const e = entry.trim()
      if (!e) return false
      // CIDR
      if (e.includes('/')) {
        return this.ipInCidr(ip, e)
      }
      return e === ip
    }

    const denied = this.config.deniedIPs?.find(matchEntry)
    if (denied) return { allowed: false, reason: `IP ${ip} matches denied entry ${denied}` }

    const allowList = this.config.allowedIPs
    if (allowList && allowList.length > 0) {
      const allowed = allowList.some(matchEntry)
      if (!allowed) return { allowed: false, reason: `IP ${ip} not in allowed list` }
    }
    return { allowed: true }
  }

  /**
   * 简化 IPv4/IPv6 CIDR 匹配（不依赖外部库）
   * IPv4 CIDR：1.2.3.0/24；IPv6 CIDR：仅前缀逐 bit 比较
   */
  private ipInCidr(ip: string, cidr: string): boolean {
    const [range, bitsStr] = cidr.split('/')
    const bits = parseInt(bitsStr, 10)
    if (!Number.isFinite(bits)) return false

    const isV4 = ip.includes('.') && range.includes('.')
    if (isV4) {
      const ipNum = this.ipv4ToInt(ip)
      const rangeNum = this.ipv4ToInt(range)
      if (ipNum < 0 || rangeNum < 0) return false
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
      return (ipNum & mask) === (rangeNum & mask)
    }
    // IPv6 简化：转字节数组 + 前缀逐 bit 比较
    const ipBytes = this.ipv6ToBytes(ip)
    const rangeBytes = this.ipv6ToBytes(range)
    if (!ipBytes || !rangeBytes) return false
    let bitsLeft = bits
    for (let i = 0; i < 16 && bitsLeft > 0; i++) {
      if (bitsLeft >= 8) {
        if (ipBytes[i] !== rangeBytes[i]) return false
        bitsLeft -= 8
      } else {
        const mask = (0xff << (8 - bitsLeft)) & 0xff
        if ((ipBytes[i] & mask) !== (rangeBytes[i] & mask)) return false
        bitsLeft = 0
      }
    }
    return true
  }

  private ipv4ToInt(ip: string): number {
    const parts = ip.split('.').map(p => parseInt(p, 10))
    if (parts.length !== 4 || parts.some(p => !Number.isFinite(p) || p < 0 || p > 255)) return -1
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  }

  private ipv6ToBytes(ip: string): Uint8Array | null {
    try {
      // 简化处理：支持 :: 缩写
      const parts = ip.split('::')
      let head: string[] = []
      let tail: string[] = []
      if (parts.length === 1) {
        head = parts[0].split(':')
      } else if (parts.length === 2) {
        head = parts[0] ? parts[0].split(':') : []
        tail = parts[1] ? parts[1].split(':') : []
      } else {
        return null
      }
      const missing = 8 - head.length - tail.length
      if (missing < 0) return null
      const segments = [...head, ...new Array(missing).fill('0'), ...tail]
      const bytes = new Uint8Array(16)
      for (let i = 0; i < 8; i++) {
        const v = parseInt(segments[i] || '0', 16)
        if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null
        bytes[i * 2] = (v >> 8) & 0xff
        bytes[i * 2 + 1] = v & 0xff
      }
      return bytes
    } catch {
      return null
    }
  }

  /** 取客户端真实 IP（不信任 X-Forwarded-For，仅取 socket address） */
  private getClientIP(req: http.IncomingMessage): string {
    return req.socket.remoteAddress || ''
  }

  // 记录 API Key 用量
  recordApiKeyUsage(apiKeyId: string, credits: number, inputTokens: number, outputTokens: number, model?: string, path?: string): void {
    if (!this.config.apiKeys) return
    const apiKey = this.config.apiKeys.find(k => k.id === apiKeyId)
    if (!apiKey) return

    const today = new Date().toISOString().split('T')[0]
    const now = Date.now()
    
    // 更新总计
    apiKey.usage.totalRequests++
    apiKey.usage.totalCredits += credits
    apiKey.usage.totalInputTokens += inputTokens
    apiKey.usage.totalOutputTokens += outputTokens
    apiKey.lastUsedAt = now

    // 更新日统计
    if (!apiKey.usage.daily[today]) {
      apiKey.usage.daily[today] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
    }
    apiKey.usage.daily[today].requests++
    apiKey.usage.daily[today].credits += credits
    apiKey.usage.daily[today].inputTokens += inputTokens
    apiKey.usage.daily[today].outputTokens += outputTokens

    // 更新模型统计
    if (model) {
      if (!apiKey.usage.byModel) {
        apiKey.usage.byModel = {}
      }
      if (!apiKey.usage.byModel[model]) {
        apiKey.usage.byModel[model] = { requests: 0, credits: 0, inputTokens: 0, outputTokens: 0 }
      }
      apiKey.usage.byModel[model].requests++
      apiKey.usage.byModel[model].credits += credits
      apiKey.usage.byModel[model].inputTokens += inputTokens
      apiKey.usage.byModel[model].outputTokens += outputTokens
    }

    // 添加用量历史记录（保留最近 100 条）
    if (!apiKey.usageHistory) {
      apiKey.usageHistory = []
    }
    apiKey.usageHistory.unshift({
      timestamp: now,
      model: model || 'unknown',
      inputTokens,
      outputTokens,
      credits,
      path: path || 'unknown'
    })
    if (apiKey.usageHistory.length > 100) {
      apiKey.usageHistory = apiKey.usageHistory.slice(0, 100)
    }

    // 触发配置保存事件
    this.events.onConfigChanged?.(this.config)
  }

  // 应用模型映射
  private pickWeightedRoundRobinModel(rule: NonNullable<ProxyConfig['modelMappings']>[number], targets: string[], requestedModel: string, apiKeyId?: string): string {
    const weights = targets.map((_, index) => {
      const raw = rule.weights?.[index]
      return Number.isFinite(raw) && raw && raw > 0 ? Math.min(50, Math.floor(raw)) : 1
    })
    const expandedTargets: string[] = []
    targets.forEach((target, index) => {
      for (let i = 0; i < weights[index]; i++) expandedTargets.push(target)
    })

    if (expandedTargets.length === 0) return targets[0]

    const key = [
      rule.id,
      rule.name,
      requestedModel.toLowerCase(),
      apiKeyId || '*',
      targets.join('|'),
      weights.join(',')
    ].join('::')
    const index = this.modelLoadBalanceState.get(key) || 0
    const target = expandedTargets[index % expandedTargets.length]
    this.modelLoadBalanceState.set(key, (index + 1) % expandedTargets.length)
    return target
  }

  private applyModelMapping(requestedModel: string, apiKeyId?: string): string {
    const mappings = this.config.modelMappings
    if (!mappings || mappings.length === 0) return requestedModel

    // 按优先级排序（数字越小优先级越高）
    const sortedMappings = [...mappings].sort((a, b) => a.priority - b.priority)

    for (const rule of sortedMappings) {
      // 检查规则是否启用
      if (!rule.enabled) continue

      // 检查是否适用于当前 API Key
      if (rule.apiKeyIds && rule.apiKeyIds.length > 0 && apiKeyId) {
        if (!rule.apiKeyIds.includes(apiKeyId)) continue
      }

      // 检查源模型是否匹配（支持通配符 *）
      const sourcePattern = rule.sourceModel.replace(/\*/g, '.*')
      const regex = new RegExp(`^${sourcePattern}$`, 'i')
      if (!regex.test(requestedModel)) continue

      // 匹配成功，根据类型选择目标模型
      const validTargets = rule.targetModels.filter(t => t.trim())
      if (validTargets.length === 0) continue

      let targetModel: string

      if (rule.type === 'loadbalance' && validTargets.length > 1) {
        // 负载均衡：根据权重轮询，低流量下也能均匀分配
        targetModel = this.pickWeightedRoundRobinModel(rule, validTargets, requestedModel, apiKeyId)
      } else {
        // replace 或 alias：直接使用第一个目标
        targetModel = validTargets[0]
      }

      proxyLogger.info('ProxyServer', `Model mapping applied: ${requestedModel} -> ${targetModel} (rule: ${rule.name}, type: ${rule.type})`)
      return targetModel
    }

    return requestedModel
  }

  // 处理请求
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = req.url || '/'
    const method = req.method || 'GET'
    const clientIP = this.getClientIP(req)
    const controller = new AbortController()
    const abortRequest = () => {
      if (!this.isStopping && res.writableEnded) return
      if (!controller.signal.aborted) {
        controller.abort(new Error(this.isStopping ? 'Proxy server stopped' : 'Client disconnected'))
      }
    }
    this.activeRequests.add(controller)
    req.on('aborted', abortRequest)
    res.on('close', abortRequest)

    // CORS 预检
    if (method === 'OPTIONS') {
      this.setCorsHeaders(res)
      res.writeHead(204)
      res.end()
      req.off('aborted', abortRequest)
      res.off('close', abortRequest)
      this.activeRequests.delete(controller)
      return
    }

    try {
      this.setCorsHeaders(res)

      // P0-4 IP 访问控制（健康检查也走，防止扫描器）
      const ipCheck = this.isClientIPAllowed(clientIP)
      if (!ipCheck.allowed) {
        proxyLogger.warn('ProxyServer', `Blocked request from ${clientIP}: ${ipCheck.reason}`)
        this.appendAuditLog('ip_blocked', { ip: clientIP, path, reason: ipCheck.reason })
        this.sendError(res, 403, 'Forbidden')
        return
      }

      // API Key 验证（健康检查端点除外）
      if (path !== '/health' && path !== '/') {
        const authResult = this.validateApiKey(req)
        if (!authResult.valid) {
          const errorMsg = authResult.reason || 'Invalid or missing API key'
          const statusCode = authResult.reason === 'Credits limit exceeded' ? 429 : 401
          // 401 不返回 reason 详情（防止指纹爬取）
          this.sendError(res, statusCode, statusCode === 401 ? 'Unauthorized' : errorMsg,
            this.isAnthropicPath(path) ? 'anthropic' : 'openai')
          return
        }
        // 将匹配的 API Key 存储到请求对象中，用于后续统计
        ;(req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey = authResult.apiKey

        // P1-7 按 API Key（或匿名时按 IP）请求限流
        const rateLimitId = authResult.apiKey?.id || `ip:${clientIP || 'unknown'}`
        const rl = this.checkRateLimit(rateLimitId)
        if (!rl.allowed) {
          res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)))
          res.setHeader('X-RateLimit-Limit', String(this.config.rateLimitPerKeyPerMinute || 0))
          res.setHeader('X-RateLimit-Remaining', '0')
          this.sendError(res, 429, 'Rate limit exceeded',
            this.isAnthropicPath(path) ? 'anthropic' : 'openai')
          return
        }
      }

      // 记录请求
      if (this.config.logRequests) {
        proxyLogger.info('ProxyServer', `${method} ${path}`)
      }

      // 路由（移除查询参数）
      const pathWithoutQuery = path.split('?')[0]
      
      if (pathWithoutQuery === '/v1/models' || pathWithoutQuery === '/models') {
        await this.handleModels(res, controller.signal)
      } else if (pathWithoutQuery === '/v1/chat/completions' || pathWithoutQuery === '/chat/completions') {
        await this.handleOpenAIChat(req, res, controller.signal)
      } else if (pathWithoutQuery === '/v1/responses' || pathWithoutQuery === '/responses') {
        await this.handleOpenAIResponses(req, res, controller.signal)
      } else if (pathWithoutQuery === '/v1/messages' || pathWithoutQuery === '/messages' || pathWithoutQuery === '/anthropic/v1/messages') {
        await this.handleClaudeMessages(req, res, controller.signal)
      } else if (pathWithoutQuery === '/v1/messages/count_tokens' || pathWithoutQuery === '/messages/count_tokens') {
        // Claude Code token 计数端点 - 返回模拟响应
        await this.handleCountTokens(req, res, controller.signal)
      } else if (pathWithoutQuery === '/api/event_logging/batch') {
        // Claude Code 遥测端点 - 直接返回 200 OK
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      } else if (pathWithoutQuery.startsWith('/v1beta/models/')) {
        // Gemini v1beta 兼容路由
        await this.handleGeminiRequest(req, res, pathWithoutQuery, controller.signal)
      } else if (pathWithoutQuery === '/v1beta/models') {
        // Gemini 模型列表
        await this.handleGeminiModels(res, controller.signal)
      } else if (pathWithoutQuery === '/health' || pathWithoutQuery === '/') {
        this.handleHealth(res)
      } else if (pathWithoutQuery === '/metrics' && this.config.enableMetrics) {
        // P2-16 Prometheus metrics
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' })
        res.end(this.renderPrometheusMetrics())
      } else if (pathWithoutQuery.startsWith('/admin/')) {
        // 管理 API 端点
        await this.handleAdminApi(req, res, pathWithoutQuery, controller.signal)
      } else {
        // 记录未知路径以便调试
        console.log(`[ProxyServer] Unknown path: ${path} (method: ${method})`)
        this.sendError(res, 404, `Not Found: ${pathWithoutQuery}`)
      }
    } catch (error) {
      if (this.isAbortError(error, controller.signal)) {
        proxyLogger.info('ProxyServer', `Request aborted: ${method} ${path}`)
        return
      }
      // P0-1 body 超限 → 413
      if (error instanceof BodyTooLargeError) {
        proxyLogger.warn('ProxyServer', `Body too large from ${clientIP}: ${error.received}/${error.limit} bytes (${path})`)
        this.sendError(res, 413, `Request body too large (max ${error.limit} bytes)`,
          this.isAnthropicPath(path) ? 'anthropic' : 'openai')
        return
      }
      // P0-5 错误响应 sanitize：500 类不吐内部 message
      console.error('[ProxyServer] Request error:', error)
      this.sendError(res, 500, 'Internal server error', this.isAnthropicPath(path) ? 'anthropic' : 'openai')
      this.events.onError?.(error as Error)
    } finally {
      req.off('aborted', abortRequest)
      res.off('close', abortRequest)
      this.activeRequests.delete(controller)
    }
  }

  // 管理 API 端点
  private async handleAdminApi(req: http.IncomingMessage, res: http.ServerResponse, path: string, signal?: AbortSignal): Promise<void> {
    const method = req.method || 'GET'

    // 管理 API 需要 API Key 验证
    const authResult = this.validateApiKey(req)
    if (!authResult.valid) {
      this.sendError(res, 401, 'Admin API requires authentication')
      return
    }

    if (path === '/admin/stats' && method === 'GET') {
      // 获取详细统计
      this.handleAdminStats(res)
    } else if (path === '/admin/accounts' && method === 'GET') {
      // 获取账号列表
      this.handleAdminAccounts(res)
    } else if (path === '/admin/config' && method === 'GET') {
      // 获取配置
      this.handleAdminConfig(res)
    } else if (path === '/admin/config' && method === 'POST') {
      // 更新配置（P1-9 schema 白名单校验，防止任意字段注入）
      const body = await this.readBody(req, signal)
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(body) } catch {
        this.sendError(res, 400, 'Invalid JSON body')
        return
      }
      const safeUpdate = this.filterAdminConfigUpdate(parsed)
      this.updateConfig(safeUpdate)
      this.appendAuditLog('config_updated', { fields: Object.keys(safeUpdate) })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, applied: Object.keys(safeUpdate), config: this.handleAdminConfigPayload() }))
    } else if (path === '/admin/audit' && method === 'GET') {
      // P2-17 审计日志
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ entries: this.auditLog.slice(-100) }))
    } else if (path === '/admin/logs' && method === 'GET') {
      // 获取最近日志
      this.handleAdminLogs(res)
    } else if (path === '/admin/cache/clear' && method === 'POST') {
      // 清除内存缓存（conversationId 映射、模型缓存、prompt cache）
      const { clearAllCaches } = require('./kiroApi')
      const cleared = clearAllCaches()
      const promptCacheCleared = promptCacheTracker.clear()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, cleared: { ...cleared, promptCache: promptCacheCleared } }))
    } else {
      this.sendError(res, 404, 'Admin endpoint not found')
    }
  }

  // 管理 API - 详细统计
  private handleAdminStats(res: http.ServerResponse): void {
    const stats = this.getStats()
    const accountStats: Record<string, unknown> = {}
    stats.accountStats.forEach((v, k) => { accountStats[k] = v })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      totalRequests: stats.totalRequests,
      successRequests: stats.successRequests,
      failedRequests: stats.failedRequests,
      totalTokens: stats.totalTokens,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      uptime: Date.now() - stats.startTime,
      startTime: stats.startTime,
      accountStats,
      recentRequests: stats.recentRequests.slice(-50)
    }))
  }

  // 管理 API - 账号列表
  private handleAdminAccounts(res: http.ServerResponse): void {
    const accounts = this.accountPool.getAllAccounts().map(acc => ({
      id: acc.id,
      email: acc.email,
      isAvailable: acc.isAvailable !== false,
      lastUsed: acc.lastUsed,
      requestCount: acc.requestCount || 0,
      errorCount: acc.errorCount || 0,
      expiresAt: acc.expiresAt,
      authMethod: acc.authMethod
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      total: accounts.length,
      available: accounts.filter(a => a.isAvailable).length,
      accounts
    }))
  }

  /**
   * P1-12 构造脱敏后的配置（apiKeys[].key 全部脱敏，tls 私钥不返回）
   * 暴露给 /admin/config GET
   */
  private handleAdminConfigPayload(): Record<string, unknown> {
    const config = this.getConfig()
    const maskKey = (k: string | undefined): string | undefined => {
      if (!k) return undefined
      if (k.length <= 8) return '***'
      return `${k.slice(0, 4)}***${k.slice(-4)}`
    }
    return {
      ...config,
      apiKey: maskKey(config.apiKey),
      apiKeys: config.apiKeys?.map(k => ({ ...k, key: maskKey(k.key) || '***' })),
      tls: config.tls ? { enabled: config.tls.enabled, hasCert: !!(config.tls.cert || config.tls.certPath), hasKey: !!(config.tls.key || config.tls.keyPath) } : undefined
    }
  }

  // 管理 API - 配置
  private handleAdminConfig(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(this.handleAdminConfigPayload()))
  }

  /**
   * P1-9 admin/config POST 字段白名单过滤
   * 仅允许"可远程改"的字段；apiKeys/apiKey 等敏感字段必须通过本地 IPC 改
   */
  private filterAdminConfigUpdate(input: Record<string, unknown>): Partial<ProxyConfig> {
    const allowed: Array<keyof ProxyConfig> = [
      'enabled', 'enableMultiAccount', 'logRequests', 'logStreamEvents',
      'maxConcurrent', 'maxRetries', 'retryDelayMs', 'preferredEndpoint',
      'tokenRefreshBeforeExpiry', 'autoStart', 'clientDrivenToolExecution',
      'disableTools', 'payloadSizeLimitKB', 'enableTokenBufferReserve',
      'tokenBufferReserve', 'autoSwitchOnQuotaExhausted', 'accountSelectionStrategy',
      'multiAccountSelectionMode', 'multiAccountGroupIds', 'modelMappings',
      'maxRequestBodyBytes', 'allowedIPs', 'deniedIPs',
      'rateLimitPerKeyPerMinute', 'sessionAffinityEnabled',
      'keepAliveTimeoutMs', 'headersTimeoutMs', 'recentRequestsLimit',
      'enableMetrics', 'apiKeyGroupBindings', 'enableAuditLog', 'strictTierRouting'
      // 故意排除：port / host / apiKey / apiKeys / tls / fallbackPort / allowExternalWithoutApiKey
      // 这些字段会改变监听行为或安全策略，必须本地 IPC 改
    ]
    const out: Partial<ProxyConfig> = {}
    for (const key of allowed) {
      if (key in input) {
        (out as Record<string, unknown>)[key] = input[key as string]
      }
    }
    return out
  }

  // 管理 API - 日志
  private handleAdminLogs(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      recentRequests: this.stats.recentRequests.slice(-100)
    }))
  }

  // 设置 CORS 头
  private setCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, anthropic-version, anthropic-beta, x-api-key, x-stainless-os, x-stainless-lang, x-stainless-package-version, x-stainless-runtime, x-stainless-runtime-version, x-stainless-arch')
    res.setHeader('Access-Control-Expose-Headers', 'x-request-id, x-ratelimit-limit-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-requests, x-ratelimit-remaining-tokens, x-ratelimit-reset-requests, x-ratelimit-reset-tokens')
  }

  private isAnthropicPath(path: string): boolean {
    const pathWithoutQuery = path.split('?')[0]
    return pathWithoutQuery === '/v1/messages'
      || pathWithoutQuery === '/messages'
      || pathWithoutQuery === '/anthropic/v1/messages'
      || pathWithoutQuery === '/v1/messages/count_tokens'
      || pathWithoutQuery === '/messages/count_tokens'
  }

  private getAnthropicErrorType(status: number): string {
    if (status === 400) return 'invalid_request_error'
    if (status === 401) return 'authentication_error'
    if (status === 403) return 'permission_error'
    if (status === 404) return 'not_found_error'
    if (status === 429) return 'rate_limit_error'
    return 'api_error'
  }

  private buildClaudeUsage(
    usage: { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number },
    simulatedCache?: { cacheCreationInputTokens: number; cacheReadInputTokens: number }
  ): { input_tokens?: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } {
    // 优先使用 Kiro 后端返回的真实 cache tokens，否则用模拟器的值
    const cacheWrite = usage.cacheWriteTokens || simulatedCache?.cacheCreationInputTokens || 0
    const cacheRead = usage.cacheReadTokens || simulatedCache?.cacheReadInputTokens || 0
    // Kiro 的 inputTokens 是全量（含缓存），Anthropic API 规范中 input_tokens 不含缓存部分
    // 需要扣除 cache tokens 避免客户端双重计费
    const adjustedInput = Math.max(0, usage.inputTokens - cacheWrite - cacheRead)
    return {
      input_tokens: adjustedInput,
      output_tokens: usage.outputTokens,
      ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
      ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {})
    }
  }

  private estimateTokenCount(value: unknown): number {
    if (value === null || value === undefined) return 0
    if (typeof value === 'string') return Math.ceil(value.length / 4)
    if (typeof value === 'number' || typeof value === 'boolean') return 1
    if (Array.isArray(value)) {
      return value.reduce<number>((total, item) => total + this.estimateTokenCount(item), 0)
    }
    if (typeof value !== 'object') return 0
    const record = value as Record<string, unknown>
    if (record.type === 'text' || record.type === 'input_text' || record.type === 'output_text') return this.estimateTokenCount(record.text) + 4
    if (record.type === 'thinking') return this.estimateTokenCount(record.thinking) + this.estimateTokenCount(record.signature) + 4
    if (record.type === 'redacted_thinking') return 8
    if (record.type === 'image' || record.type === 'input_image') return 170
    if (record.type === 'document' || record.type === 'input_file') return this.estimateTokenCount(record.title) + this.estimateTokenCount(record.name) + this.estimateTokenCount(record.filename) + this.estimateTokenCount(record.source) + this.estimateTokenCount(record.file_data) + 120
    if (record.type === 'tool_use') return this.estimateTokenCount(record.name) + this.estimateTokenCount(record.input) + 12
    if (record.type === 'tool_result') return this.estimateTokenCount(record.content) + 8
    if (typeof record.role === 'string' && 'content' in record) return this.estimateTokenCount(record.content) + 4
    if (typeof record.name === 'string' && 'input_schema' in record) return this.estimateTokenCount(record.name) + this.estimateTokenCount(record.description) + this.estimateTokenCount(record.input_schema) + 32
    return Object.entries(record).reduce<number>((total, [key, item]) => key === 'cache_control' ? total : total + this.estimateTokenCount(item), 0)
  }

  // 健康检查
  private handleHealth(res: http.ServerResponse): void {
    const stats = this.getStats()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      accounts: this.accountPool.size,
      availableAccounts: this.accountPool.availableCount,
      stats: {
        totalRequests: stats.totalRequests,
        successRequests: stats.successRequests,
        failedRequests: stats.failedRequests,
        totalTokens: stats.totalTokens,
        uptime: Date.now() - stats.startTime
      }
    }))
  }

  // Claude Code token 计数（模拟响应）
  private async handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    try {
      this.throwIfAborted(signal)
      const body = await this.readBody(req, signal)
      this.throwIfAborted(signal)
      const request = JSON.parse(body) as Partial<ClaudeRequest>
      if (!Array.isArray(request.messages)) {
        throw new Error('count_tokens requires messages')
      }
      const estimatedTokens = Math.max(1, this.estimateTokenCount(request.system) + this.estimateTokenCount(request.messages) + this.estimateTokenCount(request.tools))
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: estimatedTokens }))
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.sendError(res, 400, error instanceof Error ? error.message : 'Invalid request body', 'anthropic')
    }
  }

  // Gemini v1beta 模型列表
  private async handleGeminiModels(res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const result = await this.getAvailableModels(signal)
    const geminiModels = result.models.map(m => ({
      name: `models/${m.id}`,
      version: '001',
      displayName: m.name || m.id,
      description: m.description || '',
      inputTokenLimit: m.maxInputTokens || 200000,
      outputTokenLimit: m.maxOutputTokens || 64000,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent']
    }))
    this.throwIfResponseClosed(res, signal)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ models: geminiModels }))
  }

  // Gemini v1beta generateContent / streamGenerateContent
  private async handleGeminiRequest(req: http.IncomingMessage, res: http.ServerResponse, path: string, signal?: AbortSignal): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const geminiReq = JSON.parse(body)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey

    // 解析路径: /v1beta/models/{model}:{method}
    const match = path.match(/\/v1beta\/models\/([^:]+):(\w+)/)
    if (!match) {
      this.sendError(res, 400, 'Invalid Gemini endpoint path')
      return
    }
    const [, modelId, method] = match
    const isStream = method === 'streamGenerateContent'

    // 将 Gemini 请求转为 OpenAI 格式
    const messages: OpenAIMessage[] = []
    if (geminiReq.systemInstruction?.parts) {
      const sysText = geminiReq.systemInstruction.parts.map((p: { text?: string }) => p.text || '').join('\n')
      if (sysText) messages.push({ role: 'system', content: sysText })
    }
    for (const content of geminiReq.contents || []) {
      const role = content.role === 'model' ? 'assistant' : 'user'
      const text = (content.parts || []).map((p: { text?: string }) => p.text || '').join('')
      if (text) messages.push({ role: role as 'user' | 'assistant', content: text })
    }
    if (messages.length === 0) {
      messages.push({ role: 'user', content: 'Hello' })
    }

    const openaiRequest: OpenAIChatRequest = {
      model: this.applyModelMapping(modelId, matchedApiKey?.id),
      messages,
      stream: isStream,
      temperature: geminiReq.generationConfig?.temperature,
      top_p: geminiReq.generationConfig?.topP,
      max_tokens: geminiReq.generationConfig?.maxOutputTokens
    }

    // 复用 OpenAI 流程
    const startTime = Date.now()
    this.recordNewRequest()
    this.throwIfAborted(signal)
    const account = await this.getAvailableAccount(signal, undefined, matchedApiKey?.id, modelId)
    this.throwIfAborted(signal)
    if (!account) {
      this.sendError(res, 503, 'No available accounts')
      return
    }

    try {
      const toolNameRegistry = new ToolNameRegistry()
      const kiroPayload = openaiToKiro(openaiRequest, account.profileArn, toolNameRegistry)

      if (isStream) {
        let streamStarted = false
        const ensureStreamStarted = (): void => {
          if (streamStarted) return
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
          streamStarted = true
        }
        return new Promise<void>((resolve) => {
          this.callStreamWithFailover(
            account,
            kiroPayload,
            (_usedAccount, text) => {
              if (signal?.aborted || this.isResponseClosed(res)) return
              if (text) {
                ensureStreamStarted()
                const chunk = { candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: null }] }
                res.write(`data: ${JSON.stringify(chunk)}\n\n`)
              }
            },
            (usedAccount, usage) => {
              if (signal?.aborted || this.isResponseClosed(res)) {
                resolve()
                return
              }
              ensureStreamStarted()
              const finalChunk = { candidates: [{ content: { parts: [{ text: '' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: usage.inputTokens, candidatesTokenCount: usage.outputTokens, totalTokenCount: usage.inputTokens + usage.outputTokens } }
              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
              res.end()
              this.recordRequestSuccess()
              this.stats.totalTokens += usage.inputTokens + usage.outputTokens
              this.stats.inputTokens += usage.inputTokens
              this.stats.outputTokens += usage.outputTokens
              this.stats.totalCredits += usage.credits || 0
              this.recordAccountSuccess(usedAccount, usage)
              resolve()
            },
            (_usedAccount, error) => {
              if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
                resolve()
                return
              }
              ensureStreamStarted()
              res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
              res.end()
              this.recordRequestFailed()
              resolve()
            },
            '/v1beta',
            signal,
            matchedApiKey?.id,
            modelId
          ).catch(error => {
            if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
              res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
              res.end()
              this.recordRequestFailed()
            }
            resolve()
          })
        })
      } else {
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => callKiroApi(acc, openaiToKiro(openaiRequest, acc.profileArn, toolNameRegistry), signal),
          '/v1beta',
          signal,
          matchedApiKey?.id,
          modelId
        )
        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.stats.totalCredits += result.usage.credits || 0
        this.recordAccountSuccess(usedAccount, result.usage)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          candidates: [{ content: { parts: [{ text: result.content }], role: 'model' }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: result.usage.inputTokens, candidatesTokenCount: result.usage.outputTokens, totalTokenCount: result.usage.inputTokens + result.usage.outputTokens }
        }))
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1beta', modelId, startTime, signal)
    }
  }

  // 模型列表缓存
  private modelCache: { models: KiroModel[]; timestamp: number } | null = null
  private readonly MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 分钟缓存

  // 模型列表
  private async handleModels(res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const now = Date.now()
    
    // Kiro 官方模型（与 UI 保持一致）
    const kiroOfficialModels = [
      ...KIRO_PROXY_MODEL_PRESETS.map(model => buildKiroPresetClientModel(model, now)),
      buildClientModel({ id: 'auto', created: now, ownedBy: 'kiro-api', description: 'Auto select best model' })
    ]

    // 隐藏模型（未在官方 ListAvailableModels 中返回，但后端可能支持）
    const hiddenModels = [
      buildClientModel({ id: 'claude-3.7-sonnet', created: now, ownedBy: 'kiro-api', description: 'Claude 3.7 Sonnet (hidden)', modelName: 'Claude 3.7 Sonnet', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
      buildClientModel({ id: 'simple-task', created: now, ownedBy: 'kiro-api', description: 'Kiro fast model for intent classification and lightweight tasks (routes to Haiku)', modelName: 'Simple Task', supportedInputTypes: ['TEXT'], maxInputTokens: 200000, maxOutputTokens: 4096 }),
      buildClientModel({ id: 'CLAUDE_SONNET_4_20250514_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude Sonnet 4 (CodeWhisperer internal ID)', modelName: 'Claude Sonnet 4 (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
      buildClientModel({ id: 'CLAUDE_HAIKU_4_5_20251001_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude Haiku 4.5 (CodeWhisperer internal ID)', modelName: 'Claude Haiku 4.5 (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }),
      buildClientModel({ id: 'CLAUDE_3_7_SONNET_20250219_V1_0', created: now, ownedBy: 'kiro-api', description: 'Claude 3.7 Sonnet (CodeWhisperer internal ID)', modelName: 'Claude 3.7 Sonnet (CW)', supportedInputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 })
    ]

    // 预设模型（GPT 兼容别名）
    const presetModels = [
      buildClientModel({ id: 'gpt-4o', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro' }),
      buildClientModel({ id: 'gpt-4', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro' }),
      buildClientModel({ id: 'gpt-4-turbo', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro' }),
      buildClientModel({ id: 'gpt-3.5-turbo', created: now, ownedBy: 'kiro-proxy', description: 'GPT-compatible alias for Kiro' })
    ]

    // 尝试从 Kiro API 获取动态模型
    let kiroModels: KiroModel[] = []
    
    // 检查缓存
    if (this.modelCache && (now - this.modelCache.timestamp) < this.MODEL_CACHE_TTL) {
      kiroModels = this.modelCache.models
    } else {
      // 获取一个可用账号来请求模型列表
      const account = this.accountPool.getNextAccount()
      if (account) {
        try {
          kiroModels = await fetchKiroModels(account, signal)
          if (kiroModels.length > 0) {
            this.modelCache = { models: kiroModels, timestamp: now }
            // 同步到 kiroApi 的 ctx cache, 供 token 裁剪逻辑使用
            for (const m of kiroModels) {
              if (m.tokenLimits?.maxInputTokens) {
                setModelContextWindow(m.modelId, m.tokenLimits.maxInputTokens)
              }
            }
            proxyLogger.info('ProxyServer', `Fetched ${kiroModels.length} models from Kiro API`)
          }
        } catch (error) {
          if (this.isAbortError(error, signal)) throw error
          console.error('[ProxyServer] Failed to fetch Kiro models:', error)
        }
      }
    }

    // 转换 Kiro 模型为 OpenAI 格式（保持原始 modelId）
    const dynamicModels = kiroModels.map(m => buildClientModel({
      id: m.modelId,
      created: now,
      ownedBy: 'kiro-api',
      description: m.description,
      modelName: m.modelName,
      supportedInputTypes: m.supportedInputTypes,
      maxInputTokens: m.tokenLimits?.maxInputTokens,
      maxOutputTokens: m.tokenLimits?.maxOutputTokens,
      rateMultiplier: m.rateMultiplier,
      rateUnit: m.rateUnit,
      promptCaching: m.promptCaching,
      additionalModelRequestFieldsSchema: m.additionalModelRequestFieldsSchema,
      modelProvider: m.modelProvider
    }))

    // 合并模型列表，去重
    const modelIds = new Set<string>()
    const allModels: ClientModel[] = []
    
    // 1. 优先添加动态模型（从 API 获取的，包含真实 token limit / input types）
    for (const m of dynamicModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }
    
    // 2. 添加隐藏模型（未在官方 ListAvailableModels 中返回，但后端可能支持）
    for (const m of hiddenModels) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }
    
    // 3. 动态模型缺失时才添加静态兜底
    for (const m of [...kiroOfficialModels, ...presetModels]) {
      if (!modelIds.has(m.id)) {
        modelIds.add(m.id)
        allModels.push(m)
      }
    }

    this.throwIfResponseClosed(res, signal)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: allModels }))
  }

  // 处理 OpenAI Chat Completions 请求
  private async handleOpenAIChat(req: http.IncomingMessage, res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const request: OpenAIChatRequest = JSON.parse(body)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey

    // 提取 session hint（用于稳定 conversationId），拼入 API Key hash 隔离不同用户
    const rawHintChat = ProxyServer.extractSessionHint(req, request)
    if (!request.conversation_id && rawHintChat) {
      const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
      request.conversation_id = `${keyPrefix}:${rawHintChat}`
    }
    const affinityHintChat = request.conversation_id

    // 应用模型映射
    request.model = this.applyModelMapping(request.model, matchedApiKey?.id)

    const startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST' })

    let processedRequest: OpenAIChatRequest
    try {
      processedRequest = await this.resolveOpenAIHttpImages(this.prepareOpenAIRequest(request), signal)
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message)
      this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 400, error: message })
      this.recordRequest({ path: '/v1/chat/completions', model: request.model, responseTime: Date.now() - startTime, success: false, error: message })
      return
    }

    // 获取账号（包含 Token 刷新检查 + 会话粘性 + API Key 账号白名单）
    this.throwIfAborted(signal)
    const account = await this.getAvailableAccount(signal, affinityHintChat, matchedApiKey?.id, request.model)
    this.throwIfAborted(signal)
    if (!account) {
      this.recordRequestFailed()
      const diag = await this.classifyNoAccountReason(request.model, matchedApiKey?.id, signal)
      this.sendError(res, 503, diag.message)
      this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 503, error: diag.reason })
      this.recordRequest({ path: '/v1/chat/completions', model: request.model, success: false, error: diag.reason })
      return
    }

    this.events.onRequest?.({ path: '/v1/chat/completions', method: 'POST', accountId: account.id })

    try {
      const toolNameRegistry = new ToolNameRegistry()

      // 转换为 Kiro 格式
      const kiroPayload = openaiToKiro(processedRequest, account.profileArn, toolNameRegistry)

      // 记录请求详情到日志
      if (this.config.logRequests) {
        const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage
        const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0
        const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0
        const historyLength = kiroPayload.conversationState.history?.length || 0
        const hasImages = (userInput?.images?.length || 0) > 0
        
        proxyLogger.info('ProxyServer', `OpenAI API: ${request.model}`, {
          model: request.model,
          stream: request.stream,
          contentLength,
          toolsCount,
          historyLength,
          hasImages,
          accountId: account.id
        })
      }

      if (request.stream) {
        // 流式响应（流式不使用重试机制，错误由流处理）
        await this.handleOpenAIStream(res, account, kiroPayload, request.model, startTime, 0, undefined, false, matchedApiKey, toolNameRegistry, signal)
      } else {
        // 非流式响应（带重试机制）
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => {
            const retryPayload = openaiToKiro(processedRequest, acc.profileArn, toolNameRegistry)
            return callKiroApi(acc, retryPayload, signal)
          },
          '/v1/chat/completions',
          signal,
          matchedApiKey?.id,
          request.model
        )
        const response = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, request.model, toolNameRegistry, result.reasoningContent)

        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.recordAccountSuccess(usedAccount, result.usage)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        const respTime = Date.now() - startTime
        this.events.onResponse?.({ path: '/v1/chat/completions', model: request.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
        this.recordRequest({ path: '/v1/chat/completions', model: request.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
        // 记录 API Key 用量
        if (matchedApiKey) {
          this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, request.model, '/v1/chat/completions')
        }
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1/chat/completions', request.model, startTime, signal)
    }
  }

  private async handleOpenAIResponses(req: http.IncomingMessage, res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey
    const startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path: '/v1/responses', method: 'POST' })

    let responseRequest: OpenAIResponsesRequest
    let chatRequest: OpenAIChatRequest
    let processedRequest: OpenAIChatRequest
    let affinityHintResp: string | undefined
    try {
      responseRequest = JSON.parse(body)
      chatRequest = responsesToOpenAIChat(responseRequest)
      // session hint：用于会话粘性
      const rawHintResp = ProxyServer.extractSessionHint(req, responseRequest)
      if (rawHintResp) {
        const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
        affinityHintResp = `${keyPrefix}:${rawHintResp}`
      }
      chatRequest.model = this.applyModelMapping(chatRequest.model, matchedApiKey?.id)
      processedRequest = await this.resolveOpenAIHttpImages(this.prepareOpenAIRequest(chatRequest), signal)
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message)
      this.events.onResponse?.({ path: '/v1/responses', status: 400, error: message })
      this.recordRequest({ path: '/v1/responses', responseTime: Date.now() - startTime, success: false, error: message })
      return
    }

    this.throwIfAborted(signal)
    const account = await this.getAvailableAccount(signal, affinityHintResp, matchedApiKey?.id, chatRequest.model)
    this.throwIfAborted(signal)
    if (!account) {
      this.recordRequestFailed()
      const diag = await this.classifyNoAccountReason(chatRequest.model, matchedApiKey?.id, signal)
      this.sendError(res, 503, diag.message)
      this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 503, error: diag.reason })
      this.recordRequest({ path: '/v1/responses', model: chatRequest.model, success: false, error: diag.reason })
      return
    }

    this.events.onRequest?.({ path: '/v1/responses', method: 'POST', accountId: account.id })

    try {
      const toolNameRegistry = new ToolNameRegistry()
      if (processedRequest.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
        const responseId = `resp_${uuidv4()}`
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responseId, object: 'response', created_at: Math.floor(Date.now() / 1000), model: chatRequest.model, output: [] } })}\n\n`)
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => {
            const retryPayload = openaiToKiro(processedRequest, acc.profileArn, toolNameRegistry)
            return callKiroApi(acc, retryPayload, signal)
          },
          '/v1/responses',
          signal,
          matchedApiKey?.id,
          chatRequest.model
        )
        const chatResponse = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, chatRequest.model, toolNameRegistry, result.reasoningContent)
        this.throwIfResponseClosed(res, signal)
        const response = openAIChatToResponsesResponse(chatResponse, responseRequest.previous_response_id)
        const streamedResponse = { ...response, id: responseId }
        streamedResponse.output.forEach((item, outputIndex) => {
          this.throwIfResponseClosed(res, signal)
          res.write(`event: response.output_item.added\ndata: ${JSON.stringify({ type: 'response.output_item.added', output_index: outputIndex, item })}\n\n`)
          if (item.type === 'message') {
            item.content.forEach((part, contentIndex) => {
              this.throwIfResponseClosed(res, signal)
              res.write(`event: response.content_part.added\ndata: ${JSON.stringify({ type: 'response.content_part.added', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part: { type: part.type, text: '' } })}\n\n`)
              if (part.text) {
                res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: item.id, output_index: outputIndex, content_index: contentIndex, delta: part.text })}\n\n`)
              }
              res.write(`event: response.output_text.done\ndata: ${JSON.stringify({ type: 'response.output_text.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, text: part.text })}\n\n`)
              res.write(`event: response.content_part.done\ndata: ${JSON.stringify({ type: 'response.content_part.done', item_id: item.id, output_index: outputIndex, content_index: contentIndex, part })}\n\n`)
            })
          } else {
            if (item.arguments) {
              res.write(`event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: outputIndex, delta: item.arguments })}\n\n`)
            }
            res.write(`event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: outputIndex, arguments: item.arguments })}\n\n`)
          }
          this.throwIfResponseClosed(res, signal)
          res.write(`event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', output_index: outputIndex, item })}\n\n`)
        })
        this.throwIfResponseClosed(res, signal)
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: streamedResponse })}\n\n`)
        res.end()
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.recordAccountSuccess(usedAccount, result.usage)
        const respTime = Date.now() - startTime
        this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
        this.recordRequest({ path: '/v1/responses', model: chatRequest.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
        if (matchedApiKey) {
          this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, chatRequest.model, '/v1/responses')
        }
        return
      }

      const { result, account: usedAccount } = await this.callWithRetry(
        account,
        async (acc) => {
          const retryPayload = openaiToKiro(processedRequest, acc.profileArn, toolNameRegistry)
          return callKiroApi(acc, retryPayload, signal)
        },
        '/v1/responses',
        signal,
        matchedApiKey?.id,
        chatRequest.model
      )
      const chatResponse = kiroToOpenaiResponse(result.content, result.toolUses, result.usage, chatRequest.model, toolNameRegistry, result.reasoningContent)
      this.throwIfResponseClosed(res, signal)
      const response = openAIChatToResponsesResponse(chatResponse, responseRequest.previous_response_id)

      this.recordRequestSuccess()
      this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
      this.stats.inputTokens += result.usage.inputTokens
      this.stats.outputTokens += result.usage.outputTokens
      this.recordAccountSuccess(usedAccount, result.usage)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
      const respTime = Date.now() - startTime
      this.events.onResponse?.({ path: '/v1/responses', model: chatRequest.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
      this.recordRequest({ path: '/v1/responses', model: chatRequest.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
      if (matchedApiKey) {
        this.recordApiKeyUsage(matchedApiKey.id, result.usage.credits || 0, result.usage.inputTokens, result.usage.outputTokens, chatRequest.model, '/v1/responses')
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1/responses', chatRequest.model, startTime, signal)
    }
  }

  // 处理 OpenAI 流式响应
  private async handleOpenAIStream(
    res: http.ServerResponse,
    account: ProxyAccount,
    kiroPayload: ReturnType<typeof openaiToKiro>,
    model: string,
    startTime: number,
    currentRound: number = 0,
    streamId?: string,
    headersSent: boolean = false,
    matchedApiKey?: import('./types').ApiKey,
    toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
    signal?: AbortSignal
  ): Promise<void> {
    const id = streamId || `chatcmpl-${uuidv4()}`
    let toolCallIndex = 0
    const pendingToolCalls: Map<string, { index: number; name: string; arguments: string }> = new Map()
    let collectedContent = ''
    let streamStarted = headersSent
    const ensureStreamStarted = (): void => {
      if (streamStarted) return
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
      if (currentRound === 0) {
        const initialChunk = createOpenaiStreamChunk(id, model, { role: 'assistant' })
        res.write(`data: ${JSON.stringify(initialChunk)}\n\n`)
      }
      streamStarted = true
    }

    return new Promise((resolve) => {
      this.callStreamWithFailover(
        account,
        kiroPayload,
        (_usedAccount, text, toolUse, isThinking) => {
          if (signal?.aborted || this.isResponseClosed(res)) return
          ensureStreamStarted()
          if (text && text.trim()) {
            if (isThinking) {
              // 原生 thinking 内容 → 输出为 reasoning_content
              const chunk = createOpenaiStreamChunk(id, model, { reasoning_content: text })
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            } else {
              // 普通文本内容
              collectedContent += text
              const chunk = createOpenaiStreamChunk(id, model, { content: text })
              res.write(`data: ${JSON.stringify(chunk)}\n\n`)
            }
          }
          if (toolUse) {
            const idx = toolCallIndex++
            const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse)
            pendingToolCalls.set(toolUse.toolUseId, {
              index: idx,
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input)
            })
            const toolChunk = createOpenaiStreamChunk(id, model, {
              tool_calls: [{
                index: idx,
                id: toolUse.toolUseId,
                type: 'function',
                function: {
                  name: restoredToolUse.name,
                  arguments: JSON.stringify(toolUse.input)
                }
              }]
            })
            res.write(`data: ${JSON.stringify(toolChunk)}\n\n`)
          }
        },
        async (usedAccount, usage) => {
          if (signal?.aborted || this.isResponseClosed(res)) {
            resolve()
            return
          }
          ensureStreamStarted()
          
          this.recordRequestSuccess()
          this.stats.totalTokens += usage.inputTokens + usage.outputTokens
          this.stats.inputTokens += usage.inputTokens
          this.stats.outputTokens += usage.outputTokens
          this.stats.cacheReadTokens += usage.cacheReadTokens || 0
          this.stats.cacheWriteTokens += usage.cacheWriteTokens || 0
          this.stats.reasoningTokens += usage.reasoningTokens || 0
          this.stats.totalCredits += usage.credits || 0
          this.events.onCreditsUpdate?.(this.stats.totalCredits)
          this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
          this.recordAccountSuccess(usedAccount, usage)
          const oaiRespTime = Date.now() - startTime
          this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 200, tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, reasoningTokens: usage.reasoningTokens, credits: usage.credits, responseTime: oaiRespTime })
          this.recordRequest({ path: '/v1/chat/completions', model, accountId: usedAccount.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits, responseTime: oaiRespTime, success: true })
          // 记录 API Key 用量
          if (matchedApiKey) {
            this.recordApiKeyUsage(matchedApiKey.id, usage.credits || 0, usage.inputTokens, usage.outputTokens, model, '/v1/chat/completions')
          }

          // 发送结束 chunk（包含完整 usage 信息）
          const hasToolCalls = pendingToolCalls.size > 0
          const finishReason = hasToolCalls ? 'tool_calls' : 'stop'
          const usageInfo: {
            prompt_tokens: number
            completion_tokens: number
            total_tokens: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
          } = {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens
          }
          // 添加 cache tokens 详情
          if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
            usageInfo.prompt_tokens_details = { cached_tokens: usage.cacheReadTokens }
          }
          // 添加 reasoning tokens 详情
          if (usage.reasoningTokens && usage.reasoningTokens > 0) {
            usageInfo.completion_tokens_details = { reasoning_tokens: usage.reasoningTokens }
          }
          const finalChunk = createOpenaiStreamChunk(id, model, {}, finishReason, usageInfo)
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
          resolve()
        },
        (usedAccount, error) => {
          if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
            resolve()
            return
          }
          ensureStreamStarted()
          console.error('[ProxyServer] Stream error:', error)
          res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
          res.end()

          this.recordRequestFailed()
          this.events.onResponse?.({ path: '/v1/chat/completions', model, status: 500, error: error.message })
          this.recordRequest({ path: '/v1/chat/completions', model, accountId: usedAccount.id, responseTime: Date.now() - startTime, success: false, error: error.message })
          resolve()
        },
        '/v1/chat/completions',
        signal,
        matchedApiKey?.id,
        model
      ).catch(error => {
        if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
          res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
          res.end()
          this.recordRequestFailed()
        }
        resolve()
      })
    })
  }

  // 处理 Claude Messages 请求
  private async handleClaudeMessages(req: http.IncomingMessage, res: http.ServerResponse, signal?: AbortSignal): Promise<void> {
    const body = await this.readBody(req, signal)
    this.throwIfAborted(signal)
    const request: ClaudeRequest = JSON.parse(body)
    const matchedApiKey = (req as unknown as { matchedApiKey?: import('./types').ApiKey }).matchedApiKey

    // 提取 session hint（用于稳定 conversationId），拼入 API Key hash 隔离不同用户
    const rawHint = ProxyServer.extractSessionHint(req, request)
    if (!request.conversation_id && rawHint) {
      const keyPrefix = matchedApiKey?.id?.slice(0, 8) || 'default'
      request.conversation_id = `${keyPrefix}:${rawHint}`
    }
    // P1-8 会话粘性使用 conversation_id 作为粘性 key（已包含 API Key 前缀）
    const affinityHint = request.conversation_id

    // 应用模型映射
    request.model = this.applyModelMapping(request.model, matchedApiKey?.id)

    const startTime = Date.now()

    this.recordNewRequest()
    this.events.onRequest?.({ path: '/v1/messages', method: 'POST' })

    let processedRequest: ClaudeRequest
    try {
      processedRequest = await this.resolveClaudeHttpImages(this.prepareClaudeRequest(request), signal)
    } catch (error) {
      if (this.isAbortError(error, signal)) return
      this.recordRequestFailed()
      const message = error instanceof Error ? error.message : 'Invalid request'
      this.sendError(res, 400, message, 'anthropic')
      this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 400, error: message })
      this.recordRequest({ path: '/v1/messages', model: request.model, responseTime: Date.now() - startTime, success: false, error: message })
      return
    }

    // 获取账号（包含 Token 刷新检查 + 会话粘性 + API Key 账号白名单）
    this.throwIfAborted(signal)
    const account = await this.getAvailableAccount(signal, affinityHint, matchedApiKey?.id, request.model)
    this.throwIfAborted(signal)
    if (!account) {
      this.recordRequestFailed()
      const diag = await this.classifyNoAccountReason(request.model, matchedApiKey?.id, signal)
      this.sendError(res, 503, diag.message, 'anthropic')
      this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 503, error: diag.reason })
      this.recordRequest({ path: '/v1/messages', model: request.model, success: false, error: diag.reason })
      return
    }

    this.events.onRequest?.({ path: '/v1/messages', method: 'POST', accountId: account.id })

    try {
      const toolNameRegistry = new ToolNameRegistry()

      const kiroPayload = claudeToKiro(processedRequest, account.profileArn, toolNameRegistry)

      // 构建 prompt cache profile（用于模拟缓存 usage）
      const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length * 0.3))
      const cacheProfile = promptCacheTracker.buildClaudeProfile(
        processedRequest.system,
        processedRequest.messages,
        processedRequest.tools,
        estimatedInputTokens,
        processedRequest.model
      )
      const cacheUsage = promptCacheTracker.compute(account.id, cacheProfile)

      if (cacheProfile) {
        proxyLogger.info('ProxyServer', `Prompt cache: ${cacheProfile.breakpoints.length} breakpoints, creation=${cacheUsage.cacheCreationInputTokens}, read=${cacheUsage.cacheReadInputTokens}`)
      }

      // 记录请求详情到日志
      if (this.config.logRequests) {
        const userInput = kiroPayload.conversationState.currentMessage?.userInputMessage
        const contentLength = typeof userInput?.content === 'string' ? userInput.content.length : 0
        const toolsCount = userInput?.userInputMessageContext?.tools?.length || 0
        const historyLength = kiroPayload.conversationState.history?.length || 0
        const hasImages = (userInput?.images?.length || 0) > 0
        
        proxyLogger.info('ProxyServer', `Claude API: ${request.model}`, {
          model: request.model,
          stream: request.stream,
          contentLength,
          toolsCount,
          historyLength,
          hasImages,
          accountId: account.id.substring(0, 8) + '...'
        })
      }

      if (request.stream) {
        // 流式响应（流式不使用重试机制，错误由流处理）
        await this.handleClaudeStream(res, account, kiroPayload, request.model, startTime, 0, undefined, false, 0, matchedApiKey, toolNameRegistry, signal,
          cacheProfile ? { ...cacheUsage, cacheProfile, accountId: account.id } : undefined)
      } else {
        // 非流式响应（带重试机制）
        const { result, account: usedAccount } = await this.callWithRetry(
          account,
          async (acc) => {
            const retryPayload = claudeToKiro(processedRequest, acc.profileArn, toolNameRegistry)
            return callKiroApi(acc, retryPayload, signal)
          },
          '/v1/messages',
          signal,
          matchedApiKey?.id,
          request.model
        )
        const response = kiroToClaudeResponse(result.content, result.toolUses, result.usage, request.model, toolNameRegistry, result.reasoningContent)

        // 用缓存模拟的 usage 覆盖（如果有 cache profile）
        if (cacheProfile && cacheUsage) {
          if (cacheUsage.cacheCreationInputTokens > 0) response.usage.cache_creation_input_tokens = cacheUsage.cacheCreationInputTokens
          if (cacheUsage.cacheReadInputTokens > 0) response.usage.cache_read_input_tokens = cacheUsage.cacheReadInputTokens
          promptCacheTracker.update(usedAccount.id, cacheProfile)
        }

        this.throwIfResponseClosed(res, signal)
        this.recordRequestSuccess()
        this.stats.totalTokens += result.usage.inputTokens + result.usage.outputTokens
        this.stats.inputTokens += result.usage.inputTokens
        this.stats.outputTokens += result.usage.outputTokens
        this.recordAccountSuccess(usedAccount, result.usage)

        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(response))
        const respTime = Date.now() - startTime
        this.events.onResponse?.({ path: '/v1/messages', model: request.model, status: 200, tokens: result.usage.inputTokens + result.usage.outputTokens, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens, reasoningTokens: result.usage.reasoningTokens, credits: result.usage.credits, responseTime: respTime })
        this.recordRequest({ path: '/v1/messages', model: request.model, accountId: usedAccount.id, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, credits: result.usage.credits, responseTime: respTime, success: true })
      }
    } catch (error) {
      this.handleApiError(res, account, error as Error, '/v1/messages', request.model, startTime, signal)
    }
  }

  // 处理 Claude 流式响应
  private async handleClaudeStream(
    res: http.ServerResponse,
    account: ProxyAccount,
    kiroPayload: ReturnType<typeof claudeToKiro>,
    model: string,
    startTime: number,
    currentRound: number = 0,
    msgId?: string,
    headersSent: boolean = false,
    contentBlockIndex: number = 0,
    matchedApiKey?: import('./types').ApiKey,
    toolNameRegistry: ToolNameRegistry = new ToolNameRegistry(),
    signal?: AbortSignal,
    simulatedCacheUsage?: { cacheCreationInputTokens: number; cacheReadInputTokens: number; cacheProfile?: unknown; accountId?: string }
  ): Promise<void> {
    const id = msgId || `msg_${uuidv4()}`
    let currentBlockIndex = contentBlockIndex
    let hasStartedTextBlock = false
    let hasStartedThinkingBlock = false
    let pendingThinkingSignature: string | undefined
    let collectedContent = ''
    const pendingToolCalls: Map<string, { name: string; input: Record<string, unknown> }> = new Map()

    const flushThinkingSignature = () => {
      if (!pendingThinkingSignature) return
      const signatureDelta = createClaudeStreamEvent('content_block_delta', {
        index: currentBlockIndex,
        delta: { type: 'signature_delta', signature: pendingThinkingSignature }
      })
      res.write(`event: content_block_delta\ndata: ${JSON.stringify(signatureDelta)}\n\n`)
      pendingThinkingSignature = undefined
    }

    // 估算输入 tokens（基于 payload 大小）
    const estimatedInputTokens = Math.max(1, Math.round(JSON.stringify(kiroPayload).length / 3))
    let streamStarted = headersSent
    const ensureStreamStarted = (): void => {
      if (streamStarted) return
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      })
      if (currentRound === 0) {
        const messageStart = createClaudeStreamEvent('message_start', {
          message: {
            id,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: estimatedInputTokens, output_tokens: 0 }
          }
        })
        res.write(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`)
      }
      streamStarted = true
    }

    return new Promise((resolve) => {
      this.callStreamWithFailover(
        account,
        kiroPayload,
        (_usedAccount, text, toolUse, isThinking, reasoningSignature, redactedContent) => {
          if (signal?.aborted || this.isResponseClosed(res)) return
          ensureStreamStarted()
          // 优先处理 redacted_thinking（加密的 thinking 块，需单独 content_block）
          if (redactedContent) {
            if (hasStartedTextBlock) {
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedTextBlock = false
            }
            if (hasStartedThinkingBlock) {
              flushThinkingSignature()
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedThinkingBlock = false
            }
            const blockStart = createClaudeStreamEvent('content_block_start', {
              index: currentBlockIndex,
              content_block: { type: 'redacted_thinking', data: redactedContent }
            })
            res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
            const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
            currentBlockIndex++
            return
          }
          if (text && text.trim()) {
            if (isThinking) {
              // 原生 thinking 内容 → 输出为 Anthropic thinking block
              if (hasStartedTextBlock) {
                const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
                res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
                currentBlockIndex++
                hasStartedTextBlock = false
              }
              if (!hasStartedThinkingBlock) {
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'thinking', thinking: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedThinkingBlock = true
              }
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'thinking_delta', thinking: text }
              })
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
              if (reasoningSignature) {
                pendingThinkingSignature = reasoningSignature
              }
            } else {
              // 普通文本内容
              if (hasStartedThinkingBlock) {
                flushThinkingSignature()
                const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
                res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
                currentBlockIndex++
                hasStartedThinkingBlock = false
              }
              collectedContent += text
              if (!hasStartedTextBlock) {
                const blockStart = createClaudeStreamEvent('content_block_start', {
                  index: currentBlockIndex,
                  content_block: { type: 'text', text: '' }
                })
                res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
                hasStartedTextBlock = true
              }
              const delta = createClaudeStreamEvent('content_block_delta', {
                index: currentBlockIndex,
                delta: { type: 'text_delta', text }
              })
              res.write(`event: content_block_delta\ndata: ${JSON.stringify(delta)}\n\n`)
            }
          } else if (isThinking && reasoningSignature) {
            if (!hasStartedThinkingBlock) {
              const blockStart = createClaudeStreamEvent('content_block_start', {
                index: currentBlockIndex,
                content_block: { type: 'thinking', thinking: '' }
              })
              res.write(`event: content_block_start\ndata: ${JSON.stringify(blockStart)}\n\n`)
              hasStartedThinkingBlock = true
            }
            pendingThinkingSignature = reasoningSignature
          }
          if (toolUse) {
            const restoredToolUse = toolNameRegistry.restoreToolUse(toolUse)
            if (hasStartedThinkingBlock) {
              flushThinkingSignature()
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedThinkingBlock = false
            }
            // 结束之前的文本块
            if (hasStartedTextBlock) {
              const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
              res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
              currentBlockIndex++
              hasStartedTextBlock = false
            }
            // 记录工具调用
            pendingToolCalls.set(toolUse.toolUseId, { name: toolUse.name, input: toolUse.input })
            // 开始工具块
            const toolBlockStart = createClaudeStreamEvent('content_block_start', {
              index: currentBlockIndex,
              content_block: { type: 'tool_use', id: toolUse.toolUseId, name: restoredToolUse.name, input: {} }
            })
            res.write(`event: content_block_start\ndata: ${JSON.stringify(toolBlockStart)}\n\n`)
            // 发送工具输入
            const toolDelta = createClaudeStreamEvent('content_block_delta', {
              index: currentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolUse.input) } as any
            })
            res.write(`event: content_block_delta\ndata: ${JSON.stringify(toolDelta)}\n\n`)
            // 结束工具块
            const toolBlockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(toolBlockStop)}\n\n`)
            currentBlockIndex++
          }
        },
        async (usedAccount, usage) => {
          if (signal?.aborted || this.isResponseClosed(res)) {
            resolve()
            return
          }
          ensureStreamStarted()
          if (hasStartedThinkingBlock) {
            flushThinkingSignature()
            const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
            currentBlockIndex++
            hasStartedThinkingBlock = false
          }

          // 结束最后的文本块
          if (hasStartedTextBlock) {
            const blockStop = createClaudeStreamEvent('content_block_stop', { index: currentBlockIndex })
            res.write(`event: content_block_stop\ndata: ${JSON.stringify(blockStop)}\n\n`)
            currentBlockIndex++
          }

          this.recordRequestSuccess()
          this.stats.totalTokens += usage.inputTokens + usage.outputTokens
          this.stats.inputTokens += usage.inputTokens
          this.stats.outputTokens += usage.outputTokens
          this.stats.totalCredits += usage.credits || 0
          this.events.onCreditsUpdate?.(this.stats.totalCredits)
          this.events.onTokensUpdate?.(this.stats.inputTokens, this.stats.outputTokens)
          this.recordAccountSuccess(usedAccount, usage)
          this.stats.cacheReadTokens += usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens || 0
          this.stats.cacheWriteTokens += usage.cacheWriteTokens || simulatedCacheUsage?.cacheCreationInputTokens || 0
          this.stats.reasoningTokens += usage.reasoningTokens || 0
          const respTime = Date.now() - startTime
          this.events.onResponse?.({ path: '/v1/messages', model, status: 200, tokens: usage.inputTokens + usage.outputTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens || simulatedCacheUsage?.cacheReadInputTokens, reasoningTokens: usage.reasoningTokens, credits: usage.credits, responseTime: respTime })
          this.recordRequest({ path: '/v1/messages', model, accountId: usedAccount.id, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, credits: usage.credits, responseTime: respTime, success: true })
          // 记录 API Key 用量
          if (matchedApiKey) {
            this.recordApiKeyUsage(matchedApiKey.id, usage.credits || 0, usage.inputTokens, usage.outputTokens, model, '/v1/messages')
          }

          // 成功后更新 prompt cache tracker
          if (simulatedCacheUsage?.cacheProfile) {
            promptCacheTracker.update(usedAccount.id, simulatedCacheUsage.cacheProfile as any)
          }
          // 发送 message_delta（包含完整 usage 信息）
          const hasToolCalls = pendingToolCalls.size > 0
          const stopReason = hasToolCalls ? 'tool_use' : 'end_turn'
          const messageDelta = createClaudeStreamEvent('message_delta', {
            delta: { stop_reason: stopReason, stop_sequence: null } as any,
            usage: this.buildClaudeUsage(usage, simulatedCacheUsage)
          })
          res.write(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`)
          // 发送 message_stop
          const messageStop = createClaudeStreamEvent('message_stop')
          res.write(`event: message_stop\ndata: ${JSON.stringify(messageStop)}\n\n`)
          res.end()
          resolve()
        },
        (usedAccount, error) => {
          if (this.isAbortError(error, signal) || this.isResponseClosed(res)) {
            resolve()
            return
          }
          ensureStreamStarted()
          console.error('[ProxyServer] Stream error:', error)
          const errorEvent = createClaudeStreamEvent('error', {
            error: { type: 'api_error', message: error.message }
          })
          res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
          res.end()

          this.recordRequestFailed()
          this.events.onResponse?.({ path: '/v1/messages', model, status: 500, error: error.message })
          this.recordRequest({ path: '/v1/messages', model, accountId: usedAccount.id, responseTime: Date.now() - startTime, success: false, error: error.message })
          resolve()
        },
        '/v1/messages',
        signal,
        matchedApiKey?.id,
        model
      ).catch(error => {
        if (!this.isAbortError(error, signal) && !this.isResponseClosed(res)) {
          const errorEvent = createClaudeStreamEvent('error', {
            error: { type: 'api_error', message: error.message }
          })
          res.write(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`)
          res.end()
          this.recordRequestFailed()
        }
        resolve()
      })
    })
  }

  // 处理 API 错误
  private handleApiError(res: http.ServerResponse, account: ProxyAccount, error: Error, path: string, model?: string, startTime?: number, signal?: AbortSignal): void {
    if (this.isAbortError(error, signal) || this.isResponseClosed(res)) return
    this.recordRequestFailed()
    const attemptError = error as ProxyAttemptError
    const failedAccount = attemptError.proxyAccountId
      ? this.accountPool.getAccount(attemptError.proxyAccountId) || account
      : account
    const errCode = error.message.match(/(\d{3})/)?.[1]
    const parsedCode = errCode ? parseInt(errCode) : 500
    const isAuthError = error.message.includes('401') || error.message.includes('403') || error.message.includes('Auth')

    if (!attemptError.proxyFailureRecorded) this.recordAccountFailure(failedAccount, error)

    let statusCode = parsedCode
    if (isBillingOrQuotaError(error.message)) statusCode = 402
    else if (isThrottleError(error.message)) statusCode = 429
    if (isAuthError) statusCode = 401

    if (res.headersSent) {
      if (!this.isResponseClosed(res)) {
        if (path === '/v1/responses' || path === '/responses') {
          res.write(`event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', error: { type: 'api_error', message: error.message } })}\n\n`)
        }
        res.end()
      }
      this.events.onResponse?.({ path, status: statusCode, error: error.message })
      this.recordRequest({ path, model, accountId: failedAccount.id, responseTime: startTime ? Date.now() - startTime : 0, success: false, error: error.message })
      return
    }

    this.sendError(res, statusCode, error.message, this.isAnthropicPath(path) ? 'anthropic' : 'openai')
    this.events.onResponse?.({ path, status: statusCode, error: error.message })
    this.recordRequest({ path, model, accountId: failedAccount.id, responseTime: startTime ? Date.now() - startTime : 0, success: false, error: error.message })
  }

  // 读取请求体
  /**
   * 读取请求体，限制最大字节数以防 DoS
   * - Content-Length 头超限：立即 reject
   * - 流式累加超限：销毁连接并 reject
   * 触发 BodyTooLarge 错误时上层会发 413 Payload Too Large
   */
  private readBody(req: http.IncomingMessage, signal?: AbortSignal): Promise<string> {
    const maxBytes = Math.max(1024, this.config.maxRequestBodyBytes ?? 10 * 1024 * 1024)

    // 优先用 Content-Length 提前拒绝（避免分配缓冲）
    const declaredLen = parseInt(req.headers['content-length'] || '0', 10)
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
      return Promise.reject(new BodyTooLargeError(declaredLen, maxBytes))
    }

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      const cleanup = () => {
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('error', onError)
        req.off('aborted', onAborted)
        signal?.removeEventListener('abort', onAbort)
      }
      const onData = (chunk: Buffer) => {
        total += chunk.length
        if (total > maxBytes) {
          cleanup()
          try { req.destroy() } catch { /* ignore */ }
          reject(new BodyTooLargeError(total, maxBytes))
          return
        }
        chunks.push(chunk)
      }
      const onEnd = () => {
        cleanup()
        resolve(Buffer.concat(chunks, total).toString('utf8'))
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onAborted = () => {
        cleanup()
        reject(new Error('Client disconnected'))
      }
      const onAbort = () => {
        cleanup()
        reject(this.getAbortError(signal))
      }
      if (signal?.aborted) {
        reject(this.getAbortError(signal))
        return
      }
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('error', onError)
      req.on('aborted', onAborted)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  // 发送错误响应
  // P0-5 自动 sanitize：500 类不吐 message 详情；4xx 客户端错误正常返回
  private sendError(res: http.ServerResponse, status: number, message: string, format: 'openai' | 'anthropic' = 'openai'): void {
    if (res.writableEnded || res.destroyed) return
    // 500-599 强制使用通用消息（防止泄露内部信息）
    const safeMessage = status >= 500 && status < 600
      ? this.sanitizeErrorMessage(message) || 'Internal server error'
      : message
    // P1-6 503 → 触发 webhook（已有 5 分钟去重）
    if (status === 503) {
      this.notifyAllAccountsExhausted('unknown')
    }
    res.writeHead(status, { 'Content-Type': 'application/json' })
    if (format === 'anthropic') {
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: this.getAnthropicErrorType(status),
          message: safeMessage
        }
      }))
      return
    }
    res.end(JSON.stringify({ error: { message: safeMessage, type: 'error', code: status } }))
  }

  /**
   * P0-5 / P2-19 错误消息脱敏（移除可能含的 Bearer/Token/路径等敏感信息）
   * 用于错误响应和日志输出
   */
  private sanitizeErrorMessage(msg: string): string {
    if (!msg) return ''
    return msg
      // Bearer xxxx → Bearer ***
      .replace(/Bearer\s+[A-Za-z0-9\-_.~+/]+=*/gi, 'Bearer ***')
      // access_token / refresh_token / api_key / x-api-key 字段值
      .replace(/(access[_-]?token|refresh[_-]?token|api[_-]?key|x-api-key)["'\s:=]+[^"',\s}]+/gi, '$1=***')
      // 长 base64/JWT（>= 40 chars）替换为占位
      .replace(/eyJ[A-Za-z0-9\-_]{20,}/g, 'eyJ***')
      // Windows 用户路径
      .replace(/C:\\Users\\[^\\/\s]+/gi, 'C:\\Users\\***')
      // Linux/Mac home 路径
      .replace(/\/home\/[^\s/]+/g, '/home/***')
      .replace(/\/Users\/[^\s/]+/g, '/Users/***')
  }

  /**
   * P1-7 滑动窗口限流：每分钟 N 次（按 API Key id 或 IP）
   * 0 = 不限制
   */
  private checkRateLimit(id: string): { allowed: boolean; retryAfterMs: number } {
    const limit = this.config.rateLimitPerKeyPerMinute || 0
    if (limit <= 0) return { allowed: true, retryAfterMs: 0 }

    const now = Date.now()
    const bucket = this.rateLimitBuckets.get(id)
    if (!bucket || now - bucket.windowStart >= 60_000) {
      this.rateLimitBuckets.set(id, { count: 1, windowStart: now })
      return { allowed: true, retryAfterMs: 0 }
    }
    if (bucket.count >= limit) {
      return { allowed: false, retryAfterMs: 60_000 - (now - bucket.windowStart) }
    }
    bucket.count++
    return { allowed: true, retryAfterMs: 0 }
  }

  /** 定期清理过期的限流桶 / 会话粘性条目（避免内存泄漏） */
  private cleanupExpiredCaches(): void {
    const now = Date.now()
    // 限流桶过期 2 分钟
    for (const [key, bucket] of this.rateLimitBuckets) {
      if (now - bucket.windowStart > 120_000) this.rateLimitBuckets.delete(key)
    }
    // 粘性会话过期 10 分钟
    for (const [key, entry] of this.sessionAffinity) {
      if (now - entry.lastAt > 600_000) this.sessionAffinity.delete(key)
    }
    // 审计日志最多 200 条
    if (this.auditLog.length > 200) {
      this.auditLog = this.auditLog.slice(-200)
    }
  }

  /**
   * P1-8 会话粘性账号选择：相同 session hint 优先复用同一账号
   * 实现方式：用 sessionHint hash 索引到固定账号；账号失效时自动失效粘性
   */
  private pickAccountWithAffinity(sessionHint: string | undefined): ProxyAccount | null {
    if (!this.isSessionAffinityActive() || !sessionHint) return null
    const entry = this.sessionAffinity.get(sessionHint)
    if (entry) {
      const account = this.accountPool.getAccount(entry.accountId)
      // 校验账号仍可用，避免 affinity 把请求送回耗尽/冷却/封禁账号。
      if (account && this.accountPool.isAccountAvailable(account)) {
        entry.lastAt = Date.now()
        return account
      }
      // 已失效 → 清掉粘性
      this.sessionAffinity.delete(sessionHint)
    }
    return null
  }

  /** 记录粘性映射 */
  private rememberAffinity(sessionHint: string | undefined, accountId: string): void {
    if (!this.isSessionAffinityActive() || !sessionHint) return
    this.sessionAffinity.set(sessionHint, { accountId, lastAt: Date.now() })
  }

  /** P2-17 审计日志 */
  private appendAuditLog(type: string, data: Record<string, unknown>): void {
    if (!this.config.enableAuditLog) return
    this.auditLog.push({ ts: Date.now(), type, data })
    if (this.auditLog.length > 200) this.auditLog.shift()
  }

  /** 获取审计日志（供管理 API） */
  getAuditLog(): ReadonlyArray<{ ts: number; type: string; data: Record<string, unknown> }> {
    return this.auditLog
  }

  /** 注入 webhook 触发器（由 main/index.ts 注入，调用 renderer 的 webhook store） */
  setWebhookTrigger(fn: (event: string, payload: Record<string, unknown>) => void): void {
    this.webhookTrigger = fn
  }

  /** 关键事件去重时间戳（5 分钟内同事件不重复推） */
  private lastWebhookByEvent: Map<string, number> = new Map()

  /** P1-6 触发 webhook（封装错误处理 + 5 分钟去重） */
  private triggerWebhook(event: string, payload: Record<string, unknown>): void {
    const now = Date.now()
    const last = this.lastWebhookByEvent.get(event) || 0
    if (now - last < 5 * 60_000) return  // 同事件 5 分钟内不重复推
    this.lastWebhookByEvent.set(event, now)
    try { this.webhookTrigger?.(event, payload) } catch (err) {
      proxyLogger.warn('ProxyServer', `Webhook trigger failed: ${(err as Error).message}`)
    }
  }

  /** 全员配额耗尽 webhook（503 时调用） */
  private notifyAllAccountsExhausted(path: string, model?: string): void {
    const quota = this.accountPool.getQuotaStatus()
    this.appendAuditLog('all_accounts_exhausted', { path, model, ...quota })
    this.triggerWebhook('proxy-all-exhausted', {
      title: '反代账号全部不可用',
      message: `所有账号配额耗尽或冷却中（exhausted=${quota.exhausted}/${quota.total}，cooldown=${quota.cooldown}）`,
      level: 'error',
      fields: { 端点: path, 模型: model || '-', 总账号: quota.total, 配额耗尽: quota.exhausted, 冷却中: quota.cooldown, 可用: quota.available }
    })
  }

  /** P2-16 Prometheus metrics 文本 */
  private renderPrometheusMetrics(): string {
    const s = this.stats
    const ap = this.accountPool
    const lines: string[] = []
    lines.push('# HELP kiro_proxy_requests_total Total requests handled')
    lines.push('# TYPE kiro_proxy_requests_total counter')
    lines.push(`kiro_proxy_requests_total ${s.totalRequests}`)
    lines.push('# HELP kiro_proxy_requests_success_total Total successful requests')
    lines.push('# TYPE kiro_proxy_requests_success_total counter')
    lines.push(`kiro_proxy_requests_success_total ${s.successRequests}`)
    lines.push('# HELP kiro_proxy_requests_failed_total Total failed requests')
    lines.push('# TYPE kiro_proxy_requests_failed_total counter')
    lines.push(`kiro_proxy_requests_failed_total ${s.failedRequests}`)
    lines.push('# HELP kiro_proxy_tokens_total Total tokens consumed')
    lines.push('# TYPE kiro_proxy_tokens_total counter')
    lines.push(`kiro_proxy_tokens_total{type="input"} ${s.inputTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="output"} ${s.outputTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="cache_read"} ${s.cacheReadTokens}`)
    lines.push(`kiro_proxy_tokens_total{type="cache_write"} ${s.cacheWriteTokens}`)
    lines.push('# HELP kiro_proxy_credits_total Total credits consumed')
    lines.push('# TYPE kiro_proxy_credits_total counter')
    lines.push(`kiro_proxy_credits_total ${s.totalCredits}`)
    lines.push('# HELP kiro_proxy_accounts Accounts by status')
    lines.push('# TYPE kiro_proxy_accounts gauge')
    const quota = ap.getQuotaStatus()
    lines.push(`kiro_proxy_accounts{status="total"} ${quota.total}`)
    lines.push(`kiro_proxy_accounts{status="available"} ${quota.available}`)
    lines.push(`kiro_proxy_accounts{status="exhausted"} ${quota.exhausted}`)
    lines.push(`kiro_proxy_accounts{status="cooldown"} ${quota.cooldown}`)
    lines.push('# HELP kiro_proxy_uptime_seconds Server uptime in seconds')
    lines.push('# TYPE kiro_proxy_uptime_seconds gauge')
    lines.push(`kiro_proxy_uptime_seconds ${Math.floor((Date.now() - s.startTime) / 1000)}`)
    return lines.join('\n') + '\n'
  }

  // 记录请求到 recentRequests
  private recordRequest(log: {
    path: string
    model?: string
    accountId?: string
    inputTokens?: number
    outputTokens?: number
    credits?: number
    responseTime?: number
    success: boolean
    error?: string
  }): void {
    this.stats.recentRequests.push({
      timestamp: Date.now(),
      path: log.path,
      model: log.model || 'unknown',
      accountId: log.accountId || 'unknown',
      inputTokens: log.inputTokens || 0,
      outputTokens: log.outputTokens || 0,
      credits: log.credits,
      responseTime: log.responseTime || 0,
      success: log.success,
      // P2-19 错误消息脱敏
      error: log.error ? this.sanitizeErrorMessage(log.error).slice(0, 500) : undefined
    })
    // P2-15 可配置上限（默认 100，最多 10000）
    const limit = Math.min(10000, Math.max(20, this.config.recentRequestsLimit || 100))
    if (this.stats.recentRequests.length > limit) {
      this.stats.recentRequests = this.stats.recentRequests.slice(-limit)
    }
  }
}
