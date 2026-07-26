import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  ExternalLink,
  FlaskConical,
  Gauge,
  Hourglass,
  Image,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Zap,
  X
} from 'lucide-react'
import { Badge, Button, Input } from '../ui'
import { copyText } from '@/lib/utils'

type ModelAvailability = 'unverified' | 'available' | 'unavailable'

interface QuotaWindow {
  key: string
  label: string
  usedPercent?: number
  remainingPercent?: number
  resetAt?: number
}

interface ChatGPTAccountView {
  id: string
  email?: string
  plan?: string
  tokenValid: boolean
  expiresAt: number
  quotaWindows?: QuotaWindow[]
  quotaSyncedAt?: number
  quotaError?: string
  localUsage?: { requests: number; inputTokens: number; outputTokens: number; lastRequestAt?: number }
  lastRefreshAt?: number
  lastError?: string
  failures: number
  createdAt?: number
  updatedAt?: number
}

interface ChatGPTModelView {
  id: string
  name: string
  capabilities: string[]
  availability: ModelAvailability
  availableAccounts: number
  thinkingEfforts?: string[]
}

interface ChatGPTOAuthStatus {
  enabled: boolean
  experimental: boolean
  catalogVersion: string
  reasoningEffort: string
  reasoningEfforts: string[]
  models: ChatGPTModelView[]
  accounts: ChatGPTAccountView[]
  totalAccounts: number
  availableForImageGen: number
  availableForCodex: number
  oauthFlowPending: boolean
  pendingFlow?: { id: string; mode: 'local' | 'manual'; startedAt: number; expiresAt: number }
  lastError?: string
}

const EMPTY_STATUS: ChatGPTOAuthStatus = {
  enabled: false,
  experimental: true,
  catalogVersion: '-',
  reasoningEffort: 'auto',
  reasoningEfforts: ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  models: [],
  accounts: [],
  totalAccounts: 0,
  availableForImageGen: 0,
  availableForCodex: 0,
  oauthFlowPending: false
}

function relativeTime(timestamp?: number): string {
  if (!timestamp) return 'Unavailable'
  const remaining = timestamp - Date.now()
  if (remaining <= 0) return 'Now'
  const minutes = Math.max(1, Math.round(remaining / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function resetCountdown(timestamp?: number): string {
  if (!timestamp) return 'N/A'
  const remaining = timestamp - Date.now()
  if (remaining <= 0) return 'Resetting'
  const totalMinutes = Math.max(1, Math.floor(remaining / 60_000))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function resetDate(timestamp?: number): string {
  if (!timestamp) return 'N/A'
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function lastUpdated(accounts: ChatGPTAccountView[]): string {
  const latest = Math.max(0, ...accounts.map(account => account.quotaSyncedAt || account.updatedAt || 0))
  if (!latest) return 'Never'
  const elapsed = Date.now() - latest
  if (elapsed < 60_000) return 'Just now'
  return `${relativeTime(Date.now() + elapsed)} ago`
}

function isTransientFetchNotice(notice: { kind: 'ok' | 'error'; text: string } | null): boolean {
  return notice?.kind === 'error' && /failed to fetch|networkerror|network request failed|load failed/i.test(notice.text)
}

export function ChatGPTOAuthPanel({
  isEn,
  variant = 'control-room'
}: {
  isEn: boolean
  variant?: 'control-room' | 'accounts'
}): React.ReactNode {
  const [status, setStatus] = useState<ChatGPTOAuthStatus>(EMPTY_STATUS)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<string | null>(null)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [expiringFirst, setExpiringFirst] = useState(true)
  const [refreshCountdown, setRefreshCountdown] = useState(60)
  const [testingModels, setTestingModels] = useState<Set<string>>(new Set())
  const [copiedModel, setCopiedModel] = useState<string | null>(null)
  const backgroundSyncing = useRef(false)
  const initialAccountSync = useRef(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const nextStatus = await window.api.chatgptOAuthGetStatus()
      setStatus(nextStatus)
      setNotice(current => isTransientFetchNotice(current) ? null : current)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to load ChatGPT OAuth status' })
    } finally {
      setLoading(false)
    }
  }, [])

  const syncInBackground = useCallback(async (): Promise<void> => {
    if (backgroundSyncing.current) return
    backgroundSyncing.current = true
    try {
      await window.api.chatgptOAuthRefresh()
      await load()
    } catch {
      await load()
    } finally {
      backgroundSyncing.current = false
      setRefreshCountdown(60)
    }
  }, [load])

  useEffect(() => {
    void load()
    if (!status.oauthFlowPending && variant === 'accounts') return
    const timer = window.setInterval(() => {
      if (!document.hidden) void load()
    }, status.oauthFlowPending ? 2000 : 15_000)
    return () => window.clearInterval(timer)
  }, [load, status.oauthFlowPending, variant])

  useEffect(() => {
    if (variant !== 'accounts' || loading || initialAccountSync.current || !status.accounts.length) return
    initialAccountSync.current = true
    void syncInBackground()
  }, [loading, status.accounts.length, syncInBackground, variant])

  useEffect(() => {
    if (variant !== 'accounts' || !autoRefresh) return
    const timer = window.setInterval(() => {
      if (document.hidden) return
      setRefreshCountdown(current => {
        if (current <= 1) {
          void syncInBackground()
          return 60
        }
        return current - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, syncInBackground, variant])

  useEffect(() => {
    if (variant !== 'accounts' || !autoRefresh) return
    const now = Date.now()
    const nextReset = Math.min(
      Number.MAX_SAFE_INTEGER,
      ...status.accounts.flatMap(account =>
        (account.quotaWindows || [])
          .map(window => window.resetAt || 0)
          .filter(resetAt => resetAt > now)
      )
    )
    if (nextReset === Number.MAX_SAFE_INTEGER) return
    const delay = Math.min(nextReset - now + 1_000, 2_147_000_000)
    const timer = window.setTimeout(() => {
      if (!document.hidden) void syncInBackground()
    }, delay)
    return () => window.clearTimeout(timer)
  }, [autoRefresh, status.accounts, syncInBackground, variant])

  const connect = async (): Promise<void> => {
    setAction('connect'); setNotice(null)
    try {
      const result = await window.api.chatgptOAuthStart()
      if (!result.success || !result.authUrl) throw new Error(result.error || 'OAuth URL was not returned')
      await Promise.resolve(window.api.openExternal(result.authUrl))
      setNotice({
        kind: 'ok',
        text: result.mode === 'manual'
          ? (isEn ? 'Sign in, then paste the full localhost callback URL below.' : 'Dang nhap xong, dan toan bo URL localhost callback vao o ben duoi.')
          : (isEn ? 'Authorization opened. Complete sign-in in the browser.' : 'Da mo trang uy quyen. Hoan tat dang nhap tren trinh duyet.')
      })
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to start ChatGPT OAuth' })
    } finally { setAction(null) }
  }

  const submitCallback = async (): Promise<void> => {
    setAction('submit'); setNotice(null)
    try {
      const result = await window.api.chatgptOAuthSubmitCallback(callbackUrl.trim())
      if (!result.success) throw new Error(result.error || 'Callback URL was rejected')
      setCallbackUrl('')
      setNotice({ kind: 'ok', text: isEn ? 'ChatGPT account connected securely.' : 'Da ket noi tai khoan ChatGPT an toan.' })
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to submit callback URL' })
    } finally { setAction(null) }
  }

  const cancel = async (): Promise<void> => {
    setAction('cancel'); setNotice(null)
    try {
      const result = await window.api.chatgptOAuthCancel()
      if (!result.success) throw new Error(result.error || 'Unable to cancel OAuth')
      setCallbackUrl('')
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to cancel OAuth' })
    } finally { setAction(null) }
  }

  const refresh = async (accountId?: string): Promise<void> => {
    setAction(accountId ? `refresh-${accountId}` : 'refresh'); setNotice(null)
    try {
      const result = await window.api.chatgptOAuthRefresh(accountId)
      if (!result.success && result.refreshed === 0) throw new Error(result.error || 'Unable to refresh ChatGPT usage')
      setNotice({ kind: 'ok', text: isEn ? `Synced ${result.refreshed} account(s).` : `Da dong bo ${result.refreshed} tai khoan.` })
      await load()
      setRefreshCountdown(60)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to refresh ChatGPT usage' })
    } finally { setAction(null) }
  }

  const toggleProvider = async (): Promise<void> => {
    setAction('toggle'); setNotice(null)
    try {
      await window.api.proxyUpdateConfig({
        chatgptCodex: {
          enabled: !status.enabled,
          experimental: true,
          baseUrl: 'https://chatgpt.com/backend-api/codex/responses',
          usageUrl: 'https://chatgpt.com/backend-api/wham/usage',
          timeoutMs: 180000,
          catalogVersion: status.catalogVersion === '-' ? '2026-07-2' : status.catalogVersion,
          reasoningEffort: status.reasoningEffort || 'auto'
        }
      })
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to update provider' })
    } finally { setAction(null) }
  }

  const updateReasoningEffort = async (effort: string): Promise<void> => {
    const previousEffort = status.reasoningEffort
    setStatus(current => ({ ...current, reasoningEffort: effort }))
    setAction('reasoning'); setNotice(null)
    try {
      const result = await window.api.proxyUpdateConfig({ chatgptCodex: { reasoningEffort: effort } })
      if (!result.success) throw new Error(result.error || 'Unable to update reasoning effort')
      await load()
      setNotice({
        kind: 'ok',
        text: isEn
          ? `Thinking default saved to backend: ${effort}.`
          : `Da luu muc suy luan vao backend: ${effort}.`
      })
    } catch (error) {
      setStatus(current => ({ ...current, reasoningEffort: previousEffort }))
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to update reasoning effort' })
    } finally { setAction(null) }
  }

  const testModel = async (modelId: string): Promise<void> => {
    setTestingModels(current => new Set(current).add(modelId))
    setNotice(null)
    try {
      const result = await window.api.proxyProbeModels({ modelIds: [modelId], concurrency: 1 })
      const probe = result.results?.find(item => item.modelId === modelId && item.tier === 'chatgpt')
      if (!result.success || !probe?.ok) throw new Error(probe?.error || result.error || 'Live model test failed')
      setNotice({ kind: 'ok', text: `${modelId} ${isEn ? 'is available' : 'dang hoat dong'}${probe.latencyMs ? ` (${probe.latencyMs}ms)` : ''}.` })
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: `${modelId}: ${error instanceof Error ? error.message : 'Live model test failed'}` })
      await load()
    } finally {
      setTestingModels(current => {
        const next = new Set(current)
        next.delete(modelId)
        return next
      })
    }
  }

  const copyModelId = async (modelId: string): Promise<void> => {
    await copyText(modelId)
    setCopiedModel(modelId)
    window.setTimeout(() => setCopiedModel(current => current === modelId ? null : current), 1400)
  }

  const disconnect = async (account: ChatGPTAccountView): Promise<void> => {
    setAction(account.id); setNotice(null)
    try {
      const result = await window.api.chatgptOAuthLogout(account.id)
      if (!result.success) throw new Error(result.error || 'Unable to disconnect account')
      await load()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to disconnect account' })
    } finally { setAction(null) }
  }

  const modelCatalog = (
    <section className="chatgpt-model-panel" aria-label="Available Models">
      <div className="chatgpt-model-heading">
        <div className="proxy-deck-intro">
          <span>VERSIONED MODEL CATALOG · {status.catalogVersion}</span>
          <h3 data-no-translate>Available Models</h3>
          <p>{isEn ? 'Test a model on demand. Krouter never bulk-probes the catalog during login.' : 'Chi test khi anh bam nut. Krouter khong bulk-probe catalog luc dang nhap.'}</p>
        </div>
        <div className="chatgpt-thinking-control">
          <label className="chatgpt-thinking-select">
            <Brain />
            <span>{isEn ? 'Thinking' : 'Suy luan'}</span>
            <select
              aria-label="Thinking"
              value={status.reasoningEffort || 'auto'}
              onChange={event => void updateReasoningEffort(event.target.value)}
              disabled={action !== null}
            >
              {(status.reasoningEfforts || EMPTY_STATUS.reasoningEfforts).map(effort => (
                <option key={effort} value={effort}>{effort === 'auto' ? 'Auto' : effort.charAt(0).toUpperCase() + effort.slice(1)}</option>
              ))}
            </select>
          </label>
          <small>
            {action === 'reasoning'
              ? (isEn ? 'Saving to backend...' : 'Dang luu vao backend...')
              : (isEn ? 'Backend default. An explicit API value overrides it.' : 'Mac dinh backend. Gia tri gui trong API se duoc uu tien.')}
          </small>
        </div>
      </div>
      <div className="chatgpt-model-grid">
        {status.models.map(model => {
          const testing = testingModels.has(model.id)
          return (
            <article key={model.id} className={`chatgpt-model-card is-${model.availability}`}>
              <header>
                <div><Sparkles /><span><strong>{model.name}</strong><code>{model.id}</code></span></div>
                <Badge variant={model.availability === 'available' ? 'success' : model.availability === 'unavailable' ? 'destructive' : 'secondary'}>{model.availability}</Badge>
              </header>
              <div className="chatgpt-model-capabilities">
                {model.capabilities.map(capability => <span key={capability}>{capability}</span>)}
              </div>
              <div className="chatgpt-model-meta">
                <span>{model.availableAccounts} {isEn ? 'verified account(s)' : 'tai khoan da xac minh'}</span>
                <small>{(model.thinkingEfforts || []).filter(item => item !== 'auto').join(' · ')}</small>
              </div>
              <footer>
                <button onClick={() => void copyModelId(model.id)} title={isEn ? 'Copy model ID' : 'Sao chep model ID'}>
                  {copiedModel === model.id ? <CheckCircle2 /> : <Copy />}
                  {copiedModel === model.id ? (isEn ? 'Copied' : 'Da chep') : (isEn ? 'Copy' : 'Sao chep')}
                </button>
                <button className="is-test" onClick={() => void testModel(model.id)} disabled={testing || !status.enabled || !status.accounts.length}>
                  {testing ? <Loader2 className="animate-spin" /> : <Zap />}
                  {testing ? (isEn ? 'Testing' : 'Dang test') : 'Test model'}
                </button>
              </footer>
            </article>
          )
        })}
      </div>
    </section>
  )

  if (variant === 'accounts') {
    const accounts = [...status.accounts]
    if (expiringFirst) {
      accounts.sort((a, b) => {
        const aReset = Math.min(a.expiresAt, ...(a.quotaWindows || []).map(window => window.resetAt || Number.MAX_SAFE_INTEGER))
        const bReset = Math.min(b.expiresAt, ...(b.quotaWindows || []).map(window => window.resetAt || Number.MAX_SAFE_INTEGER))
        return aReset - bReset
      })
    }

    return (
      <div className="chatgpt-limits-deck">
        <header className="chatgpt-limits-toolbar">
          <div className="chatgpt-limits-title">
            <h2>{isEn ? 'Provider Limits' : 'Gioi han provider'}</h2>
            <span>{isEn ? 'Last updated:' : 'Cap nhat:'} {lastUpdated(status.accounts)}</span>
          </div>
          <div className="chatgpt-limits-controls">
            <div className="chatgpt-provider-select"><Sparkles /><span>Codex</span><ChevronDown /></div>
            <button className={expiringFirst ? 'is-active' : ''} onClick={() => setExpiringFirst(current => !current)}><Hourglass />{isEn ? 'Expiring first' : 'Sap het han'}</button>
            <button className={autoRefresh ? 'is-active' : ''} onClick={() => setAutoRefresh(current => !current)}><span className="chatgpt-mini-switch"><i /></span>{autoRefresh ? (isEn ? `Auto-refresh (${refreshCountdown}s)` : `Tu dong (${refreshCountdown}s)`) : (isEn ? 'Auto-refresh' : 'Tu dong')}</button>
            <button onClick={() => void refresh()} disabled={action !== null || !status.accounts.length}><RefreshCw className={action === 'refresh' ? 'animate-spin' : ''} />{isEn ? 'Refresh all' : 'Lam moi tat ca'}</button>
            <button className={status.enabled ? 'is-active' : ''} onClick={() => void toggleProvider()} disabled={action !== null}><Gauge />{status.enabled ? (isEn ? 'Routing on' : 'Routing bat') : (isEn ? 'Routing off' : 'Routing tat')}</button>
            {status.oauthFlowPending
              ? <button className="is-danger" onClick={() => void cancel()} disabled={action !== null}>{action === 'cancel' ? <Loader2 className="animate-spin" /> : <X />}{isEn ? 'Cancel' : 'Huy'}</button>
              : <button className="is-primary" onClick={() => void connect()} disabled={action !== null}>{action === 'connect' ? <Loader2 className="animate-spin" /> : <Plus />}{isEn ? 'Add account' : 'Them tai khoan'}</button>}
          </div>
        </header>

        {status.pendingFlow?.mode === 'manual' && (
          <section className="chatgpt-callback-box">
            <div><strong>{isEn ? 'Paste localhost callback URL' : 'Dan URL localhost callback'}</strong><span>{isEn ? `This one-time session expires in ${relativeTime(status.pendingFlow.expiresAt)}. The URL is submitted only to the Krouter backend.` : `Phien dung mot lan het han sau ${relativeTime(status.pendingFlow.expiresAt)}. URL chi gui vao backend Krouter.`}</span></div>
            <div className="chatgpt-callback-entry">
              <Input value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=...&state=..." autoComplete="off" spellCheck={false} />
              <Button onClick={() => void submitCallback()} disabled={!callbackUrl.trim() || action !== null}>{action === 'submit' ? <Loader2 className="animate-spin" /> : <Send />}{isEn ? 'Complete' : 'Hoan tat'}</Button>
            </div>
          </section>
        )}

        {notice && <div className={`chatgpt-oauth-notice ${notice.kind}`}>{notice.kind === 'ok' ? <CheckCircle2 /> : <AlertTriangle />}<span>{notice.text}</span><button onClick={() => setNotice(null)}>x</button></div>}
        {status.lastError && !status.oauthFlowPending && <div className="chatgpt-oauth-notice error"><AlertTriangle /><span>{status.lastError}</span></div>}

        <section className="chatgpt-limit-grid">
          {loading && !accounts.length ? (
            <div className="chatgpt-limit-empty"><Loader2 className="animate-spin" />{isEn ? 'Loading provider limits...' : 'Dang tai gioi han provider...'}</div>
          ) : accounts.length ? accounts.map(account => {
            const windows: QuotaWindow[] = account.quotaWindows?.length
              ? account.quotaWindows
              : [
                  { key: 'session', label: 'Session' },
                  { key: 'weekly', label: 'Weekly' }
                ]
            return (
              <article key={account.id} className={`chatgpt-limit-card ${account.tokenValid ? 'is-live' : 'is-expired'}`}>
                <header>
                  <div className="chatgpt-limit-provider">
                    <span><Sparkles /></span>
                    <div>
                      <strong title={account.email || 'ChatGPT account'}>{account.email || 'ChatGPT account'}</strong>
                      <small>{account.plan || (isEn ? 'Plan unavailable' : 'Chua co thong tin goi')}</small>
                    </div>
                  </div>
                  <span className={`chatgpt-limit-status ${account.tokenValid && account.failures < 5 ? 'is-healthy' : 'is-attention'}`}>
                    {account.tokenValid && account.failures < 5
                      ? (isEn ? 'Active' : 'Dang hoat dong')
                      : (isEn ? 'Attention' : 'Can chu y')}
                  </span>
                </header>
                <div className="chatgpt-limit-badges">
                  <b>CHATGPT {(account.plan || 'ACCOUNT').toUpperCase()}</b>
                  <span>CODEX</span>
                  {!status.enabled && <span className="is-muted">{isEn ? 'ROUTING OFF' : 'ROUTING TAT'}</span>}
                </div>
                <div className="chatgpt-limit-windows">
                  {windows.map(window => {
                    const remaining = window.remainingPercent ?? (window.usedPercent === undefined ? undefined : Math.max(0, 100 - window.usedPercent))
                    const used = window.usedPercent ?? (remaining === undefined ? undefined : Math.max(0, 100 - remaining))
                    const critical = remaining !== undefined && remaining <= 10
                    return (
                      <div key={window.key} className={`chatgpt-limit-window ${critical ? 'is-critical' : ''} ${remaining === undefined ? 'is-unavailable' : ''}`}>
                        <div className="chatgpt-limit-window-head">
                          <div className="chatgpt-limit-label"><i /><strong>{window.label}</strong></div>
                          <b>{used === undefined ? 'N/A' : `${Math.round(used)}%`}</b>
                        </div>
                        <div className="chatgpt-limit-meter">
                          <div><i style={{ width: `${used ?? 0}%` }} /></div>
                        </div>
                        <div className="chatgpt-limit-window-meta">
                          <span>{used === undefined ? 'N/A' : `${Math.round(used)} / 100`}</span>
                          <span><Clock3 />{window.resetAt ? `${resetDate(window.resetAt)} reset` : (isEn ? 'Reset unavailable' : 'Chua co lich reset')}</span>
                        </div>
                        <div className="chatgpt-limit-reset">
                          {window.resetAt
                            ? `${isEn ? 'Resets in' : 'Reset sau'} ${resetCountdown(window.resetAt)}`
                            : (isEn ? 'Upstream reset unavailable' : 'Upstream chua tra thoi gian reset')}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="chatgpt-limit-telemetry">
                  <span><i />{account.quotaError || (account.quotaSyncedAt ? `${isEn ? 'Synced' : 'Da dong bo'} ${new Date(account.quotaSyncedAt).toLocaleString()}` : (isEn ? 'Upstream quota not synced' : 'Chua dong bo quota upstream'))}</span>
                  <span>{isEn ? 'Local usage' : 'Su dung Krouter'}: <b>{account.localUsage?.requests || 0}</b> requests</span>
                </div>
                <footer>
                  <div className="chatgpt-limit-token">
                    <span>{account.tokenValid ? (isEn ? 'Token live' : 'Token hoat dong') : (isEn ? 'Token expired' : 'Token het han')}</span>
                    <small>{relativeTime(account.expiresAt)} {isEn ? 'left' : 'con lai'}</small>
                  </div>
                  <div className="chatgpt-limit-actions">
                    <button title={isEn ? 'Refresh quota' : 'Lam moi quota'} onClick={() => void refresh(account.id)} disabled={action !== null}><RefreshCw className={action === `refresh-${account.id}` ? 'animate-spin' : ''} /></button>
                    <button className="is-danger" title={isEn ? 'Disconnect account' : 'Ngat ket noi'} onClick={() => void disconnect(account)} disabled={action !== null}>{action === account.id ? <Loader2 className="animate-spin" /> : <LogOut />}</button>
                    <span className={`chatgpt-account-switch ${account.tokenValid && status.enabled ? 'is-on' : ''}`} title={account.tokenValid ? 'Token live' : 'Token expired'}><i /></span>
                  </div>
                </footer>
              </article>
            )
          }) : (
            <div className="chatgpt-limit-empty"><Sparkles /><strong>{isEn ? 'No Codex accounts connected' : 'Chua ket noi tai khoan Codex'}</strong><span>{isEn ? 'Add a ChatGPT identity to start tracking provider limits.' : 'Them tai khoan ChatGPT de theo doi quota provider.'}</span><button onClick={() => void connect()}><Plus />{isEn ? 'Add account' : 'Them tai khoan'}</button></div>
          )}
        </section>
        {modelCatalog}
      </div>
    )
  }

  return (
    <div className="chatgpt-oauth-deck">
      <section className="chatgpt-oauth-hero">
        <div className="chatgpt-oauth-orb"><FlaskConical /></div>
        <div>
          <span>CHATGPT / CODEX EXPERIMENTAL</span>
          <h2>{isEn ? 'OAuth model provider' : 'Provider model OAuth'}</h2>
          <p>{isEn ? 'Route namespaced Codex models through connected ChatGPT identities. ChatGPT plans and OpenAI API billing remain separate.' : 'Route model Codex co namespace qua tai khoan ChatGPT da ket noi. Goi ChatGPT va billing OpenAI API van la hai he thong rieng.'}</p>
        </div>
        <div className="chatgpt-oauth-actions">
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={action !== null || !status.accounts.length}><RefreshCw className={action === 'refresh' ? 'animate-spin' : ''} />Sync quota</Button>
          <Button variant={status.enabled ? 'default' : 'outline'} size="sm" onClick={() => void toggleProvider()} disabled={action !== null}><Gauge />{status.enabled ? 'Enabled' : 'Enable provider'}</Button>
          {status.oauthFlowPending
            ? <Button variant="destructive" onClick={() => void cancel()} disabled={action !== null}>{action === 'cancel' ? <Loader2 className="animate-spin" /> : <X />}{isEn ? 'Cancel login' : 'Huy dang nhap'}</Button>
            : <Button onClick={() => void connect()} disabled={action !== null}>{action === 'connect' ? <Loader2 className="animate-spin" /> : <LogIn />}{isEn ? 'Connect account' : 'Ket noi tai khoan'}<ExternalLink /></Button>}
        </div>
      </section>

      <section className="chatgpt-oauth-signals">
        <div><ShieldCheck /><span><small>{isEn ? 'CONNECTED' : 'DA KET NOI'}</small><strong>{status.totalAccounts}</strong></span></div>
        <div><CheckCircle2 /><span><small>{isEn ? 'CODEX READY' : 'CODEX SAN SANG'}</small><strong>{status.availableForCodex}</strong></span></div>
        <div><Image /><span><small>{isEn ? 'IMAGE READY' : 'ANH SAN SANG'}</small><strong>{status.availableForImageGen}</strong></span></div>
        <div><Clock3 /><span><small>CATALOG</small><strong>{status.catalogVersion}</strong></span></div>
      </section>

      {status.pendingFlow?.mode === 'manual' && (
        <section className="chatgpt-callback-box">
          <div><strong>{isEn ? 'Paste localhost callback URL' : 'Dan URL localhost callback'}</strong><span>{isEn ? `This one-time session expires in ${relativeTime(status.pendingFlow.expiresAt)}. The URL is submitted only to the Krouter backend.` : `Phien dung mot lan het han sau ${relativeTime(status.pendingFlow.expiresAt)}. URL chi gui vao backend Krouter.`}</span></div>
          <div className="chatgpt-callback-entry">
            <Input value={callbackUrl} onChange={event => setCallbackUrl(event.target.value)} placeholder="http://localhost:1455/auth/callback?code=...&state=..." autoComplete="off" spellCheck={false} />
            <Button onClick={() => void submitCallback()} disabled={!callbackUrl.trim() || action !== null}>{action === 'submit' ? <Loader2 className="animate-spin" /> : <Send />}{isEn ? 'Complete' : 'Hoan tat'}</Button>
          </div>
        </section>
      )}

      {notice && <div className={`chatgpt-oauth-notice ${notice.kind}`}>{notice.kind === 'ok' ? <CheckCircle2 /> : <AlertTriangle />}<span>{notice.text}</span><button onClick={() => setNotice(null)}>x</button></div>}
      {status.lastError && !status.oauthFlowPending && <div className="chatgpt-oauth-notice error"><AlertTriangle /><span>{status.lastError}</span></div>}

      <section className="chatgpt-account-list">
        {loading && !status.accounts.length ? <div className="chatgpt-empty"><Loader2 className="animate-spin" />{isEn ? 'Loading provider state...' : 'Dang tai provider...'}</div> : status.accounts.length ? status.accounts.map(account => (
          <article key={account.id} className="chatgpt-account-card codex">
            <div className="chatgpt-account-avatar">{(account.email || 'C').slice(0, 1).toUpperCase()}</div>
            <div className="chatgpt-account-copy"><strong>{account.email || 'ChatGPT account'}</strong><span>{account.plan || 'Plan unavailable'}</span><small>Local telemetry: {account.localUsage?.requests || 0} requests</small></div>
            <div className="chatgpt-quota-grid">
              {(account.quotaWindows || []).length ? account.quotaWindows!.map(window => (
                <div key={window.key} className="chatgpt-quota">
                  <span><b>{window.label}</b><small>reset {relativeTime(window.resetAt)}</small></span>
                  <div><i style={{ width: `${window.remainingPercent ?? Math.max(0, 100 - (window.usedPercent || 0))}%` }} /></div>
                  <code>{Math.round(window.remainingPercent ?? Math.max(0, 100 - (window.usedPercent || 0)))}%</code>
                </div>
              )) : <span className="chatgpt-quota-empty">{account.quotaError || (isEn ? 'Upstream quota not synced' : 'Chua dong bo quota upstream')}</span>}
            </div>
            <div className="chatgpt-account-health"><Badge variant={account.tokenValid && account.failures < 5 ? 'success' : 'destructive'}>{account.tokenValid ? 'TOKEN LIVE' : 'TOKEN EXPIRED'}</Badge><span>{relativeTime(account.expiresAt)} left</span><small>sync {account.quotaSyncedAt ? new Date(account.quotaSyncedAt).toLocaleString() : 'never'}</small></div>
            <div className="chatgpt-account-buttons"><Button variant="ghost" size="sm" onClick={() => void refresh(account.id)} disabled={action !== null}><RefreshCw className={action === `refresh-${account.id}` ? 'animate-spin' : ''} /></Button><Button variant="ghost" className="text-destructive" onClick={() => void disconnect(account)} disabled={action !== null}>{action === account.id ? <Loader2 className="animate-spin" /> : <LogOut />}</Button></div>
          </article>
        )) : <div className="chatgpt-empty"><FlaskConical /><strong>{isEn ? 'No ChatGPT identity connected' : 'Chua ket noi tai khoan ChatGPT'}</strong><span>{isEn ? 'Connect an account to activate namespaced Codex models and the shared image route.' : 'Ket noi tai khoan de bat model Codex co namespace va route tao anh dung chung.'}</span></div>}
      </section>

      {modelCatalog}

      <footer className="chatgpt-oauth-foot"><ShieldCheck /><p>{isEn ? 'Experimental integration: upstream endpoints, models and quota fields can change without notice. Krouter labels upstream quota separately from locally observed usage.' : 'Tich hop experimental: endpoint, model va quota upstream co the thay doi. Krouter tach quota upstream khoi usage quan sat cuc bo.'}</p></footer>
    </div>
  )
}
