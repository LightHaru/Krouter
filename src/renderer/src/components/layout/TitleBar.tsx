import { useEffect, useState } from 'react'
import { Menu } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'
import { TaskCenterButton } from './TaskCenter'
import krouterMark from '@/assets/krouter-mark.svg'
import { APP_NAME } from '@/brand'

interface TitleBarProps {
  /** Hiện nút hamburger (mobile) mở sidebar drawer. */
  showMenuButton?: boolean
  onMenuClick?: () => void
}

/** Web dashboard top bar (no desktop window controls). */
export function TitleBar({ showMenuButton = false, onMenuClick }: TitleBarProps = {}): React.ReactNode {
  useTranslation()
  const [appVersion, setAppVersion] = useState('')

  useEffect(() => {
    window.api.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

  return (
    <div
      className={cn(
        'flex items-center h-8 w-full select-none flex-shrink-0',
        'bg-[var(--titlebar-bg)] text-foreground/80',
        'border-b border-foreground/5'
      )}
      style={{ paddingLeft: 12, paddingRight: 12 }}
    >
      {showMenuButton && (
        <div className="flex items-center pr-1">
          <button
            type="button"
            onClick={onMenuClick}
            title="Menu"
            aria-label="Open navigation"
            className="flex h-6 w-6 items-center justify-center rounded-md text-foreground/70 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <Menu className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      )}

      <div className="flex flex-1 items-center gap-2 text-xs">
        <img
          src={krouterMark}
          alt=""
          className="h-4 w-4 opacity-90"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = 'none'
          }}
        />
        <span className="font-medium tracking-wide text-foreground/70">
          {APP_NAME}
          {appVersion && ` v${appVersion}`}
        </span>
      </div>

      <div className="flex items-center gap-1 px-2">
        <TaskCenterButton />
      </div>
    </div>
  )
}
