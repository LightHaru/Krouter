import { useEffect, useId, useMemo, useState } from 'react'
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, Code2, FileKey2, Github, Globe2, Loader2, MousePointer2, Plus, Power, Radio, Save, Search, ShieldCheck, Trash2 } from 'lucide-react'
import { Badge, Button, Input, Switch } from '../ui'
import { useTranslation } from '@/hooks/useTranslation'

type IdeType = 'kiro' | 'copilot' | 'antigravity' | 'cursor' | 'custom'
interface DnsEntry { ip: string; hostname: string; enabled: boolean; ideType?: string }
interface ModelMapping { ideModel: string; krouterModel: string; ideType: IdeType; enabled: boolean }
interface KrouterModel { id: string; name?: string; modelProvider?: string; provider?: string; tier?: string; availableInPool?: boolean }
interface MitmDecision { timestamp: number; hostname: string; method: string; path: string; ideType: string; action: 'intercept' | 'passthrough' | 'router-success' | 'router-failure'; reason?: string; sourceModel?: string; mappedModel?: string; status?: number }
interface MitmStatus {
  running: boolean
  port: number
  listenerReachable: boolean
  routerReachable: boolean
  lastDiagnosticAt: number | null
  lastDiagnosticError: string | null
  connections: number
  interceptedRequests: number
  passthroughRequests: number
  byIdeType: Record<string, number>
  caReady: boolean
  routerSuccesses: number
  routerFailures: number
  lastRequestAt: number | null
  lastInterceptAt: number | null
  lastRouterStatus: number | null
  recentDecisions: MitmDecision[]
}

const EMPTY_MITM_STATUS: MitmStatus = {
  running: false,
  port: 443,
  listenerReachable: false,
  routerReachable: false,
  lastDiagnosticAt: null,
  lastDiagnosticError: null,
  connections: 0,
  interceptedRequests: 0,
  passthroughRequests: 0,
  byIdeType: {},
  caReady: false,
  routerSuccesses: 0,
  routerFailures: 0,
  lastRequestAt: null,
  lastInterceptAt: null,
  lastRouterStatus: null,
  recentDecisions: []
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const IDE_PROFILES: Array<{ id: Exclude<IdeType, 'custom'>; name: string; caption: string; icon: React.ElementType; domains: string[] }> = [
  { id: 'kiro', name: 'Kiro IDE', caption: 'AWS CodeWhisperer runtime', icon: Code2, domains: ['runtime.us-east-1.kiro.dev', 'q.us-east-1.amazonaws.com', 'codewhisperer.us-east-1.amazonaws.com'] },
  { id: 'copilot', name: 'GitHub Copilot', caption: 'Copilot individual API', icon: Github, domains: ['api.individual.githubcopilot.com'] },
  { id: 'antigravity', name: 'Antigravity', caption: 'Google Cloud Code / Gemini', icon: Bot, domains: ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'] },
  { id: 'cursor', name: 'Cursor', caption: 'Cursor agent runtime', icon: MousePointer2, domains: ['api2.cursor.sh'] }
]

export function MITMPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [selectedIde, setSelectedIde] = useState<Exclude<IdeType, 'custom'>>('kiro')
  const [dnsEntries, setDnsEntries] = useState<DnsEntry[]>([])
  const [caInstalled, setCaInstalled] = useState(false)
  const [status, setStatus] = useState<MitmStatus>(EMPTY_MITM_STATUS)
  const [mappings, setMappings] = useState<ModelMapping[]>([])
  const [availableModels, setAvailableModels] = useState<KrouterModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [modelsError, setModelsError] = useState('')
  const [busy, setBusy] = useState<'dns' | 'server' | 'ca' | 'mappings' | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const enabledIdeTypes = useMemo(() => new Set(dnsEntries.map((entry) => entry.ideType).filter(Boolean) as IdeType[]), [dnsEntries])
  const selectedProfile = IDE_PROFILES.find((profile) => profile.id === selectedIde) || IDE_PROFILES[0]
  const selectedMappings = mappings.map((mapping, index) => ({ mapping, index })).filter(({ mapping }) => mapping.ideType === selectedIde)

  const loadStatus = async (includeStatic = false): Promise<void> => {
    try {
      const runtime = await window.api.mitmGetStatus()
      let nextCaReady: boolean | undefined
      if (includeStatic) {
        const [hosts, proxyRuntime, cert] = await Promise.all([
          window.api.kproxyGetHostsStatus(),
          window.api.kproxyGetStatus(),
          window.api.kproxyCheckCaCertInstalled()
        ])
        const nextEntries = hosts.entries || []
        setDnsEntries(current => sameJsonValue(current, nextEntries) ? current : nextEntries)
        setCaInstalled(current => current === Boolean(cert.installed) ? current : Boolean(cert.installed))
        nextCaReady = Boolean(proxyRuntime.caInfo)
      }
      setStatus(current => {
        const next: MitmStatus = {
        running: runtime.running,
        port: runtime.port || 443,
        listenerReachable: Boolean(runtime.listenerReachable),
        routerReachable: Boolean(runtime.routerReachable),
        lastDiagnosticAt: runtime.lastDiagnosticAt || null,
        lastDiagnosticError: runtime.lastDiagnosticError || null,
        connections: runtime.connections || 0,
        interceptedRequests: runtime.interceptedRequests || 0,
        passthroughRequests: runtime.passthroughRequests || 0,
          byIdeType: runtime.byIdeType || {},
          caReady: nextCaReady ?? current.caReady,
          routerSuccesses: runtime.routerSuccesses || 0,
          routerFailures: runtime.routerFailures || 0,
          lastRequestAt: runtime.lastRequestAt || null,
          lastInterceptAt: runtime.lastInterceptAt || null,
          lastRouterStatus: runtime.lastRouterStatus || null,
          recentDecisions: runtime.recentDecisions || []
        }
        return sameJsonValue(current, next) ? current : next
      })
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : 'Unable to load MITM status' })
    }
  }

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const [mappingResult, modelResult] = await Promise.all([
          window.api.kproxyGetModelMappings(),
          window.api.proxyGetModels().catch((error) => ({ success: false, models: [], error: error instanceof Error ? error.message : String(error) }))
        ])
        if (alive) {
          setMappings(mappingResult.mappings || [])
          const unique = new Map<string, KrouterModel>()
          for (const model of modelResult.models || []) if (model?.id && !unique.has(model.id)) unique.set(model.id, model as KrouterModel)
          setAvailableModels(Array.from(unique.values()).sort((a, b) => a.id.localeCompare(b.id)))
          setModelsError(modelResult.success === false ? modelResult.error || 'Unable to load Krouter model catalog' : '')
          setModelsLoading(false)
        }
      } catch (error) {
        if (alive) {
          setModelsLoading(false)
          setModelsError(error instanceof Error ? error.message : 'Unable to load Krouter model catalog')
        }
      }
      if (alive) await loadStatus(true)
    }
    void load()
    const runtimeTimer = window.setInterval(() => { if (alive && !document.hidden) void loadStatus(false) }, 2500)
    const staticTimer = window.setInterval(() => { if (alive && !document.hidden) void loadStatus(true) }, 30000)
    return () => {
      alive = false
      window.clearInterval(runtimeTimer)
      window.clearInterval(staticTimer)
    }
  }, [])

  const toggleIdeDns = async (ideType: Exclude<IdeType, 'custom'>): Promise<void> => {
    setBusy('dns'); setNotice(null)
    const desired = new Set(enabledIdeTypes)
    if (desired.has(ideType)) desired.delete(ideType); else desired.add(ideType)
    try {
      const result = await window.api.kproxySetHostsIdeTypes(Array.from(desired).filter((type): type is Exclude<IdeType, 'custom'> => type !== 'custom'))
      if (!result.success) throw new Error(result.error || 'DNS Redirect update failed')
      setDnsEntries(result.entries || [])
      setNotice({ kind: 'ok', text: desired.has(ideType) ? `${selectedProfile.name} DNS routes enabled.` : `${selectedProfile.name} DNS routes removed.` })
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : 'DNS Redirect update failed' })
      await loadStatus()
    } finally { setBusy(null) }
  }

  const toggleServer = async (): Promise<void> => {
    setBusy('server'); setNotice(null)
    try {
      if (status.running) {
        const result = await window.api.mitmStop()
        if (!result.success) throw new Error(result.error || 'Failed to stop MITM service')
      } else {
        const initialized = await window.api.kproxyInit()
        if (!initialized.success) throw new Error(initialized.error || 'Failed to initialize CA')
        const result = await window.api.mitmStart()
        if (!result.success) throw new Error(result.error || 'Failed to start HTTPS interception on port 443')
      }
      await loadStatus()
      setNotice({ kind: 'ok', text: status.running ? 'MITM HTTPS service stopped.' : 'MITM HTTPS service is listening on port 443.' })
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : 'MITM service operation failed' })
    } finally { setBusy(null) }
  }

  const installCertificate = async (): Promise<void> => {
    setBusy('ca'); setNotice(null)
    try {
      const initialized = await window.api.kproxyInit()
      if (!initialized.success) throw new Error(initialized.error || 'Failed to initialize CA')
      const result = await window.api.kproxyInstallCaCert()
      if (!result.success) throw new Error(result.error || 'Certificate installation failed')
      await loadStatus()
      setNotice({ kind: 'ok', text: result.message || 'CA certificate is trusted.' })
    } catch (cause) {
      setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : 'Certificate installation failed' })
    } finally { setBusy(null) }
  }

  const saveMappings = async (): Promise<void> => {
    const invalid = mappings.find((mapping) => !mapping.ideModel.trim() || !mapping.krouterModel.trim())
    if (invalid) { setNotice({ kind: 'error', text: 'Every route needs an incoming and target model.' }); return }
    setBusy('mappings'); setNotice(null)
    try {
      const result = await window.api.kproxySaveModelMappings(mappings)
      if (!result.success) throw new Error(result.error || 'Failed to save model mappings')
      setNotice({ kind: 'ok', text: `${selectedProfile.name} routing aliases saved.` })
    } catch (cause) { setNotice({ kind: 'error', text: cause instanceof Error ? cause.message : 'Failed to save model mappings' }) }
    finally { setBusy(null) }
  }

  const updateMapping = (index: number, patch: Partial<ModelMapping>): void => setMappings((current) => current.map((mapping, mappingIndex) => mappingIndex === index ? { ...mapping, ...patch } : mapping))
  const addMapping = (): void => setMappings((current) => [...current, { ideModel: '', krouterModel: '', ideType: selectedIde, enabled: true }])
  const removeMapping = (index: number): void => setMappings((current) => current.filter((_, mappingIndex) => mappingIndex !== index))
  const selectedDecisions = status.recentDecisions.filter(decision => decision.ideType === selectedIde).slice(0, 8)
  const selectedRouteVerified = status.recentDecisions.some(decision => decision.ideType === selectedIde && decision.action === 'router-success')
  const readySteps = Number(caInstalled) + Number(status.listenerReachable) + Number(enabledIdeTypes.has(selectedIde)) + Number(selectedRouteVerified)
  const routeState = selectedRouteVerified
    ? 'ROUTED'
    : status.interceptedRequests > 0
      ? 'INTERCEPTING'
      : status.passthroughRequests > 0
        ? 'PASSTHROUGH'
        : 'WAITING'

  return (
    <div className="mitm-workbench flex-1 overflow-auto p-4 md:p-6">
      <header className="mitm-head">
        <div><span><Radio /> TRAFFIC INTERCEPTION</span><h1>{isEn ? 'MITM routing workbench' : 'Ban dieu khien MITM'}</h1><p>{isEn ? 'Configure certificate trust once, then control DNS and model aliases independently for each IDE.' : 'Cau hinh CA mot lan, sau do dieu khien DNS va model alias rieng cho tung IDE.'}</p></div>
        <div className="mitm-readiness"><strong>{readySteps}/4</strong><span>{isEn ? 'verified route steps' : 'buoc route da xac minh'}</span><div><i style={{ width: `${readySteps / 4 * 100}%` }} /></div></div>
      </header>

      {notice && <div className={`mitm-notice ${notice.kind}`}><span>{notice.kind === 'ok' ? <CheckCircle2 /> : <AlertTriangle />}</span><p>{notice.text}</p><button onClick={() => setNotice(null)}>x</button></div>}
      {status.lastDiagnosticError && <div className="mitm-notice error"><span><AlertTriangle /></span><p>{status.lastDiagnosticError}</p></div>}
      {status.running && enabledIdeTypes.has(selectedIde) && !selectedRouteVerified && <div className="mitm-notice error"><span><AlertTriangle /></span><p>Close every {selectedProfile.name} window, reopen it after DNS Redirect is enabled, then send one short prompt. Existing keep-alive TLS sockets bypass newly applied hosts entries until the IDE restarts.</p></div>}

      <section className="mitm-core-strip">
        <div><FileKey2 /><span><small>CERTIFICATE</small><strong>{caInstalled ? 'Trusted' : status.caReady ? 'Generated' : 'Required'}</strong></span><Button size="sm" variant={caInstalled ? 'outline' : 'default'} onClick={() => void installCertificate()} disabled={busy !== null}>{busy === 'ca' && <Loader2 className="animate-spin" />}{caInstalled ? 'Reinstall' : 'Install CA'}</Button></div>
        <div><Power /><span><small>HTTPS INTERCEPTOR</small><strong>{status.listenerReachable ? `TLS verified :${status.port}` : status.running ? `Checking :${status.port}` : 'Stopped'}</strong></span><Button size="sm" variant={status.running ? 'destructive' : 'default'} onClick={() => void toggleServer()} disabled={busy !== null}>{busy === 'server' && <Loader2 className="animate-spin" />}{status.running ? 'Stop' : 'Start :443'}</Button></div>
        <div><ShieldCheck /><span><small>ACTIVE IDE ROUTES</small><strong>{enabledIdeTypes.size} / {IDE_PROFILES.length}</strong></span><Badge variant={enabledIdeTypes.size ? 'success' : 'secondary'}>{enabledIdeTypes.size ? 'CONFIGURED' : 'NONE'}</Badge></div>
      </section>

      <section className="mitm-ide-grid">
        {IDE_PROFILES.map((profile) => {
          const Icon = profile.icon
          const active = profile.id === selectedIde
          const dnsOn = enabledIdeTypes.has(profile.id)
          const aliasCount = mappings.filter((mapping) => mapping.ideType === profile.id && mapping.enabled).length
          return <button key={profile.id} className={active ? 'mitm-ide-card selected' : 'mitm-ide-card'} onClick={() => setSelectedIde(profile.id)}><div><span className="mitm-ide-icon"><Icon /></span><Badge variant={dnsOn ? 'success' : 'secondary'}>{dnsOn ? 'DNS ON' : 'DNS OFF'}</Badge></div><strong>{profile.name}</strong><p>{profile.caption}</p><footer><span>{profile.domains.length} domains</span><span>{aliasCount} aliases</span><span>{status.byIdeType[profile.id] || 0} hits</span></footer></button>
        })}
      </section>

      <div className="mitm-profile-head">
        <div><span>ACTIVE PROFILE</span><h2>{selectedProfile.name}</h2><p>{selectedProfile.caption}</p></div>
        <div className="mitm-profile-toggle"><span><small>DNS REDIRECT</small><strong>{enabledIdeTypes.has(selectedIde) ? 'Enabled' : 'Disabled'}</strong></span>{busy === 'dns' ? <Loader2 className="animate-spin" /> : <Switch checked={enabledIdeTypes.has(selectedIde)} onCheckedChange={() => void toggleIdeDns(selectedIde)} disabled={busy !== null} />}</div>
      </div>

      <div className="mitm-main-grid">
        <section className="mitm-domain-panel">
          <div className="mitm-section-head"><div><span>DNS ROUTES</span><h2>{selectedProfile.name} domains</h2></div><Badge variant={enabledIdeTypes.has(selectedIde) ? 'success' : 'secondary'}>{enabledIdeTypes.has(selectedIde) ? 'ACTIVE' : 'OFF'}</Badge></div>
          <div className="mitm-domain-list">{selectedProfile.domains.map((hostname) => { const installed = dnsEntries.some((entry) => entry.hostname === hostname); return <div className="mitm-domain-row" key={hostname}><span className={installed ? 'active' : ''} /><b>{selectedProfile.name}</b><code>{hostname}</code><small>127.0.0.1</small>{installed ? <CheckCircle2 /> : <span />}</div> })}</div>
          <div className="mitm-uac-note"><AlertTriangle /><p><strong>Windows permission boundary</strong><span>Changing this IDE profile opens one UAC prompt and only rewrites the marked Krouter block. Other hosts entries remain untouched.</span></p></div>
        </section>

        <aside className="mitm-live-panel">
          <div className="mitm-section-head"><div><span>PROFILE TELEMETRY</span><h2>{selectedProfile.name}</h2></div><Badge variant={routeState === 'ROUTED' ? 'success' : routeState === 'PASSTHROUGH' ? 'secondary' : 'outline'}>{routeState}</Badge></div>
          <div className="mitm-live-number"><strong>{status.byIdeType[selectedIde] || 0}</strong><span>profile interceptions</span></div>
          <div className="mitm-live-stats"><div><small>ROUTER SUCCESS</small><b>{status.routerSuccesses}</b></div><div><small>PASSTHROUGH</small><b>{status.passthroughRequests}</b></div></div>
          <div className="mitm-route-diagram"><span>{selectedProfile.name}</span><i /><span>DNS</span><i /><span>:443</span><i /><span>Krouter</span></div>
          <div className="mitm-decision-list">
            {selectedDecisions.map((decision) => <div key={`${decision.timestamp}-${decision.action}-${decision.path}`}>
              <span className={decision.action === 'router-success' || decision.action === 'intercept' ? 'ok' : decision.action === 'router-failure' ? 'error' : ''}>{decision.action}</span>
              <code title={decision.path}>{decision.path}</code>
              <small>{decision.reason || decision.mappedModel || (decision.status ? `HTTP ${decision.status}` : '')}</small>
            </div>)}
            {!selectedDecisions.length && <p>No traffic observed for this profile yet.</p>}
          </div>
        </aside>
      </div>

      <section className="mitm-mapping-panel">
        <div className="mitm-section-head"><div><span>ROUTING ALIASES</span><h2>{selectedProfile.name} model map</h2><p>Only aliases for this IDE are shown. Changes are staged until Save aliases.</p></div><div className="mitm-map-actions"><Button size="sm" variant="outline" onClick={addMapping}><Plus />Add alias</Button><Button size="sm" onClick={() => void saveMappings()} disabled={busy !== null}>{busy === 'mappings' ? <Loader2 className="animate-spin" /> : <Save />}Save aliases</Button></div></div>
        <div className="mitm-model-catalog-state"><span>{modelsLoading ? <Loader2 className="animate-spin" /> : <Search />}{modelsLoading ? 'Loading Krouter catalog...' : `${availableModels.length} Krouter models available`}</span>{modelsError && <small>{modelsError}</small>}</div>
        <div className="mitm-map-table"><div className="mitm-map-header"><span>ON</span><span>INCOMING MODEL</span><span>KROUTER TARGET</span><span /></div>{selectedMappings.map(({ mapping, index }) => <div className="mitm-map-row" key={`${mapping.ideType}-${index}`}><Switch checked={mapping.enabled} onCheckedChange={(enabled) => updateMapping(index, { enabled })} /><Input value={mapping.ideModel} onChange={(event) => updateMapping(index, { ideModel: event.target.value })} placeholder="ide-model-name" /><ModelTargetPicker value={mapping.krouterModel} models={availableModels} loading={modelsLoading} onChange={(krouterModel) => updateMapping(index, { krouterModel })} /><Button size="icon" variant="ghost" className="text-destructive" onClick={() => removeMapping(index)}><Trash2 /></Button></div>)}</div>
        {!selectedMappings.length && <div className="mitm-map-empty"><Globe2 /><span>No aliases for {selectedProfile.name}. Requests keep their original model name.</span></div>}
      </section>
    </div>
  )
}

function ModelTargetPicker({ value, models, loading, onChange }: { value: string; models: KrouterModel[]; loading: boolean; onChange: (value: string) => void }): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const listId = useId()
  const normalized = query.trim().toLowerCase()
  const filtered = models.filter(model => {
    if (!normalized) return true
    return `${model.id} ${model.name || ''} ${model.modelProvider || model.provider || ''}`.toLowerCase().includes(normalized)
  }).slice(0, 80)

  return (
    <div className="mitm-model-picker">
      <div className="mitm-model-picker-input">
        <Input
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          autoComplete="off"
          value={value}
          onFocus={() => { setQuery(''); setOpen(true) }}
          onClick={() => { setQuery(''); setOpen(true) }}
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          onChange={(event) => { setQuery(event.target.value); onChange(event.target.value); setOpen(true) }}
          placeholder={loading ? 'loading-model-catalog...' : 'Choose a Krouter model'}
        />
        <button type="button" aria-label="Show Krouter models" onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(current => { if (!current) setQuery(''); return !current })}><ChevronDown /></button>
      </div>
      {open && <div className="mitm-model-options" id={listId} role="listbox">
        {loading ? <div className="mitm-model-option-state"><Loader2 className="animate-spin" />Loading model catalog...</div> : filtered.length ? filtered.map(model => (
          <button key={model.id} type="button" role="option" aria-selected={model.id === value} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(model.id); setQuery(''); setOpen(false) }}>
            <span><strong>{model.id}</strong><small>{model.name && model.name !== model.id ? model.name : 'Krouter model'}</small></span>
            <span><Badge variant={model.availableInPool === false ? 'secondary' : 'success'}>{model.modelProvider || model.provider || model.tier || 'KROUTER'}</Badge></span>
          </button>
        )) : <div className="mitm-model-option-state"><Search />No model matches &quot;{query}&quot;</div>}
      </div>}
    </div>
  )
}
