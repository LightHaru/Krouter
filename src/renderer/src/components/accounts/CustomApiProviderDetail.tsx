import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Brain,
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Server,
  Trash2
} from 'lucide-react'
import { Badge, Button, Input } from '../ui'
import {
  CUSTOM_REASONING_EFFORTS,
  maskCustomApiKey,
  providerKeys,
  type CustomApiKeyView,
  type CustomApiReasoningEffort,
  type CustomProviderView
} from './customApiTypes'
import { copyText } from '@/lib/utils'

interface Props {
  isEn: boolean
  provider: CustomProviderView
  providers: CustomProviderView[]
  onBack: () => void
  onSaved: () => Promise<void>
}

type KeyTestResult = { success: boolean; error?: string; models: number }

export function CustomApiProviderDetail({
  isEn,
  provider,
  providers,
  onBack,
  onSaved
}: Props): React.ReactNode {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [showAddKey, setShowAddKey] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKeyValue, setNewKeyValue] = useState('')
  const [newModel, setNewModel] = useState('')
  const [keyResults, setKeyResults] = useState<Record<string, KeyTestResult>>({})
  const keys = useMemo(() => providerKeys(provider), [provider])
  const models = provider.models || []
  const routePrefix = provider.routePrefix || provider.id

  const saveProvider = async (nextProvider: CustomProviderView, successMessage: string): Promise<void> => {
    setNotice(null)
    const nextProviders = providers.map((item) => item.id === provider.id ? nextProvider : item)
    const result = await window.api.proxyUpdateConfig({ customApiProviders: nextProviders })
    if (!result.success) throw new Error(result.error || 'Unable to save provider')
    await onSaved()
    setNotice({ kind: 'ok', text: successMessage })
  }

  const addKey = async (): Promise<void> => {
    const apiKey = newKeyValue.trim()
    if (!apiKey) return
    setBusy('add-key')
    try {
      const key: CustomApiKeyView = {
        id: `${provider.id}-key-${Date.now().toString(36)}`,
        name: newKeyName.trim() || `Key ${keys.length + 1}`,
        apiKey,
        enabled: true,
        createdAt: Date.now()
      }
      await saveProvider(
        { ...provider, keys: [...keys, key], apiKey: keys[0]?.apiKey || apiKey },
        isEn ? `${key.name} added and routing is ready.` : `Da them ${key.name} va routing da san sang.`
      )
      setNewKeyName('')
      setNewKeyValue('')
      setShowAddKey(false)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to add API key' })
    } finally {
      setBusy(null)
    }
  }

  const updateKeys = async (nextKeys: CustomApiKeyView[], message: string): Promise<void> => {
    setBusy('keys')
    try {
      await saveProvider(
        { ...provider, keys: nextKeys, apiKey: nextKeys.find((key) => key.enabled)?.apiKey || nextKeys[0]?.apiKey || '' },
        message
      )
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to update API keys' })
    } finally {
      setBusy(null)
    }
  }

  const testKey = async (key: CustomApiKeyView): Promise<void> => {
    setBusy(key.id)
    setNotice(null)
    try {
      const result = await window.api.proxyTestCustomApi({
        ...provider,
        apiKey: key.apiKey,
        keys: [{ ...key, enabled: true }],
        models: []
      })
      const nextResult = {
        success: result.success,
        error: result.error,
        models: result.models?.length || 0
      }
      setKeyResults((current) => ({ ...current, [key.id]: nextResult }))
      setNotice({
        kind: result.success ? 'ok' : 'error',
        text: result.success
          ? `${key.name}: ${nextResult.models} ${isEn ? 'models discovered.' : 'model da duoc tim thay.'}`
          : `${key.name}: ${result.error || 'Connection failed'}`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection failed'
      setKeyResults((current) => ({ ...current, [key.id]: { success: false, error: message, models: 0 } }))
      setNotice({ kind: 'error', text: `${key.name}: ${message}` })
    } finally {
      setBusy(null)
    }
  }

  const importModels = async (): Promise<void> => {
    setBusy('models')
    setNotice(null)
    try {
      const result = await window.api.proxyTestCustomApi({ ...provider, models: [] })
      if (!result.success) throw new Error(result.error || 'Unable to import /models')
      const imported = Array.from(new Set((result.models || []).map((model) => model.upstreamId || model.id)))
      await saveProvider({
        ...provider,
        models: imported,
        modelDiscoveryMode: 'manual',
        modelsSyncedAt: Date.now(),
        modelsSyncError: undefined
      }, `${imported.length} ${isEn ? 'models imported from /models.' : 'model da import tu /models.'}`)
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to import /models' })
    } finally {
      setBusy(null)
    }
  }

  const addModel = async (): Promise<void> => {
    const model = newModel.trim()
    if (!model || models.includes(model)) return
    setBusy('models')
    try {
      await saveProvider(
        { ...provider, models: [...models, model], modelDiscoveryMode: 'manual' },
        `${routePrefix}/${model} ${isEn ? 'added to routing.' : 'da them vao routing.'}`
      )
      setNewModel('')
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to add model' })
    } finally {
      setBusy(null)
    }
  }

  const updateThinking = async (effort: CustomApiReasoningEffort): Promise<void> => {
    setBusy('thinking')
    try {
      await saveProvider(
        { ...provider, reasoningEffort: effort },
        `${isEn ? 'Thinking default saved' : 'Da luu Thinking mac dinh'}: ${effort}.`
      )
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to save Thinking' })
    } finally {
      setBusy(null)
    }
  }

  const toggleProvider = async (): Promise<void> => {
    setBusy('provider')
    try {
      await saveProvider(
        { ...provider, enabled: !provider.enabled },
        provider.enabled
          ? (isEn ? 'Provider disabled.' : 'Da tat provider.')
          : (isEn ? 'Provider enabled.' : 'Da bat provider.')
      )
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to update provider' })
    } finally {
      setBusy(null)
    }
  }

  const removeModel = async (model: string): Promise<void> => {
    setBusy(`model:${model}`)
    try {
      await saveProvider(
        {
          ...provider,
          models: models.filter((item) => item !== model),
          modelDiscoveryMode: 'manual'
        },
        `${model} ${isEn ? 'removed.' : 'da duoc xoa.'}`
      )
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to remove model' })
    } finally {
      setBusy(null)
    }
  }

  const removeProvider = async (): Promise<void> => {
    if (!confirm(isEn ? `Delete ${provider.name}?` : `Xoa ${provider.name}?`)) return
    setBusy('delete-provider')
    try {
      const result = await window.api.proxyUpdateConfig({
        customApiProviders: providers.filter((item) => item.id !== provider.id)
      })
      if (!result.success) throw new Error(result.error || 'Unable to delete provider')
      await onSaved()
      onBack()
    } catch (error) {
      setNotice({ kind: 'error', text: error instanceof Error ? error.message : 'Unable to delete provider' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="custom-provider-detail">
      <header className="custom-provider-detail-head">
        <button className="custom-provider-back" onClick={onBack}><ArrowLeft />{isEn ? 'Back to providers' : 'Ve danh sach provider'}</button>
        <div className="custom-provider-title">
          <div className="provider-brand custom"><Server /></div>
          <div>
            <div><h2>{provider.name}</h2><Badge variant={provider.enabled ? 'success' : 'secondary'}>{provider.enabled ? 'Active' : 'Disabled'}</Badge></div>
            <p>{provider.protocol === 'openai' ? 'OpenAI compatible' : 'Anthropic compatible'} · {provider.baseUrl}</p>
          </div>
        </div>
      </header>

      {notice && <div className={`provider-detail-notice ${notice.kind}`}>{notice.kind === 'ok' ? <CheckCircle2 /> : <AlertTriangle />}<span>{notice.text}</span></div>}

      <section className="custom-provider-summary-card">
        <div><small>{isEn ? 'PROVIDER DETAILS' : 'CHI TIET PROVIDER'}</small><strong>/{routePrefix}</strong><span>{provider.baseUrl}</span></div>
        <div className="custom-provider-summary-actions">
          <Button
            variant="outline"
            onClick={() => void toggleProvider()}
            disabled={busy !== null}
          >{busy === 'provider' ? <Loader2 className="animate-spin" /> : <Power />}{provider.enabled ? (isEn ? 'Disable' : 'Tat') : (isEn ? 'Enable' : 'Bat')}</Button>
          <Button variant="destructive" onClick={() => void removeProvider()} disabled={busy !== null}><Trash2 />{isEn ? 'Delete' : 'Xoa'}</Button>
        </div>
      </section>

      <section className="custom-provider-section">
        <header>
          <div><KeyRound /><span><strong>{isEn ? 'Connections' : 'Ket noi'}</strong><small>{keys.length} API key(s), automatic failover</small></span></div>
          <Button onClick={() => setShowAddKey((current) => !current)}><Plus />{isEn ? 'Add API Key' : 'Them API Key'}</Button>
        </header>
        {showAddKey && (
          <div className="custom-key-form">
            <Input value={newKeyName} onChange={(event) => setNewKeyName(event.target.value)} placeholder={isEn ? 'Key name' : 'Ten key'} />
            <Input value={newKeyValue} onChange={(event) => setNewKeyValue(event.target.value)} placeholder="sk-..." type="password" autoComplete="off" />
            <Button onClick={() => void addKey()} disabled={!newKeyValue.trim() || busy !== null}>{busy === 'add-key' ? <Loader2 className="animate-spin" /> : <Plus />}{isEn ? 'Save key' : 'Luu key'}</Button>
          </div>
        )}
        <div className="custom-key-list">
          {keys.map((key, index) => {
            const result = keyResults[key.id]
            return (
              <article key={key.id} className="custom-key-row">
                <div className="custom-key-index">{index + 1}</div>
                <div><strong>{key.name}</strong><span>{maskCustomApiKey(key.apiKey)}</span></div>
                <Badge variant={result ? (result.success ? 'success' : 'destructive') : key.enabled ? 'success' : 'secondary'}>
                  {result ? (result.success ? 'Reachable' : 'Failed') : key.enabled ? 'Active' : 'Disabled'}
                </Badge>
                <div className="custom-key-actions">
                  <Button size="sm" variant="outline" onClick={() => void testKey(key)} disabled={busy !== null}>{busy === key.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}Test</Button>
                  <Button size="sm" variant="ghost" onClick={() => void updateKeys(keys.map((item) => item.id === key.id ? { ...item, enabled: !item.enabled } : item), `${key.name} ${key.enabled ? 'disabled' : 'enabled'}.`)} disabled={busy !== null}><Power /></Button>
                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void updateKeys(keys.filter((item) => item.id !== key.id), `${key.name} removed.`)} disabled={busy !== null}><Trash2 /></Button>
                </div>
              </article>
            )
          })}
        </div>
      </section>

      <section className="custom-provider-section custom-model-section">
        <header>
          <div><Brain /><span><strong data-no-translate>Available Models</strong><small>{isEn ? 'Imported models are immediately available to routing and client configuration.' : 'Model import se co ngay trong routing va cau hinh client.'}</small></span></div>
          <label className="custom-thinking-select">
            <span>Thinking</span>
            <select aria-label="Custom API Thinking" value={provider.reasoningEffort || 'auto'} onChange={(event) => void updateThinking(event.target.value as CustomApiReasoningEffort)} disabled={busy !== null}>
              {CUSTOM_REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{effort === 'auto' ? 'Auto' : effort.charAt(0).toUpperCase() + effort.slice(1)}</option>)}
            </select>
          </label>
        </header>
        <div className="custom-model-import-row">
          <Input value={newModel} onChange={(event) => setNewModel(event.target.value)} placeholder={isEn ? 'Model ID, e.g. gpt-4.1' : 'Model ID, vi du gpt-4.1'} />
          <Button variant="outline" onClick={() => void addModel()} disabled={!newModel.trim() || busy !== null}><Plus />{isEn ? 'Add' : 'Them'}</Button>
          <Button onClick={() => void importModels()} disabled={busy !== null}>{busy === 'models' ? <Loader2 className="animate-spin" /> : <Download />}{isEn ? 'Import from /models' : 'Import tu /models'}</Button>
        </div>
        {provider.modelsSyncError && <div className="provider-inline-error"><AlertTriangle />{provider.modelsSyncError}</div>}
        <div className="custom-model-list">
          {models.length ? models.map((model) => (
            <article key={model}>
              <div><Server /><span><strong>{model}</strong><code>{routePrefix}/{model}</code></span></div>
              <div>
                <button title="Copy model ID" onClick={() => void copyText(`${routePrefix}/${model}`)}><Copy /></button>
                <button title="Remove model" onClick={() => void removeModel(model)} disabled={busy !== null}>
                  {busy === `model:${model}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
                </button>
              </div>
            </article>
          )) : <div className="custom-model-empty">{isEn ? 'No models yet. Import from /models or add one manually.' : 'Chua co model. Hay import tu /models hoac them thu cong.'}</div>}
        </div>
      </section>
    </div>
  )
}
