import { useEffect, useMemo, useState } from 'react'
import {
  Activity, ArrowUpRight, Boxes, CheckCircle2, Cloud, Gauge, KeyRound, Layers3,
  Radio, Route, Server, ShieldCheck, Sparkles, Users, Zap
} from 'lucide-react'
import { useAccountsStore } from '@/store/accounts'
import { Badge, Button, Card, CardContent } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'
import type { PageType } from '../layout'

interface HomeRuntime {
  proxyRunning: boolean
  proxyPort: number
  poolSize: number
  modelCount: number
  bedrockEnabled: boolean
  bedrockModels: number
  customProviders: number
  customModels: number
  recentRequests: Array<{ time?: string; model?: string; status?: number; provider?: string; responseTime?: number }>
}

const EMPTY_RUNTIME: HomeRuntime = {
  proxyRunning: false, proxyPort: 5580, poolSize: 0, modelCount: 0,
  bedrockEnabled: false, bedrockModels: 0, customProviders: 0, customModels: 0, recentRequests: []
}

function navigate(page: PageType): void {
  window.dispatchEvent(new CustomEvent('navigate-page', { detail: page }))
}

export function HomePage(): React.ReactNode {
  const { accounts, activeAccountId, getStats, usagePrecision } = useAccountsStore()
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const stats = getStats()
  const activeAccount = activeAccountId ? accounts.get(activeAccountId) : undefined
  const [runtime, setRuntime] = useState<HomeRuntime>(EMPTY_RUNTIME)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const [status, modelsResult, logsResult] = await Promise.all([
          window.api.proxyGetStatus(),
          window.api.proxyGetModels(),
          window.api.proxyLoadLogs()
        ])
        if (!alive) return
        const config = (status?.config || {}) as {
          port?: number
          bedrock?: { enabled?: boolean; models?: string[] }
          customApiProviders?: Array<{ enabled?: boolean; models?: string[] }>
          xpixi?: { enabled?: boolean; models?: string[] }
        }
        const providers = (config.customApiProviders || []).filter((provider) => provider.enabled !== false)
        const customModelCount = providers.reduce((sum, provider) => sum + (provider.models?.length || 0), 0)
          + (config.xpixi?.enabled ? config.xpixi.models?.length || 0 : 0)
        const statusAccounts = (status as { accounts?: Array<unknown>; accountCount?: number })?.accounts
        setRuntime({
          proxyRunning: Boolean(status?.running),
          proxyPort: config.port || 5580,
          poolSize: Array.isArray(statusAccounts) ? statusAccounts.length : stats.byStatus.active,
          modelCount: modelsResult.models?.length || 0,
          bedrockEnabled: Boolean(config.bedrock?.enabled),
          bedrockModels: config.bedrock?.models?.length || 0,
          customProviders: providers.length + (config.xpixi?.enabled ? 1 : 0),
          customModels: customModelCount,
          recentRequests: ((logsResult as { logs?: HomeRuntime['recentRequests'] })?.logs || []).slice(0, 5)
        })
      } catch {
        if (alive) setRuntime((current) => ({ ...current, poolSize: stats.byStatus.active }))
      }
    }
    void load()
    const timer = window.setInterval(load, 15_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [stats.byStatus.active])

  const usage = useMemo(() => {
    let used = 0
    let limit = 0
    for (const account of accounts.values()) {
      if (account.status !== 'active' || !account.usage) continue
      used += account.usage.current || 0
      limit += account.usage.limit || 0
    }
    const percent = limit > 0 ? (used / limit) * 100 : 0
    return { used, limit, remaining: Math.max(0, limit - used), percent }
  }, [accounts])

  const providers = [
    {
      id: 'kiro', icon: Sparkles, label: 'Kiro', detail: `${stats.byStatus.active} ${isEn ? 'active accounts' : 'tài khoản hoạt động'}`,
      metric: `${runtime.poolSize} pool`, online: stats.byStatus.active > 0, page: 'accounts' as PageType
    },
    {
      id: 'bedrock', icon: Cloud, label: 'AWS Bedrock', detail: runtime.bedrockEnabled ? `${runtime.bedrockModels || 'Auto'} models` : (isEn ? 'Not configured' : 'Chưa cấu hình'),
      metric: runtime.bedrockEnabled ? 'Ready' : 'Offline', online: runtime.bedrockEnabled, page: 'accounts' as PageType
    },
    {
      id: 'custom', icon: KeyRound, label: 'Custom API', detail: `${runtime.customProviders} ${isEn ? 'providers' : 'nhà cung cấp'}`,
      metric: `${runtime.customModels} models`, online: runtime.customProviders > 0, page: 'accounts' as PageType
    }
  ]

  return (
    <div className="home-command flex-1 overflow-auto p-4 md:p-6">
      <section className="command-hero">
        <div className="min-w-0">
          <div className="command-kicker"><Radio className="h-3.5 w-3.5" /> {isEn ? 'Live routing fabric' : 'Hệ thống định tuyến trực tiếp'}</div>
          <h1>{isEn ? 'Everything routes from here.' : 'Mọi tuyến AI, trong một màn hình.'}</h1>
          <p>{isEn ? 'Kiro capacity, Bedrock models and custom APIs are unified behind one observable endpoint.' : 'Kiro, Bedrock và Custom API được hợp nhất sau một endpoint có thể quan sát đầy đủ.'}</p>
        </div>
        <div className="command-endpoint">
          <span className={runtime.proxyRunning ? 'is-online' : ''} />
          <div><small>API ENDPOINT</small><code>127.0.0.1:{runtime.proxyPort}</code></div>
          <Button size="sm" onClick={() => navigate('proxy')}>{isEn ? 'Open proxy' : 'Mở Proxy'}<ArrowUpRight /></Button>
        </div>
      </section>

      <section className="command-metrics">
        <Metric icon={Users} label={isEn ? 'Accounts' : 'Tài khoản'} value={stats.total} note={`${stats.byStatus.active} healthy`} tone="green" />
        <Metric icon={Boxes} label={isEn ? 'Available models' : 'Model khả dụng'} value={runtime.modelCount} note="Kiro + Bedrock + API" tone="blue" />
        <Metric icon={Gauge} label={isEn ? 'Capacity left' : 'Dung lượng còn lại'} value={usage.remaining.toLocaleString()} note={`${usage.percent.toFixed(usagePrecision ? 2 : 1)}% used`} tone="orange" />
        <Metric icon={ShieldCheck} label={isEn ? 'Route status' : 'Trạng thái tuyến'} value={runtime.proxyRunning ? 'Online' : 'Stopped'} note={`${runtime.poolSize} accounts in pool`} tone={runtime.proxyRunning ? 'green' : 'red'} />
      </section>

      <div className="command-grid">
        <section className="provider-fabric">
          <div className="section-heading"><div><span>{isEn ? 'PROVIDER FABRIC' : 'HỆ THỐNG PROVIDER'}</span><h2>{isEn ? 'Three sources. One route.' : 'Ba nguồn. Một tuyến duy nhất.'}</h2></div><Route /></div>
          <div className="provider-flow">
            {providers.map((provider, index) => {
              const Icon = provider.icon
              return <div className="provider-flow-wrap" key={provider.id}>
                <button className="provider-node" onClick={() => navigate(provider.page)}>
                  <div className="provider-node-top"><div className="provider-icon"><Icon /></div><span className={provider.online ? 'provider-dot online' : 'provider-dot'} /></div>
                  <strong>{provider.label}</strong><p>{provider.detail}</p><div className="provider-node-foot"><span>{provider.metric}</span><ArrowUpRight /></div>
                </button>
                {index < providers.length - 1 && <div className="route-connector"><Zap /></div>}
              </div>
            })}
          </div>
          <div className="route-output"><Layers3 /><div><small>UNIFIED OUTPUT</small><strong>OpenAI · Anthropic · Responses · Gemini</strong></div><Badge>{runtime.modelCount} models</Badge></div>
        </section>

        <section className="capacity-panel">
          <div className="section-heading"><div><span>{isEn ? 'CAPACITY' : 'DUNG LƯỢNG'}</span><h2>{isEn ? 'Pool runway' : 'Sức chứa hệ thống'}</h2></div><Activity /></div>
          <div className="capacity-ring" style={{ '--capacity': `${Math.min(100, usage.percent)}%` } as React.CSSProperties}>
            <div><strong>{usage.percent.toFixed(0)}%</strong><span>{isEn ? 'consumed' : 'đã dùng'}</span></div>
          </div>
          <div className="capacity-numbers"><div><small>{isEn ? 'USED' : 'ĐÃ DÙNG'}</small><strong>{usage.used.toLocaleString()}</strong></div><div><small>{isEn ? 'LIMIT' : 'GIỚI HẠN'}</small><strong>{usage.limit.toLocaleString()}</strong></div></div>
          <button className="active-route" onClick={() => navigate('accounts')}><div className="avatar-dot">{activeAccount?.email?.slice(0, 1).toUpperCase() || 'K'}</div><div><small>{isEn ? 'ACTIVE ACCOUNT' : 'TÀI KHOẢN HIỆN TẠI'}</small><strong>{activeAccount?.email || (isEn ? 'Not selected' : 'Chưa chọn')}</strong></div><ArrowUpRight /></button>
        </section>
      </div>

      <section className="traffic-strip">
        <div className="section-heading"><div><span>{isEn ? 'RECENT TRAFFIC' : 'LƯU LƯỢNG GẦN ĐÂY'}</span><h2>{isEn ? 'Latest routed requests' : 'Request định tuyến mới nhất'}</h2></div><Button variant="ghost" size="sm" onClick={() => navigate('proxy')}>{isEn ? 'View all' : 'Xem tất cả'}<ArrowUpRight /></Button></div>
        <div className="traffic-list">
          {runtime.recentRequests.length ? runtime.recentRequests.map((request, index) => <div className="traffic-row" key={`${request.time}-${index}`}><span className={(request.status || 0) < 400 ? 'traffic-status ok' : 'traffic-status'}><CheckCircle2 /></span><code>{request.model || 'auto'}</code><span>{request.provider || 'Kiro'}</span><span className="traffic-time">{request.responseTime ? `${request.responseTime}ms` : request.time || '-'}</span><Badge variant={(request.status || 0) < 400 ? 'success' : 'destructive'}>{request.status || 200}</Badge></div>) : <div className="traffic-empty"><Server /><span>{isEn ? 'Traffic will appear here after the next request.' : 'Request mới sẽ xuất hiện ở đây.'}</span></div>}
        </div>
      </section>
    </div>
  )
}

function Metric({ icon: Icon, label, value, note, tone }: { icon: React.ElementType; label: string; value: string | number; note: string; tone: string }): React.ReactNode {
  return <Card className={`command-metric tone-${tone}`}><CardContent><div className="metric-icon"><Icon /></div><div className="metric-copy"><small>{label}</small><strong>{value}</strong><span>{note}</span></div></CardContent></Card>
}
