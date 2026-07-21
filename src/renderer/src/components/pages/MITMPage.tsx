import { useState, useEffect } from 'react'
import {
  Shield, Power, Settings, Save, Plus, Trash2, Edit2,
  CheckCircle2, AlertTriangle, Info, Play, Square, Globe
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Switch, Badge } from '../ui'

interface DNSEntry {
  hostname: string
  enabled: boolean
  ideType: 'kiro' | 'copilot' | 'antigravity' | 'custom'
}

interface ModelMapping {
  ideModel: string
  krouterModel: string
  ideType: string
  enabled: boolean
}

interface MitmStatus {
  running: boolean
  port: number
  connections: number
  interceptedRequests: number
}

const PREDEFINED_ENTRIES: DNSEntry[] = [
  { hostname: 'runtime.us-east-1.kiro.dev', enabled: true, ideType: 'kiro' },
  { hostname: 'runtime.us-west-2.kiro.dev', enabled: true, ideType: 'kiro' },
  { hostname: 'o.us-east-1.amazoninces.com', enabled: true, ideType: 'copilot' },
  { hostname: 'codehub.server.us-east-1.amazoninces.com', enabled: true, ideType: 'copilot' },
  { hostname: 'generativelanguage.googleapis.com', enabled: true, ideType: 'antigravity' },
  { hostname: 'daily-cloudcode-pa.googleapis.com', enabled: true, ideType: 'antigravity' }
]

export function MITMPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  const [dnsEnabled, setDnsEnabled] = useState(false)
  const [dnsEntries, setDnsEntries] = useState<{ ip: string; hostname: string }[]>([])
  const [mitmStatus, setMitmStatus] = useState<MitmStatus>({ running: false, port: 443, connections: 0, interceptedRequests: 0 })
  const [modelMappings, setModelMappings] = useState<ModelMapping[]>([])
  const [loading, setLoading] = useState(false)
  const [editingMapping, setEditingMapping] = useState<ModelMapping | null>(null)
  const [editIdx, setEditIdx] = useState(-1)

  useEffect(() => {
    loadAll()
    const interval = setInterval(loadMitmStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  async function loadAll() {
    await Promise.all([loadHostsStatus(), loadMitmStatus(), loadModelMappings()])
  }

  async function loadHostsStatus() {
    try {
      const res = await (window as any).api?.kproxyGetHostsStatus?.()
      if (res) {
        setDnsEnabled(res.enabled)
        setDnsEntries(res.entries || [])
      }
    } catch { /* ignore */ }
  }

  async function loadMitmStatus() {
    try {
      const res = await (window as any).api?.kproxyGetStatus?.()
      if (res) {
        setMitmStatus({
          running: res.running,
          port: res.config?.port || 443,
          connections: res.stats?.activeConnections || 0,
          interceptedRequests: res.stats?.totalRequests || 0
        })
      }
    } catch { /* ignore */ }
  }

  async function loadModelMappings() {
    try {
      const res = await (window as any).api?.kproxyGetModelMappings?.()
      if (res?.mappings) setModelMappings(res.mappings)
    } catch { /* ignore */ }
  }

  async function toggleDns() {
    setLoading(true)
    try {
      const res = await (window as any).api?.kproxyToggleHosts?.(!dnsEnabled)
      if (res?.success) {
        setDnsEnabled(!dnsEnabled)
        await loadHostsStatus()
      } else if (res?.error) {
        alert(res.error)
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  async function toggleMitmServer() {
    setLoading(true)
    try {
      if (mitmStatus.running) {
        const res = await (window as any).api?.kproxyStop?.()
        if (!res?.success) alert(res?.error || 'Failed to stop')
      } else {
        const res = await (window as any).api?.kproxyStart?.()
        if (!res?.success) alert(res?.error || 'Failed to start')
      }
      await loadMitmStatus()
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }

  async function saveModelMappings() {
    setLoading(true)
    try {
      await (window as any).api?.kproxySaveModelMappings?.(modelMappings)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setLoading(false)
    }
  }

  function addMapping() {
    const m: ModelMapping = { ideModel: '', krouterModel: '', ideType: 'kiro', enabled: true }
    setModelMappings([...modelMappings, m])
    setEditingMapping(m)
    setEditIdx(modelMappings.length)
  }

  function deleteMapping(idx: number) {
    setModelMappings(modelMappings.filter((_, i) => i !== idx))
  }

  function toggleMapping(idx: number) {
    const updated = [...modelMappings]
    updated[idx] = { ...updated[idx], enabled: !updated[idx].enabled }
    setModelMappings(updated)
  }

  function startEdit(idx: number) {
    setEditingMapping({ ...modelMappings[idx] })
    setEditIdx(idx)
  }

  function saveEdit() {
    if (!editingMapping) return
    const updated = [...modelMappings]
    updated[editIdx] = editingMapping
    setModelMappings(updated)
    setEditingMapping(null)
    setEditIdx(-1)
  }

  const ideLabel = (type: string) => {
    if (type === 'kiro') return '⚡ Kiro'
    if (type === 'copilot') return '🐙 Copilot'
    if (type === 'antigravity') return '🌌 Antigravity'
    return '🔧 Custom'
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 shadow-lg shadow-purple-500/25">
            <Shield className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">
              {isEn ? 'MITM Proxy Settings' : 'Cai dat MITM Proxy'}
            </h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'Intercept IDE traffic and route through Krouter with custom model mappings'
                : 'Chan bat traffic IDE va route qua Krouter voi model mapping tuy chinh'}
            </p>
          </div>
        </div>
      </div>

      {/* Status Overview */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Power className={mitmStatus.running ? 'h-5 w-5 text-green-500' : 'h-5 w-5 text-gray-400'} />
              {isEn ? 'MITM Server Status' : 'Trang thai MITM Server'}
            </CardTitle>
            <div className="flex items-center gap-3">
              {mitmStatus.running && (
                <Badge variant="secondary" className="bg-green-500/10 text-green-600 border-green-200">
                  ● {isEn ? 'Active' : 'Dang chay'}
                </Badge>
              )}
              <Button
                size="sm"
                variant={mitmStatus.running ? 'destructive' : 'default'}
                onClick={toggleMitmServer}
                disabled={loading}
              >
                {mitmStatus.running ? <Square className="h-4 w-4 mr-1" /> : <Play className="h-4 w-4 mr-1" />}
                {mitmStatus.running ? (isEn ? 'Stop' : 'Dung') : (isEn ? 'Start' : 'Bat dau')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4">
            <div className="p-3 rounded-lg border bg-muted/50 text-center">
              <div className="text-2xl font-bold text-green-600">{mitmStatus.running ? 'ON' : 'OFF'}</div>
              <div className="text-xs text-muted-foreground">{isEn ? 'Server' : 'Server'}</div>
            </div>
            <div className="p-3 rounded-lg border bg-muted/50 text-center">
              <div className="text-2xl font-bold">{mitmStatus.port}</div>
              <div className="text-xs text-muted-foreground">{isEn ? 'Port' : 'Port'}</div>
            </div>
            <div className="p-3 rounded-lg border bg-muted/50 text-center">
              <div className="text-2xl font-bold text-blue-600">{mitmStatus.connections}</div>
              <div className="text-xs text-muted-foreground">{isEn ? 'Connections' : 'Ket noi'}</div>
            </div>
            <div className="p-3 rounded-lg border bg-muted/50 text-center">
              <div className="text-2xl font-bold text-purple-600">{mitmStatus.interceptedRequests}</div>
              <div className="text-xs text-muted-foreground">{isEn ? 'Intercepted' : 'Da chan'}</div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* DNS Redirect */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              {isEn ? 'DNS Redirect (Hosts File)' : 'DNS Redirect (Hosts File)'}
            </CardTitle>
            <Switch checked={dnsEnabled} onCheckedChange={toggleDns} disabled={loading} />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {isEn
              ? 'Redirect IDE domains to 127.0.0.1 via /etc/hosts for MITM interception.'
              : 'Chuyen huong domain IDE ve 127.0.0.1 qua /etc/hosts de MITM chan bat.'}
          </p>

          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase text-muted-foreground">
              {isEn ? 'Predefined Entries' : 'Entries mac dinh'}
            </Label>
            {PREDEFINED_ENTRIES.map((entry) => (
              <div key={entry.hostname} className="flex items-center gap-3 p-2.5 rounded-lg border bg-card">
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {ideLabel(entry.ideType)}
                </Badge>
                <code className="flex-1 text-xs font-mono truncate">{entry.hostname}</code>
                <span className="text-[10px] text-muted-foreground">→ 127.0.0.1</span>
                {dnsEnabled && dnsEntries.some(e => e.hostname === entry.hostname) && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
                )}
              </div>
            ))}
          </div>

          {!dnsEnabled && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-50 dark:bg-yellow-950/20 border border-yellow-200 dark:border-yellow-800 text-xs">
              <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium text-yellow-700 dark:text-yellow-400">
                  {isEn ? 'Admin privileges required' : 'Can quyen admin'}
                </p>
                <p className="text-yellow-600 dark:text-yellow-500 mt-0.5">
                  {isEn
                    ? 'Modifying /etc/hosts requires root access. Run Krouter as root or use sudo.'
                    : 'Sua /etc/hosts can quyen root. Chay Krouter voi root hoac sudo.'}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Model Mappings */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                {isEn ? 'Model Mappings' : 'Anh xa Model'}
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {isEn
                  ? 'Map IDE model names to Krouter models for interception'
                  : 'Anh xa ten model IDE sang model Krouter de chan bat'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={addMapping}>
                <Plus className="h-4 w-4 mr-1" />
                {isEn ? 'Add' : 'Them'}
              </Button>
              <Button size="sm" onClick={saveModelMappings} disabled={loading}>
                <Save className="h-4 w-4 mr-1" />
                {isEn ? 'Save' : 'Luu'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {modelMappings.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Settings className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">{isEn ? 'No model mappings configured' : 'Chua co anh xa nao'}</p>
              <p className="text-xs mt-1">{isEn ? 'Add your first mapping to get started' : 'Them anh xa dau tien de bat dau'}</p>
            </div>
          ) : (
            <div className="space-y-2">
              {modelMappings.map((mapping, idx) => (
                <div key={idx} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                  <Switch
                    checked={mapping.enabled}
                    onCheckedChange={() => toggleMapping(idx)}
                  />
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {ideLabel(mapping.ideType || 'custom')}
                  </Badge>
                  <div className="flex-1 grid grid-cols-2 gap-2 min-w-0">
                    <div>
                      <div className="text-[10px] text-muted-foreground">{isEn ? 'IDE Model' : 'IDE Model'}</div>
                      <code className="text-xs font-mono truncate block">{mapping.ideModel || '—'}</code>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">{isEn ? 'Krouter Model' : 'Krouter Model'}</div>
                      <code className="text-xs font-mono truncate block text-primary">{mapping.krouterModel || '—'}</code>
                    </div>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => startEdit(idx)}>
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => deleteMapping(idx)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Default mappings info */}
          <div className="mt-4 p-3 rounded-lg border bg-blue-50/50 dark:bg-blue-950/10 border-blue-200 dark:border-blue-800">
            <div className="flex items-start gap-2">
              <Info className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
              <div className="text-xs">
                <p className="font-medium text-blue-700 dark:text-blue-400 mb-1">
                  {isEn ? 'Default Mappings:' : 'Anh xa mac dinh:'}
                </p>
                <div className="text-blue-600 dark:text-blue-500 space-y-0.5 font-mono">
                  <p>claude-opus-4.5 (Kiro) → claude-opus-4.5</p>
                  <p>claude-sonnet-4.5 (Kiro) → claude-sonnet-4.5</p>
                  <p>gpt-4o (Copilot) → claude-sonnet-4.5</p>
                  <p>gemini-pro (Antigravity) → gemini-2.0-flash-exp</p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* How It Works */}
      <Card className="border-blue-200 dark:border-blue-900">
        <CardHeader>
          <CardTitle className="text-blue-600 dark:text-blue-400 flex items-center gap-2">
            <Info className="h-5 w-5" />
            {isEn ? 'How DNS Redirect Works' : 'Cach DNS Redirect hoat dong'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {[
            { step: '1', title: isEn ? 'Modify hosts file' : 'Sua file hosts', desc: isEn ? 'Redirect IDE domains to 127.0.0.1' : 'Chuyen huong domain IDE ve 127.0.0.1' },
            { step: '2', title: isEn ? 'Start HTTPS server' : 'Khoi dong HTTPS server', desc: isEn ? 'Listen on localhost:443 with SSL certificate' : 'Nghe tren localhost:443 voi SSL certificate' },
            { step: '3', title: isEn ? 'Intercept & map models' : 'Chan bat & anh xa model', desc: isEn ? 'Transform IDE requests, replace model names' : 'Bien doi request IDE, thay ten model' },
            { step: '4', title: isEn ? 'Route through Krouter' : 'Route qua Krouter', desc: isEn ? 'Apply smart rotation, caching, multi-account' : 'Ap dung smart rotation, caching, multi-account' }
          ].map((item) => (
            <div key={item.step} className="flex gap-3">
              <div className="shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold">{item.step}</div>
              <div>
                <p className="font-medium">{item.title}</p>
                <p className="text-muted-foreground text-xs">{item.desc}</p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Security Warning */}
      <Card className="border-yellow-200 dark:border-yellow-900">
        <CardHeader>
          <CardTitle className="text-yellow-600 dark:text-yellow-400 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            {isEn ? 'Security Notice' : 'Luu y bao mat'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p className="text-muted-foreground">
            {isEn
              ? 'DNS redirect modifies your system hosts file and intercepts HTTPS traffic.'
              : 'DNS redirect se sua file hosts he thong va chan bat HTTPS traffic.'}
          </p>
          <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
            <li>{isEn ? 'Requires root/admin privileges' : 'Can quyen root/admin'}</li>
            <li>{isEn ? 'Install CA certificate for SSL trust' : 'Cai dat CA certificate de trust SSL'}</li>
            <li>{isEn ? 'Disable when not in use' : 'Tat khi khong su dung'}</li>
            <li>{isEn ? 'Keep certificate private' : 'Giu certificate rieng tu'}</li>
          </ul>
        </CardContent>
      </Card>

      {/* Edit Modal */}
      {editingMapping && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => { setEditingMapping(null); setEditIdx(-1) }}>
          <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <CardHeader>
              <CardTitle>{isEn ? 'Edit Model Mapping' : 'Sua anh xa model'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>{isEn ? 'IDE Model Name' : 'Ten model IDE'}</Label>
                <Input
                  value={editingMapping.ideModel}
                  onChange={(e) => setEditingMapping({ ...editingMapping, ideModel: e.target.value })}
                  placeholder="e.g., us.anthropic.claude-opus-4-5..."
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <Label>{isEn ? 'Krouter Model' : 'Model Krouter'}</Label>
                <Input
                  value={editingMapping.krouterModel}
                  onChange={(e) => setEditingMapping({ ...editingMapping, krouterModel: e.target.value })}
                  placeholder="e.g., claude-sonnet-4.5"
                  className="font-mono text-xs"
                />
              </div>
              <div>
                <Label>{isEn ? 'IDE Type' : 'Loai IDE'}</Label>
                <Input
                  value={editingMapping.ideType}
                  onChange={(e) => setEditingMapping({ ...editingMapping, ideType: e.target.value })}
                  placeholder="kiro / copilot / antigravity / custom"
                  className="text-xs"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => { setEditingMapping(null); setEditIdx(-1) }}>
                  {isEn ? 'Cancel' : 'Huy'}
                </Button>
                <Button onClick={saveEdit}>
                  {isEn ? 'Save' : 'Luu'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
