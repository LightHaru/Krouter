import { useState, useEffect } from 'react'
import { ProxyPanel, BedrockPanel } from '../proxy'
import { useTranslation } from '@/hooks/useTranslation'
import { Server, Activity, BarChart3 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, Badge } from '../ui'

interface AccountHealthData {
  id: string
  email?: string
  tier?: string
  isAvailable: boolean
  health: {
    successRate: number
    avgLatency: number
    overallScore: number
    isHealthy: boolean
    quotaUsagePercent: number
    requestsPerMinute: number
    throttleCount: number
  }
  requestCount: number
}

interface EndpointMetricsData {
  path: string
  totalRequests: number
  successCount: number
  errorCount: number
  avgResponseTime: number
  p95ResponseTime: number
}

function AccountHealthWidget({ isEn }: { isEn: boolean }) {
  const [accounts, setAccounts] = useState<AccountHealthData[]>([])
  const [endpoints, setEndpoints] = useState<EndpointMetricsData[]>([])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 10000)
    return () => clearInterval(interval)
  }, [])

  async function loadData() {
    try {
      const [healthRes, metricsRes] = await Promise.all([
        (window as any).api?.proxyGetAccountHealth?.(),
        (window as any).api?.proxyGetEndpointMetrics?.()
      ])
      if (healthRes?.accounts) setAccounts(healthRes.accounts)
      if (metricsRes?.endpoints) setEndpoints(metricsRes.endpoints)
    } catch { /* ignore */ }
  }

  const healthyCount = accounts.filter(a => a.health?.isHealthy).length
  const unhealthyCount = accounts.filter(a => a.health && !a.health.isHealthy).length
  const totalRequests = endpoints.reduce((sum, e) => sum + e.totalRequests, 0)
  const avgLatency = endpoints.length > 0
    ? Math.round(endpoints.reduce((sum, e) => sum + e.avgResponseTime, 0) / endpoints.length)
    : 0

  if (accounts.length === 0 && endpoints.length === 0) return null

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Account Health Summary */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            {isEn ? 'Account Health' : 'Suc khoe tai khoan'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 mb-3">
            <div className="text-center">
              <div className="text-2xl font-bold text-green-500">{healthyCount}</div>
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Healthy' : 'Khoe'}</div>
            </div>
            {unhealthyCount > 0 && (
              <div className="text-center">
                <div className="text-2xl font-bold text-red-500">{unhealthyCount}</div>
                <div className="text-[10px] text-muted-foreground">{isEn ? 'Unhealthy' : 'Yeu'}</div>
              </div>
            )}
          </div>
          <div className="space-y-1 max-h-[120px] overflow-auto">
            {accounts.slice(0, 8).map(a => (
              <div key={a.id} className="flex items-center justify-between text-xs">
                <span className="truncate max-w-[140px]">{a.email || a.id.slice(0, 8)}</span>
                <div className="flex items-center gap-1">
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: `hsl(${(a.health?.overallScore || 0) * 120}, 70%, 50%)` }}
                  />
                  <span className="text-muted-foreground w-8 text-right">
                    {Math.round((a.health?.overallScore || 0) * 100)}%
                  </span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Endpoint Metrics */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            {isEn ? 'Endpoint Metrics' : 'Metrics endpoint'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 mb-3">
            <div className="text-center">
              <div className="text-2xl font-bold">{totalRequests}</div>
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Total Requests' : 'Tong request'}</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold">{avgLatency}ms</div>
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Avg Latency' : 'Latency TB'}</div>
            </div>
          </div>
          <div className="space-y-1 max-h-[120px] overflow-auto">
            {endpoints.map(ep => {
              const errRate = ep.totalRequests > 0 ? (ep.errorCount / ep.totalRequests * 100) : 0
              return (
                <div key={ep.path} className="flex items-center justify-between text-xs">
                  <span className="font-mono truncate max-w-[140px]">{ep.path}</span>
                  <div className="flex items-center gap-2">
                    <span>{ep.totalRequests}</span>
                    {errRate > 5 && (
                      <Badge variant="destructive" className="text-[9px] px-1 py-0">
                        {errRate.toFixed(0)}% err
                      </Badge>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export function ProxyPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* 页面标题 */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary shadow-lg shadow-primary/25">
            <Server className="h-6 w-6 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">{isEn ? 'API Proxy Service' : 'API 反代服务'}</h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'Provide OpenAI and Claude compatible API endpoints with multi-account rotation'
                : '提供 OpenAI 和 Claude 兼容的 API 端点，支持多账号轮询'
              }
            </p>
          </div>
        </div>
      </div>
      {/* Phase 8+10: Health & Metrics Dashboard */}
      <AccountHealthWidget isEn={isEn} />
      {/* Phase 11: Bedrock Diagnostics */}
      <BedrockPanel isEn={isEn} />
      <ProxyPanel />
    </div>
  )
}
