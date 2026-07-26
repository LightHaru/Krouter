import { memo, useMemo, useState, type ReactElement } from 'react'
import { Activity, AlertCircle, CheckCircle2, Clock3, FileText, Search, Server, Sigma } from 'lucide-react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input } from '../ui'
import { cn } from '@/lib/utils'

export type RecentLogEntry = {
  time: string
  path: string
  model?: string
  status: number
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  credits?: number
  responseTime?: number
  accountId?: string
  accountEmail?: string
  error?: string
}

interface RecentRequestsPanelProps {
  logs: RecentLogEntry[]
  isEn: boolean
  onViewAll: () => void
  onViewDetailed: () => void
}

function shortModel(model?: string): string {
  if (!model) return '-'
  return model.replace('anthropic.', '').replace('-v1:0', '')
}

function providerLabel(log: RecentLogEntry): string {
  if (log.accountEmail) return log.accountEmail
  if (log.accountId === 'bedrock') return 'AWS Bedrock'
  if (log.accountId?.startsWith('custom:')) return log.accountId.slice(7)
  return log.accountId || '-'
}

function Metric({ icon, label, value, tone }: { icon: ReactElement; label: string; value: string; tone: string }): ReactElement {
  return <div className="rounded-xl border bg-background/70 p-3"><div className={cn('flex items-center gap-1.5 text-xs', tone)}>{icon}<span>{label}</span></div><p className="mt-1.5 text-lg font-semibold tracking-tight">{value}</p></div>
}

function RecentRequestsPanelInner({ logs, isEn, onViewAll, onViewDetailed }: RecentRequestsPanelProps): ReactElement {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'success' | 'error'>('all')

  const metrics = useMemo(() => {
    const success = logs.filter((log) => log.status < 400).length
    const errors = logs.length - success
    const avgLatency = logs.length ? logs.reduce((sum, log) => sum + (log.responseTime || 0), 0) / logs.length : 0
    const tokens = logs.reduce((sum, log) => sum + (log.tokens || (log.inputTokens || 0) + (log.outputTokens || 0)), 0)
    return { success, errors, avgLatency, tokens }
  }, [logs])

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return logs.filter((log) => {
      if (filter === 'success' && log.status >= 400) return false
      if (filter === 'error' && log.status < 400) return false
      if (!normalized) return true
      return [log.path, log.model, providerLabel(log), log.error, String(log.status)].some((value) => value?.toLowerCase().includes(normalized))
    })
  }, [logs, query, filter])

  return (
    <Card className="overflow-hidden border bg-gradient-to-br from-background via-background to-primary/[0.03]">
      <CardHeader className="border-b pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base"><div className="rounded-lg bg-primary/10 p-2"><Activity className="h-4 w-4 text-primary" /></div><div><span>{isEn ? 'Recent requests' : 'Request gần đây'}</span><p className="mt-0.5 text-xs font-normal text-muted-foreground">{isEn ? 'Live traffic, provider routing and usage' : 'Lưu lượng, định tuyến provider và mức dùng theo thời gian thực'}</p></div></CardTitle>
          <div className="flex gap-2"><Button variant="outline" size="sm" onClick={onViewAll}><FileText className="mr-1.5 h-3.5 w-3.5" />{isEn ? 'All logs' : 'Tất cả log'}</Button><Button variant="outline" size="sm" onClick={onViewDetailed}><Activity className="mr-1.5 h-3.5 w-3.5" />{isEn ? 'Inspect' : 'Chi tiết'}</Button></div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Metric icon={<CheckCircle2 className="h-3.5 w-3.5" />} label={isEn ? 'Succeeded' : 'Thành công'} value={metrics.success.toLocaleString()} tone="text-emerald-600" />
          <Metric icon={<AlertCircle className="h-3.5 w-3.5" />} label={isEn ? 'Failed' : 'Thất bại'} value={metrics.errors.toLocaleString()} tone="text-destructive" />
          <Metric icon={<Clock3 className="h-3.5 w-3.5" />} label={isEn ? 'Avg latency' : 'Độ trễ TB'} value={metrics.avgLatency ? `${(metrics.avgLatency / 1000).toFixed(2)}s` : '-'} tone="text-sky-600" />
          <Metric icon={<Sigma className="h-3.5 w-3.5" />} label="Tokens" value={metrics.tokens.toLocaleString()} tone="text-violet-600" />
        </div>
      </CardHeader>
      <CardContent className="p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 pl-9" placeholder={isEn ? 'Search model, provider, path or error...' : 'Tìm model, provider, endpoint hoặc lỗi...'} /></div>
          <div className="flex rounded-lg border bg-muted/30 p-0.5">{(['all', 'success', 'error'] as const).map((item) => <button key={item} type="button" onClick={() => setFilter(item)} className={cn('rounded-md px-3 py-1.5 text-xs transition-colors', filter === item ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground')}>{item === 'all' ? (isEn ? 'All' : 'Tất cả') : item === 'success' ? (isEn ? 'Success' : 'Thành công') : (isEn ? 'Errors' : 'Có lỗi')}</button>)}</div>
          <Badge variant="secondary">{filtered.length}/{logs.length}</Badge>
        </div>

        {filtered.length === 0 ? <div className="grid min-h-40 place-items-center rounded-xl border border-dashed bg-muted/15 text-center text-sm text-muted-foreground"><div><Server className="mx-auto mb-2 h-6 w-6" />{logs.length === 0 ? (isEn ? 'Requests will appear here when clients call the proxy.' : 'Request sẽ xuất hiện khi client gọi Proxy API.') : (isEn ? 'No requests match this filter.' : 'Không có request phù hợp bộ lọc.')}</div></div> : (
          <div className="max-h-[430px] space-y-1 overflow-y-auto pr-1">
            {filtered.map((log, index) => {
              const ok = log.status < 400
              const totalTokens = log.tokens || (log.inputTokens || 0) + (log.outputTokens || 0)
              return <div key={`${log.time}|${log.path}|${log.model || ''}|${index}`} className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-colors hover:border-border hover:bg-muted/35"><div className={cn('grid h-8 w-8 place-items-center rounded-lg', ok ? 'bg-emerald-500/10 text-emerald-600' : 'bg-destructive/10 text-destructive')}>{ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}</div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><code className="truncate text-xs font-semibold">{shortModel(log.model)}</code><Badge variant="outline" className="h-5 text-[10px]">{providerLabel(log)}</Badge><span className="truncate text-[11px] text-muted-foreground">{log.path}</span></div><div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground"><span>{log.time}</span><span>In {log.inputTokens?.toLocaleString() || '-'}</span><span>Out {log.outputTokens?.toLocaleString() || '-'}</span>{log.cacheReadTokens ? <span className="text-emerald-600">Cache {log.cacheReadTokens.toLocaleString()}</span> : null}{log.reasoningTokens ? <span className="text-violet-600">Think {log.reasoningTokens.toLocaleString()}</span> : null}{log.error ? <span className="max-w-xl truncate text-destructive" title={log.error}>{log.error}</span> : null}</div></div><div className="text-right"><Badge className={ok ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600' : 'border-destructive/20 bg-destructive/10 text-destructive'}>{log.status || (ok ? 200 : 500)}</Badge><div className="mt-1.5 flex items-center justify-end gap-2 text-[10px] text-muted-foreground"><span>{totalTokens.toLocaleString()} tok</span><span>{log.responseTime ? `${(log.responseTime / 1000).toFixed(2)}s` : '-'}</span></div></div></div>
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export const RecentRequestsPanel = memo(RecentRequestsPanelInner)
