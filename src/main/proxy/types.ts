// Kiro Proxy 类型定义

// ============ OpenAI 兼容格式 ============
export interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  temperature?: number
  top_p?: number
  max_tokens?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: string | { type: string; function: { name: string } }
  response_format?: { type: string; json_schema?: unknown }
  conversation_id?: string
  metadata?: Record<string, unknown>
  kiro_context?: KiroRequestContext
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max' | string
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'adaptive' } | { type: 'disabled' }
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OpenAIContentPart[]
  reasoning_content?: string
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  cache_control?: ClaudeCacheControl
}

export interface OpenAIContentPart {
  type: 'text' | 'image_url' | 'file' | 'document'
  text?: string
  image_url?: { url: string; detail?: string }
  file?: { filename?: string; file_data?: string }
  source?: ClaudeDocumentSource
  name?: string
  cache_control?: ClaudeCacheControl
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
  cache_control?: ClaudeCacheControl
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChoice[]
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens?: number
    }
    completion_tokens_details?: {
      reasoning_tokens?: number
    }
  }
}

export interface OpenAIChoice {
  index: number
  message: {
    role: 'assistant'
    content: string | null
    reasoning_content?: string
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: 'stop' | 'length' | 'tool_calls' | null
}

export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: {
    index: number
    delta: {
      role?: 'assistant'
      content?: string
      reasoning_content?: string
      tool_calls?: Partial<OpenAIToolCall>[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | null
  }[]
}

export interface OpenAIResponsesRequest {
  model: string
  input: string | OpenAIResponseInputItem[]
  instructions?: string
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: string | { type: string; name?: string; function?: { name: string } }
  previous_response_id?: string
  reasoning?: unknown
  metadata?: Record<string, unknown>
  kiro_context?: KiroRequestContext
}

export interface OpenAIResponseInputItem {
  type?: 'message' | 'function_call' | 'function_call_output'
  role?: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIResponseContentPart[]
  call_id?: string
  name?: string
  arguments?: string
  output?: string
}

export interface OpenAIResponseContentPart {
  type: 'input_text' | 'output_text' | 'input_image' | 'input_file'
  text?: string
  image_url?: string
  file_data?: string
  filename?: string
}

export interface OpenAIResponsesResponse {
  id: string
  object: 'response'
  created_at: number
  model: string
  output: OpenAIResponseOutputItem[]
  previous_response_id?: string
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

export type OpenAIResponseOutputItem =
  | { type: 'message'; id: string; role: 'assistant'; content: { type: 'output_text'; text: string }[] }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }

// ============ Claude 兼容格式 ============
export interface ClaudeRequest {
  model: string
  messages: ClaudeMessage[]
  max_tokens: number
  temperature?: number
  top_p?: number
  stream?: boolean
  system?: string | ClaudeSystemBlock[]
  tools?: ClaudeTool[]
  tool_choice?: { type: string; name?: string }
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive'; display?: string } | { type: 'disabled' }
  conversation_id?: string
  metadata?: Record<string, unknown>
  kiro_context?: KiroRequestContext
  anthropic_beta?: string[]
  output_config?: { effort?: string; task_budget?: { type: 'tokens'; total: number; remaining?: number } }
  context_management?: { type?: string; [key: string]: unknown }
}

export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ClaudeContentBlock[]
  cache_control?: ClaudeCacheControl
}

export interface ClaudeSystemBlock {
  type: 'text'
  text: string
  cache_control?: ClaudeCacheControl
}

export interface ClaudeContentBlock {
  type: 'text' | 'image' | 'document' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking'
  text?: string
  thinking?: string
  signature?: string
  data?: string
  source?: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string } | ClaudeDocumentSource
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: string | ClaudeContentBlock[]
  cache_control?: ClaudeCacheControl
}

export type ClaudeDocumentSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'text'; media_type?: string; data: string }

export interface ClaudeTool {
  name: string
  description: string
  input_schema: unknown
  cache_control?: ClaudeCacheControl
}

export interface ClaudeCacheControl {
  type: string
}

export interface ClaudeResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: ClaudeContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'tool_use' | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface ClaudeStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error'
  message?: Partial<ClaudeResponse>
  index?: number
  content_block?: ClaudeContentBlock
  delta?: { type: string; text?: string; thinking?: string; signature?: string; data?: string; reasoning_content?: string; stop_reason?: string; stop_sequence?: string }
  usage?: { input_tokens?: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }
  error?: { type: string; message: string }
}

// ============ Kiro API 格式 ============
export interface KiroPayload {
  conversationState: KiroConversationState
  profileArn?: string
  inferenceConfig?: KiroInferenceConfig
  additionalModelRequestFields?: Record<string, unknown>
}

export interface KiroConversationState {
  agentContinuationId?: string
  agentTaskType?: string
  chatTriggerType: 'MANUAL'
  conversationId: string
  currentMessage: KiroCurrentMessage
  history?: KiroHistoryMessage[]
}

export interface KiroCurrentMessage {
  userInputMessage: KiroUserInputMessage
}

export interface KiroUserInputMessage {
  content: string
  modelId?: string  // 可选，占位消息不需要
  origin: string
  images?: KiroImage[]
  documents?: KiroDocument[]
  cachePoint?: KiroCachePoint
  clientCacheConfig?: unknown
  userInputMessageContext?: KiroUserInputMessageContext
}

export interface KiroImage {
  format: string
  source: { bytes: string }
}

export interface KiroDocument {
  format: string
  name: string
  source: { bytes: string }
}

export interface KiroUserInputMessageContext {
  toolResults?: KiroToolResult[]
  tools?: KiroToolWrapper[]
  editorState?: unknown
  shellState?: unknown
  gitState?: unknown
  envState?: unknown
  additionalContext?: unknown
}

export interface KiroToolResult {
  content: { text: string }[]
  status: 'success' | 'error'
  toolUseId: string
}

export type KiroToolWrapper = {
  toolSpecification: {
    name: string
    description: string
    inputSchema: { json: unknown }
  }
} | {
  cachePoint: KiroCachePoint
}

export interface KiroHistoryMessage {
  userInputMessage?: KiroUserInputMessage
  assistantResponseMessage?: KiroAssistantResponseMessage
}

export interface KiroAssistantResponseMessage {
  content: string
  cachePoint?: KiroCachePoint
  reasoningContent?: KiroReasoningContent
  toolUses?: KiroToolUse[]
}

export interface KiroToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown>
}

export interface KiroInferenceConfig {
  maxTokens?: number
  temperature?: number
  topP?: number
}

export interface KiroCachePoint {
  type: 'default'
}

export interface KiroReasoningContent {
  reasoningText?: {
    text: string
    signature?: string
  }
  redactedContent?: string
}

export interface KiroRequestContext {
  editorState?: unknown
  shellState?: unknown
  gitState?: unknown
  envState?: unknown
  additionalContext?: unknown
}

export interface KiroUsage {
  inputTokens: number
  outputTokens: number
  credits: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

// ============ 账号和代理配置 ============
export interface ProxyAccount {
  id: string
  email?: string
  accessToken: string
  refreshToken?: string
  kiroApiKey?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: 'social' | 'idc' | 'IdC' | 'external_idp' | 'api_key' | 'apikey'
  provider?: string
  /** Kiro subscription tier: 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams'. Used for tier-based Bedrock routing. */
  subscriptionType?: string
  profileArn?: string
  expiresAt?: number
  machineId?: string  // 账户绑定的设备 ID（64位十六进制）
  /** 账号绑定的出口代理 URL（http/https）；为空则使用全局代理逻辑 */
  proxyUrl?: string
  /** 账号所属分组 ID；与 multiAccountSelectionMode='groups' + multiAccountGroupIds 配合做轮询分组过滤 */
  groupId?: string
  // 运行时状态
  lastUsed?: number
  requestCount?: number
  errorCount?: number
  lastErrorStatus?: number
  isAvailable?: boolean
  cooldownUntil?: number
  // 配额追踪
  quotaUsed?: number
  /** Credits consumed by the most recent successful request. Used to merge stale pool state with fresher persisted usage. */
  quotaUsedDelta?: number
  quotaLimit?: number
  quotaExhaustedAt?: number // 配额耗尽时间戳
  quotaResetAt?: number // 下次配额重置时间
  // 长期封禁追踪（区分于临时 errorCount 冷却）
  // Kiro 后端 TEMPORARILY_SUSPENDED / AccountSuspendedException 等风控触发时设置
  // 需要联系 AWS Support 人工解封，账号池会持续跳过直到 clearSuspended
  suspendedAt?: number       // 封禁时间戳
  suspendReason?: string     // 封禁原因 (如 'TEMPORARILY_SUSPENDED')
  suspendMessage?: string    // 封禁完整错误消息 (含联系链接)
  // Phase 15: ChatGPT OAuth for free image generation
  chatgpt?: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    email?: string
    plan?: string
    imageQuota?: {
      used: number
      limit: number
      resetAt: number
    }
    lastImageGenAt?: number
    consecutiveFailures: number
  }
}

// ============ Tier-based routing ============
/** Kiro subscription tiers (2026). Paid = tất cả trừ 'free' và 'unknown'. */
export type KiroTier = 'free' | 'pro' | 'pro_plus' | 'power' | 'enterprise' | 'teams' | 'unknown'

/** Một rule trong Tier_Eligibility_Map: model nào, tier nào được phép, premium hay standard. */
export interface TierEligibilityRule {
  /** Khớp modelId (đã normalize). Hỗ trợ hậu tố '*' (prefix match), vd 'claude-opus-*'. */
  modelPattern: string
  /** Phân loại: 'premium' chỉ paid tier phục vụ; 'standard' mọi tier. */
  class: 'premium' | 'standard'
  /** Danh sách tier được phép phục vụ model này (dùng cho premium). */
  allowedTiers: KiroTier[]
}

/** Kết quả live-probe một model trên một tier đại diện. */
export interface ModelProbeResult {
  modelId: string
  tier: KiroTier
  ok: boolean
  error?: string
  latencyMs?: number
  accountId?: string
  checkedAt: number
}

// API Key 格式类型
export type ApiKeyFormat = 'sk' | 'simple' | 'token'

// API Key 用量记录
export interface ApiKeyUsageRecord {
  timestamp: number
  model: string
  inputTokens: number
  outputTokens: number
  credits: number
  path: string
}

// API Key 类型
export interface ApiKey {
  id: string
  name: string
  key: string
  format: ApiKeyFormat  // 密钥格式
  enabled: boolean
  createdAt: number
  lastUsedAt?: number
  // 额度限制
  creditsLimit?: number  // Credits 上限（undefined 表示无限制）
  // 用量统计
  usage: {
    totalRequests: number
    totalCredits: number
    totalInputTokens: number
    totalOutputTokens: number
    // 按日期统计（YYYY-MM-DD -> usage）
    daily: Record<string, {
      requests: number
      credits: number
      inputTokens: number
      outputTokens: number
    }>
    // 按模型统计
    byModel?: Record<string, {
      requests: number
      credits: number
      inputTokens: number
      outputTokens: number
    }>
  }
  // 用量历史记录（最近 100 条）
  usageHistory?: ApiKeyUsageRecord[]
}

// 模型映射规则
export interface ModelMappingRule {
  id: string
  name: string  // 规则名称
  enabled: boolean
  // 映射类型：replace(替换), alias(别名), loadbalance(负载均衡)
  type: 'replace' | 'alias' | 'loadbalance'
  // 源模型（用户请求的模型名，支持通配符 *）
  sourceModel: string
  // 目标模型列表（负载均衡时按权重轮询）
  targetModels: string[]
  // 负载均衡权重（可选，默认平均）
  weights?: number[]
  // 优先级（数字越小优先级越高）
  priority: number
  // 适用的 API Key ID 列表（空表示全局）
  apiKeyIds?: string[]
}

export interface ProxyConfig {
  enabled: boolean
  port: number
  host: string
  apiKey?: string  // 保留兼容性
  apiKeys?: ApiKey[]  // 多 API Key 支持
  enableMultiAccount: boolean
  selectedAccountIds: string[]
  logRequests: boolean
  logStreamEvents?: boolean
  maxConcurrent: number
  // 重试配置
  maxRetries?: number
  retryDelayMs?: number
  // 流式健壮性配置（防 Openclaw "聊到一半卡住"）
  // 初始缓冲：先攒少量首帧再 flush 给客户端；只要还没 flush，中途出错就能无缝换号重来。
  // - streamInitialBufferBytes: 缓冲字节阈值（默认 2048），达到即 flush
  // - streamInitialBufferMs: 缓冲时间阈值（默认 150ms），超时即 flush
  streamInitialBufferBytes?: number
  streamInitialBufferMs?: number
  // 流超时（0 = 关闭）：AWS 长时间不吐字节时主动 abort，避免客户端无限等待
  // - streamFirstByteTimeoutMs: 首字节超时（默认 30000）
  // - streamIdleTimeoutMs: 中途空闲超时（默认 60000，每收到一块即重置）
  streamFirstByteTimeoutMs?: number
  streamIdleTimeoutMs?: number
  // 心跳（0 = 关闭）：等待首帧/换号期间定期发送 SSE 注释，避免中间代理/CDN 掐断空闲连接
  streamHeartbeatIntervalMs?: number
  // 自动 prompt cache：为 OpenAI 路径（客户端不发 cache_control，如 Openclaw）自动在
  // 稳定前缀（tools/system/history）插入 cachePoint 标记，让 AWS Kiro 真正缓存并回传
  // cacheRead/cacheWrite token。默认开启。
  autoCachePoint?: boolean
  // cachePoint 数量上限（AWS Bedrock 单请求最多 4 个）。若某模型/账号 400 可下调。默认 4。
  autoCachePointMaxPoints?: number
  // 首选端点配置
  preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli'
  // Token 刷新提前量（秒）
  tokenRefreshBeforeExpiry?: number
  // TLS/HTTPS 配置
  tls?: TlsConfig
  // 自动启动
  autoStart?: boolean
  clientDrivenToolExecution?: boolean
  // 禁用工具调用（移除 tools 参数）
  disableTools?: boolean
  // Payload 大小限制（KB），超过时截断工具结果（byte 维度）
  payloadSizeLimitKB?: number
  // Token buffer reserve 开关（默认 false = 完全跳过 trimHistoryByTokens）
  // 关闭时后端不再裁剪任何旧消息，超出 context window 由 Kiro 后端原样返回错误
  enableTokenBufferReserve?: boolean
  // Token buffer reserve（仅在 enableTokenBufferReserve=true 时生效）
  // effective limit = model.maxInputTokens - buffer
  // 默认 20K：覆盖 system + tools + current message + output + 估算偏差
  tokenBufferReserve?: number
  // 单账号模式下额度耗尽自动切换到下一个账号
  autoSwitchOnQuotaExhausted?: boolean
  // 多账号选择策略 (仅 enableMultiAccount=true 时生效)
  // - round-robin: 每次请求成功后切到下一个账号 (默认, 负载均衡)
  // - sticky: 一个账号成功就粘住, 直到失败才切换 (保留 prompt cache, 牺牲均衡)
  accountSelectionStrategy?: 'smart' | 'round-robin' | 'sticky' | 'least-used'
  // 多账号轮询范围 (仅 enableMultiAccount=true 时生效)
  // - 'all': 使用所有 active 账号（默认）
  // - 'groups': 仅使用 multiAccountGroupIds 选中分组的账号；可包含特殊值 '__ungrouped__' 表示未分组账号
  multiAccountSelectionMode?: 'all' | 'groups'
  multiAccountGroupIds?: string[]
  // 模型映射规则
  modelMappings?: ModelMappingRule[]

  // ============ 安全 / 限流 / 可观测（v1.8 新增） ============
  /** 入站请求体最大字节数（默认 10MB）。超过返回 413 */
  maxRequestBodyBytes?: number
  /** 允许访问的客户端 IP 列表（CIDR 或单 IP）；空数组或未设 = 不限制 */
  allowedIPs?: string[]
  /** 拒绝访问的客户端 IP 列表（CIDR 或单 IP）；优先级高于 allowedIPs */
  deniedIPs?: string[]
  /** 当绑定 host 是 0.0.0.0/外网接口时，是否允许无 API Key 启动（默认 false 拒绝） */
  allowExternalWithoutApiKey?: boolean
  /** 按 API Key（或匿名时按 IP）的请求频率限制：每分钟最大请求数。0=不限制 */
  rateLimitPerKeyPerMinute?: number
  /** 客户端会话粘性：true 时同一 session hint 总路由到同一账号子集 */
  sessionAffinityEnabled?: boolean
  /** keep-alive 连接空闲超时（毫秒），默认 65s */
  keepAliveTimeoutMs?: number
  /** request headers 接收超时（毫秒），默认 60s */
  headersTimeoutMs?: number
  /** recentRequests 保留条数（默认 100，最多 10000） */
  recentRequestsLimit?: number
  /** 是否暴露 /metrics（Prometheus 文本格式） */
  enableMetrics?: boolean
  /**
   * P2-21 API Key 与账号的精细绑定：apiKey id → 允许使用的账号 ID 数组（白名单）
   * 未配置或空数组 = 该 API Key 可使用所有账号；
   * 兼容旧名 apiKeyGroupBindings（按 group 绑定，需配合 group 同步）
   */
  apiKeyAccountBindings?: Record<string, string[]>
  /** @deprecated 改用 apiKeyAccountBindings；保留以兼容老配置 */
  apiKeyGroupBindings?: Record<string, string[]>
  /** HTTP + HTTPS 双端口：启用 TLS 时，仍同时监听 HTTP 端口在 fallbackPort */
  fallbackPort?: number
  /** 启用审计日志（管理 API 操作、config 变更） */
  enableAuditLog?: boolean
  /**
   * Khi true: với model cần chọn theo năng lực (requiresModelCapabilitySelection),
   * chỉ xét tài khoản đúng tier (vd Opus → chỉ Power_Account). Mặc định không đặt:
   * giữ hành vi hiện tại dựa trên accountSupportsModel.
   */
  strictTierRouting?: boolean
  /**
   * Bật lọc account theo tier (Subscription_Tag) trước khi kiểm tra capability.
   * - true (mặc định): pipeline chọn account phân nhóm Free → unknown → paid, model
   *   premium chỉ xét paid; capability-cache xác nhận thật ở bước sau (hybrid).
   * - false: dùng đúng legacy path (chỉ capability-cache), không lọc theo tag.
   * Runtime-updatable (không nằm trong restartTriggerFields). Xem tierRouting.ts.
   */
  tierRoutingEnabled?: boolean
  /**
   * Tier_Eligibility_Map: quy tắc model → tier được phép phục vụ. Nếu không đặt,
   * dùng DEFAULT_TIER_ELIGIBILITY_MAP trong modelCatalog.ts. Mỗi rule khớp modelId
   * theo pattern (hỗ trợ '*' cuối), phân loại premium/standard + tier cho phép.
   */
  tierEligibilityMap?: TierEligibilityRule[]
  /**
   * User-defined custom models added from the one-click client config dialog.
   * Persisted so they survive reopening the dialog and app restarts. These are
   * merged into the model list the dialog shows; they are never fetched from Kiro.
   */
  customModels?: Array<{
    id: string
    name?: string
    inputTypes?: string[]
    maxInputTokens?: number
    maxOutputTokens?: number
  }>
  /** AWS Bedrock upstream provider (SigV4). Routed in parallel to the Kiro account pool. */
  bedrock?: import('./bedrock').BedrockConfig
  /** Xpixi third-party API provider. Routed in parallel to Kiro and Bedrock. */
  xpixi?: import('./xpixi').XpixiConfig
  /** Phase 15: ChatGPT OAuth image generation config */
  chatgptImage?: import('./chatgptImage').ChatGPTImageConfig
}

export interface TlsConfig {
  enabled: boolean
  certPath?: string // 证书文件路径
  keyPath?: string // 私钥文件路径
  // 或直接提供 PEM 内容
  cert?: string
  key?: string
}

// Token 刷新回调类型
export type TokenRefreshCallback = (account: ProxyAccount) => Promise<{
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  error?: string
}>

export interface ProxyStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalTokens: number
  totalCredits: number // 累计总 credits（所有请求）
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  startTime: number
  accountStats: Map<string, AccountStats>
  // 按端点统计
  endpointStats: Map<string, EndpointStats>
  // 按模型统计
  modelStats: Map<string, ModelStats>
  // 最近请求日志
  recentRequests: RequestLog[]
}

export interface AccountStats {
  requests: number
  tokens: number
  inputTokens: number
  outputTokens: number
  errors: number
  lastUsed: number
  avgResponseTime: number
  totalResponseTime: number
}

export interface EndpointStats {
  name: string
  requests: number
  successes: number
  failures: number
  quotaErrors: number
}

export interface ModelStats {
  model: string
  requests: number
  tokens: number
}

export interface RequestLog {
  timestamp: number
  path: string
  model: string
  accountId: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  credits?: number // Kiro API 返回的 credit 使用量
  responseTime: number
  success: boolean
  error?: string
  /** Whether tier-tag routing was active when this request's account was selected. */
  tierRoutingActive?: boolean
}

// ============ Event Stream 解析 ============
export interface KiroEventStreamMessage {
  type: string
  payload: unknown
}

export interface KiroAssistantResponseEvent {
  content?: string
  toolUse?: KiroToolUse
}

export interface KiroUsageEvent {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}
