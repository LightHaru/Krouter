type AnyCallback = (...args: any[]) => void

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const EVENT_RECONNECT_MS = 2000

const listenerSets = new Map<string, Set<AnyCallback>>()
let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

function kebabFromOnMethod(methodName: string): string {
  return methodName
    .replace(/^on/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

function ensureEventSource(): void {
  if (eventSource || listenerSets.size === 0) return

  eventSource = new EventSource(`${API_BASE}/api/events`, { withCredentials: true })
  eventSource.onmessage = (message) => {
    try {
      const envelope = JSON.parse(message.data) as {
        channel: string
        args?: unknown[]
        payload?: unknown
      }
      const listeners = listenerSets.get(envelope.channel)
      if (!listeners) return
      const args = Array.isArray(envelope.args) ? envelope.args : [envelope.payload]
      for (const listener of listeners) listener(...args)
    } catch (error) {
      console.warn('[WebApi] Failed to parse event payload', error)
    }
  }
  eventSource.onerror = () => {
    eventSource?.close()
    eventSource = null
    if (listenerSets.size > 0 && !reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        ensureEventSource()
      }, EVENT_RECONNECT_MS)
    }
  }
}

function subscribe(channel: string, callback: AnyCallback): () => void {
  let listeners = listenerSets.get(channel)
  if (!listeners) {
    listeners = new Set()
    listenerSets.set(channel, listeners)
  }
  listeners.add(callback)
  ensureEventSource()

  return () => {
    const current = listenerSets.get(channel)
    current?.delete(callback)
    if (current && current.size === 0) listenerSets.delete(channel)
    if (listenerSets.size === 0) {
      eventSource?.close()
      eventSource = null
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }
  }
}

async function callBackend<T>(method: string, args: unknown[]): Promise<T> {
  const response = await fetch(`${API_BASE}/api/ipc`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args })
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(data?.error || response.statusText)
  }
  return data as T
}

function downloadText(data: string, filename: string): boolean {
  const blob = new Blob([data], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  return true
}

function importTextFile(): Promise<{ content: string; format: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.txt,.csv,text/plain,application/json,text/csv'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      const content = await file.text()
      const format = file.name.split('.').pop()?.toLowerCase() || 'txt'
      resolve({ content, format })
    }
    input.click()
  })
}

const browserOverrides: Record<string, unknown> = {
  openExternal: (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  openSubscriptionWindow: async (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
    return { success: true }
  },
  exportToFile: async (data: string, filename: string) => downloadText(data, filename),
  importFromFile: importTextFile,
  startSocialLogin: async (provider: 'Google' | 'Github', usePrivateMode?: boolean) => {
    const result = await callBackend<{ success: boolean; loginUrl?: string; state?: string; error?: string }>('startSocialLogin', [provider, usePrivateMode])
    if (result.success && result.loginUrl) {
      window.open(result.loginUrl, '_blank', 'noopener,noreferrer')
    }
    return result
  },
  protonOpenLogin: async () => {
    const result = await callBackend<{ success: boolean; loggedIn: boolean; loginUrl?: string; error?: string }>('protonOpenLogin', [])
    if (result.loginUrl) {
      window.open(result.loginUrl, '_blank', 'noopener,noreferrer')
    }
    return result
  },
  downloadUpdate: async () => ({ success: false, error: 'Web deployments are updated on the server.' }),
  installUpdate: () => undefined,
  getProactiveRenewalEnabled: async () => ({ success: true, enabled: false, leadTimeMinutes: 15 }),
  setProactiveRenewalEnabled: async () => ({
    success: false,
    enabled: false,
    error: 'Kiro IDE proactive renewal is only available in the desktop application.'
  }),
  updateTrayAccount: () => undefined,
  updateTrayAccountList: () => undefined,
  refreshTrayMenu: () => undefined,
  updateTrayLanguage: () => undefined,
  sendCloseConfirmResponse: () => undefined,
  window: {
    minimize: () => undefined,
    maximizeToggle: () => undefined,
    close: () => undefined,
    isMaximized: async () => false,
    getPlatform: async () => 'darwin' as NodeJS.Platform,
    onMaximizeChange: () => () => undefined
  }
}

export const browserApi = new Proxy(browserOverrides, {
  get(target, prop) {
    if (typeof prop !== 'string') return undefined
    if (prop in target) return target[prop]

    if (prop.startsWith('on') && prop.length > 2) {
      const listener = (callback: AnyCallback) => subscribe(kebabFromOnMethod(prop), callback)
      target[prop] = listener
      return listener
    }

    const caller = (...args: unknown[]) => callBackend(prop, args)
    target[prop] = caller
    return caller
  }
}) as unknown as Window['api']

export function installBrowserApi(): void {
  if (!window.api) {
    window.api = browserApi
  }
  if (!window.electron) {
    window.electron = {} as Window['electron']
  }
}
