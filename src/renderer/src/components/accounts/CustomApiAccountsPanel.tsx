import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, KeyRound, Loader2, Plus, RefreshCw, Search, Server, Trash2 } from 'lucide-react'
import { Badge, Button, Card, CardContent, Input } from '../ui'
import { CustomApiProviderDetail } from './CustomApiProviderDetail'
import { maskCustomApiKey, providerKeys, type CustomProviderView } from './customApiTypes'

interface Props {
  isEn: boolean
  selectedProviderId?: string | null
  onOpenProvider: (providerId: string) => void
  onBackToProviders: () => void
  onAddProvider: () => void
}

export function CustomApiAccountsPanel({
  isEn,
  selectedProviderId,
  onOpenProvider,
  onBackToProviders,
  onAddProvider
}: Props): React.ReactNode {
  const [providers, setProviders] = useState<CustomProviderView[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Record<string, { success: boolean; models: string[]; error?: string }>>({})
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (showLoader = true): Promise<void> => {
    if (showLoader) setLoading(true)
    setError(null)
    try {
      const status = await window.api.proxyGetStatus()
      const config = status?.config as {
        customApiProviders?: CustomProviderView[]
        xpixi?: { enabled?: boolean; apiKey?: string; baseUrl?: string; models?: string[] }
      } | undefined
      const next = [...(config?.customApiProviders || [])]
      if (config?.xpixi?.enabled && config.xpixi.apiKey && !next.some((item) => item.id === 'xpixi')) {
        next.push({
          id: 'xpixi',
          name: 'Xpixi (legacy)',
          enabled: true,
          protocol: 'openai',
          authType: 'bearer',
          apiKey: config.xpixi.apiKey,
          baseUrl: config.xpixi.baseUrl || 'https://api.xpiki.com',
          routePrefix: 'xpixi',
          models: config.xpixi.models,
          legacy: true
        })
      }
      setProviders(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load providers')
    } finally {
      if (showLoader) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const selectedProvider = selectedProviderId
    ? providers.find((provider) => provider.id === selectedProviderId)
    : undefined

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return providers
    return providers.filter((provider) => {
      const models = results[provider.id]?.models || provider.models || []
      return `${provider.name} ${provider.baseUrl} ${provider.protocol} ${models.join(' ')}`.toLowerCase().includes(needle)
    })
  }, [providers, query, results])

  const totalModels = providers.reduce((sum, provider) => sum + (results[provider.id]?.models || provider.models || []).length, 0)
  const activeProviders = providers.filter((provider) => provider.enabled).length
  const protocols = new Set(providers.map((provider) => provider.protocol)).size

  const testProvider = async (provider: CustomProviderView): Promise<void> => {
    setBusyId(provider.id)
    try {
      const result = await window.api.proxyTestCustomApi(provider)
      setResults((current) => ({
        ...current,
        [provider.id]: {
          success: result.success,
          models: (result.models || []).map((model) => model.upstreamId),
          error: result.error
        }
      }))
    } catch (cause) {
      setResults((current) => ({
        ...current,
        [provider.id]: { success: false, models: [], error: cause instanceof Error ? cause.message : 'Test failed' }
      }))
    } finally {
      setBusyId(null)
    }
  }

  const removeProvider = async (provider: CustomProviderView): Promise<void> => {
    if (!confirm(isEn ? `Remove ${provider.name}?` : `Xoa provider ${provider.name}?`)) return
    setBusyId(provider.id)
    try {
      if (provider.legacy) {
        await window.api.proxyUpdateConfig({ xpixi: { enabled: false, apiKey: '', models: [] } })
      } else {
        await window.api.proxyUpdateConfig({ customApiProviders: providers.filter((item) => item.id !== provider.id && !item.legacy) })
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }

  if (loading) return <ProviderLoader text={isEn ? 'Loading Custom API workspace...' : 'Dang tai Custom API...'} />

  if (selectedProviderId && selectedProvider) {
    return (
      <CustomApiProviderDetail
        isEn={isEn}
        provider={selectedProvider}
        providers={providers.filter((provider) => !provider.legacy)}
        onBack={onBackToProviders}
        onSaved={() => load(false)}
      />
    )
  }

  if (selectedProviderId && !selectedProvider) {
    return (
      <div className="provider-empty">
        <AlertTriangle />
        <h2>{isEn ? 'Provider not found' : 'Khong tim thay provider'}</h2>
        <Button onClick={onBackToProviders}>{isEn ? 'Back to providers' : 'Ve danh sach provider'}</Button>
      </div>
    )
  }

  if (providers.length === 0) {
    return (
      <div className="provider-empty">
        <div className="provider-brand custom"><KeyRound /></div>
        <h2>{isEn ? 'Connect a Custom API' : 'Ket noi Custom API'}</h2>
        <p>{isEn ? 'Bring any OpenAI- or Anthropic-compatible endpoint into the same routing fabric.' : 'Them endpoint tuong thich OpenAI hoac Anthropic vao cung he thong dinh tuyen.'}</p>
        <Button onClick={onAddProvider}><Plus />{isEn ? 'Add provider' : 'Them provider'}</Button>
      </div>
    )
  }

  return (
    <div className="provider-workspace">
      <div className="provider-workspace-head">
        <div className="provider-identity">
          <div className="provider-brand custom"><KeyRound /></div>
          <div>
            <div className="provider-title-line"><h2>Custom API</h2><Badge variant="success"><CheckCircle2 /> {activeProviders} {isEn ? 'active' : 'dang bat'}</Badge></div>
            <p>{isEn ? 'OpenAI and Anthropic compatible routes, isolated by provider prefix.' : 'Tuyen OpenAI va Anthropic duoc tach rieng theo prefix provider.'}</p>
          </div>
        </div>
        <div className="provider-actions">
          <Button variant="outline" onClick={() => void load()}><RefreshCw />{isEn ? 'Refresh' : 'Tai lai'}</Button>
          <Button onClick={onAddProvider}><Plus />{isEn ? 'Add provider' : 'Them provider'}</Button>
        </div>
      </div>

      {error && <div className="provider-alert"><AlertTriangle /><span>{error}</span></div>}

      <div className="provider-stat-row">
        <ProviderStat label={isEn ? 'Providers' : 'Provider'} value={providers.length} detail={isEn ? 'configured' : 'da cau hinh'} />
        <ProviderStat label={isEn ? 'Online routes' : 'Tuyen dang bat'} value={activeProviders} detail="API proxy" />
        <ProviderStat label={isEn ? 'Known models' : 'Model da biet'} value={totalModels} detail={isEn ? 'exposed' : 'cong khai'} />
        <ProviderStat label={isEn ? 'Protocols' : 'Giao thuc'} value={protocols} detail="OpenAI / Anthropic" />
      </div>

      <div className="provider-catalog-bar">
        <div><span>{isEn ? 'PROVIDER CATALOG' : 'DANH MUC PROVIDER'}</span><strong>{filtered.length} {isEn ? 'routing identities' : 'dinh danh dinh tuyen'}</strong></div>
        <div className="provider-search"><Search /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={isEn ? 'Search endpoint, model or protocol...' : 'Tim endpoint, model hoac giao thuc...'} /></div>
      </div>

      <div className="provider-model-grid provider-api-grid">
        {filtered.map((provider) => {
          const result = results[provider.id]
          const models = result?.models || provider.models || []
          const canOpen = !provider.legacy
          return (
            <Card
              key={provider.id}
              className={`provider-model-card provider-api-card${canOpen ? ' is-clickable' : ''}`}
              role={canOpen ? 'button' : undefined}
              tabIndex={canOpen ? 0 : undefined}
              onClick={canOpen ? () => onOpenProvider(provider.id) : undefined}
              onKeyDown={(event) => {
                if (canOpen && (event.key === 'Enter' || event.key === ' ')) onOpenProvider(provider.id)
              }}
            >
              <CardContent>
                <div className="model-card-top">
                  <span className={`model-kind ${provider.protocol}`}><Server />{provider.protocol}</span>
                  <span className={result ? (result.success ? 'model-health ok' : 'model-health fail') : (provider.enabled ? 'model-health ok' : 'model-health')}>{result ? (result.success ? 'Reachable' : 'Failed') : (provider.enabled ? 'Active' : 'Disabled')}</span>
                </div>
                <div className="provider-api-name"><strong>{provider.name}</strong>{provider.legacy && <Badge variant="secondary">legacy</Badge>}</div>
                <code title={provider.baseUrl}>{provider.baseUrl}</code>
                <div className="provider-api-meta"><span>/{provider.routePrefix || provider.id}</span><span>{providerKeys(provider).length} keys</span><span>{maskCustomApiKey(providerKeys(provider)[0]?.apiKey)}</span><span>{models.length} models</span></div>
                {result && !result.success && <div className="provider-inline-error"><AlertTriangle />{result.error || 'Connection failed'}</div>}
                <div className="model-card-foot">
                  <span>{models.slice(0, 2).join(', ') || (isEn ? 'Discover models' : 'Chua tai model')}</span>
                  <div className="provider-card-actions">
                    <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); void testProvider(provider) }} disabled={busyId === provider.id}>{busyId === provider.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}{isEn ? 'Test' : 'Kiem tra'}</Button>
                    <Button size="icon" variant="ghost" className="text-destructive" onClick={(event) => { event.stopPropagation(); void removeProvider(provider) }} disabled={busyId === provider.id}><Trash2 /></Button>
                    {canOpen && <ChevronRight className="provider-open-arrow" />}
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function ProviderStat({ label, value, detail }: { label: string; value: number; detail: string }): React.ReactNode {
  return <div className="provider-stat"><small>{label}</small><strong>{value}</strong><span>{detail}</span></div>
}

function ProviderLoader({ text }: { text: string }): React.ReactNode {
  return <div className="provider-loader"><Loader2 className="animate-spin" /><span>{text}</span></div>
}
