import { useCallback, useEffect, useState } from 'react'
import { Button, Card, CardContent, Badge } from '../ui'
import { Key, Loader2, RefreshCw, Trash2, Plus, CheckCircle2, AlertTriangle, Server } from 'lucide-react'
import { cn } from '@/lib/utils'

interface XpixiConfigView {
  enabled?: boolean
  apiKey?: string
  baseUrl?: string
  models?: string[]
}

interface XpixiModelView {
  id: string
}

interface XpixiAccountsPanelProps {
  isEn: boolean
  onAddXpixi: () => void
}

function maskKey(key?: string): string {
  if (!key) return ''
  if (key.length <= 10) return key
  return `${key.slice(0, 8)}...${key.slice(-8)}`
}

export function XpixiAccountsPanel({ isEn, onAddXpixi }: XpixiAccountsPanelProps): React.ReactNode {
  const [config, setConfig] = useState<XpixiConfigView | null>(null)
  const [loading, setLoading] = useState(true)
  const [models, setModels] = useState<XpixiModelView[]>([])
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)

  const loadConfig = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await window.api.proxyGetStatus()
      const cfg = (status?.config as { xpixi?: XpixiConfigView } | undefined)?.xpixi || null
      setConfig(cfg)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load config')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadConfig()
  }, [loadConfig])

  const configured = Boolean(config?.enabled && config?.apiKey)

  const testAndLoad = useCallback(async () => {
    if (!configured) return
    setTesting(true)
    setError(null)
    try {
      const result = await window.api.proxyTestXpixi({
        apiKey: config?.apiKey,
        baseUrl: config?.baseUrl
      })
      if (result.success) {
        setModels(result.models || [])
      } else {
        setError(result.error || (isEn ? 'API key test failed' : 'Kiểm tra key thất bại'))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }, [configured, config, isEn])

  useEffect(() => {
    if (configured) void testAndLoad()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured])

  const handleRemove = async () => {
    if (!confirm(isEn ? 'Remove this Xpixi provider? Requests will stop using it.' : 'Xóa Xpixi provider này? Backend sẽ ngừng dùng nó.')) return
    setRemoving(true)
    setError(null)
    try {
      await window.api.proxyUpdateConfig({ xpixi: { enabled: false, apiKey: '', models: [] } })
      setConfig(null)
      setModels([])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remove failed')
    } finally {
      setRemoving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        {isEn ? 'Loading Xpixi provider...' : 'Đang tải Xpixi...'}
      </div>
    )
  }

  if (!configured) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
        <div className="p-4 rounded-full bg-primary/10">
          <Key className="h-8 w-8 text-primary" />
        </div>
        <div>
          <p className="font-medium">{isEn ? 'No Xpixi provider yet' : 'Chưa có Xpixi provider'}</p>
          <p className="text-sm text-muted-foreground mt-1 max-w-md">
            {isEn
              ? 'Add Xpixi API key to access third-party Claude models with flexible quota management.'
              : 'Thêm Xpixi API key để truy cập các model Claude của bên thứ ba với quản lý quota linh hoạt.'}
          </p>
        </div>
        <Button onClick={onAddXpixi} className="rounded-xl">
          <Plus className="h-4 w-4 mr-1.5" />
          {isEn ? 'Add Xpixi' : 'Thêm Xpixi'}
        </Button>
      </div>
    )
  }

  const exposed = config?.models && config.models.length > 0 ? config.models : null
  const baseUrl = config?.baseUrl || 'https://api.xpiki.com'

  return (
    <div className="h-full overflow-y-auto px-1 py-1 space-y-4">
      <Card className="border bg-background">
        <CardContent className="p-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-primary/10">
                <Server className="h-5 w-5 text-primary" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold">Xpixi</span>
                  <Badge className="bg-success/15 text-success border-success/20">
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    {isEn ? 'Active' : 'Đang bật'}
                  </Badge>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 space-x-2">
                  <span>{isEn ? 'Endpoint' : 'Endpoint'}: <code className="font-mono">{baseUrl}</code></span>
                  <span>Key: <code className="font-mono">{maskKey(config?.apiKey)}</code></span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={testAndLoad} disabled={testing} className="rounded-lg">
                {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                <span className="ml-1.5">{isEn ? 'Reload models' : 'Tải lại model'}</span>
              </Button>
              <Button variant="outline" size="sm" onClick={handleRemove} disabled={removing} className="rounded-lg text-destructive hover:bg-destructive hover:text-white">
                {removing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary" className="border-0">{isEn ? 'Total' : 'Tổng'}: {models.length}</Badge>
            {exposed && <Badge variant="secondary" className="border-0 bg-primary/15 text-primary">{isEn ? 'Exposed' : 'Đang expose'}: {exposed.length}</Badge>}
          </div>

          {testing ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {isEn ? 'Loading models...' : 'Đang tải model...'}
            </div>
          ) : models.length > 0 ? (
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">{isEn ? 'Available models' : 'Các model khả dụng'}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-96 overflow-y-auto pr-1">
                  {models.map(m => (
                    <div key={m.id} className={cn('flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs', exposed && !exposed.includes(m.id) ? 'opacity-40' : '')}>
                      <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                      <code className="truncate font-mono">{m.id}</code>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground py-2">{isEn ? 'No models found or API key invalid.' : 'Không tìm thấy model hoặc API key không hợp lệ.'}</div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
