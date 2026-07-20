import { memo, type ReactElement } from 'react'
import { Activity, FileText } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '../ui'

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

const GRID_TEMPLATE = '1.7fr 0.9fr 1.2fr 1.1fr 0.45fr 0.7fr 0.7fr 0.9fr 0.7fr 0.7fr 0.6fr'

function shortModel(model?: string): string {
  if (!model) return '-'
  return model.replace('anthropic.', '').replace('-v1:0', '')
}

function RecentRequestsPanelInner({ logs, isEn, onViewAll, onViewDetailed }: RecentRequestsPanelProps): ReactElement | null {
  if (logs.length === 0) return null

  return (
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
            <Badge variant="secondary" className="text-xs">{logs.length}</Badge>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onViewAll}>
              <FileText className="h-3 w-3 mr-1" />
              {isEn ? 'View All' : 'Xem tất cả'}
            </Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onViewDetailed}>
              <Activity className="h-3 w-3 mr-1" />
              {isEn ? 'Detailed Logs' : 'Log chi tiết'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-2">
        {/* Cuộn ngang trên màn hình hẹp: min-width giữ các cột không bị ép chồng dòng
            (vd status "503" từng bị xuống dòng thành 5/0/3 trông như lỗi) */}
        <div className="overflow-x-auto">
          <div className="min-w-[860px]">
            {/* Column headers */}
            <div
              className="grid gap-2 px-2 pb-1 mb-1 border-b text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              style={{ gridTemplateColumns: GRID_TEMPLATE }}
            >
              <span className="text-left">{isEn ? 'Time' : 'Thời gian'}</span>
              <span className="text-left">{isEn ? 'Path' : 'Đường dẫn'}</span>
              <span className="text-left">Model</span>
              <span className="text-left">{isEn ? 'Account' : 'Tài khoản'}</span>
              <span className="text-center">{isEn ? 'St' : 'TT'}</span>
              <span className="text-right">In</span>
              <span className="text-right">Out</span>
              <span className="text-right" title={isEn ? 'Cache Read/Write' : 'Cache đọc/ghi'}>Cache</span>
              <span className="text-right" title={isEn ? 'Reasoning tokens' : 'Token suy luận'}>Think</span>
              <span className="text-right">{isEn ? 'Credit' : 'Tín dụng'}</span>
              <span className="text-right">{isEn ? 'Time' : 'Độ trễ'}</span>
            </div>
            <div className="max-h-[360px] overflow-y-auto text-xs font-mono space-y-0.5">
              {logs.map((log) => (
                <div
                  key={`${log.time}|${log.path}|${log.model || ''}`}
                  className="grid gap-2 py-1 px-2 rounded hover:bg-muted/50 items-center"
                  style={{ gridTemplateColumns: GRID_TEMPLATE }}
                >
                  <span className="text-muted-foreground whitespace-nowrap text-left">{log.time}</span>
                  <span className="truncate text-left" title={log.path}>{log.path}</span>
                  <span className="truncate text-left text-muted-foreground" title={log.model}>{shortModel(log.model)}</span>
                  <span className="truncate text-left text-muted-foreground" title={log.accountEmail || log.accountId}>{log.accountEmail || log.accountId || '-'}</span>
                  <span className={`text-center whitespace-nowrap ${log.status >= 400 ? 'text-destructive' : 'text-success'}`}>{log.status}</span>
                  <span className="text-muted-foreground text-right whitespace-nowrap">{log.inputTokens ? log.inputTokens.toLocaleString() : '-'}</span>
                  <span className="text-muted-foreground text-right whitespace-nowrap">{log.outputTokens ? log.outputTokens.toLocaleString() : '-'}</span>
                  <span className="text-right whitespace-nowrap">
                    {log.cacheReadTokens ? (
                      // Cache HIT: nổi bật phần read (tiết kiệm lặp lại). Write ở tooltip.
                      <span
                        className="inline-flex items-center gap-0.5 rounded px-1 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        title={`${isEn ? 'Cache read' : 'Đọc cache'}: ${log.cacheReadTokens.toLocaleString()}${log.cacheWriteTokens ? ` · ${isEn ? 'write' : 'ghi'}: ${log.cacheWriteTokens.toLocaleString()}` : ''}`}
                      >✓{log.cacheReadTokens.toLocaleString()}</span>
                    ) : log.cacheWriteTokens ? (
                      // Chỉ có write (lần đầu tạo cache): hiện mờ hơn.
                      <span className="text-amber-500/80" title={`${isEn ? 'Cache write (first time)' : 'Ghi cache (lần đầu)'}: ${log.cacheWriteTokens.toLocaleString()}`}>+{log.cacheWriteTokens.toLocaleString()}</span>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </span>
                  <span className="text-violet-500 text-right whitespace-nowrap">{log.reasoningTokens ? log.reasoningTokens.toLocaleString() : '-'}</span>
                  <span className="text-muted-foreground text-right whitespace-nowrap">{log.credits ? log.credits.toFixed(4) : '-'}</span>
                  <span className="text-muted-foreground text-right whitespace-nowrap">{log.responseTime ? `${(log.responseTime / 1000).toFixed(1)}s` : '-'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export const RecentRequestsPanel = memo(RecentRequestsPanelInner)
