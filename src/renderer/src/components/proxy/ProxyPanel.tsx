import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Play, Square, RefreshCw, Copy, Check, Server, Activity, AlertCircle, Globe, Zap, Loader2, FileText, Eye, EyeOff, Dices, Cpu, UserCheck, RotateCcw, Users, Clock, Settings2, ExternalLink } from 'lucide-react'
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Switch, Badge, Select } from '../ui'
import { ProxySecurityPanel } from './ProxySecurityPanel'
import { useAccountsStore } from '../../store/accounts'
import { useTranslation } from '../../hooks/useTranslation'
import { ProxyLogsDialog } from './ProxyLogsDialog'
import { ProxyDetailedLogsDialog } from './ProxyDetailedLogsDialog'
import { ModelsDialog } from './ModelsDialog'
import { ModelMappingDialog } from './ModelMappingDialog'
import { AccountSelectDialog } from './AccountSelectDialog'
import { ApiKeyManager } from './ApiKeyManager'
import { ClientConfigDialog } from './ClientConfigDialog'
import { createPortal } from 'react-dom'

const PROXY_STATUS_REFRESH_MS = 5000

function compactNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 100_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toLocaleString()
}

interface ProxyStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  totalTokens: number
  totalCredits: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  startTime: number
}

interface SessionStats {
  totalRequests: number
  successRequests: number
  failedRequests: number
  startTime: number
}

interface ModelMappingRule {
  id: string
  name: string
  enabled: boolean
  type: 'replace' | 'alias' | 'loadbalance'
  sourceModel: string
  targetModels: string[]
  weights?: number[]
  priority: number
  apiKeyIds?: string[]
}

interface ApiKeyInfo {
  id: string
  name: string
  key: string
  enabled: boolean
}

interface ProxyConfig {
  enabled: boolean
  port: number
  host: string
  apiKey?: string
  apiKeys?: ApiKeyInfo[]
  enableMultiAccount: boolean
  selectedAccountId?: string
  logRequests: boolean
  logStreamEvents?: boolean
  maxRetries?: number
  preferredEndpoint?: 'codewhisperer' | 'amazonq' | 'amazonq-cli'
  autoStart?: boolean
  clientDrivenToolExecution?: boolean
  disableTools?: boolean
  payloadSizeLimitKB?: number
  enableTokenBufferReserve?: boolean
  tokenBufferReserve?: number
  autoSwitchOnQuotaExhausted?: boolean
  accountSelectionStrategy?: 'smart' | 'round-robin' | 'sticky' | 'least-used'
  // 多账号轮询范围（与 main/proxy/types.ts 保持一致）
  multiAccountSelectionMode?: 'all' | 'groups'
  multiAccountGroupIds?: string[]
  modelMappings?: ModelMappingRule[]
  // v1.8 安全 / 限流 / 可观测
  maxRequestBodyBytes?: number
  allowedIPs?: string[]
  deniedIPs?: string[]
  allowExternalWithoutApiKey?: boolean
  rateLimitPerKeyPerMinute?: number
  sessionAffinityEnabled?: boolean
  keepAliveTimeoutMs?: number
  headersTimeoutMs?: number
  recentRequestsLimit?: number
  enableMetrics?: boolean
  fallbackPort?: number
  enableAuditLog?: boolean
}

interface DashboardTunnelStatus {
  running: boolean
  requested: boolean
  localUrl: string
  publicUrl?: string
  startedAt?: number
  pid?: number
  binary: string
  error?: string
  logs: string[]
}

// 反代请求日志：模块级持久化 + 单次订阅，避免切到其它页面 unmount 后日志清空、中间请求事件丢失
type RecentLogEntry = { time: string; path: string; model?: string; status: number; tokens?: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number; credits?: number; responseTime?: number; error?: string }
let _proxyRecentLogs: RecentLogEntry[] = []
let _refSetProxyRecentLogs: ((v: RecentLogEntry[]) => void) | null = null
let _proxyResponseListenerRegistered = false
function ensureProxyResponseListenerRegistered(): void {
  if (_proxyResponseListenerRegistered) return
  _proxyResponseListenerRegistered = true
  window.api.onProxyResponse((info) => {
    const now = new Date()
    const year = now.getFullYear()
    const month = (now.getMonth() + 1).toString().padStart(2, '0')
    const day = now.getDate().toString().padStart(2, '0')
    const hours = now.getHours().toString().padStart(2, '0')
    const minutes = now.getMinutes().toString().padStart(2, '0')
    const seconds = now.getSeconds().toString().padStart(2, '0')
    const ms = now.getMilliseconds().toString().padStart(3, '0')
    const fullTime = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`
    _proxyRecentLogs = [{
      time: fullTime,
      path: info.path,
      model: info.model,
      status: info.status,
      tokens: info.tokens,
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      cacheReadTokens: info.cacheReadTokens,
      reasoningTokens: info.reasoningTokens,
      credits: info.credits,
      responseTime: info.responseTime,
      error: info.error
    }, ..._proxyRecentLogs.slice(0, 99)]
    _refSetProxyRecentLogs?.(_proxyRecentLogs)
  })
}

export function ProxyPanel() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [isRunning, setIsRunning] = useState(false)
  const [config, setConfig] = useState<ProxyConfig>({
    enabled: false,
    port: 5580,
    host: '127.0.0.1',
    enableMultiAccount: true,
    logRequests: true,
    clientDrivenToolExecution: true,
    accountSelectionStrategy: 'smart',
    sessionAffinityEnabled: false
  })
  const [stats, setStats] = useState<ProxyStats | null>(null)
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null)
  const [accountCount, setAccountCount] = useState(0)
  const [availableCount, setAvailableCount] = useState(0)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recentLogs, setRecentLogs] = useState<RecentLogEntry[]>(_proxyRecentLogs)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isRefreshingModels, setIsRefreshingModels] = useState(false)
  const [syncSuccess, setSyncSuccess] = useState(false)
  const [refreshSuccess, setRefreshSuccess] = useState(false)
  const [showLogsDialog, setShowLogsDialog] = useState(false)
  const [showDetailedLogsDialog, setShowDetailedLogsDialog] = useState(false)
  const [showModelsDialog, setShowModelsDialog] = useState(false)
  const [showClientConfigDialog, setShowClientConfigDialog] = useState(false)
  const [showModelMappingDialog, setShowModelMappingDialog] = useState(false)
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([])
  const [showAccountSelectDialog, setShowAccountSelectDialog] = useState(false)
  const [showApiKeyManager, setShowApiKeyManager] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)
  const [apiKeyFormat, setApiKeyFormat] = useState<'sk' | 'simple' | 'token'>('sk')
  const [apiKeyCopied, setApiKeyCopied] = useState(false)
  const [apiKeyGenerated, setApiKeyGenerated] = useState(false)
  const [tunnelStatus, setTunnelStatus] = useState<DashboardTunnelStatus | null>(null)
  const [tunnelTarget, setTunnelTarget] = useState('')
  const [tunnelLoading, setTunnelLoading] = useState(false)
  const [tunnelCopied, setTunnelCopied] = useState(false)

  const accounts = useAccountsStore(state => state.accounts)
  const groups = useAccountsStore(state => state.groups)

  // 生成随机 API Key
  const generateApiKey = useCallback(() => {
    const randomHex = (len: number) => {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
      return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
    }
    
    let newKey: string
    switch (apiKeyFormat) {
      case 'sk':
        newKey = `sk-${randomHex(48)}`
        break
      case 'simple':
        newKey = `PROXY_KEY_${randomHex(32).toUpperCase()}`
        break
      case 'token':
        newKey = `PROXY_KEY:${randomHex(32)}`
        break
      default:
        newKey = `sk-${randomHex(48)}`
    }
    
    setConfig(prev => ({ ...prev, apiKey: newKey }))
    window.api.proxyUpdateConfig({ apiKey: newKey })
    setShowApiKey(true)
    setApiKeyGenerated(true)
    setTimeout(() => setApiKeyGenerated(false), 1500)
  }, [apiKeyFormat])

  // 复制 API Key
  const copyApiKey = useCallback(() => {
    if (config.apiKey) {
      navigator.clipboard.writeText(config.apiKey)
      setApiKeyCopied(true)
      setTimeout(() => setApiKeyCopied(false), 1500)
    }
  }, [config.apiKey])

  // 获取状态
  const fetchStatus = useCallback(async () => {
    try {
      const result = await window.api.proxyGetStatus()
      setIsRunning(result.running)
      if (result.config) {
        const cfg = result.config as ProxyConfig & { selectedAccountIds?: string[] }
        // 将 selectedAccountIds 数组转换为单个 selectedAccountId
        if (cfg.selectedAccountIds && cfg.selectedAccountIds.length > 0) {
          cfg.selectedAccountId = cfg.selectedAccountIds[0]
        }
        const clientDrivenToolExecution = cfg.clientDrivenToolExecution !== false
        setConfig({
          ...cfg,
          clientDrivenToolExecution
        })
      }
      if (result.stats) {
        setStats(result.stats as ProxyStats)
      }
      if (result.sessionStats) {
        setSessionStats(result.sessionStats as SessionStats)
      }

      const accountsResult = await window.api.proxyGetAccounts()
      setAccountCount(accountsResult.accounts.length)
      setAvailableCount(accountsResult.availableCount)
    } catch (err) {
      console.error('Failed to fetch proxy status:', err)
    }
  }, [])

  const fetchTunnelStatus = useCallback(async () => {
    if (typeof window.api.dashboardTunnelGetStatus !== 'function') return
    try {
      const status = await window.api.dashboardTunnelGetStatus()
      setTunnelStatus(status)
      setTunnelTarget(current => current || status.localUrl || '')
    } catch (err) {
      console.error('Failed to fetch dashboard tunnel status:', err)
    }
  }, [])

  const handleTunnelStart = async () => {
    if (typeof window.api.dashboardTunnelStart !== 'function') return
    setTunnelLoading(true)
    setError(null)
    try {
      const result = await window.api.dashboardTunnelStart({ localUrl: tunnelTarget.trim() || undefined })
      setTunnelStatus(result.status)
      setTunnelTarget(result.status.localUrl)
      if (!result.success) setError(result.error || result.status.error || 'Không bật được Dashboard Tunnel')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTunnelLoading(false)
    }
  }

  const handleTunnelStop = async () => {
    if (typeof window.api.dashboardTunnelStop !== 'function') return
    setTunnelLoading(true)
    setError(null)
    try {
      const result = await window.api.dashboardTunnelStop()
      setTunnelStatus(result.status)
      if (!result.success) setError(result.error || result.status.error || 'Không tắt được Dashboard Tunnel')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setTunnelLoading(false)
    }
  }

  const copyTunnelUrl = useCallback(() => {
    if (!tunnelStatus?.publicUrl) return
    navigator.clipboard.writeText(tunnelStatus.publicUrl)
    setTunnelCopied(true)
    setTimeout(() => setTunnelCopied(false), 1500)
  }, [tunnelStatus?.publicUrl])

  const loadAvailableModels = useCallback(async () => {
    try {
      const result = await window.api.proxyGetModels()
      if (result.success && result.models) {
        setAvailableModels(result.models.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name || m.id })))
      }
    } catch {
    }
  }, [])

  // 同步账号到反代池
  // override 用于「改了分组配置立即重同步」场景：setConfig 后闭包里的 config 可能是旧值，
  // 调用方传入新模式 / 新分组 ids，强制覆盖。
  const syncAccounts = useCallback(async (override?: {
    mode?: 'all' | 'groups'
    groupIds?: string[]
  }) => {
    setIsSyncing(true)
    setSyncSuccess(false)
    try {
      const selMode = override?.mode ?? config.multiAccountSelectionMode ?? 'all'
      const selGroupIds = override?.groupIds ?? config.multiAccountGroupIds ?? []
      let candidates = Array.from(accounts.values())
        .filter(acc => acc.status === 'active' && acc.credentials?.accessToken)

      // 多账号轮询 + 'groups' 范围：按选中分组过滤（'__ungrouped__' 表示未分组账号）
      if (config.enableMultiAccount && selMode === 'groups') {
        const gids = new Set(selGroupIds)
        candidates = candidates.filter(acc => {
          if (!acc.groupId) return gids.has('__ungrouped__')
          return gids.has(acc.groupId)
        })
      }

      const proxyAccounts = candidates.map(acc => ({
          id: acc.id,
          email: acc.email,
          accessToken: acc.credentials.accessToken,
          refreshToken: acc.credentials?.refreshToken,
          profileArn: acc.profileArn,
          expiresAt: acc.credentials?.expiresAt,
          machineId: acc.machineId,
          // Token 刷新所需字段
          clientId: acc.credentials?.clientId,
          clientSecret: acc.credentials?.clientSecret,
          region: acc.credentials?.region || 'us-east-1',
          authMethod: acc.credentials?.authMethod,
          provider: acc.credentials?.provider || acc.idp,
          // 透传分组 ID：后端 getAvailableAccount 可据此做二次过滤（双保险），即便前端忘了重同步也安全
          groupId: acc.groupId
        }))

      const result = await window.api.proxySyncAccounts(proxyAccounts)
      if (result.success) {
        setAccountCount(result.accountCount || 0)
        await fetchStatus()
        setSyncSuccess(true)
        setTimeout(() => setSyncSuccess(false), 2000)
      }
    } catch (err) {
      console.error('Failed to sync accounts:', err)
    } finally {
      setIsSyncing(false)
    }
  }, [accounts, fetchStatus, config.enableMultiAccount, config.multiAccountSelectionMode, config.multiAccountGroupIds])

  // 启动服务器
  const handleStart = async () => {
    setError(null)
    try {
      // 先同步账号
      await syncAccounts()

      const result = await window.api.proxyStart({
        port: config.port,
        host: config.host,
        apiKey: config.apiKey,
        enableMultiAccount: config.enableMultiAccount,
        enabled: true,
        autoStart: config.autoStart,
        accountSelectionStrategy: config.enableMultiAccount ? (config.accountSelectionStrategy || 'smart') : config.accountSelectionStrategy,
        sessionAffinityEnabled: config.enableMultiAccount && (config.accountSelectionStrategy || 'smart') !== 'sticky'
          ? false
          : config.sessionAffinityEnabled,
        logRequests: config.logRequests,
        clientDrivenToolExecution: config.clientDrivenToolExecution !== false,
        disableTools: config.disableTools
      })

      if (result.success) {
        setIsRunning(true)
        setConfig(prev => ({ ...prev, enabled: true }))
        await fetchStatus()
      } else {
        setError(result.error || (isEn ? 'Failed to start' : 'Khởi động thất bại'))
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // 停止服务器
  const handleStop = async () => {
    setError(null)
    try {
      const result = await window.api.proxyStop()
      if (result.success) {
        setIsRunning(false)
        setConfig(prev => ({ ...prev, enabled: false }))
        setStats(null)
      } else {
        setError(result.error || (isEn ? 'Failed to stop' : 'Dừng thất bại'))
      }
    } catch (err) {
      setError((err as Error).message)
    }
  }

  // 复制地址（0.0.0.0 对人不可读，复制为 localhost）
  const copyAddress = () => {
    const displayHost = config.host === '0.0.0.0' ? 'localhost' : config.host
    const address = `http://${displayHost}:${config.port}`
    navigator.clipboard.writeText(address)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // 刷新模型缓存
  const handleRefreshModels = async () => {
    setIsRefreshingModels(true)
    setRefreshSuccess(false)
    try {
      const result = await window.api.proxyRefreshModels()
      if (result.success) {
        await loadAvailableModels()
        setRefreshSuccess(true)
        setTimeout(() => setRefreshSuccess(false), 2000)
      } else {
        setError(result.error || (isEn ? 'Failed to refresh models' : 'Làm mới model thất bại'))
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIsRefreshingModels(false)
    }
  }

  // 加载历史日志
  useEffect(() => {
    window.api.proxyLoadLogs().then(result => {
      if (result.success && result.logs.length > 0) {
        setRecentLogs(result.logs)
      }
    })
  }, [])

  // 保存日志（防抖）
  useEffect(() => {
    void fetchTunnelStatus()
    const timer = setInterval(() => void fetchTunnelStatus(), 5000)
    return () => clearInterval(timer)
  }, [fetchTunnelStatus])

  useEffect(() => {
    if (recentLogs.length === 0) return
    const timer = setTimeout(() => {
      window.api.proxySaveLogs(recentLogs)
    }, 2000)
    return () => clearTimeout(timer)
  }, [recentLogs])

  // 初始化
  useEffect(() => {
    fetchStatus()
    loadAvailableModels()

    // 监听事件
    const unsubRequest = window.api.onProxyRequest((info) => {
      console.log('[Proxy] Request:', info)
    })

    // onProxyResponse：模块级单次订阅；这里只注册 setter 通道 + 拉取请求触发统计刷新
    ensureProxyResponseListenerRegistered()
    _refSetProxyRecentLogs = setRecentLogs
    // 触发一次统计刷新即可（统计有独立的 fetchStatus，不依赖订阅）
    const unsubStatsHook = window.api.onProxyResponse(() => { fetchStatus() })

    const unsubError = window.api.onProxyError((err) => {
      console.error('[Proxy] Error:', err)
      setError(err)
    })

    const unsubStatus = window.api.onProxyStatusChange((status) => {
      setIsRunning(status.running)
      if (status.running) {
        setConfig(prev => ({ ...prev, port: status.port }))
      }
    })

    return () => {
      unsubRequest()
      unsubStatsHook()
      unsubError()
      unsubStatus()
      _refSetProxyRecentLogs = null
    }
  }, [fetchStatus, loadAvailableModels])

  useEffect(() => {
    const refreshIfVisible = () => {
      if (!document.hidden) void fetchStatus()
    }
    document.addEventListener('visibilitychange', refreshIfVisible)
    const timer = setInterval(refreshIfVisible, PROXY_STATUS_REFRESH_MS)
    return () => {
      document.removeEventListener('visibilitychange', refreshIfVisible)
      clearInterval(timer)
    }
  }, [fetchStatus])

  // 用 ref 持有最新的 syncAccounts，避免把它放进下方 effect 依赖导致循环重触发
  const syncAccountsRef = useRef(syncAccounts)
  useEffect(() => { syncAccountsRef.current = syncAccounts }, [syncAccounts])

  /**
   * 账号集合签名：只反映"参与同步的账号 id + 分组"，**不含** token / 用量 / 状态时间戳。
   * 这样后台 token 刷新、用量更新等高频变动不会触发重新同步（避免按钮疯狂闪烁），
   * 仅在真正增删账号 / 改分组时才同步。token 更新由主进程账号池自身刷新逻辑处理。
   */
  const accountsSyncSignature = useMemo(() => {
    return Array.from(accounts.values())
      .filter(a => a.status === 'active' && a.credentials?.accessToken)
      .map(a => `${a.id}:${a.groupId || ''}`)
      .sort()
      .join('|')
  }, [accounts])

  // 账号集合变化时同步（防抖 600ms + 仅签名变化才触发；跳过首次 mount 避免每次进页面都同步）
  const syncMountedRef = useRef(false)
  useEffect(() => {
    if (!isRunning) return
    if (!syncMountedRef.current) {
      syncMountedRef.current = true
      return
    }
    const timer = setTimeout(() => { void syncAccountsRef.current() }, 600)
    return () => clearTimeout(timer)
  }, [accountsSyncSignature, isRunning])

  // 实时更新运行时间
  const [uptime, setUptime] = useState(0)
  useEffect(() => {
    if (!isRunning || !stats) {
      setUptime(0)
      return
    }
    
    // 立即计算一次
    setUptime(Math.floor((Date.now() - stats.startTime) / 1000))
    
    // 每秒更新
    const timer = setInterval(() => {
      setUptime(Math.floor((Date.now() - stats.startTime) / 1000))
    }, 1000)
    
    return () => clearInterval(timer)
  }, [isRunning, stats])
  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    return `${h}h ${m}m ${s}s`
  }

  return (
    <div className="space-y-4">
      {/* 状态卡片 */}
      <Card className="hover-lift relative z-10">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Server className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg text-primary">{isEn ? 'Kiro API Proxy' : 'Kiro API Proxy'}</CardTitle>
                <CardDescription>
                  {isEn ? 'Provides OpenAI and Claude compatible API endpoints' : 'Cung cấp endpoint tương thích OpenAI và Claude'}
                </CardDescription>
              </div>
            </div>
            <Badge 
              variant={isRunning ? 'default' : 'secondary'} 
              className={isRunning 
                ? 'bg-success text-white flex items-center gap-1.5 pr-2.5' 
                : 'bg-muted text-muted-foreground flex items-center gap-1.5 pr-2.5'}
            >
              <span className={isRunning 
                ? 'relative flex h-2 w-2' 
                : 'relative flex h-2 w-2'}>
                {isRunning && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                )}
                <span className={isRunning 
                  ? 'relative inline-flex rounded-full h-2 w-2 bg-white' 
                  : 'relative inline-flex rounded-full h-2 w-2 bg-muted-foreground'}></span>
              </span>
              {isRunning ? (isEn ? 'Running' : 'Đang chạy') : (isEn ? 'Stopped' : 'Đã dừng')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 控制按钮 */}
          <div className="flex items-center gap-2">
            {!isRunning ? (
              <Button onClick={handleStart} className="gap-2">
                <Play className="h-4 w-4" />
                {isEn ? 'Start Service' : 'Bật dịch vụ'}
              </Button>
            ) : (
              <Button onClick={handleStop} variant="destructive" className="gap-2">
                <Square className="h-4 w-4" />
                {isEn ? 'Stop Service' : 'Tắt dịch vụ'}
              </Button>
            )}
            <Button onClick={() => void syncAccounts()} variant="outline" className="gap-2" disabled={!isRunning || isSyncing}>
              {isSyncing ? <Loader2 className="h-4 w-4 animate-spin" /> : syncSuccess ? <Check className="h-4 w-4 text-success" /> : <RefreshCw className="h-4 w-4" />}
              {isSyncing ? (isEn ? 'Syncing...' : 'Đang đồng bộ...') : syncSuccess ? (isEn ? 'Synced!' : 'Đã đồng bộ') : (isEn ? 'Sync Accounts' : 'Đồng bộ tài khoản')}
            </Button>
            <Button onClick={handleRefreshModels} variant="outline" className="gap-2" disabled={!isRunning || isRefreshingModels}>
              {isRefreshingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : refreshSuccess ? <Check className="h-4 w-4 text-success" /> : <RefreshCw className="h-4 w-4" />}
              {isRefreshingModels ? (isEn ? 'Refreshing...' : 'Đang làm mới...') : refreshSuccess ? (isEn ? 'Refreshed!' : 'Đã làm mới') : (isEn ? 'Refresh Models' : 'Làm mới model')}
            </Button>
            <Button onClick={() => setShowModelsDialog(true)} variant="outline" className="gap-2" disabled={!isRunning}>
              <Cpu className="h-4 w-4" />
              {isEn ? 'View Models' : 'Xem model'}
            </Button>
            <Button onClick={() => setShowClientConfigDialog(true)} variant="outline" className="gap-2">
              <Settings2 className="h-4 w-4" />
              {isEn ? 'Configure Clients' : 'Cấu hình client'}
            </Button>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="flex items-center gap-2 text-destructive text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {/* 服务地址 */}
          {isRunning && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Label className="min-w-[80px]">{isEn ? 'Address:' : 'Địa chỉ:'}</Label>
                <code className="flex-1 px-3 py-2 bg-muted rounded text-sm">
                  http://{config.host === '0.0.0.0' ? 'localhost' : config.host}:{config.port}
                </code>
                <Button variant="outline" size="icon" onClick={copyAddress}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              {config.host === '0.0.0.0' && (
                <p className="text-xs text-muted-foreground pl-[88px]">
                  {isEn
                    ? `LAN devices use http://<this-machine-IP>:${config.port}`
                    : `Thiết bị khác dùng http://<IP-máy-này>:${config.port}`}
                </p>
              )}
            </div>
          )}

          {/* 基础配置 — 4 列紧凑布局：端口 + 监听 + API Key + 格式选择 */}
          <div className="rounded-lg border bg-background/70 p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-md bg-primary/10">
                  <Globe className="h-4 w-4 text-primary" />
                </div>
                <div>
                  <div className="text-sm font-semibold">{isEn ? 'Dashboard Tunnel' : 'Tunnel dashboard'}</div>
                  <div className="text-xs text-muted-foreground">
                    {isEn
                      ? 'Expose the dashboard with Cloudflare Quick Tunnel. Login is still required.'
                      : 'Mở dashboard bằng Cloudflare Quick Tunnel. Người dùng vẫn phải đăng nhập.'}
                  </div>
                </div>
              </div>
              <Badge variant={tunnelStatus?.running ? 'default' : 'secondary'} className={tunnelStatus?.running ? 'bg-success text-white' : ''}>
                {tunnelStatus?.running ? (isEn ? 'Online' : 'Đang bật') : (isEn ? 'Off' : 'Đang tắt')}
              </Badge>
            </div>
            <div className="grid grid-cols-12 gap-2 items-end">
              <div className="col-span-8 space-y-1.5">
                <Label htmlFor="tunnelTarget" className="text-xs">{isEn ? 'Local dashboard target' : 'Đích dashboard nội bộ'}</Label>
                <Input
                  id="tunnelTarget"
                  value={tunnelTarget}
                  onChange={(event) => setTunnelTarget(event.target.value)}
                  placeholder={isEn ? 'Example: http://127.0.0.1 or http://127.0.0.1:4010' : 'Ví dụ: http://127.0.0.1 hoặc http://127.0.0.1:4010'}
                  disabled={tunnelStatus?.running || tunnelLoading}
                  className="h-9"
                />
              </div>
              <div className="col-span-4 flex gap-2">
                {tunnelStatus?.running ? (
                  <Button onClick={handleTunnelStop} variant="outline" className="gap-2 flex-1" disabled={tunnelLoading}>
                    {tunnelLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                    {isEn ? 'Stop Tunnel' : 'Tắt tunnel'}
                  </Button>
                ) : (
                  <Button onClick={handleTunnelStart} variant="outline" className="gap-2 flex-1" disabled={tunnelLoading}>
                    {tunnelLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {isEn ? 'Start Tunnel' : 'Bật tunnel'}
                  </Button>
                )}
              </div>
            </div>
            {tunnelStatus?.publicUrl && (
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-muted rounded text-sm truncate">{tunnelStatus.publicUrl}</code>
                <Button variant="outline" size="icon" onClick={copyTunnelUrl} title={isEn ? 'Copy tunnel URL' : 'Sao chép link tunnel'}>
                  {tunnelCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={() => window.api.openExternal(tunnelStatus.publicUrl!)} title={isEn ? 'Open tunnel' : 'Mở tunnel'}>
                  <ExternalLink className="h-4 w-4" />
                </Button>
              </div>
            )}
            {tunnelStatus?.error && (
              <div className="text-xs text-destructive">{tunnelStatus.error}</div>
            )}
            {tunnelStatus && !tunnelStatus.running && !tunnelStatus.error && (
              <div className="text-xs text-muted-foreground">
                {isEn
                  ? `Binary: ${tunnelStatus.binary}. Set CLOUDFLARED_BIN if cloudflared is not in PATH.`
                  : `File chạy: ${tunnelStatus.binary}. Nếu cloudflared không có trong PATH, đặt CLOUDFLARED_BIN.`}
              </div>
            )}
          </div>

          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="port" className="text-xs">{isEn ? 'Port' : 'Cổng'}</Label>
              <Input
                id="port"
                type="number"
                value={config.port}
                onChange={(e) => {
                  const newPort = parseInt(e.target.value) || 5580
                  setConfig(prev => ({ ...prev, port: newPort }))
                  window.api.proxyUpdateConfig({ port: newPort })
                }}
                disabled={isRunning}
                className="h-9"
              />
            </div>
            <div className="col-span-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="host" className="text-xs" title={config.host === '0.0.0.0' ? (isEn ? 'LAN access enabled. Set an API Key and allow port through firewall.' : 'Đang cho phép truy cập ngoài máy; nên đặt API Key và mở cổng firewall') : (isEn ? 'Loopback only. Toggle Public for LAN access.' : 'Chỉ chạy nội bộ; bật Public để thiết bị khác truy cập')}>{isEn ? 'Host' : 'Địa chỉ nghe'}</Label>
                <div className="flex items-center gap-1">
                  <Switch
                    id="publicAccess"
                    checked={config.host === '0.0.0.0'}
                    onCheckedChange={async (checked) => {
                      const newHost = checked ? '0.0.0.0' : '127.0.0.1'
                      setConfig(prev => ({ ...prev, host: newHost }))
                      await window.api.proxyUpdateConfig({ host: newHost })
                      if (isRunning) {
                        try {
                          await window.api.proxyStop()
                          await new Promise(r => setTimeout(r, 200))
                          await window.api.proxyStart()
                        } catch (err) {
                          console.error('[Proxy] Failed to restart after host change:', err)
                          setError(err instanceof Error ? err.message : String(err))
                        }
                      }
                    }}
                    className="scale-75"
                  />
                  <Label htmlFor="publicAccess" className="text-[10px] cursor-pointer">{isEn ? 'Public' : 'Public'}</Label>
                </div>
              </div>
              <Input
                id="host"
                value={config.host}
                onChange={(e) => {
                  const newHost = e.target.value
                  setConfig(prev => ({ ...prev, host: newHost }))
                  window.api.proxyUpdateConfig({ host: newHost })
                }}
                disabled={isRunning}
                className={`h-9 ${config.host === '0.0.0.0' ? 'border-warning/50' : ''}`}
              />
            </div>
            {/* API Key 区：占 7 列 */}
            <div className="col-span-7 space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="apiKey" className="text-xs" title={isEn ? 'When set, requests must provide this key in Authorization or X-Api-Key header' : 'Khi đặt key, request phải gửi qua header Authorization hoặc X-Api-Key'}>{isEn ? 'API Key (Optional)' : 'API Key (tùy chọn)'}</Label>
                <div className="flex items-center gap-1">
                  <Select
                    value={apiKeyFormat}
                    options={[
                      { value: 'sk', label: 'sk-xxx' },
                      { value: 'simple', label: 'PROXY_KEY' },
                      { value: 'token', label: 'KEY:TOKEN' }
                    ]}
                    onChange={(v) => setApiKeyFormat(v as 'sk' | 'simple' | 'token')}
                    className="w-[120px] h-7 text-xs [&>button]:h-7 [&>button]:py-0 [&>button]:px-2.5"
                  />
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={generateApiKey} disabled={isRunning} title={isEn ? 'Generate' : 'Tạo ngẫu nhiên'}>
                    {apiKeyGenerated ? <Check className="h-3.5 w-3.5 text-success" /> : <Dices className="h-3.5 w-3.5" />}
                  </Button>
                  {config.apiKey && (
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyApiKey} title={isEn ? 'Copy' : 'Sao chép'}>
                      {apiKeyCopied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setShowApiKeyManager(true)} title={isEn ? 'Manage Multiple API Keys' : 'Quản lý nhiều API Key'}>
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="relative">
                <Input
                  id="apiKey"
                  type={showApiKey ? 'text' : 'password'}
                  placeholder={isEn ? 'Leave empty to skip auth' : 'Để trống để bỏ xác thực'}
                  value={config.apiKey || ''}
                  onChange={(e) => {
                    const newApiKey = e.target.value || undefined
                    setConfig(prev => ({ ...prev, apiKey: newApiKey }))
                    window.api.proxyUpdateConfig({ apiKey: newApiKey })
                  }}
                  disabled={isRunning}
                  className="pr-9 h-9"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-2.5 hover:bg-transparent"
                  onClick={() => setShowApiKey(!showApiKey)}
                  title={showApiKey ? (isEn ? 'Hide' : 'Ẩn') : (isEn ? 'Show' : 'Hiện')}
                >
                  {showApiKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          </div>


          {/* 运行模式开关区 — 网格化对齐，避免 flex-wrap 造成的凌乱布局 */}
          <div className="grid grid-cols-3 gap-x-4 gap-y-3 items-center">
            <div className="flex items-center gap-2">
              <Switch
                id="autoStart"
                checked={config.autoStart || false}
                onCheckedChange={async (checked) => {
                  const patch: Partial<ProxyConfig> = checked
                    ? { autoStart: true, enabled: true }
                    : { autoStart: false, enabled: isRunning }
                  setConfig(prev => ({ ...prev, ...patch }))
                  const result = await window.api.proxyUpdateConfig(patch)
                  if (!result.success) {
                    setError(result.error || (isEn ? 'Failed to update auto start' : 'Không lưu được tự khởi động'))
                  }
                  await fetchStatus()
                }}
              />
              <Label htmlFor="autoStart" className="text-sm cursor-pointer">{isEn ? 'Auto Start' : 'Tự khởi động'}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="multiAccount"
                checked={config.enableMultiAccount}
                onCheckedChange={(checked) => {
                  const patch: Partial<ProxyConfig> = checked
                    ? { enableMultiAccount: true, accountSelectionStrategy: 'smart', sessionAffinityEnabled: false }
                    : { enableMultiAccount: false }
                  setConfig(prev => ({ ...prev, ...patch }))
                  window.api.proxyUpdateConfig(patch)
                }}
                disabled={isRunning}
              />
              <Label htmlFor="multiAccount" className="text-sm cursor-pointer">{isEn ? 'Multi-Account' : 'Nhiều tài khoản'}</Label>
            </div>
            {/* 开启多账号轮询时显示策略选择 */}
            {config.enableMultiAccount && (
              <div className="col-span-2 flex items-center gap-2">
                <Label className="text-sm shrink-0">
                  {isEn ? 'Strategy' : 'Chiến lược'}:
                </Label>
                <div className="flex gap-1 bg-muted/30 rounded-lg p-0.5">
                  {(['smart', 'round-robin', 'least-used', 'sticky'] as const).map(strategy => {
                    const active = (config.accountSelectionStrategy || 'smart') === strategy
                    const labelEn = strategy === 'smart' ? 'Smart' : strategy === 'round-robin' ? 'Round-Robin' : strategy === 'least-used' ? 'Least-Used' : 'Sticky'
                    const labelZh = strategy === 'smart' ? 'Thông minh' : strategy === 'round-robin' ? 'Xoay vòng' : strategy === 'least-used' ? 'Ít dùng nhất' : 'Bám phiên'
                    return (
                      <button
                        key={strategy}
                        type="button"
                        disabled={isRunning}
                        className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                          active
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                        onClick={() => {
                          const patch: Partial<ProxyConfig> = strategy !== 'sticky'
                            ? { accountSelectionStrategy: strategy, sessionAffinityEnabled: false }
                            : { accountSelectionStrategy: strategy }
                          setConfig(prev => ({ ...prev, ...patch }))
                          window.api.proxyUpdateConfig(patch)
                        }}
                      >
                        {isEn ? labelEn : labelZh}
                      </button>
                    )
                  })}
                </div>
                <span className="text-xs text-muted-foreground">
                  {(() => {
                    const strategy = config.accountSelectionStrategy || 'smart'
                    if (strategy === 'smart') return isEn ? 'Score quota, errors, latency and token freshness before each request' : 'Chấm điểm quota, lỗi, độ trễ và token trước mỗi request'
                    if (strategy === 'least-used') return isEn ? 'Pick the account with the fewest successful requests' : 'Chọn tài khoản có số request thành công thấp nhất'
                    if (strategy === 'sticky') return isEn ? 'Stay on success account until failure (preserves prompt cache)' : 'Giữ tài khoản đang thành công cho tới khi lỗi'
                    return isEn ? 'Each request rotates to next account (load balanced)' : 'Mỗi request chuyển sang tài khoản kế tiếp để cân bằng tải'
                  })()}
                </span>
              </div>
            )}
            {/* 多账号轮询范围：全部账号 / 指定分组 */}
            {config.enableMultiAccount && (() => {
              const selMode = config.multiAccountSelectionMode || 'all'
              const selectedGids = new Set(config.multiAccountGroupIds || [])
              const sortedGroups = Array.from(groups.values()).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              const accountList = Array.from(accounts.values()).filter(a => a.status === 'active' && a.credentials?.accessToken)
              const ungroupedCount = accountList.filter(a => !a.groupId).length
              const countByGroup = new Map<string, number>()
              for (const a of accountList) if (a.groupId) countByGroup.set(a.groupId, (countByGroup.get(a.groupId) || 0) + 1)
              const selectedAccountTotal = selMode === 'all'
                ? accountList.length
                : accountList.filter(a => !a.groupId ? selectedGids.has('__ungrouped__') : selectedGids.has(a.groupId)).length
              const toggleGid = (gid: string) => {
                const next = new Set(selectedGids)
                if (next.has(gid)) next.delete(gid); else next.add(gid)
                const ids = Array.from(next)
                setConfig(prev => ({ ...prev, multiAccountGroupIds: ids }))
                window.api.proxyUpdateConfig({ multiAccountGroupIds: ids })
                // 关键：立即用新分组 ids 重新同步账号池，避免「改了分组但反代仍用旧账号」的体感 bug
                void syncAccounts({ mode: 'groups', groupIds: ids })
              }
              return (
                <div className="col-span-2 flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Label className="text-sm shrink-0">{isEn ? 'Scope' : 'Phạm vi'}:</Label>
                    <div className="flex gap-1 bg-muted/30 rounded-lg p-0.5">
                      {(['all', 'groups'] as const).map(mode => {
                        const active = selMode === mode
                        const label = mode === 'all'
                          ? (isEn ? 'All Accounts' : 'Tất cả tài khoản')
                          : (isEn ? 'Specific Groups' : 'Nhóm đã chọn')
                        return (
                          <button
                            key={mode}
                            type="button"
                            disabled={isRunning}
                            className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                              active ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                            onClick={() => {
                              setConfig(prev => ({ ...prev, multiAccountSelectionMode: mode }))
                              window.api.proxyUpdateConfig({ multiAccountSelectionMode: mode })
                              // 关键：切换 all/groups 立即重新同步账号池
                              void syncAccounts({ mode, groupIds: Array.from(selectedGids) })
                            }}
                          >
                            {label}
                          </button>
                        )
                      })}
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {selMode === 'all'
                        ? (isEn ? `${selectedAccountTotal} active accounts` : `${selectedAccountTotal} tài khoản hoạt động`)
                        : (isEn ? `${selectedAccountTotal} accounts in selected groups` : `${selectedAccountTotal} tài khoản trong nhóm đã chọn`)}
                    </span>
                  </div>

                  {/* 分组多选 chip：仅 groups 模式 */}
                  {selMode === 'groups' && (
                    <div className="flex flex-wrap items-center gap-1.5 pl-[60px]">
                      {/* 未分组特殊 chip */}
                      <button
                        type="button"
                        disabled={isRunning}
                        onClick={() => toggleGid('__ungrouped__')}
                        className={`flex items-center gap-1 px-2 h-7 rounded-md text-xs font-medium border transition-all ${
                          selectedGids.has('__ungrouped__')
                            ? 'bg-muted text-foreground border-muted-foreground/30'
                            : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/40'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        {selectedGids.has('__ungrouped__') && <Check className="h-3 w-3" />}
                        <span>{isEn ? 'Ungrouped' : 'Chưa nhóm'}</span>
                        <span className="text-[10px] opacity-70">({ungroupedCount})</span>
                      </button>
                      {/* 用户分组 chips */}
                      {sortedGroups.map(group => {
                        const isSel = selectedGids.has(group.id)
                        const count = countByGroup.get(group.id) || 0
                        return (
                          <button
                            key={group.id}
                            type="button"
                            disabled={isRunning}
                            onClick={() => toggleGid(group.id)}
                            className={`flex items-center gap-1 px-2 h-7 rounded-md text-xs font-medium border transition-all ${
                              isSel ? 'text-foreground' : 'bg-background text-muted-foreground border-border hover:text-foreground hover:border-primary/40'
                            } disabled:opacity-50 disabled:cursor-not-allowed`}
                            style={isSel ? {
                              backgroundColor: (group.color || '#888') + '22',
                              borderColor: (group.color || '#888') + '66'
                            } : undefined}
                          >
                            {isSel && <Check className="h-3 w-3" style={{ color: group.color || undefined }} />}
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: group.color || '#888' }} />
                            <span>{group.name}</span>
                            <span className="text-[10px] opacity-70">({count})</span>
                          </button>
                        )
                      })}
                      {sortedGroups.length === 0 && (
                        <span className="text-xs text-muted-foreground italic">
                          {isEn ? 'No groups defined yet. Create groups in Account Manager first.' : 'Chưa có nhóm nào. Hãy tạo nhóm trong trang Tài khoản trước.'}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}
            {/* 关闭多账号轮询时显示账号选择按钮和自动切换开关 */}
            {!config.enableMultiAccount && (
              <>
                <div className="col-span-2">
                  <Button
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => setShowAccountSelectDialog(true)}
                    disabled={isRunning}
                  >
                    <UserCheck className="h-4 w-4 mr-2" />
                    {config.selectedAccountId ? (
                      (() => {
                        const acc = accounts.get(config.selectedAccountId)
                        return acc ? (acc.email || acc.id.substring(0, 12) + '...') : (isEn ? 'First Available' : 'Tài khoản khả dụng đầu tiên')
                      })()
                    ) : (
                      isEn ? 'First Available' : 'Tài khoản khả dụng đầu tiên'
                    )}
                  </Button>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="autoSwitchOnQuotaExhausted"
                    checked={config.autoSwitchOnQuotaExhausted || false}
                    onCheckedChange={(checked) => {
                      setConfig(prev => ({ ...prev, autoSwitchOnQuotaExhausted: checked }))
                      window.api.proxyUpdateConfig({ autoSwitchOnQuotaExhausted: checked })
                    }}
                    disabled={isRunning}
                  />
                  <Label htmlFor="autoSwitchOnQuotaExhausted" className="text-sm cursor-pointer truncate" title={isEn ? 'Auto-switch on quota exhausted' : 'Tự chuyển khi tài khoản hết hạn mức'}>
                    {isEn ? 'Auto-switch' : 'Tự chuyển'}
                  </Label>
                </div>
              </>
            )}
            <div className="flex items-center gap-2">
              <Switch
                id="logRequests"
                checked={config.logRequests}
                onCheckedChange={(checked) => {
                  setConfig(prev => ({ ...prev, logRequests: checked }))
                  window.api.proxyUpdateConfig({ logRequests: checked })
                }}
              />
              <Label htmlFor="logRequests" className="text-sm cursor-pointer">{isEn ? 'Log Requests' : 'Ghi log request'}</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="logStreamEvents"
                checked={config.logStreamEvents || false}
                onCheckedChange={(checked) => {
                  setConfig(prev => ({ ...prev, logStreamEvents: checked }))
                  window.api.proxyUpdateConfig({ logStreamEvents: checked })
                }}
              />
              <Label htmlFor="logStreamEvents" className="text-sm cursor-pointer">{isEn ? 'Stream Events' : 'Sự kiện stream'}</Label>
            </div>
          </div>

          {/* 高级配置 — 3 列紧凑布局，描述移到 Label 的 title tooltip */}
          <div className="border-t border-border pt-3 overflow-visible">
            <h4 className="text-xs font-medium mb-2 text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
              <Settings2 className="h-3.5 w-3.5" />
              {isEn ? 'Advanced Settings' : 'Cài đặt nâng cao'}
            </h4>
            <div className="grid grid-cols-3 gap-x-3 gap-y-3 items-start overflow-visible">
              <div className="space-y-1.5 relative z-20">
                <Label htmlFor="preferredEndpoint" className="text-xs">{isEn ? 'Preferred Endpoint' : 'Endpoint ưu tiên'}</Label>
                <Select
                  value={config.preferredEndpoint || ''}
                  options={[
                    { value: '', label: isEn ? 'Auto Select' : 'Tự chọn', description: isEn ? 'Auto select based on availability' : 'Tự chọn endpoint theo khả dụng' },
                    { value: 'codewhisperer', label: 'CodeWhisperer', description: isEn ? 'IDE mode endpoint' : 'Endpoint chế độ IDE' },
                    { value: 'amazonq', label: 'AmazonQ', description: isEn ? 'IDE mode (q.amazonaws.com)' : 'Chế độ IDE (q.amazonaws.com)' },
                    { value: 'amazonq-cli', label: 'AmazonQ CLI', description: isEn ? 'CLI mode (SendMessageStreaming)' : 'Chế độ CLI (SendMessageStreaming)' }
                  ]}
                  onChange={(value) => {
                    const endpoint = (value || undefined) as 'codewhisperer' | 'amazonq' | 'amazonq-cli' | undefined
                    setConfig(prev => ({ ...prev, preferredEndpoint: endpoint }))
                    window.api.proxyUpdateConfig({ preferredEndpoint: endpoint })
                  }}
                  placeholder={isEn ? 'Select endpoint' : 'Chọn endpoint'}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="maxRetries" className="text-xs">{isEn ? 'Max Retries' : 'Số lần thử lại tối đa'}</Label>
                <Input
                  id="maxRetries"
                  type="number"
                  min={0}
                  max={10}
                  value={config.maxRetries || 3}
                  onChange={(e) => {
                    const retries = parseInt(e.target.value) || 3
                    setConfig(prev => ({ ...prev, maxRetries: retries }))
                    window.api.proxyUpdateConfig({ maxRetries: retries })
                  }}
                  disabled={isRunning}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="payloadSizeLimit" className="text-xs" title={isEn ? 'When payload exceeds this limit, oldest tool results will be truncated. Default 1536KB (1.5MB).' : 'Khi payload vượt giới hạn này, kết quả tool cũ nhất sẽ bị cắt. Mặc định 1536KB (1.5MB).'}>{isEn ? 'Payload (KB)' : 'Payload (KB)'}</Label>
                <Input
                  id="payloadSizeLimit"
                  type="number"
                  min={256}
                  max={10240}
                  step={128}
                  value={config.payloadSizeLimitKB || 1536}
                  onChange={(e) => {
                    const kb = parseInt(e.target.value) || 1536
                    setConfig(prev => ({ ...prev, payloadSizeLimitKB: kb }))
                    window.api.proxyUpdateConfig({ payloadSizeLimitKB: kb })
                  }}
                  disabled={isRunning}
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="clientDrivenToolExecution" className="text-xs" title={isEn ? 'Recommended for OpenCode and Claude Code. Disable only when the proxy should fabricate tool results.' : 'Khuyến nghị cho OpenCode và Claude Code. Chỉ tắt khi muốn proxy tự tạo kết quả tool.'}>{isEn ? 'Tool Execution' : 'Thực thi tool'}</Label>
                <div className="flex items-center justify-between h-9 px-3 rounded-md border border-input bg-transparent">
                  <span className="text-xs text-muted-foreground">{isEn ? 'Client-driven' : 'Client xử lý'}</span>
                  <Switch
                    id="clientDrivenToolExecution"
                    checked={config.clientDrivenToolExecution !== false}
                    onCheckedChange={(checked) => {
                      setConfig(prev => ({ ...prev, clientDrivenToolExecution: checked }))
                      window.api.proxyUpdateConfig({ clientDrivenToolExecution: checked })
                    }}
                    disabled={isRunning}
                    className="scale-90"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="disableTools" className="text-xs" title={isEn ? 'When enabled, the proxy strips all tool definitions from requests.' : 'Khi bật, proxy sẽ loại bỏ toàn bộ định nghĩa tool khỏi request, phù hợp chat thuần.'}>{isEn ? 'Disable Tools' : 'Tắt gọi tool'}</Label>
                <div className="flex items-center justify-between h-9 px-3 rounded-md border border-input bg-transparent">
                  <span className="text-xs text-muted-foreground">{isEn ? 'No tool calls' : 'Không gọi tool'}</span>
                  <Switch
                    id="disableTools"
                    checked={config.disableTools || false}
                    onCheckedChange={(checked) => {
                      setConfig(prev => ({ ...prev, disableTools: checked }))
                      window.api.proxyUpdateConfig({ disableTools: checked })
                    }}
                    disabled={isRunning}
                    className="scale-90"
                  />
                </div>
              </div>
              {/* Token Buffer Reserve — 占 3 列合为一行：开关 + 输入 */}
              <div className="col-span-3 space-y-1.5">
                <Label htmlFor="tokenBufferReserve" className="text-xs" title={isEn ? 'When enabled, reserves N tokens below context window for trim (e.g. 200K → trim at 180K). When disabled, never trims.' : 'Khi bật, chừa N token dưới context window để làm ngưỡng cắt (ví dụ 200K -> cắt ở 180K). Khi tắt sẽ không cắt lịch sử.'}>{isEn ? 'Token Buffer Reserve (auto-trim history)' : 'Dự phòng token (tự cắt lịch sử)'}</Label>
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-between h-9 px-3 rounded-md border border-input bg-transparent w-[160px] flex-shrink-0">
                    <span className="text-xs text-muted-foreground">{isEn ? 'Auto-trim' : 'Bật tự cắt'}</span>
                    <Switch
                      id="enableTokenBufferReserve"
                      checked={config.enableTokenBufferReserve || false}
                      onCheckedChange={(checked) => {
                        setConfig(prev => ({ ...prev, enableTokenBufferReserve: checked }))
                        window.api.proxyUpdateConfig({ enableTokenBufferReserve: checked })
                      }}
                      disabled={isRunning}
                      className="scale-90"
                    />
                  </div>
                  <Input
                    id="tokenBufferReserve"
                    type="number"
                    min={5000}
                    max={150000}
                    step={1000}
                    value={config.tokenBufferReserve || 20000}
                    onChange={(e) => {
                      const tokens = parseInt(e.target.value) || 20000
                      setConfig(prev => ({ ...prev, tokenBufferReserve: tokens }))
                      window.api.proxyUpdateConfig({ tokenBufferReserve: tokens })
                    }}
                    disabled={isRunning || !config.enableTokenBufferReserve}
                    placeholder={isEn ? 'Reserve tokens (default 20000)' : 'Số token dự phòng (mặc định 20000)'}
                    className="h-9 flex-1"
                  />
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* v1.8 反代安全 / 可观测设置（独立卡片，可折叠） */}
      <ProxySecurityPanel
        config={config as unknown as Parameters<typeof ProxySecurityPanel>[0]['config']}
        setConfig={setConfig as unknown as Parameters<typeof ProxySecurityPanel>[0]['setConfig']}
        isRunning={isRunning}
        isEn={isEn}
      />

      {/* 统计卡片 */}
      {isRunning && (
        <div className="grid grid-cols-6 gap-3">
          <Card className="hover-lift bg-gradient-to-br from-blue-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Users className="h-3 w-3" />
                <span>{isEn ? 'Pool' : 'Pool tài khoản'}</span>
              </div>
              <div className="text-xl font-bold text-foreground">{availableCount}/{accountCount}</div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-purple-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Activity className="h-3 w-3" />
                  <span>{isEn ? 'Total' : 'Tổng request'}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-4 w-4 text-muted-foreground hover:text-destructive"
                  onClick={async () => {
                    await window.api.proxyResetRequestStats()
                    const result = await window.api.proxyGetStatus()
                    if (result.stats) {
                      setStats(result.stats as ProxyStats)
                    }
                    if (result.sessionStats) {
                      setSessionStats(result.sessionStats as SessionStats)
                    }
                  }}
                  title={isEn ? 'Reset Statistics' : 'Đặt lại thống kê'}
                >
                  <RotateCcw className="h-3 w-3" />
                </Button>
              </div>
              <div className="text-xl font-bold text-foreground">{stats?.totalRequests || 0}</div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-green-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Check className="h-3 w-3" />
                <span>{isEn ? 'Total S/F' : 'Tổng thành công/lỗi'}</span>
              </div>
              <div className="text-xl font-bold">
                <span className="text-success">{stats?.successRequests || 0}</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span className="text-destructive">{stats?.failedRequests || 0}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-cyan-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Zap className="h-3 w-3" />
                <span>{isEn ? 'Session' : 'Phiên này'}</span>
              </div>
              <div className="text-xl font-bold text-foreground">{sessionStats?.totalRequests || 0}</div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-orange-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Activity className="h-3 w-3" />
                <span>{isEn ? 'Session S/F' : 'Phiên thành công/lỗi'}</span>
              </div>
              <div className="text-xl font-bold">
                <span className="text-success">{sessionStats?.successRequests || 0}</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span className="text-destructive">{sessionStats?.failedRequests || 0}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-primary/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Clock className="h-3 w-3" />
                <span>{isEn ? 'Uptime' : 'Thời gian chạy'}</span>
              </div>
              <div className="text-xl font-bold text-primary whitespace-nowrap">{formatUptime(uptime)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 第二行统计卡片 - Token 分解和 Cache */}
      {isRunning && stats && (
        <div className="grid grid-cols-6 gap-3">
          <Card className="hover-lift bg-gradient-to-br from-indigo-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Activity className="h-3 w-3" />
                <span>{isEn ? 'Total Tokens' : 'Tổng token'}</span>
              </div>
              <div className="text-xl font-bold text-indigo-500" title={((stats.inputTokens || 0) + (stats.outputTokens || 0)).toLocaleString()}>{compactNumber((stats.inputTokens || 0) + (stats.outputTokens || 0))}</div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-blue-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Activity className="h-3 w-3" />
                <span>{isEn ? 'Input / Output' : 'Đầu vào / Đầu ra'}</span>
              </div>
              <div className="text-sm font-bold">
                <span className="text-blue-500" title={(stats.inputTokens || 0).toLocaleString()}>{compactNumber(stats.inputTokens || 0)}</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span className="text-purple-500" title={(stats.outputTokens || 0).toLocaleString()}>{compactNumber(stats.outputTokens || 0)}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-emerald-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Cpu className="h-3 w-3" />
                <span>{isEn ? 'Cache Hit' : 'Cache hit'}</span>
                {(() => {
                  const read = stats.cacheReadTokens || 0
                  const total = read + (stats.cacheWriteTokens || 0)
                  const rate = total > 0 ? (read / total * 100) : 0
                  return rate > 0 ? (
                    <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">{rate.toFixed(0)}%</Badge>
                  ) : null
                })()}
              </div>
              <div className="text-sm font-bold">
                <span className="text-emerald-500" title={`${isEn ? 'Cache Read' : 'Đọc cache'}: ${(stats.cacheReadTokens || 0).toLocaleString()}`}>{compactNumber(stats.cacheReadTokens || 0)}</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span className="text-amber-500" title={`${isEn ? 'Cache Write' : 'Ghi cache'}: ${(stats.cacheWriteTokens || 0).toLocaleString()}`}>{compactNumber(stats.cacheWriteTokens || 0)}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-violet-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Zap className="h-3 w-3" />
                <span>{isEn ? 'Reasoning' : 'Token suy luận'}</span>
              </div>
              <div className="text-xl font-bold text-violet-500" title={(stats.reasoningTokens || 0).toLocaleString()}>{compactNumber(stats.reasoningTokens || 0)}</div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-green-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <UserCheck className="h-3 w-3" />
                <span>{isEn ? 'Success Rate' : 'Tỷ lệ thành công'}</span>
              </div>
              <div className="text-xl font-bold text-success">
                {stats.totalRequests > 0 ? `${((stats.successRequests / stats.totalRequests) * 100).toFixed(1)}%` : '-'}
              </div>
            </CardContent>
          </Card>
          <Card className="hover-lift bg-gradient-to-br from-amber-500/5 to-transparent">
            <CardContent className="pt-3 pb-3">
              <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
                <Server className="h-3 w-3" />
                <span>Credits</span>
              </div>
              <div className="text-xl font-bold text-amber-500">{(stats.totalCredits || 0).toFixed(4)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* API 端点说明 */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Globe className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'API Endpoints' : 'Endpoint API'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/chat/completions</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'OpenAI Compatible' : 'Tương thích OpenAI'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/responses</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'OpenAI Responses' : 'OpenAI Responses'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/messages</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'Claude Compatible' : 'Tương thích Claude'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/anthropic/v1/messages</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'Claude Code' : 'Claude Code'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/messages/count_tokens</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'Token Count' : 'Đếm token'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1/models</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'Model List' : 'Danh sách model'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-orange-500 w-11 flex-shrink-0 font-mono">POST</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1beta/models/*:generateContent</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'Gemini Compatible' : 'Tương thích Gemini'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
            <code className="text-muted-foreground flex-1 font-mono">/v1beta/models</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'Gemini Models' : 'Model Gemini'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
            <code className="text-muted-foreground flex-1 font-mono">/health</code>
            <span className="text-xs text-muted-foreground">{isEn ? 'Health Check' : 'Kiểm tra health'}</span>
          </div>
          <div className="border-t pt-2 mt-2 space-y-1.5">
            <div className="text-xs text-muted-foreground mb-1">{isEn ? 'Admin API (Requires API Key)' : 'Admin API (cần API Key)'}</div>
            <div className="flex items-center gap-2">
              <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
              <code className="text-muted-foreground flex-1 font-mono">/admin/stats</code>
              <span className="text-xs text-muted-foreground">{isEn ? 'Detailed Stats' : 'Thống kê chi tiết'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
              <code className="text-muted-foreground flex-1 font-mono">/admin/accounts</code>
              <span className="text-xs text-muted-foreground">{isEn ? 'Account List' : 'Danh sách tài khoản'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-500 w-11 flex-shrink-0 font-mono">GET</span>
              <code className="text-muted-foreground flex-1 font-mono">/admin/logs</code>
              <span className="text-xs text-muted-foreground">{isEn ? 'Request Logs' : 'Log request'}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 最近请求日志 */}
      {recentLogs.length > 0 && (
        <Card className="hover-lift">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-primary/10">
                  <Activity className="h-4 w-4 text-primary" />
                </div>
                {isEn ? 'Recent Requests' : 'Request gần đây'}
              </CardTitle>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">{recentLogs.length}</Badge>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowLogsDialog(true)}>
                  <FileText className="h-3 w-3 mr-1" />
                  {isEn ? 'View All' : 'Xem tất cả'}
                </Button>
                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setShowDetailedLogsDialog(true)}>
                  <Activity className="h-3 w-3 mr-1" />
                  {isEn ? 'Detailed Logs' : 'Log chi tiết'}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <div className="max-h-[150px] overflow-y-auto text-xs font-mono space-y-0.5">
              {recentLogs.slice(0, 5).map((log, idx) => (
                <div key={idx} className="grid gap-2 py-1 px-2 rounded hover:bg-muted/50 items-center" style={{ gridTemplateColumns: '2fr 1fr 1.2fr 0.5fr 0.8fr 0.8fr 0.8fr 0.8fr 0.6fr' }}>
                  <span className="text-muted-foreground whitespace-nowrap text-left">{log.time}</span>
                  <span className="truncate text-left" title={log.path}>{log.path}</span>
                  <span className="truncate text-left text-muted-foreground" title={log.model}>{log.model ? log.model.replace('anthropic.', '').replace('-v1:0', '') : '-'}</span>
                  <span className={`text-center ${log.status >= 400 ? 'text-destructive' : 'text-success'}`}>{log.status}</span>
                  <span className="text-muted-foreground text-right">{log.inputTokens ? log.inputTokens.toLocaleString() : '-'}</span>
                  <span className="text-muted-foreground text-right">{log.outputTokens ? log.outputTokens.toLocaleString() : '-'}</span>
                  <span className="text-success text-right">{log.cacheReadTokens ? log.cacheReadTokens.toLocaleString() : '-'}</span>
                  <span className="text-muted-foreground text-right">{log.credits ? log.credits.toFixed(4) : '-'}</span>
                  <span className="text-muted-foreground text-right">{log.responseTime ? `${(log.responseTime / 1000).toFixed(1)}s` : '-'}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 功能说明 */}
      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Supported Features' : 'Tính năng hỗ trợ'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Auto Token Refresh' : 'Tự làm mới token'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Request Retry' : 'Tự thử lại request'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Multi-Account Rotation' : 'Xoay tua nhiều tài khoản'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'IDC/Social Auth' : 'Xác thực IDC/Social'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Agentic Mode Detection' : 'Nhận diện chế độ agentic'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Thinking Mode Support' : 'Hỗ trợ thinking mode'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Image Processing' : 'Xử lý hình ảnh'}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-primary">✓</span>
              <span className="text-foreground">{isEn ? 'Usage Statistics' : 'Thống kê sử dụng'}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 日志弹窗 */}
      <ProxyLogsDialog
        open={showLogsDialog}
        onOpenChange={setShowLogsDialog}
        logs={recentLogs}
        totalCredits={stats?.totalCredits || 0}
        totalTokens={(stats?.inputTokens || 0) + (stats?.outputTokens || 0)}
        onClearLogs={() => {
          setRecentLogs([])
          window.api.proxySaveLogs([])
        }}
        onResetCredits={async () => {
          await window.api.proxyResetCredits()
          fetchStatus()
        }}
        onResetTokens={async () => {
          await window.api.proxyResetTokens()
          fetchStatus()
        }}
        isEn={isEn}
      />

      {/* 详细日志弹窗 */}
      <ProxyDetailedLogsDialog
        open={showDetailedLogsDialog}
        onOpenChange={setShowDetailedLogsDialog}
      />

      {/* 模型列表弹窗 */}
      <ModelsDialog
        open={showModelsDialog}
        onOpenChange={setShowModelsDialog}
        isEn={isEn}
        onOpenModelMapping={async () => {
          // 获取可用模型列表
          try {
            const result = await window.api.proxyGetModels()
            if (result.success && result.models) {
              setAvailableModels(result.models.map((m: { id: string; name?: string }) => ({ id: m.id, name: m.name || m.id })))
            }
          } catch {
            // 忽略错误
          }
          setShowModelsDialog(false)
          setShowModelMappingDialog(true)
        }}
        mappingCount={config.modelMappings?.length || 0}
      />

      <ClientConfigDialog
        open={showClientConfigDialog}
        onOpenChange={setShowClientConfigDialog}
        isEn={isEn}
      />

      {/* 模型映射弹窗 */}
      <ModelMappingDialog
        open={showModelMappingDialog}
        onOpenChange={setShowModelMappingDialog}
        isEn={isEn}
        mappings={config.modelMappings || []}
        onMappingsChange={(mappings) => {
          setConfig(prev => ({ ...prev, modelMappings: mappings }))
          window.api.proxyUpdateConfig({ modelMappings: mappings })
        }}
        apiKeys={(config.apiKeys || []).map(k => ({ id: k.id, name: k.name }))}
        availableModels={availableModels}
      />

      {/* 账号选择弹窗 */}
      <AccountSelectDialog
        open={showAccountSelectDialog}
        onOpenChange={setShowAccountSelectDialog}
        accounts={accounts}
        selectedAccountId={config.selectedAccountId}
        onSelect={(accountId) => {
          setConfig(prev => ({ ...prev, selectedAccountId: accountId }))
          window.api.proxyUpdateConfig({ selectedAccountIds: accountId ? [accountId] : [] })
        }}
        isEn={isEn}
      />

      {/* API Key 管理弹窗 */}
      {showApiKeyManager && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowApiKeyManager(false)} />
          <div className="relative bg-background rounded-lg shadow-lg w-[800px] max-h-[80vh] overflow-y-auto p-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">{isEn ? 'API Key Management' : 'Quản lý API Key'}</h2>
              <Button variant="ghost" size="icon" onClick={() => setShowApiKeyManager(false)}>✕</Button>
            </div>
            <ApiKeyManager />
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}


