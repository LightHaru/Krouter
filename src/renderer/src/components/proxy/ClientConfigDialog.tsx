import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertCircle, Bot, Check, Code2, Copy, Cpu, FileCog, KeyRound, Loader2, Settings2, Sparkles, Terminal, Workflow, X, type LucideIcon } from 'lucide-react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Select } from '../ui'
import { useAccountsStore } from '../../store/accounts'
import { cn } from '@/lib/utils'

type ClientTarget = 'claudeCode' | 'opencode' | 'codex' | 'gemini' | 'hermes' | 'openclaw'

interface ModelInfo {
  id: string
  name: string
  description?: string
  inputTypes?: string[]
  maxInputTokens?: number | null
  maxOutputTokens?: number | null
}

interface ClientConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isEn: boolean
}

interface ClientOption {
  id: ClientTarget
  name: string
  description: string
  icon: LucideIcon
}

interface ConfigureResult {
  client: ClientTarget
  success: boolean
  paths: string[]
  backupPaths: string[]
  error?: string
}

interface ProxyApiKeyInfo {
  id?: string
  name?: string
  key: string
  enabled?: boolean
}

const clientLabels: Record<ClientTarget, string> = {
  claudeCode: 'Claude Code',
  opencode: 'OpenCode',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  hermes: 'Hermes',
  openclaw: 'OpenClaw'
}

const preferredModelIds = [
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.5',
  'claude-haiku-4.5'
]

const kiroModelPresets: ModelInfo[] = [
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', description: 'Claude Sonnet 4.5', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 },
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: 'Claude Sonnet 4', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 },
  { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', description: 'Power account model', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 },
  { id: 'claude-opus-4.7', name: 'Claude Opus 4.7', description: 'Power account model', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 },
  { id: 'claude-opus-4.5', name: 'Claude Opus 4.5', description: 'Power account model', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 },
  { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', description: 'Claude Haiku 4.5', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }
]

function normalizeModelId(id: string): string {
  return id.trim().toLowerCase().replace(/^(claude-(?:sonnet|haiku|opus)-\d+)-(\d+)(.*)$/u, '$1.$2$3')
}

function mergeModelPresets(items: ModelInfo[]): ModelInfo[] {
  const modelMap = new Map<string, ModelInfo>()
  for (const model of [...items, ...kiroModelPresets]) {
    if (!model.id?.trim()) continue
    const key = normalizeModelId(model.id)
    if (!modelMap.has(key)) {
      modelMap.set(key, model)
    }
  }
  return Array.from(modelMap.values()).sort((a, b) => {
    const aIndex = preferredModelIds.findIndex(id => normalizeModelId(id) === normalizeModelId(a.id))
    const bIndex = preferredModelIds.findIndex(id => normalizeModelId(id) === normalizeModelId(b.id))
    if (aIndex !== -1 || bIndex !== -1) return (aIndex === -1 ? 99 : aIndex) - (bIndex === -1 ? 99 : bIndex)
    if (normalizeModelId(a.id) === 'auto') return 1
    if (normalizeModelId(b.id) === 'auto') return -1
    return a.id.localeCompare(b.id)
  })
}

function chooseDefaultModelId(items: ModelInfo[], current: string): string {
  const currentKey = normalizeModelId(current)
  const currentMatch = items.find(model => normalizeModelId(model.id) === currentKey)
  if (currentKey && currentKey !== 'auto' && currentMatch) return currentMatch.id
  for (const preferredId of preferredModelIds) {
    const match = items.find(model => normalizeModelId(model.id) === normalizeModelId(preferredId))
    if (match) return match.id
  }
  return items.find(model => normalizeModelId(model.id) !== 'auto')?.id || items[0]?.id || ''
}

function chooseDefaultModelIds(items: ModelInfo[], current: string[]): string[] {
  const byKey = new Map(items.map(model => [normalizeModelId(model.id), model.id]))
  const kept = current
    .map(id => byKey.get(normalizeModelId(id)))
    .filter((id): id is string => Boolean(id && normalizeModelId(id) !== 'auto'))
  if (kept.length > 0) return Array.from(new Set(kept))

  const preferred = preferredModelIds
    .map(id => byKey.get(normalizeModelId(id)))
    .filter((id): id is string => Boolean(id && normalizeModelId(id) !== 'auto'))
  if (preferred.length > 0) return Array.from(new Set(preferred))

  const fallback = items.find(model => normalizeModelId(model.id) !== 'auto')?.id
  return fallback ? [fallback] : []
}

export function ClientConfigDialog({ open, onOpenChange, isEn }: ClientConfigDialogProps) {
  const accounts = useAccountsStore(state => state.accounts)
  const activeAccountId = useAccountsStore(state => state.activeAccountId)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState('')
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([])
  const [selectedClients, setSelectedClients] = useState<ClientTarget[]>(['openclaw'])
  const [loadingModels, setLoadingModels] = useState(false)
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [creatingKey, setCreatingKey] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ConfigureResult[]>([])
  const [proxyBase, setProxyBase] = useState('')
  const [, setApiKeys] = useState<ProxyApiKeyInfo[]>([])
  const [proxyKey, setProxyKey] = useState<ProxyApiKeyInfo | null>(null)
  const [keyCopied, setKeyCopied] = useState(false)

  const clientOptions: ClientOption[] = useMemo(() => [
    {
      id: 'claudeCode',
      name: 'Claude Code',
      description: isEn ? 'Writes ANTHROPIC_BASE_URL, API key and default model' : 'Ghi ANTHROPIC_BASE_URL, API key và model mặc định',
      icon: Bot
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      description: isEn ? 'Adds Kiro provider and model metadata to opencode.json' : 'Thêm provider Kiro và metadata model vào opencode.json',
      icon: Code2
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      description: isEn ? 'Adds Kiro OpenAI Responses provider' : 'Thêm provider Kiro dùng OpenAI Responses',
      icon: Terminal
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      description: isEn ? 'Writes .env and settings.json for Gemini v1beta' : 'Ghi .env và settings.json cho Gemini v1beta',
      icon: Sparkles
    },
    {
      id: 'hermes',
      name: 'Hermes',
      description: isEn ? 'Adds Kiro provider to config.yaml' : 'Thêm provider Kiro vào config.yaml',
      icon: Workflow
    },
    {
      id: 'openclaw',
      name: 'OpenClaw',
      description: isEn ? 'Adds Kiro provider to openclaw.json' : 'Thêm provider Kiro vào openclaw.json',
      icon: Settings2
    }
  ], [isEn])

  const selectedModel = models.find(model => model.id === selectedModelId)
  const selectedModelIdSet = useMemo(() => new Set(selectedModelIds.map(normalizeModelId)), [selectedModelIds])
  const importOpenClawOnly = selectedClients.length === 1 && selectedClients[0] === 'openclaw'

  const maskKey = (key: string) => {
    if (key.length <= 14) return key
    return `${key.slice(0, 8)}...${key.slice(-4)}`
  }

  const chooseProxyKey = (keys: ProxyApiKeyInfo[]) => {
    return keys.find(item => item.name === 'OpenClaw - Kiro API Proxy')
      || keys.find(item => item.enabled !== false)
      || keys[0]
      || null
  }

  const loadModels = useCallback(async () => {
    setLoadingModels(true)
    setError(null)
    setResults([])
    try {
      const proxyModels = await window.api.proxyGetModels()
      if (proxyModels.success && proxyModels.models.length > 0) {
        const mergedModels = mergeModelPresets(proxyModels.models)
        setModels(mergedModels)
        setSelectedModelId(current => chooseDefaultModelId(mergedModels, current))
        setSelectedModelIds(current => chooseDefaultModelIds(mergedModels, current))
        return
      }

      const activeAccount = activeAccountId ? accounts.get(activeAccountId) : undefined
      const account = activeAccount?.status === 'active' && activeAccount.credentials?.accessToken
        ? activeAccount
        : Array.from(accounts.values()).find(item => item.status === 'active' && item.credentials?.accessToken)

      if (account) {
        const accountModels = await window.api.accountGetModels(
          account.credentials.accessToken,
          account.credentials.region || 'us-east-1',
          account.profileArn,
          account.machineId,
          account.credentials.provider || account.idp,
          account.credentials.authMethod,
          account.id
        )
        if (accountModels.success && accountModels.models.length > 0) {
          const mergedModels = mergeModelPresets(accountModels.models as ModelInfo[])
          setModels(mergedModels)
          setSelectedModelId(current => chooseDefaultModelId(mergedModels, current))
          setSelectedModelIds(current => chooseDefaultModelIds(mergedModels, current))
          return
        }
      }

      setModels([])
      setSelectedModelId('')
      setSelectedModelIds([])
      setError(isEn ? 'No models were loaded. Please check whether the account is active and try reloading.' : 'Chưa tải được model. Hãy kiểm tra tài khoản đang active rồi tải lại.')
    } catch (err) {
      setModels([])
      setSelectedModelId('')
      setSelectedModelIds([])
      setError(err instanceof Error ? err.message : (isEn ? 'Failed to load models' : 'Tải model thất bại'))
    } finally {
      setLoadingModels(false)
    }
  }, [accounts, activeAccountId, isEn])

  const loadApiKeys = useCallback(async () => {
    setLoadingKeys(true)
    try {
      const result = await window.api.proxyGetApiKeys()
      if (result.success) {
        const keys = result.apiKeys || []
        setApiKeys(keys)
        setProxyKey(chooseProxyKey(keys))
      }
    } catch (err) {
      console.error('[ClientConfig] Failed to load API keys:', err)
    } finally {
      setLoadingKeys(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      void loadModels()
      void loadApiKeys()
    }
  }, [open, loadModels, loadApiKeys])

  if (!open) return null

  const toggleClient = (client: ClientTarget) => {
    setResults([])
    setSelectedClients(current => current.includes(client) ? current.filter(item => item !== client) : [...current, client])
  }

  const toggleModel = (modelId: string) => {
    setResults([])
    setSelectedModelIds(current => {
      const key = normalizeModelId(modelId)
      const exists = current.some(id => normalizeModelId(id) === key)
      const next = exists ? current.filter(id => normalizeModelId(id) !== key) : [...current, modelId]
      if (!exists && next.length === 1) setSelectedModelId(modelId)
      if (exists && normalizeModelId(selectedModelId) === key) {
        setSelectedModelId(next[0] || '')
      }
      return next
    })
  }

  const selectRecommendedModels = () => {
    setResults([])
    setSelectedModelIds(chooseDefaultModelIds(models, []))
  }

  const clearSelectedModels = () => {
    setResults([])
    setSelectedModelIds(selectedModelId ? [selectedModelId] : [])
  }

  const copyProxyKey = async () => {
    if (!proxyKey?.key) return
    await navigator.clipboard.writeText(proxyKey.key)
    setKeyCopied(true)
    setTimeout(() => setKeyCopied(false), 1600)
  }

  const createOpenClawKey = async () => {
    setCreatingKey(true)
    setError(null)
    try {
      const result = await window.api.proxyAddApiKey({
        name: 'OpenClaw - Kiro API Proxy',
        format: 'sk'
      })
      if (!result.success || !result.apiKey) {
        setError(result.error || (isEn ? 'Failed to create API key' : 'Tạo API key thất bại'))
        return
      }
      setApiKeys(current => [result.apiKey!, ...current])
      setProxyKey(result.apiKey)
    } catch (err) {
      setError(err instanceof Error ? err.message : (isEn ? 'Failed to create API key' : 'Tạo API key thất bại'))
    } finally {
      setCreatingKey(false)
    }
  }

  const applyConfig = async () => {
    if (!selectedModelId) {
      setError(isEn ? 'Please select a model' : 'Hãy chọn model')
      return
    }
    if (selectedClients.length === 0) {
      setError(isEn ? 'Please select at least one client' : 'Hãy chọn ít nhất một client')
      return
    }

    if (selectedModelIds.length === 0) {
      setError(isEn ? 'Please select at least one model to add' : 'Hãy chọn ít nhất một model để thêm')
      return
    }

    setApplying(true)
    setError(null)
    setResults([])
    try {
      const selectedKeys = new Set(selectedModelIds.map(normalizeModelId))
      selectedKeys.add(normalizeModelId(selectedModelId))
      const selectedModels = models.filter(model => selectedKeys.has(normalizeModelId(model.id)))
      if (!selectedModels.some(model => normalizeModelId(model.id) === normalizeModelId(selectedModelId)) && selectedModel) {
        selectedModels.unshift(selectedModel)
      }
      const result = await window.api.proxyConfigureClients({
        clients: selectedClients,
        modelId: selectedModelId,
        modelName: selectedModel?.name,
        models: selectedModels.map(model => ({
          id: model.id,
          name: model.name,
          inputTypes: model.inputTypes,
          maxInputTokens: model.maxInputTokens,
          maxOutputTokens: model.maxOutputTokens
        }))
      })
      setProxyBase(result.openaiBaseUrl || result.proxyOrigin)
      const returnedKey = result.apiKey
      if (returnedKey) {
        setProxyKey(returnedKey)
        setApiKeys(current => current.some(item => item.id && item.id === returnedKey.id)
          ? current.map(item => item.id === returnedKey.id ? { ...item, ...returnedKey } : item)
          : [returnedKey, ...current])
      }
      setResults(result.results)
      if (!result.success) {
        setError(result.error || (isEn ? 'Some clients failed to configure' : 'Một số client cấu hình thất bại'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : (isEn ? 'Failed to configure clients' : 'Cấu hình client thất bại'))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <Card className="relative w-[780px] max-h-[85vh] shadow-2xl border-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 glass-card-strong">
        <CardHeader className="pb-4 border-b sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl flex items-center gap-3">
              <div className="p-2 rounded-xl bg-primary/10">
                <Settings2 className="h-6 w-6 text-primary" />
              </div>
              <div>
                <span className="font-bold">{isEn ? 'One-Click Client Configuration' : 'Cấu hình client một chạm'}</span>
                <div className="flex items-center gap-2 mt-1">
                  <Badge className="bg-primary/10 text-primary border-primary/20 font-semibold">
                    {selectedClients.length} {isEn ? 'selected' : 'đã chọn'}
                  </Badge>
                  {proxyBase && (
                    <Badge variant="secondary" className="text-xs border-0">
                      {proxyBase}
                    </Badge>
                  )}
                </div>
              </div>
            </CardTitle>
            <Button variant="ghost" size="icon" className="h-9 w-9 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
              <X className="h-5 w-5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          <div className="max-h-[calc(85vh-140px)] overflow-y-auto pr-2 space-y-4">
            <div className="rounded-xl border bg-background p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <KeyRound className="h-4 w-4 text-primary" />
                  <span className="font-medium">{isEn ? 'Kiro API Proxy key' : 'Key Kiro API Proxy'}</span>
                </div>
                <Button variant="outline" size="sm" onClick={createOpenClawKey} disabled={creatingKey}>
                  {creatingKey ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                  {isEn ? 'Create key' : 'Tạo key'}
                </Button>
              </div>
              <div className="rounded-lg border bg-muted/40 px-3 py-2 flex items-center gap-2">
                <code className="flex-1 text-xs break-all">
                  {loadingKeys ? (isEn ? 'Loading key...' : 'Đang tải key...') : proxyKey?.key ? maskKey(proxyKey.key) : (isEn ? 'No key yet. Import will create one automatically.' : 'Chưa có key. Khi import hệ thống sẽ tự tạo.')}
                </code>
                {proxyKey?.key && (
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyProxyKey} title={isEn ? 'Copy key' : 'Sao chép key'}>
                    {keyCopied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {isEn
                  ? 'The server stores this key and OpenClaw uses it to call the Kiro API proxy quota pool.'
                  : 'Server sẽ lưu key này để OpenClaw gọi qua Kiro API proxy và dùng quota xoay tài khoản.'}
              </div>
            </div>

            <div className="rounded-xl border bg-background p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-primary" />
                  <span className="font-medium">{isEn ? 'Model' : 'Model'}</span>
                </div>
                <Button variant="outline" size="sm" onClick={loadModels} disabled={loadingModels}>
                  {loadingModels ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCog className="h-4 w-4" />}
                  {isEn ? 'Reload' : 'Tải lại'}
                </Button>
              </div>
              {loadingModels ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {isEn ? 'Loading models...' : 'Đang tải model...'}
                </div>
              ) : models.length > 0 ? (
                <div className="space-y-2">
                  <Select
                    value={selectedModelId}
                    options={models.map(model => ({
                      value: model.id,
                      label: model.id,
                      description: model.name && model.name !== model.id ? model.name : model.description
                    }))}
                    onChange={value => {
                      setSelectedModelId(value)
                      setSelectedModelIds(current => current.some(id => normalizeModelId(id) === normalizeModelId(value)) ? current : [...current, value])
                      setResults([])
                    }}
                    placeholder={isEn ? 'Select model' : 'Chọn model'}
                  />
                  {selectedModel && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="secondary" className="border-0">{selectedModel.name || selectedModel.id}</Badge>
                      {selectedModel.inputTypes?.map(type => (
                        <Badge key={type} variant="secondary" className="border-0">{type}</Badge>
                      ))}
                    </div>
                  )}
                  <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <Badge className="bg-primary/10 text-primary border-primary/20">{selectedModelIds.length}</Badge>
                        <span className="text-sm font-medium">{isEn ? 'Models to add' : 'Model sẽ thêm'}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button type="button" variant="outline" size="sm" onClick={selectRecommendedModels}>
                          <Check className="h-3.5 w-3.5" />
                          {isEn ? 'Recommended' : 'Đề xuất'}
                        </Button>
                        <Button type="button" variant="ghost" size="sm" onClick={clearSelectedModels}>
                          {isEn ? 'Only primary' : 'Chỉ primary'}
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                      {models.filter(model => normalizeModelId(model.id) !== 'auto').map(model => {
                        const checked = selectedModelIdSet.has(normalizeModelId(model.id))
                        return (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => toggleModel(model.id)}
                            className={cn(
                              'flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                              checked ? 'border-primary/50 bg-primary/10' : 'border-border bg-background hover:border-primary/40'
                            )}
                          >
                            <span className={cn(
                              'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                              checked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                            )}>
                              {checked && <Check className="h-3 w-3" />}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-semibold">{model.id}</span>
                              {model.name && model.name !== model.id && (
                                <span className="block truncate text-muted-foreground">{model.name}</span>
                              )}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground py-2">{isEn ? 'No models loaded' : 'Chưa có model'}</div>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {clientOptions.map(option => {
                const Icon = option.icon
                const checked = selectedClients.includes(option.id)
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleClient(option.id)}
                    className={cn(
                      'text-left rounded-xl border p-4 transition-all hover:border-primary/50 hover:bg-primary/5',
                      checked ? 'border-primary/50 bg-primary/10 shadow-sm' : 'bg-background'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="p-2 rounded-lg bg-primary/10">
                        <Icon className="h-5 w-5 text-primary" />
                      </div>
                      <div className={cn('h-5 w-5 rounded-full border flex items-center justify-center', checked ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/40')}>
                        {checked && <Check className="h-3.5 w-3.5" />}
                      </div>
                    </div>
                    <div className="font-semibold text-sm mb-1">{option.name}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed">{option.description}</div>
                  </button>
                )
              })}
            </div>

            <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 flex items-start gap-2 text-sm text-warning">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>{isEn ? 'Existing client files are merged and backed up before writing.' : 'File client hiện có sẽ được merge và tạo backup trước khi ghi.'}</div>
            </div>

            {error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-3 flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>{error}</div>
              </div>
            )}

            {results.length > 0 && (
              <div className="space-y-2">
                {proxyBase && (
                  <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground space-y-1">
                    <div><span className="font-semibold text-foreground">Base URL:</span> <code>{proxyBase}</code></div>
                    <div>{isEn ? 'In OpenClaw, use /models and choose the krouter provider.' : 'Trong OpenClaw, gõ /models rồi chọn provider krouter.'}</div>
                  </div>
                )}
                {results.map(result => (
                  <div key={result.client} className={cn('rounded-xl border p-3 text-sm', result.success ? 'border-success/30 bg-success/10' : 'border-destructive/30 bg-destructive/10')}>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="font-semibold">{clientLabels[result.client]}</span>
                      <Badge className={result.success ? 'bg-success/15 text-success border-success/20' : 'bg-destructive/15 text-destructive border-destructive/20'}>
                        {result.success ? (isEn ? 'Configured' : 'Đã cấu hình') : (isEn ? 'Failed' : 'Thất bại')}
                      </Badge>
                    </div>
                    {result.error ? (
                      <div className="text-xs text-destructive">{result.error}</div>
                    ) : (
                      <div className="space-y-1 text-xs text-muted-foreground">
                        {result.paths.map(path => <div key={path} className="font-mono break-all">{path}</div>)}
                        {result.backupPaths.length > 0 && <div>{isEn ? 'Backups created' : 'Backup đã tạo'}: {result.backupPaths.length}</div>}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={applying}>{isEn ? 'Close' : 'Đóng'}</Button>
              <Button onClick={applyConfig} disabled={loadingModels || applying || !selectedModelId || selectedModelIds.length === 0 || selectedClients.length === 0}>
                {applying ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {applying
                  ? (isEn ? 'Configuring...' : 'Đang cấu hình...')
                  : importOpenClawOnly
                    ? (isEn ? 'Import to OpenClaw' : 'Import vào OpenClaw')
                    : (isEn ? 'Apply Configuration' : 'Áp dụng cấu hình')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
