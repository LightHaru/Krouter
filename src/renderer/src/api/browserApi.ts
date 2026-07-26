type AnyCallback = (...args: unknown[]) => void

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const EVENT_RECONNECT_MS = 2000
const EVENT_RECONNECT_MAX_MS = 30000
/** Sau ngần này lần kết nối hỏng liên tiếp thì coi như phiên đã mất, không phải mạng chập chờn. */
const EVENT_RECONNECT_AUTH_HINT_AT = 4

const listenerSets = new Map<string, Set<AnyCallback>>()
let eventSource: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0

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
  eventSource.onopen = () => {
    reconnectAttempts = 0
  }
  eventSource.onerror = () => {
    eventSource?.close()
    eventSource = null
    if (listenerSets.size > 0 && !reconnectTimer) {
      // Trước đây thử lại đều đặn 2 giây vô hạn, không đếm lần: khi phiên đã hết hạn thì
      // đó là vòng lặp 401 không bao giờ dừng. Có backoff + báo mất phiên sau vài lần hỏng.
      reconnectAttempts++
      if (reconnectAttempts >= EVENT_RECONNECT_AUTH_HINT_AT) notifyAuthLost()
      const delay = Math.min(EVENT_RECONNECT_MS * 2 ** (reconnectAttempts - 1), EVENT_RECONNECT_MAX_MS)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        ensureEventSource()
      }, delay)
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
      reconnectAttempts = 0
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }
  }
}

/** Phát khi backend trả 401 để AuthGate đưa người dùng về màn hình đăng nhập. */
export const AUTH_LOST_EVENT = 'krouter:auth-lost'

function notifyAuthLost(): void {
  window.dispatchEvent(new CustomEvent(AUTH_LOST_EVENT))
}

async function callBackend<T>(method: string, args: unknown[]): Promise<T> {
  const response = await fetch(`${API_BASE}/api/ipc`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, args })
  })
  const text = await response.text()
  // JSON.parse phải nằm trong try và phải sau khi biết response.ok: một trang lỗi HTML do
  // nginx sinh ra (502) sẽ ném SyntaxError "Unexpected token '<'" và che mất lỗi thật.
  let data: { error?: string } | null = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!response.ok) {
    // Phiên hết hạn (TTL 7 ngày, hoặc bị đẩy ra khi vượt MAX_SESSIONS_PER_USER): trước đây
    // không có nhánh nào xử lý, nên mọi nút bấm chỉ hiện "Unauthorized" trong khi lưới tài
    // khoản vẫn render dữ liệu cache như thể mọi thứ bình thường.
    if (response.status === 401) notifyAuthLost()
    throw new Error(data?.error || text?.slice(0, 200) || response.statusText)
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

    // Trước đây mọi resolve đều nằm trong onchange. Người dùng đóng hộp thoại chọn file thì
    // sự kiện bắn ra là 'cancel', không phải 'change' — promise treo vĩnh viễn nên khối
    // `finally { setIsImporting(false) }` của caller không bao giờ chạy và nút Import kẹt ở
    // trạng thái "Importing…" cho tới khi tải lại trang.
    let settled = false
    const finish = (value: { content: string; format: string } | null): void => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onWindowFocus)
      resolve(value)
    }
    // Safari cũ không bắn sự kiện 'cancel'; khi cửa sổ lấy lại focus mà vẫn chưa có file
    // thì coi như người dùng đã huỷ.
    const onWindowFocus = (): void => {
      setTimeout(() => {
        if (!settled && !input.files?.length) finish(null)
      }, 300)
    }

    input.oncancel = () => finish(null)
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) {
        finish(null)
        return
      }
      try {
        const content = await file.text()
        const format = file.name.split('.').pop()?.toLowerCase() || 'txt'
        finish({ content, format })
      } catch (error) {
        console.warn('[WebApi] Không đọc được file đã chọn', error)
        finish(null)
      }
    }
    window.addEventListener('focus', onWindowFocus, { once: true })
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
  downloadUpdate: async () => callBackend('applyKrouterUpdate', []),
  installUpdate: async () => callBackend('applyKrouterUpdate', []),
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
