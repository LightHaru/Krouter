import { useEffect, useState } from 'react'
import { Minus, Square, X, Copy as RestoreIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskCenterButton } from './TaskCenter'
import krouterMark from '@/assets/krouter-mark.svg'
import { APP_NAME } from '@/brand'

/**
 * 跨平台自定义 titlebar
 * - macOS: 居中标题 + 左侧 traffic lights 留位（系统渲染）
 * - Windows/Linux: 左侧应用图标+标题 + 右侧自绘按钮
 *
 * 拖动：整条 titlebar 用 -webkit-app-region: drag
 * 按钮区：使用 no-drag 让点击生效
 */
export function TitleBar(): React.ReactNode {
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

  const isMac = platform === 'darwin'

  return (
    <div
      className={cn(
        'flex items-center h-8 w-full select-none flex-shrink-0',
        'bg-[var(--titlebar-bg)] text-foreground/80',
        'border-b border-foreground/5'
      )}
      style={{
        // 整条 titlebar 可拖动
        WebkitAppRegion: 'drag',
        // mac 留 80px 给 traffic lights
        paddingLeft: isMac ? 80 : 12,
        paddingRight: isMac ? 12 : 0
      } as React.CSSProperties}
    >
      {/* 应用图标 + 标题 */}
      <div
        className={cn(
          'flex items-center gap-2 text-xs',
          isMac ? 'flex-1 justify-center' : 'flex-1'
        )}
      >
        {!isMac && (
          <img src={krouterMark} alt="" className="h-4 w-4 opacity-90" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} />
        )}
        <span className="font-medium tracking-wide text-foreground/70">
          {APP_NAME}{appVersion && ` v${appVersion}`}
        </span>
      </div>

      {/* 任务中心入口（仅当有任务时显示） */}
      <div className="flex items-center gap-1 px-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <TaskCenterButton />
      </div>

      {/* Windows/Linux 按钮组 */}
      {!isMac && (
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
