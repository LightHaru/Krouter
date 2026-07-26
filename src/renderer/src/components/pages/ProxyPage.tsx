import { useEffect, useState } from 'react'
import { Activity, BarChart3, Boxes, Cloud, Gauge, Radio, Route, Server, ShieldCheck } from 'lucide-react'
import { ProxyPanel, BedrockPanel, ChatGPTOAuthPanel } from '../proxy'
import { useTranslation } from '@/hooks/useTranslation'
import { Badge, Button } from '../ui'

interface AccountHealthData {
  id: string
  email?: string
  health: { overallScore: number; isHealthy: boolean; avgLatency: number; successRate: number }
}

interface EndpointMetricsData {
  path: string
  totalRequests: number
  errorCount: number
  avgResponseTime: number
  p95ResponseTime: number
}

interface ProxyOverview {
  running: boolean
  port: number
  host: string
  accountCount: number
  modelCount: number
  requestCount: number
}

type ProxyDeck = 'runtime' | 'providers' | 'health'

const EMPTY_OVERVIEW: ProxyOverview = { running: false, port: 5580, host: '127.0.0.1', accountCount: 0, modelCount: 0, requestCount: 0 }

export function ProxyPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [deck, setDeck] = useState<ProxyDeck>('runtime')
  const [overview, setOverview] = useState<ProxyOverview>(EMPTY_OVERVIEW)
  const [accounts, setAccounts] = useState<AccountHealthData[]>([])
  const [endpoints, setEndpoints] = useState<EndpointMetricsData[]>([])

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const api = window.api as typeof window.api & {
          proxyGetAccountHealth?: () => Promise<{ accounts?: AccountHealthData[] }>
          proxyGetEndpointMetrics?: () => Promise<{ endpoints?: EndpointMetricsData[] }>
        }
        const [status, models, health, metrics] = await Promise.all([
          window.api.proxyGetStatus(),
          window.api.proxyGetModels(),
          api.proxyGetAccountHealth?.(),
          api.proxyGetEndpointMetrics?.()
        ])
        if (!alive) return
        const config = (status?.config || {}) as { port?: number; host?: string }
        const statusView = status as { running?: boolean; accounts?: unknown[]; accountCount?: number; stats?: { totalRequests?: number } }
        setOverview({
          running: Boolean(statusView.running),
          port: config.port || 5580,
          host: config.host || '127.0.0.1',
          accountCount: statusView.accounts?.length || statusView.accountCount || 0,
          modelCount: models.models?.length || 0,
          requestCount: statusView.stats?.totalRequests || 0
        })
        setAccounts(health?.accounts || [])
        setEndpoints(metrics?.endpoints || [])
      } catch { /* The runtime panel exposes the actionable error state. */ }
    }
    void load()
    const interval = window.setInterval(load, 10_000)
    return () => { alive = false; window.clearInterval(interval) }
  }, [])

  const healthy = accounts.filter((account) => account.health?.isHealthy).length
  const totalEndpointRequests = endpoints.reduce((sum, endpoint) => sum + endpoint.totalRequests, 0)
  const totalEndpointErrors = endpoints.reduce((sum, endpoint) => sum + endpoint.errorCount, 0)
  const avgLatency = endpoints.length ? Math.round(endpoints.reduce((sum, endpoint) => sum + endpoint.avgResponseTime, 0) / endpoints.length) : 0

  return (
    <div className="proxy-control-room flex-1 overflow-auto p-4 md:p-6">
      <header className="proxy-command-bar">
        <div className="proxy-command-title">
          <span><Radio /> {isEn ? 'UNIFIED API GATEWAY' : 'CONG API HOP NHAT'}</span>
          <h1>{isEn ? 'Routing control room' : 'Trung tam dieu phoi API'}</h1>
          <p>{isEn ? 'Operate every compatible endpoint, provider and account pool from one observable surface.' : 'Van hanh endpoint, provider va pool tai khoan tren mot man hinh co the quan sat.'}</p>
        </div>
        <div className="proxy-live-address">
          <span className={overview.running ? 'online' : ''} />
          <div><small>{overview.running ? (isEn ? 'GATEWAY ONLINE' : 'GATEWAY DANG CHAY') : (isEn ? 'GATEWAY STOPPED' : 'GATEWAY DA DUNG')}</small><code>http://{overview.host === '0.0.0.0' ? 'localhost' : overview.host}:{overview.port}</code></div>
          <Badge variant={overview.running ? 'success' : 'secondary'}>{overview.running ? 'LIVE' : 'OFF'}</Badge>
        </div>
      </header>

      <section className="proxy-signal-rail">
        <Signal icon={Route} label={isEn ? 'Runtime' : 'Runtime'} value={overview.running ? 'Online' : 'Stopped'} note={`:${overview.port}`} />
        <Signal icon={ShieldCheck} label={isEn ? 'Healthy pool' : 'Pool on dinh'} value={`${healthy}/${accounts.length || overview.accountCount}`} note={isEn ? 'accounts' : 'tai khoan'} />
        <Signal icon={Boxes} label={isEn ? 'Model routes' : 'Tuyen model'} value={overview.modelCount} note={isEn ? 'published' : 'cong khai'} />
        <Signal icon={Activity} label={isEn ? 'Traffic' : 'Luu luong'} value={totalEndpointRequests || overview.requestCount} note={`${totalEndpointErrors} errors`} />
        <Signal icon={Gauge} label={isEn ? 'Mean latency' : 'Do tre TB'} value={`${avgLatency}ms`} note={`${endpoints.length} endpoints`} />
      </section>

      <nav className="proxy-deck-nav" aria-label={isEn ? 'Proxy control sections' : 'Khu vuc dieu khien Proxy'}>
        <DeckButton active={deck === 'runtime'} icon={Server} label={isEn ? 'Runtime & configuration' : 'Runtime & cau hinh'} onClick={() => setDeck('runtime')} />
        <DeckButton active={deck === 'providers'} icon={Cloud} label={isEn ? 'Provider diagnostics' : 'Chan doan provider'} onClick={() => setDeck('providers')} />
        <DeckButton active={deck === 'health'} icon={BarChart3} label={isEn ? 'Health & endpoints' : 'Suc khoe & endpoint'} onClick={() => setDeck('health')} />
      </nav>

      <section className="proxy-deck">
        {deck === 'runtime' && <ProxyPanel />}
        {deck === 'providers' && <div className="proxy-provider-deck"><div className="proxy-deck-intro"><span>PROVIDER ROUTES</span><h2>{isEn ? 'Provider readiness' : 'Do san sang cua provider'}</h2><p>{isEn ? 'Test credentials, connect OAuth identities and publish namespaced models from one surface.' : 'Kiem tra credential, ket noi OAuth va cong khai model co namespace tai mot noi.'}</p></div><div className="proxy-provider-grid"><BedrockPanel isEn={isEn} /><ChatGPTOAuthPanel isEn={isEn} /></div></div>}
        {deck === 'health' && <HealthDeck accounts={accounts} endpoints={endpoints} isEn={isEn} />}
      </section>
    </div>
  )
}

function Signal({ icon: Icon, label, value, note }: { icon: React.ElementType; label: string; value: string | number; note: string }): React.ReactNode {
  return <div className="proxy-signal"><Icon /><div><small>{label}</small><strong>{value}</strong><span>{note}</span></div></div>
}

function DeckButton({ active, icon: Icon, label, onClick }: { active: boolean; icon: React.ElementType; label: string; onClick: () => void }): React.ReactNode {
  return <Button variant="ghost" className={active ? 'active' : ''} onClick={onClick}><Icon />{label}</Button>
}

function HealthDeck({ accounts, endpoints, isEn }: { accounts: AccountHealthData[]; endpoints: EndpointMetricsData[]; isEn: boolean }): React.ReactNode {
  return (
    <div className="health-deck">
      <section className="health-table-panel">
        <div className="proxy-deck-intro"><span>ACCOUNT MATRIX</span><h2>{isEn ? 'Pool health' : 'Suc khoe pool'}</h2><p>{isEn ? 'Live route score and latency for every participating identity.' : 'Diem tuyen va do tre cua tung tai khoan trong pool.'}</p></div>
        <div className="health-list">
          {accounts.length ? accounts.map((account) => <div className="health-row" key={account.id}><span className={account.health?.isHealthy ? 'ok' : ''} /><div><strong>{account.email || account.id}</strong><small>{account.id}</small></div><b>{Math.round((account.health?.overallScore || 0) * 100)}%</b><code>{Math.round(account.health?.avgLatency || 0)}ms</code></div>) : <EmptyHealth text={isEn ? 'No account health samples yet.' : 'Chua co mau suc khoe tai khoan.'} />}
        </div>
      </section>
      <section className="health-table-panel">
        <div className="proxy-deck-intro"><span>ENDPOINT MATRIX</span><h2>{isEn ? 'Protocol traffic' : 'Luu luong giao thuc'}</h2><p>{isEn ? 'Error pressure and tail latency grouped by compatible route.' : 'Loi va do tre p95 theo tung route tuong thich.'}</p></div>
        <div className="health-list">
          {endpoints.length ? endpoints.map((endpoint) => {
            const errorRate = endpoint.totalRequests ? endpoint.errorCount / endpoint.totalRequests * 100 : 0
            return <div className="health-row endpoint" key={endpoint.path}><span className={errorRate < 5 ? 'ok' : ''} /><div><strong>{endpoint.path}</strong><small>{endpoint.totalRequests} requests</small></div><b>{errorRate.toFixed(1)}%</b><code>p95 {Math.round(endpoint.p95ResponseTime)}ms</code></div>
          }) : <EmptyHealth text={isEn ? 'Endpoint metrics appear after the first request.' : 'Metrics se xuat hien sau request dau tien.'} />}
        </div>
      </section>
    </div>
  )
}

function EmptyHealth({ text }: { text: string }): React.ReactNode {
  return <div className="health-empty"><Activity /><span>{text}</span></div>
}
