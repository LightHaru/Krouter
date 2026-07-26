import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, BarChart3, Bot, Boxes, CheckCircle2, Clock3, Coins, Database,
  Download, Gauge, Layers3, RefreshCw, Search, Server, Sigma, Trash2, TriangleAlert
} from 'lucide-react'
import { Badge, Button, Card, Input } from '../ui'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

type UsagePeriod = 'today' | '24h' | '7d' | '30d' | '60d' | 'all'
type BreakdownMode = 'model' | 'provider' | 'account' | 'endpoint'
type ChartMetric = 'tokens' | 'requests'

interface UsageTotals {
  requests: number
  successfulRequests: number
  failedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  credits: number
  estimatedCostUsd: number
  pricedRequests: number
  avgResponseTime: number
  p95ResponseTime: number
}

interface UsageBucket {
  key: string
  label: string
  startAt: number
  requests: number
  failedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

interface UsageBreakdown extends UsageTotals {
  key: string
  label: string
  provider?: string
  model?: string
  accountId?: string
  path?: string
  lastUsedAt: number
}

interface UsageRequest {
  id: string
  timestamp: number
  path: string
  model: string
  provider: string
  providerLabel: string
  accountId?: string
  accountLabel?: string
  status: number
  success: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  credits: number
  responseTime: number
  estimatedCostUsd?: number
  pricingAvailable: boolean
  error?: string
}

interface UsageSnapshot {
  generatedAt: number
  period: UsagePeriod
  startAt: number | null
  endAt: number
  retentionDays: number
  priceCatalogVersion: string
  totals: UsageTotals
  series: UsageBucket[]
  byProvider: UsageBreakdown[]
  byModel: UsageBreakdown[]
  byAccount: UsageBreakdown[]
  byEndpoint: UsageBreakdown[]
  recentRequests: UsageRequest[]
}

const PERIODS: UsagePeriod[] = ['today', '24h', '7d', '30d', '60d', 'all']

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(Math.round(value || 0))
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0)
}

function formatCost(value: number): string {
  return `$${(value || 0).toFixed(value >= 1 ? 2 : 4)}`
}

function formatLatency(value: number): string {
  if (!value) return '-'
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString()
}

function exportSnapshot(snapshot: UsageSnapshot): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `krouter-usage-${snapshot.period}-${new Date().toISOString().slice(0, 10)}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function UsageAnalyticsPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [period, setPeriod] = useState<UsagePeriod>('today')
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [breakdownMode, setBreakdownMode] = useState<BreakdownMode>('model')
  const [chartMetric, setChartMetric] = useState<ChartMetric>('tokens')
  const [query, setQuery] = useState('')
  const [selectedRequest, setSelectedRequest] = useState<UsageRequest | null>(null)

  const load = useCallback(async (quiet = false): Promise<void> => {
    if (!quiet) setLoading(true)
    try {
      const result = await window.api.proxyGetUsageAnalytics({ period, recentLimit: 250 }) as UsageSnapshot
      setSnapshot(result)
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load usage analytics')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [period])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const interval = window.setInterval(() => void load(true), 15_000)
    return () => window.clearInterval(interval)
  }, [autoRefresh, load])

  useEffect(() => {
    if (typeof window.api.onProxyResponse !== 'function') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = window.api.onProxyResponse(() => {
      if (!autoRefresh) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(true), 500)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [autoRefresh, load])

  const breakdown = useMemo(() => {
    if (!snapshot) return []
    if (breakdownMode === 'provider') return snapshot.byProvider
    if (breakdownMode === 'account') return snapshot.byAccount
    if (breakdownMode === 'endpoint') return snapshot.byEndpoint
    return snapshot.byModel
  }, [snapshot, breakdownMode])

  const filteredRequests = useMemo(() => {
    if (!snapshot) return []
    const normalized = query.trim().toLowerCase()
    if (!normalized) return snapshot.recentRequests
    return snapshot.recentRequests.filter((request) => [
      request.model, request.providerLabel, request.accountLabel, request.accountId,
      request.path, request.error, String(request.status)
    ].some((value) => value?.toLowerCase().includes(normalized)))
  }, [snapshot, query])

  const clearAnalytics = async (): Promise<void> => {
    const confirmed = window.confirm(isEn
      ? 'Clear the dedicated usage history? System event logs are not affected.'
      : 'Xoa lich su Usage rieng? System event stream se khong bi anh huong.')
    if (!confirmed) return
    await window.api.proxyClearUsageAnalytics()
    setSelectedRequest(null)
    await load()
  }

  const totals = snapshot?.totals
  const successRate = totals?.requests ? totals.successfulRequests / totals.requests * 100 : 0
  const cacheRate = totals && totals.inputTokens + totals.cacheReadTokens > 0
    ? totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens) * 100
    : 0
  const pricingCoverage = totals?.requests ? (totals.pricedRequests / totals.requests) * 100 : 0

  return (
    <div className="usage-analytics flex-1 overflow-auto p-4 md:p-6">
      <header className="usage-hero">
        <div>
          <span className="usage-eyebrow"><BarChart3 /> {isEn ? 'TRAFFIC INTELLIGENCE' : 'PHAN TICH LUU LUONG'}</span>
          <h1>{isEn ? 'Usage & Analytics' : 'Usage & Analytics'}</h1>
          <p>{isEn
            ? 'A dedicated ledger for models, providers, token flow, latency and request outcomes.'
            : 'So cai rieng cho model, provider, token, do tre va ket qua tung request.'}</p>
        </div>
        <div className="usage-actions">
          <label className="usage-auto-refresh">
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span />
            {isEn ? 'Live refresh' : 'Tu lam moi'}
          </label>
          <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />{isEn ? 'Refresh' : 'Lam moi'}</Button>
          <Button variant="outline" onClick={() => snapshot && exportSnapshot(snapshot)} disabled={!snapshot}><Download className="h-4 w-4" />Export</Button>
          <Button variant="outline" className="text-destructive" onClick={() => void clearAnalytics()}><Trash2 className="h-4 w-4" />{isEn ? 'Clear' : 'Xoa'}</Button>
        </div>
      </header>

      <div className="usage-periods" role="tablist" aria-label="Usage period">
        {PERIODS.map((item) => (
          <button key={item} type="button" className={cn(period === item && 'active')} onClick={() => setPeriod(item)}>
            {item === 'today' ? (isEn ? 'Today' : 'Hom nay') : item === 'all' ? (isEn ? 'All time' : 'Tat ca') : item.toUpperCase()}
          </button>
        ))}
        <span className="usage-updated">{snapshot ? `${isEn ? 'Updated' : 'Cap nhat'} ${formatTime(snapshot.generatedAt)}` : ''}</span>
      </div>

      {error && <div className="usage-error"><TriangleAlert /><span>{error}</span><Button size="sm" variant="outline" onClick={() => void load()}>{isEn ? 'Retry' : 'Thu lai'}</Button></div>}

      <section className="usage-overview-grid">
        <OverviewCard icon={Activity} label={isEn ? 'Requests' : 'Request'} value={formatNumber(totals?.requests || 0)} note={`${successRate.toFixed(1)}% success`} tone="mint" />
        <OverviewCard icon={Sigma} label={isEn ? 'Input tokens' : 'Input token'} value={compactNumber(totals?.inputTokens || 0)} note={formatNumber(totals?.inputTokens || 0)} tone="coral" />
        <OverviewCard icon={Database} label={isEn ? 'Cached tokens' : 'Cached token'} value={compactNumber(totals?.cacheReadTokens || 0)} note={`${cacheRate.toFixed(1)}% cache hit`} tone="sky" />
        <OverviewCard icon={Bot} label={isEn ? 'Output tokens' : 'Output token'} value={compactNumber(totals?.outputTokens || 0)} note={`${compactNumber(totals?.reasoningTokens || 0)} reasoning`} tone="green" />
        <OverviewCard icon={Clock3} label={isEn ? 'P95 latency' : 'Do tre P95'} value={formatLatency(totals?.p95ResponseTime || 0)} note={`${formatLatency(totals?.avgResponseTime || 0)} avg`} tone="violet" />
        <OverviewCard icon={Coins} label={isEn ? 'Est. reference cost' : 'Chi phi tham chieu'} value={`~${formatCost(totals?.estimatedCostUsd || 0)}`} note={`${pricingCoverage.toFixed(0)}% priced · ${totals?.credits.toFixed(2) || '0'} credits`} tone="amber" />
      </section>

      <section className="usage-main-grid">
        <Card className="usage-chart-card">
          <div className="usage-section-head">
            <div><span>TIME SERIES</span><h2>{chartMetric === 'tokens' ? (isEn ? 'Token throughput' : 'Luong token') : (isEn ? 'Request volume' : 'Luong request')}</h2></div>
            <div className="usage-toggle">
              <button className={cn(chartMetric === 'tokens' && 'active')} onClick={() => setChartMetric('tokens')}>Tokens</button>
              <button className={cn(chartMetric === 'requests' && 'active')} onClick={() => setChartMetric('requests')}>Requests</button>
            </div>
          </div>
          <UsageChart series={snapshot?.series || []} metric={chartMetric} />
          <div className="usage-chart-legend">
            <span><i className="input" />{isEn ? 'Input' : 'Input'}</span>
            <span><i className="output" />{isEn ? 'Output' : 'Output'}</span>
            <span><i className="cache" />Cache</span>
            <span className="ml-auto">{snapshot?.series.reduce((sum, item) => sum + item.totalTokens, 0).toLocaleString() || 0} tokens</span>
          </div>
        </Card>

        <Card className="usage-pulse-card">
          <div className="usage-section-head"><div><span>ROUTE PULSE</span><h2>{isEn ? 'Provider share' : 'Ty trong provider'}</h2></div><Layers3 /></div>
          <ProviderShare items={snapshot?.byProvider || []} total={totals?.totalTokens || 0} />
        </Card>
      </section>

      <section className="usage-breakdown-card">
        <div className="usage-section-head">
          <div><span>BREAKDOWN</span><h2>{isEn ? 'Where usage went' : 'Usage da di dau'}</h2></div>
          <div className="usage-breakdown-tabs">
            {(['model', 'provider', 'account', 'endpoint'] as BreakdownMode[]).map((item) => (
              <button key={item} className={cn(breakdownMode === item && 'active')} onClick={() => setBreakdownMode(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
        <BreakdownTable items={breakdown} emptyText={isEn ? 'No usage recorded for this period.' : 'Chua co usage trong khoang thoi gian nay.'} />
      </section>

      <section className="usage-requests-card">
        <div className="usage-section-head">
          <div><span>REQUEST LEDGER</span><h2>{isEn ? 'Recent model calls' : 'Cac lan goi model gan day'}</h2></div>
          <div className="relative min-w-[260px]"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder={isEn ? 'Model, provider, endpoint, error...' : 'Model, provider, endpoint, loi...'} /></div>
        </div>
        <RequestLedger requests={filteredRequests} selectedId={selectedRequest?.id} onSelect={setSelectedRequest} isEn={isEn} />
      </section>

      {selectedRequest && <RequestInspector request={selectedRequest} onClose={() => setSelectedRequest(null)} isEn={isEn} />}

      <footer className="usage-footnote">
        <Database />
        <span>{isEn
          ? `Usage records are stored separately for ${snapshot?.retentionDays || 90} days. System event logs remain unchanged. Costs are estimates only (${snapshot?.priceCatalogVersion || 'reference catalog'}).`
          : `Usage duoc luu rieng ${snapshot?.retentionDays || 90} ngay. System event stream khong thay doi. Chi phi chi la uoc tinh (${snapshot?.priceCatalogVersion || 'reference catalog'}).`}</span>
      </footer>
    </div>
  )
}

function OverviewCard({ icon: Icon, label, value, note, tone }: { icon: React.ElementType; label: string; value: string; note: string; tone: string }): React.ReactNode {
  return <Card className={cn('usage-overview-card', tone)}><div className="usage-card-icon"><Icon /></div><div><small>{label}</small><strong title={value}>{value}</strong><span>{note}</span></div></Card>
}

function UsageChart({ series, metric }: { series: UsageBucket[]; metric: ChartMetric }): React.ReactNode {
  const max = Math.max(1, ...series.map((item) => metric === 'tokens' ? item.totalTokens + item.cacheReadTokens : item.requests))
  if (!series.length) return <div className="usage-empty-chart"><BarChart3 /><span>No data</span></div>
  return (
    <div className="usage-bars">
      {series.map((item, index) => {
        const input = metric === 'tokens' ? item.inputTokens : Math.max(0, item.requests - item.failedRequests)
        const output = metric === 'tokens' ? item.outputTokens : item.failedRequests
        const cache = metric === 'tokens' ? item.cacheReadTokens : 0
        const total = input + output + cache
        const height = Math.max(total ? 4 : 1, total / max * 100)
        return (
          <div className="usage-bar-column" key={item.key} title={`${item.label}\n${formatNumber(item.requests)} requests\n${formatNumber(item.inputTokens)} in / ${formatNumber(item.outputTokens)} out\n${formatNumber(item.cacheReadTokens)} cached`}>
            <div className="usage-bar-stack" style={{ height: `${height}%` }}>
              {cache > 0 && <i className="cache" style={{ flex: cache }} />}
              {output > 0 && <i className="output" style={{ flex: output }} />}
              {input > 0 && <i className="input" style={{ flex: input }} />}
            </div>
            {(index === 0 || index === series.length - 1 || index % Math.max(1, Math.floor(series.length / 5)) === 0) && <span>{item.label}</span>}
          </div>
        )
      })}
    </div>
  )
}

function ProviderShare({ items, total }: { items: UsageBreakdown[]; total: number }): React.ReactNode {
  if (!items.length) return <div className="usage-empty-compact"><Server /><span>Waiting for traffic</span></div>
  const colors = ['#36d399', '#fb923c', '#38bdf8', '#a78bfa', '#facc15']
  return <div className="provider-share-list">{items.slice(0, 6).map((item, index) => {
    const percent = total > 0 ? item.totalTokens / total * 100 : 0
    return <div key={item.key}><div><span><i style={{ background: colors[index % colors.length] }} />{item.label}</span><b>{percent.toFixed(1)}%</b></div><div className="provider-share-track"><i style={{ width: `${Math.max(1, percent)}%`, background: colors[index % colors.length] }} /></div><small>{compactNumber(item.totalTokens)} tokens · {item.requests} req</small></div>
  })}</div>
}

function BreakdownTable({ items, emptyText }: { items: UsageBreakdown[]; emptyText: string }): React.ReactNode {
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead><tr><th>Route</th><th>Provider</th><th>Requests</th><th>Input</th><th>Cache</th><th>Output</th><th>Reasoning</th><th>P95</th><th>Credits</th><th>Last used</th></tr></thead>
        <tbody>
          {items.map((item) => <tr key={item.key}><td><strong>{item.label}</strong><small>{item.model || item.path || item.accountId || item.key}</small></td><td><Badge variant="outline">{item.provider || '-'}</Badge></td><td>{formatNumber(item.requests)}</td><td>{formatNumber(item.inputTokens)}</td><td className="cache-cell">{formatNumber(item.cacheReadTokens)}</td><td className="output-cell">{formatNumber(item.outputTokens)}</td><td>{formatNumber(item.reasoningTokens)}</td><td>{formatLatency(item.p95ResponseTime)}</td><td>{item.credits.toFixed(2)}</td><td>{formatTime(item.lastUsedAt)}</td></tr>)}
          {!items.length && <tr><td colSpan={10}><div className="usage-table-empty"><Boxes />{emptyText}</div></td></tr>}
        </tbody>
      </table>
    </div>
  )
}

function RequestLedger({ requests, selectedId, onSelect, isEn }: { requests: UsageRequest[]; selectedId?: string; onSelect: (request: UsageRequest) => void; isEn: boolean }): React.ReactNode {
  if (!requests.length) return <div className="usage-table-empty"><Activity />{isEn ? 'Requests will appear after clients call Krouter.' : 'Request se xuat hien sau khi client goi Krouter.'}</div>
  return <div className="usage-request-list">{requests.map((request) => (
    <button type="button" key={request.id} className={cn('usage-request-row', selectedId === request.id && 'selected')} onClick={() => onSelect(request)}>
      <span className={cn('usage-request-status', request.success ? 'ok' : 'error')}>{request.success ? <CheckCircle2 /> : <TriangleAlert />}</span>
      <span className="usage-request-model"><strong>{request.model}</strong><small>{request.providerLabel} · {request.accountLabel || request.accountId || '-'}</small></span>
      <span className="usage-request-endpoint"><code>{request.path}</code><small>{formatTime(request.timestamp)}</small></span>
      <span className="usage-token-pair"><b>{formatNumber(request.inputTokens)}</b><small>IN</small></span>
      <span className="usage-token-pair output"><b>{formatNumber(request.outputTokens)}</b><small>OUT</small></span>
      <span className="usage-token-pair cache"><b>{formatNumber(request.cacheReadTokens)}</b><small>CACHE</small></span>
      <span className="usage-request-latency"><Gauge />{formatLatency(request.responseTime)}</span>
      <Badge variant={request.success ? 'success' : 'destructive'}>{request.status}</Badge>
    </button>
  ))}</div>
}

function RequestInspector({ request, onClose, isEn }: { request: UsageRequest; onClose: () => void; isEn: boolean }): React.ReactNode {
  const fields: Array<[string, string]> = [
    ['Provider', request.providerLabel],
    ['Model', request.model],
    ['Endpoint', request.path],
    ['Account', request.accountLabel || request.accountId || '-'],
    ['Status', String(request.status)],
    ['Input tokens', formatNumber(request.inputTokens)],
    ['Output tokens', formatNumber(request.outputTokens)],
    ['Cache read', formatNumber(request.cacheReadTokens)],
    ['Cache write', formatNumber(request.cacheWriteTokens)],
    ['Reasoning', formatNumber(request.reasoningTokens)],
    ['Total tokens', formatNumber(request.totalTokens)],
    ['Credits', request.credits.toFixed(4)],
    ['Latency', formatLatency(request.responseTime)],
    ['Time', formatTime(request.timestamp)]
  ]
  return <div className="usage-inspector-backdrop" onClick={onClose}><aside className="usage-inspector" onClick={(event) => event.stopPropagation()}><div className="usage-inspector-head"><div><span>REQUEST DETAIL</span><h2>{request.model}</h2></div><Button variant="ghost" onClick={onClose}>Close</Button></div><div className="usage-inspector-grid">{fields.map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>{request.error && <div className="usage-inspector-error"><TriangleAlert /><div><strong>{isEn ? 'Upstream error' : 'Loi upstream'}</strong><p>{request.error}</p></div></div>}<p className="usage-inspector-note">{isEn ? 'Prompts, responses, API keys and OAuth tokens are never stored in Usage Analytics.' : 'Usage Analytics khong luu prompt, response, API key hay OAuth token.'}</p></aside></div>
}
