import { useEffect, useState } from 'react'
import {
  Activity, BarChart3, Bell, BookOpen, ChevronLeft, CreditCard, Fingerprint, Home, Info,
  Network, ScrollText, Server, Settings, Shield, Sparkles, Stethoscope, UserPlus,
  Users, Wand2, Zap
} from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import krouterMark from '@/assets/krouter-mark.svg'
import { APP_NAME } from '@/brand'
import { useTranslation } from '@/hooks/useTranslation'

export type PageType = 'home' | 'accounts' | 'machineId' | 'kiroSettings' | 'proxy' | 'usage' | 'kproxy' | 'mitm' | 'proxyPool' | 'register' | 'subscription' | 'webhooks' | 'diagnose' | 'configSync' | 'skills' | 'logs' | 'docs' | 'settings' | 'about'

interface SidebarProps {
  currentPage: PageType
  onPageChange: (page: PageType) => void
  collapsed: boolean
  onToggleCollapse: () => void
  variant?: 'static' | 'drawer'
  onNavigate?: () => void
}

interface NavItem {
  id: PageType
  labelKey: string
  icon: React.ElementType
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: 'Overview',
    items: [
      { id: 'home', labelKey: 'nav.home', icon: Home },
      { id: 'accounts', labelKey: 'nav.accounts', icon: Users },
      { id: 'subscription', labelKey: 'nav.subscription', icon: CreditCard }
    ]
  },
  {
    label: 'Routing',
    items: [
      { id: 'proxy', labelKey: 'nav.proxy', icon: Server },
      { id: 'usage', labelKey: 'nav.usage', icon: BarChart3 },
      { id: 'kproxy', labelKey: 'nav.kproxy', icon: Shield },
      { id: 'mitm', labelKey: 'nav.mitm', icon: Zap },
      { id: 'proxyPool', labelKey: 'nav.proxyPool', icon: Network }
    ]
  },
  {
    label: 'Automation',
    items: [
      { id: 'register', labelKey: 'nav.register', icon: UserPlus },
      { id: 'kiroSettings', labelKey: 'nav.kiroSettings', icon: Sparkles },
      { id: 'skills', labelKey: 'nav.skills', icon: Wand2 },
      { id: 'webhooks', labelKey: 'nav.webhooks', icon: Bell }
    ]
  },
  {
    label: 'System',
    items: [
      { id: 'machineId', labelKey: 'nav.machineId', icon: Fingerprint },
      { id: 'diagnose', labelKey: 'nav.diagnose', icon: Stethoscope },
      { id: 'logs', labelKey: 'nav.logs', icon: ScrollText },
      { id: 'docs', labelKey: 'nav.docs', icon: BookOpen },
      { id: 'settings', labelKey: 'nav.settings', icon: Settings },
      { id: 'about', labelKey: 'nav.about', icon: Info }
    ]
  }
]

export function Sidebar({ currentPage, onPageChange, collapsed, onToggleCollapse, variant = 'static', onNavigate }: SidebarProps): React.ReactNode {
  const { t } = useTranslation()
  const isDrawer = variant === 'drawer'
  const [isNarrow, setIsNarrow] = useState(false)

  useEffect(() => {
    if (isDrawer) return
    const query = window.matchMedia('(max-width: 900px)')
    const update = (): void => setIsNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [isDrawer])

  const compact = !isDrawer && (collapsed || isNarrow)
  const selectPage = (page: PageType): void => {
    onPageChange(page)
    onNavigate?.()
  }

  return (
    <motion.aside
      initial={false}
      animate={{ width: isDrawer ? 280 : compact ? 76 : 248 }}
      transition={{ type: 'spring', stiffness: 360, damping: 34 }}
      className={cn('control-sidebar flex h-full min-h-0 shrink-0 flex-col', isDrawer && 'rounded-none border-y-0 border-l-0')}
    >
      <div className={cn('flex h-[76px] shrink-0 items-center border-b border-border/70', compact ? 'justify-center px-3' : 'px-5')}>
        <div className="brand-lockup">
          <div className="brand-mark"><img src={krouterMark} alt="" className="h-8 w-8" /></div>
          {!compact && (
            <div className="min-w-0">
              <div className="text-[15px] font-extrabold tracking-[-0.02em] text-foreground">{APP_NAME}</div>
              <div className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.22em] text-muted-foreground">Control plane</div>
            </div>
          )}
        </div>
      </div>

      <nav className={cn('min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-3', compact ? 'px-2.5' : 'px-3')}>
        {NAV_GROUPS.map((group, groupIndex) => (
          <div key={group.label} className={cn(groupIndex > 0 && 'mt-4')}>
            {!compact && <div className="nav-section-label">{group.label}</div>}
            {compact && groupIndex > 0 && <div className="mx-2 mb-2 border-t border-border/70" />}
            <div className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon
                const active = currentPage === item.id
                const label = t(item.labelKey)
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => selectPage(item.id)}
                    title={label}
                    aria-current={active ? 'page' : undefined}
                    className={cn('control-nav-item', compact ? 'justify-center px-0' : 'px-3', active && 'is-active')}
                  >
                    {active && <motion.span layoutId="active-nav-rail" className="active-nav-rail" transition={{ type: 'spring', stiffness: 420, damping: 36 }} />}
                    <Icon className="relative z-10 h-[18px] w-[18px] shrink-0" strokeWidth={active ? 2.4 : 1.9} />
                    {!compact && <span className="relative z-10 min-w-0 truncate">{label}</span>}
                    {!compact && active && <Activity className="relative z-10 ml-auto h-3.5 w-3.5 opacity-60" />}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </nav>

      {!isDrawer && !isNarrow && (
        <div className="border-t border-border/70 p-3">
          <button type="button" onClick={onToggleCollapse} className={cn('control-nav-item text-muted-foreground', compact ? 'justify-center px-0' : 'px-3')}>
            <motion.span animate={{ rotate: compact ? 180 : 0 }} transition={{ duration: 0.2 }}><ChevronLeft className="h-[18px] w-[18px]" /></motion.span>
            {!compact && <span>Collapse rail</span>}
          </button>
        </div>
      )}
    </motion.aside>
  )
}
