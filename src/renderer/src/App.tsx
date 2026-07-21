import { useState, useEffect, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AccountManager } from './components/accounts'
import { Sidebar, TitleBar, type PageType } from './components/layout'
import { HomePage, AboutPage, SettingsPage, MachineIdPage, KiroSettingsPage, ProxyPage, KProxyPage, ProxyPoolPage, WebhooksPage, DiagnosePage, ConfigSyncPage, SkillsPage, MITMPage, RegisterPage, SubscriptionPage, LogsPage, DocsPage } from './components/pages'
import { useWebhookStore } from './store/webhooks'
import { UpdateDialog } from './components/UpdateDialog'
import { useAccountsStore } from './store/accounts'
import { pageFromPath } from './lib/docsRoute'
import { useIsMobile } from './hooks/useIsMobile'

// 后台刷新结果批量化间隔：N 条结果合并到一次 set，避免 N 次 Map 全量复制 + 渲染抖动
const BACKGROUND_RESULT_FLUSH_MS = 120
const BACKEND_ACCOUNT_SYNC_INTERVAL_MS = 10000
const BACKEND_ACCOUNT_SYNC_DEBOUNCE_MS = 800

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<PageType>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const isMobile = useIsMobile()

  // Đóng drawer khi thoát chế độ mobile (tránh kẹt overlay khi phóng to cửa sổ).
  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false)
  }, [isMobile])

  // Escape đóng drawer.
  useEffect(() => {
    if (!mobileNavOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileNavOpen])

  const {
    loadFromStorage,
    startAutoTokenRefresh,
    stopAutoTokenRefresh,
    applyBackgroundRefreshResults,
    applyBackgroundCheckResults,
    applyProxyAccountUpdate,
    flushSaveImmediately,
    updateAccountStatus
  } = useAccountsStore()

  const backendAccountSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const backendAccountSyncInFlightRef = useRef(false)
  const syncAccountsFromBackend = useCallback((delayMs = 0): void => {
    if (backendAccountSyncTimerRef.current) clearTimeout(backendAccountSyncTimerRef.current)
    backendAccountSyncTimerRef.current = setTimeout(() => {
      backendAccountSyncTimerRef.current = null
      if (backendAccountSyncInFlightRef.current) return
      if (typeof document !== 'undefined' && document.hidden) return
      backendAccountSyncInFlightRef.current = true
      loadFromStorage({ silent: true })
        .catch((error) => console.warn('[App] silent backend account sync failed:', error))
        .finally(() => {
          backendAccountSyncInFlightRef.current = false
        })
    }, delayMs)
  }, [loadFromStorage])

  // 应用启动时加载数据并启动自动刷新
  useEffect(() => {
    loadFromStorage().then(() => {
      startAutoTokenRefresh()
    })
    useAccountsStore.getState().loadProactiveRenewalEnabled()
    // 加载 Webhook 配置
    useWebhookStore.getState().loadFromStorage()

    return () => {
      stopAutoTokenRefresh()
    }
  }, [loadFromStorage, startAutoTokenRefresh, stopAutoTokenRefresh])

  useEffect(() => {
    const interval = setInterval(() => {
      syncAccountsFromBackend()
    }, BACKEND_ACCOUNT_SYNC_INTERVAL_MS)
    const onFocus = (): void => syncAccountsFromBackend()
    const onVisibilityChange = (): void => {
      if (!document.hidden) syncAccountsFromBackend()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (backendAccountSyncTimerRef.current) {
        clearTimeout(backendAccountSyncTimerRef.current)
        backendAccountSyncTimerRef.current = null
      }
    }
  }, [syncAccountsFromBackend])

  // 订阅 Kiro IDE 自己 refresh token 后反代检测到的事件
  // 触发时间点：Kiro IDE 在后台 refresh loop 把磁盘 token 写新了，反代 watcher 反向同步到 store
  // 这里收到事件后从磁盘重新加载账号数据，让 UI 立刻显示最新 expiresAt / accessToken
  useEffect(() => {
    if (typeof window.api.onKiroIdeTokenChanged !== 'function') return
    const unsubscribe = window.api.onKiroIdeTokenChanged((data) => {
      console.log(`[App] Kiro IDE refreshed token for account ${data.accountId} (${data.reason}), reloading accounts...`)
      loadFromStorage().catch((e) => console.warn('[App] reload after IDE token change failed:', e))
    })
    return unsubscribe
  }, [loadFromStorage])

  // 反代关键事件 → 触发 webhook（v1.8 新增）
  // 由 main/proxyServer 内置的 webhookTrigger 通过 IPC 推送过来，统一在 renderer 调 useWebhookStore
  useEffect(() => {
    const unsubscribe = window.api.onProxyWebhookTrigger?.((event, payload) => {
      try {
        const store = useWebhookStore.getState()
        // 映射反代事件名 → Webhook 事件类型
        const webhookEventMap: Record<string, 'risk-warning' | 'account-banned'> = {
          'proxy-account-suspended': 'account-banned',
          'proxy-all-exhausted': 'risk-warning',
          'proxy-pool-low': 'risk-warning'
        }
        const targetEvent = webhookEventMap[event] || 'risk-warning'
        // 规范化 level（main 用 'error'/'info' 等字符串字面量，需要映射到 store 接受的类型）
        const rawLevel = (payload as { level?: string })?.level
        const level: 'info' | 'warn' | 'error' | 'success' =
          rawLevel === 'error' ? 'error'
          : rawLevel === 'info' ? 'info'
          : rawLevel === 'success' ? 'success'
          : 'warn'
        void store.triggerEvent(targetEvent, {
          title: String((payload as Record<string, unknown>).title ?? '反代告警'),
          message: String((payload as Record<string, unknown>).message ?? ''),
          level,
          fields: (payload as { fields?: Record<string, string | number> })?.fields
        })
      } catch (err) {
        console.error('[App] Proxy webhook trigger failed:', err)
      }
    })
    return () => { unsubscribe?.() }
  }, [])

  // Đồng bộ URL cho deep-link /docs (không dùng router; chỉ History API).
  // Mount: nếu vào thẳng /docs thì mở trang docs. popstate: đồng bộ back/forward.
  useEffect(() => {
    if (pageFromPath(window.location.pathname) === 'docs') {
      setCurrentPage('docs')
    }
    const onPop = (): void => {
      const isDocs = pageFromPath(window.location.pathname) === 'docs'
      setCurrentPage((prev) => (isDocs ? 'docs' : prev === 'docs' ? 'home' : prev))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Khi currentPage đổi: đồng bộ URL /docs <-> /. Giới hạn ở /docs để tránh hồi quy.
  useEffect(() => {
    try {
      const isDocsPath = pageFromPath(window.location.pathname) === 'docs'
      if (currentPage === 'docs' && !isDocsPath) {
        window.history.pushState(null, '', '/docs')
      } else if (currentPage !== 'docs' && isDocsPath) {
        window.history.pushState(null, '', '/')
      }
    } catch {
      // pushState best-effort; điều hướng state vẫn hoạt động nếu URL không đổi.
    }
  }, [currentPage])

  // 应用内页面跳转（轻量 CustomEvent，供深层组件无需 prop 钻取即可切页）
  useEffect(() => {
    const handler = (e: Event): void => {
      const detail = (e as CustomEvent<PageType>).detail
      if (detail) setCurrentPage(detail)
    }
    window.addEventListener('navigate-page', handler)
    return () => window.removeEventListener('navigate-page', handler)
  }, [])

  // 关闭/刷新前强制 flush 防抖中的待保存数据，防止数据丢失
  useEffect(() => {
    const handleBeforeUnload = (): void => { void flushSaveImmediately() }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [flushSaveImmediately])




  // 监听后台刷新结果：缓冲 + 批量化 flush，N 条结果合并为一次 set，消除 Map 复制风暴
  useEffect(() => {
    const refreshBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      flushTimer = null
      if (refreshBuffer.length === 0) return
      const batch = refreshBuffer.splice(0)
      applyBackgroundRefreshResults(batch)
      syncAccountsFromBackend(BACKEND_ACCOUNT_SYNC_DEBOUNCE_MS)
    }

    const unsubscribe = window.api.onBackgroundRefreshResult((data) => {
      refreshBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        // 卸载前 flush 剩余结果，防止丢失
        flush()
      }
    }
  }, [applyBackgroundRefreshResults, syncAccountsFromBackend])

  // 监听后台检查结果：同样的批量化策略
  useEffect(() => {
    const checkBuffer: Array<{ id: string; success: boolean; data?: unknown; error?: string }> = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
      flushTimer = null
      if (checkBuffer.length === 0) return
      const batch = checkBuffer.splice(0)
      applyBackgroundCheckResults(batch)
      syncAccountsFromBackend(BACKEND_ACCOUNT_SYNC_DEBOUNCE_MS)
    }

    const unsubscribe = window.api.onBackgroundCheckResult((data) => {
      checkBuffer.push(data)
      if (!flushTimer) {
        flushTimer = setTimeout(flush, BACKGROUND_RESULT_FLUSH_MS)
      }
    })
    return () => {
      unsubscribe()
      if (flushTimer) {
        clearTimeout(flushTimer)
        flush()
      }
    }
  }, [applyBackgroundCheckResults, syncAccountsFromBackend])

  useEffect(() => {
    if (typeof window.api.onProxyAccountUpdate !== 'function') return
    const unsubscribe = window.api.onProxyAccountUpdate((account) => {
      applyProxyAccountUpdate(account)
    })
    return () => {
      unsubscribe()
    }
  }, [applyProxyAccountUpdate])

  // 监听反代账号被封禁事件（TEMPORARILY_SUSPENDED / AccountSuspendedException）
  // 反代触发后，把封禁状态同步到 store 让 UI 显示
  useEffect(() => {
    const unsubscribe = window.api.onProxyAccountSuspended((info) => {
      console.warn(`[App] Account suspended via proxy: ${info.email || info.id} (${info.reason})`)
      updateAccountStatus(info.id, 'blocked', `[${info.reason}] ${info.message}`)
    })
    return () => {
      unsubscribe()
    }
  }, [updateAccountStatus])

  const renderPage = () => {
    switch (currentPage) {
      case 'home':
        return <HomePage />
      case 'accounts':
        return <AccountManager />
      case 'machineId':
        return <MachineIdPage />
      case 'kiroSettings':
        return <KiroSettingsPage />
      case 'proxy':
        return <ProxyPage />
      case 'kproxy':
        return <KProxyPage />
      case 'mitm':
        return <MITMPage />
      case 'proxyPool':
        return <ProxyPoolPage />
      case 'register':
        return <RegisterPage />
      case 'subscription':
        return <SubscriptionPage />
      case 'webhooks':
        return <WebhooksPage />
      case 'diagnose':
        return <DiagnosePage />
      case 'configSync':
        return <ConfigSyncPage />
      case 'skills':
        return <SkillsPage />
      case 'logs':
        return <LogsPage />
      case 'docs':
        return <DocsPage />
      case 'settings':
        return <SettingsPage />
      case 'about':
        return <AboutPage />
      default:
        return <HomePage />
    }
  }

  return (
    <div className="app-shell ambient-bg">
      <TitleBar showMenuButton={isMobile} onMenuClick={() => setMobileNavOpen(true)} />
      <div className="app-workspace">
        {/* Desktop: sidebar tĩnh. Mobile: ẩn, thay bằng drawer bên dưới. */}
        {!isMobile && (
          <Sidebar
            currentPage={currentPage}
            onPageChange={setCurrentPage}
            collapsed={sidebarCollapsed}
            onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
          />
        )}
        <main className="app-main page-surface">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentPage}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
              className="h-full flex flex-col"
            >
              {renderPage()}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Mobile sidebar drawer */}
      <AnimatePresence>
        {isMobile && mobileNavOpen && (
          <div className="fixed inset-0 z-[9997]">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setMobileNavOpen(false)}
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              className="absolute left-0 top-0 bottom-0 p-2"
            >
              <Sidebar
                variant="drawer"
                currentPage={currentPage}
                onPageChange={setCurrentPage}
                collapsed={false}
                onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
                onNavigate={() => setMobileNavOpen(false)}
              />
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <UpdateDialog />
    </div>
  )
}

export default App
