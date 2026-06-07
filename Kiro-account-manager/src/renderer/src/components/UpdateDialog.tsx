import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle, Clock, ExternalLink, RefreshCw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface UpdateCheckResult {
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  releaseName?: string
  releaseNotes?: string
  releaseUrl?: string
  publishedAt?: string
  source?: string
  packageName?: string
  error?: string
}

interface ApplyUpdateResult extends UpdateCheckResult {
  success: boolean
  updated?: boolean
  inProgress?: boolean
  restartScheduled?: boolean
  output?: string
}

type UpdateStatus = 'checking' | 'available' | 'updating' | 'updated' | 'error'

const SNOOZE_KEY = 'krouter.update.snoozeUntil'
const DISMISSED_VERSION_KEY = 'krouter.update.dismissedVersion'

function stripNotes(notes?: string): string {
  return String(notes || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_#>~-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatDate(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}

export function UpdateDialog(): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<UpdateStatus>('checking')
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      const snoozeUntil = Number(localStorage.getItem(SNOOZE_KEY) || '0')
      if (snoozeUntil > Date.now()) return
      try {
        setStatus('checking')
        const result = await window.api.checkForUpdatesManual()
        if (cancelled) return
        const latestVersion = result.latestVersion || ''
        const dismissedVersion = localStorage.getItem(DISMISSED_VERSION_KEY)
        if (result.hasUpdate && latestVersion && dismissedVersion !== latestVersion) {
          setUpdateInfo(result)
          setStatus('available')
          setOpen(true)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setStatus('error')
        }
      }
    }, 1200)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const notes = useMemo(() => stripNotes(updateInfo?.releaseNotes), [updateInfo?.releaseNotes])
  const publishedAt = useMemo(() => formatDate(updateInfo?.publishedAt), [updateInfo?.publishedAt])

  const closeForSession = (): void => {
    if (status !== 'updating') setOpen(false)
  }

  const dismissVersion = (): void => {
    if (updateInfo?.latestVersion) {
      localStorage.setItem(DISMISSED_VERSION_KEY, updateInfo.latestVersion)
    }
    setOpen(false)
  }

  const snoozeOneDay = (): void => {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + 24 * 60 * 60 * 1000))
    setOpen(false)
  }

  const applyUpdate = async (): Promise<void> => {
    setStatus('updating')
    setError(null)
    try {
      const result = await window.api.applyKrouterUpdate() as ApplyUpdateResult
      if (!result.success) {
        setError(result.error || 'Update failed.')
        setStatus('error')
        return
      }
      setUpdateInfo((current) => ({ ...current, ...result }))
      if (result.latestVersion) localStorage.setItem(DISMISSED_VERSION_KEY, result.latestVersion)
      setStatus('updated')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  const openRelease = (): void => {
    if (updateInfo?.releaseUrl) window.api.openExternal(updateInfo.releaseUrl)
  }

  if (!open || !updateInfo) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button className="absolute inset-0 bg-black/45" onClick={closeForSession} aria-label="Close update dialog" />
      <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b bg-primary/5 p-5">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg',
              status === 'error' ? 'bg-destructive/15 text-destructive' : 'bg-primary/15 text-primary'
            )}>
              {status === 'error' ? <AlertCircle className="h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold">
                {status === 'updated' ? 'Krouter da duoc cap nhat' : 'Co ban Krouter moi'}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                v{updateInfo.currentVersion || 'unknown'} {'->'} v{updateInfo.latestVersion || 'latest'}
              </p>
            </div>
          </div>
          {status !== 'updating' && (
            <Button variant="ghost" size="icon" onClick={closeForSession} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Nguon cap nhat</div>
              <div className="mt-1 font-medium">{updateInfo.source || 'npm'}</div>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="text-xs text-muted-foreground">Package</div>
              <div className="mt-1 truncate font-medium">{updateInfo.packageName || '@lightharu/krouter'}</div>
            </div>
          </div>

          {updateInfo.releaseName && (
            <div>
              <div className="text-xs font-medium uppercase text-muted-foreground">Phien ban</div>
              <div className="mt-1 text-sm font-medium">{updateInfo.releaseName}</div>
            </div>
          )}

          {publishedAt && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>{publishedAt}</span>
            </div>
          )}

          {notes && (
            <div className="max-h-28 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
              {notes}
            </div>
          )}

          {status === 'updating' && (
            <div className="flex items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm text-primary">
              <RefreshCw className="h-4 w-4 animate-spin" />
              <span>Dang cap nhat Krouter, vui long doi...</span>
            </div>
          )}

          {status === 'updated' && (
            <div className="flex items-start gap-2 rounded-lg border border-green-500/25 bg-green-500/10 p-3 text-sm text-green-700 dark:text-green-300">
              <CheckCircle className="mt-0.5 h-4 w-4" />
              <span>
                {Boolean((updateInfo as ApplyUpdateResult).restartScheduled)
                  ? 'Da cai ban moi. Backend se tu khoi dong lai sau vai giay.'
                  : 'Da cai ban moi. Neu trang chua doi version, hay restart backend/CLI de nap code moi.'}
              </span>
            </div>
          )}

          {status === 'error' && (
            <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
              {error || updateInfo.error || 'Update failed.'}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              {updateInfo.releaseUrl && (
                <Button variant="outline" onClick={openRelease}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Chi tiet
                </Button>
              )}
              {status === 'available' && (
                <Button variant="outline" onClick={snoozeOneDay}>
                  Tat 1 ngay
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {status === 'available' && (
                <Button variant="ghost" onClick={dismissVersion}>
                  Tat
                </Button>
              )}
              {status === 'available' || status === 'error' ? (
                <Button onClick={applyUpdate}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Cap nhat
                </Button>
              ) : (
                <Button onClick={closeForSession}>Dong</Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
