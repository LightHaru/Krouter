import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy as RestoreIcon, Menu, Radio } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskCenterButton } from './TaskCenter'
import krouterMark from '@/assets/krouter-mark.svg'
import { APP_NAME } from '@/brand'
import type { PageType } from './Sidebar'

interface TitleBarProps {
  /** Hiện nút hamburger (mobile) mở sidebar drawer. */
  showMenuButton?: boolean
  onMenuClick?: () => void
  currentPage?: PageType
}

const PAGE_NAMES: Record<PageType, string> = {
  home: 'Command center', accounts: 'Accounts', machineId: 'Machine identity', kiroSettings: 'Kiro settings',
  proxy: 'API proxy', usage: 'Usage & analytics', kproxy: 'K-Proxy', mitm: 'MITM proxy', proxyPool: 'Proxy pool', register: 'Registration',
  subscription: 'Subscriptions', webhooks: 'Webhooks', diagnose: 'Diagnostics', configSync: 'Config sync',
  skills: 'Skills', logs: 'Activity logs', docs: 'Documentation', settings: 'Preferences', about: 'About'
}

/**
 * 跨平台自定义 titlebar
 * - macOS: 居中标题 + 左侧 traffic lights 留位（系统渲染）
 * - Windows/Linux: 左侧应用图标+标题 + 右侧自绘按钮
 *
 * 拖动：整条 titlebar 用 -webkit-app-region: drag
 * 按钮区：使用 no-drag 让点击生效
 */
// Bản web (trình duyệt) KHÔNG phải Electron: không có window controls, và tuyệt đối
// không bật -webkit-app-region: drag vì trên trình duyệt nó nuốt hết click (hamburger
// sẽ không bấm được).
const IS_ELECTRON =
  typeof navigator !== 'undefined' && navigator.userAgent.toLowerCase().includes('electron')

export function TitleBar({ showMenuButton = false, onMenuClick, currentPage = 'home' }: TitleBarProps = {}): React.ReactNode {
  useTranslation()
  const [platform, setPlatform] = useState<NodeJS.Platform>('win32')
  const [isMaximized, setIsMaximized] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    let cleanup: (() => void) | undefined

    const init = async () => {
      try {
        const p = await window.api.window.getPlatform()
        setPlatform(p)
        const max = await window.api.window.isMaximized()
        setIsMaximized(max)
      } catch (err) {
        console.warn('[TitleBar] init failed', err)
      }

      // 监听最大化状态变化
      cleanup = window.api.window.onMaximizeChange((m) => setIsMaximized(m))
    }

    init()

    // 获取应用版本号
    window.api.getAppVersion().then(setAppVersion).catch(() => {})

    return () => cleanup?.()
  }, [])

  // Chỉ coi là macOS khi THỰC SỰ chạy Electron trên mac (web shim trả 'darwin' giả).
  const isMac = IS_ELECTRON && platform === 'darwin'

  return (
    <div
      className={cn(
        'control-titlebar flex h-11 w-full flex-shrink-0 select-none items-center text-foreground/80'
      )}
      style={{
        // Chỉ Electron mới kéo được cửa sổ; web bật drag sẽ chặn click.
        WebkitAppRegion: IS_ELECTRON ? 'drag' : 'no-drag',
        // mac 留 80px 给 traffic lights
        paddingLeft: isMac ? 80 : 16,
        paddingRight: isMac ? 12 : 0
      } as React.CSSProperties}
    >
      {/* Hamburger (mobile) mở sidebar drawer */}
      {showMenuButton && (
        <div className="flex items-center pr-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            type="button"
            onClick={onMenuClick}
            title="Menu"
            aria-label="Open navigation"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground/70 transition-colors hover:border-primary/40 hover:text-primary"
          >
            <Menu className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Application identity and current workspace. */}
      <div
        className={cn(
          'flex min-w-0 items-center gap-2.5 text-xs',
          isMac ? 'flex-1 justify-center' : 'flex-1'
        )}
      >
        {!isMac && (
          <img src={krouterMark} alt="" className="h-[18px] w-[18px] opacity-90" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        )}
        <span className="hidden font-bold tracking-tight text-foreground/80 sm:inline">{APP_NAME}</span>
        <span className="hidden h-4 w-px bg-border sm:block" />
        <span className="truncate font-medium text-muted-foreground">{PAGE_NAMES[currentPage]}</span>
      </div>

      {/* 任务中心入口（仅当有任务时显示） */}
      <div className="flex items-center gap-2 px-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="hidden items-center gap-1.5 rounded-full border border-emerald-600/20 bg-emerald-500/8 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 sm:flex">
          <Radio className="h-3 w-3" /> Online
        </div>
        {appVersion && <span className="hidden font-mono text-[10px] text-muted-foreground md:inline">v{appVersion}</span>}
        <TaskCenterButton />
      </div>

      {/* Windows/Linux 按钮组 — chỉ hiển thị trong Electron (web không có window controls) */}
      {IS_ELECTRON && !isMac && (
        <div
          className="flex items-stretch h-full"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <TitleBarButton onClick={() => window.api.window.minimize()} title="Thu nhỏ">
            <Minus className="h-3.5 w-3.5" strokeWidth={2} />
          </TitleBarButton>
          <TitleBarButton onClick={() => window.api.window.maximizeToggle()} title={isMaximized ? 'Khôi phục' : 'Phóng to'}>
            {isMaximized ? (
              <RestoreIcon className="h-3 w-3" strokeWidth={2} />
            ) : (
              <Square className="h-3 w-3" strokeWidth={2} />
            )}
          </TitleBarButton>
          <TitleBarButton onClick={() => window.api.window.close()} title="Đóng" variant="close">
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </TitleBarButton>
        </div>
      )}
    </div>
  )
}

interface TitleBarButtonProps {
  onClick: () => void
  title: string
  variant?: 'default' | 'close'
  children: React.ReactNode
}

function TitleBarButton({ onClick, title, variant = 'default', children }: TitleBarButtonProps): React.ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex items-center justify-center w-12 h-full text-foreground/70 transition-colors',
        'hover:text-foreground',
        variant === 'close'
          ? 'hover:bg-red-500 hover:text-white'
          : 'hover:bg-foreground/10'
      )}
    >
      {children}
    </button>
  )
}
