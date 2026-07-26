import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Cloud, Loader2, Plus, RefreshCw, Search, Trash2, Zap } from 'lucide-react'
import { Badge, Button, Card, CardContent, Input } from '../ui'

interface BedrockConfigView { enabled?: boolean; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string; models?: string[] }
interface BedrockModelView { id: string; name?: string; provider?: string; kind: 'foundation' | 'profile' }
interface Props { isEn: boolean; onAddBedrock: () => void }

function maskKey(key?: string): string { return key ? `${key.slice(0, 4)}...${key.slice(-4)}` : '-' }

export function BedrockAccountsPanel({ isEn, onAddBedrock }: Props): React.ReactNode {
  const [config, setConfig] = useState<BedrockConfigView | null>(null)
  const [models, setModels] = useState<BedrockModelView[]>([])
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [busyModel, setBusyModel] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, { ok: boolean; latencyMs?: number; error?: string }>>({})

  const loadConfig = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const status = await window.api.proxyGetStatus()
      setConfig(((status?.config as { bedrock?: BedrockConfigView })?.bedrock) || null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to load Bedrock') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void loadConfig() }, [loadConfig])
  const configured = Boolean(config?.enabled && config.accessKeyId && config.secretAccessKey)

  const discover = useCallback(async (): Promise<void> => {
    if (!configured) return
    setTesting(true); setError(null)
    try {
      const result = await window.api.proxyTestBedrock({ accessKeyId: config?.accessKeyId, secretAccessKey: config?.secretAccessKey, sessionToken: config?.sessionToken, region: config?.region })
      if (!result.success) throw new Error(result.error || 'Credential test failed')
      setModels(result.models || [])
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Credential test failed') }
    finally { setTesting(false) }
  }, [configured, config])

  useEffect(() => { if (configured) void discover() }, [configured, discover])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? models.filter((model) => `${model.id} ${model.provider || ''} ${model.kind}`.toLowerCase().includes(needle)) : models
  }, [models, query])

  const profiles = models.filter((model) => model.kind === 'profile').length
  const exposed = config?.models?.length || models.length

  const testModel = async (modelId: string): Promise<void> => {
    setBusyModel(modelId)
    try {
      const response = await window.api.proxyProbeModels({ modelIds: [modelId], concurrency: 1 })
      const probe = response.results?.find((item) => item.modelId === modelId && item.tier === 'bedrock')
      setResults((current) => ({ ...current, [modelId]: { ok: Boolean(probe?.ok), latencyMs: probe?.latencyMs, error: probe?.error || response.error } }))
    } finally { setBusyModel(null) }
  }

  const remove = async (): Promise<void> => {
    if (!confirm(isEn ? 'Remove AWS Bedrock?' : 'Xóa AWS Bedrock?')) return
    await window.api.proxyUpdateConfig({ bedrock: { enabled: false, accessKeyId: '', secretAccessKey: '', sessionToken: '', models: [] } })
    setConfig(null); setModels([])
  }

  if (loading) return <ProviderLoader text={isEn ? 'Loading Bedrock workspace...' : 'Đang tải không gian Bedrock...'} />
  if (!configured) return <ProviderEmpty icon={Cloud} title={isEn ? 'Connect AWS Bedrock' : 'Kết nối AWS Bedrock'} body={isEn ? 'Add an AWS identity to unlock premium and cross-region models.' : 'Thêm AWS identity để dùng model premium và cross-region.'} action={isEn ? 'Add Bedrock' : 'Thêm Bedrock'} onClick={onAddBedrock} />

  return (
    <div className="provider-workspace">
      <div className="provider-workspace-head">
        <div className="provider-identity"><div className="provider-brand bedrock"><Cloud /></div><div><div className="provider-title-line"><h2>AWS Bedrock</h2><Badge variant="success"><CheckCircle2 /> {isEn ? 'Connected' : 'Đã kết nối'}</Badge></div><p>{config?.region || 'us-east-1'} · {maskKey(config?.accessKeyId)} · {isEn ? 'Managed AWS route' : 'Tuyến AWS được quản lý'}</p></div></div>
        <div className="provider-actions"><Button variant="outline" onClick={() => void discover()} disabled={testing}>{testing ? <Loader2 className="animate-spin" /> : <RefreshCw />}{isEn ? 'Discover models' : 'Tải model'}</Button><Button variant="outline" size="icon" className="text-destructive" onClick={() => void remove()}><Trash2 /></Button></div>
      </div>

      {error && <div className="provider-alert"><AlertTriangle /><span>{error}</span></div>}

      <div className="provider-stat-row">
        <ProviderStat label={isEn ? 'Discovered' : 'Đã tìm thấy'} value={models.length} detail="models" />
        <ProviderStat label="Inference profiles" value={profiles} detail={isEn ? 'cross-region' : 'đa vùng'} />
        <ProviderStat label={isEn ? 'Foundation' : 'Nền tảng'} value={models.length - profiles} detail="on-demand" />
        <ProviderStat label={isEn ? 'Exposed routes' : 'Tuyến công khai'} value={exposed} detail="API proxy" />
      </div>

      <div className="provider-catalog-bar"><div><span>{isEn ? 'MODEL CATALOG' : 'DANH MỤC MODEL'}</span><strong>{filtered.length} {isEn ? 'available routes' : 'tuyến khả dụng'}</strong></div><div className="provider-search"><Search /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isEn ? 'Search model or provider...' : 'Tìm model hoặc provider...'} /></div></div>

      <div className="provider-model-grid">
        {testing && models.length === 0 ? <ProviderLoader text={isEn ? 'Discovering invokable models...' : 'Đang tìm model có thể gọi...'} /> : filtered.map((model) => {
          const result = results[model.id]
          return <Card key={model.id} className="provider-model-card"><CardContent><div className="model-card-top"><span className={`model-kind ${model.kind}`}><Zap />{model.kind}</span><span className={result ? (result.ok ? 'model-health ok' : 'model-health fail') : 'model-health'}>{result ? (result.ok ? `${result.latencyMs || 0}ms` : 'Failed') : 'Untested'}</span></div><code title={model.id}>{model.id}</code><div className="model-card-foot"><span>{model.provider || model.id.split('.')[1] || 'AWS'}</span><Button size="sm" variant="ghost" onClick={() => void testModel(model.id)} disabled={busyModel === model.id}>{busyModel === model.id ? <Loader2 className="animate-spin" /> : (isEn ? 'Test route' : 'Kiểm tra')}</Button></div></CardContent></Card>
        })}
      </div>
    </div>
  )
}

function ProviderStat({ label, value, detail }: { label: string; value: number; detail: string }): React.ReactNode { return <div className="provider-stat"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div> }
function ProviderLoader({ text }: { text: string }): React.ReactNode { return <div className="provider-loader"><Loader2 className="animate-spin" /><span>{text}</span></div> }
function ProviderEmpty({ icon: Icon, title, body, action, onClick }: { icon: React.ElementType; title: string; body: string; action: string; onClick: () => void }): React.ReactNode { return <div className="provider-empty"><div className="provider-brand bedrock"><Icon /></div><h2>{title}</h2><p>{body}</p><Button onClick={onClick}><Plus />{action}</Button></div> }
