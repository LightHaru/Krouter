import { useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle,
  Code,
  Download,
  ExternalLink,
  Github,
  KeyRound,
  MonitorUp,
  Network,
  RefreshCw,
  Route,
  ServerCog,
  Shield,
  Sparkles,
  TerminalSquare,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, Button } from '../ui'
import krouterLogo from '@/assets/krouter-logo.svg'
import krouterMark from '@/assets/krouter-mark.svg'
import { APP_GITHUB_URL, APP_NAME, APP_OWNER, APP_TAGLINE, APP_TAGLINE_VI } from '@/brand'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/hooks/useTranslation'

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  releaseNotes?: string
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  assets?: Array<{
    name: string
    downloadUrl: string
    size: number
  }>
  error?: string
}

interface FeatureItem {
  icon: LucideIcon
  title: string
  body: string
}

interface FlowItem {
  icon: LucideIcon
  label: string
  detail: string
}

export function AboutPage() {
  const [version, setVersion] = useState('...')
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  useEffect(() => {
    window.api.getAppVersion().then(setVersion).catch(() => setVersion('unknown'))
  }, [])

  const checkForUpdates = async () => {
    setIsCheckingUpdate(true)
    try {
      const result = await window.api.checkForUpdatesManual()
      setUpdateInfo(result)
      setShowUpdateModal(true)
    } catch (error) {
      setUpdateInfo({
        hasUpdate: false,
        error: error instanceof Error ? error.message : 'Check update failed'
      })
      setShowUpdateModal(true)
    } finally {
      setIsCheckingUpdate(false)
    }
  }

  const openExternal = (url: string | undefined) => {
    if (!url) return
    window.api.openExternal(url)
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const features: FeatureItem[] = [
    {
      icon: Route,
      title: isEn ? 'Account router' : 'Router tai khoan',
      body: isEn
        ? 'Rotates requests across healthy Kiro accounts by model, quota, and runtime state.'
        : 'Xoay request qua cac tai khoan Kiro con khoe theo model, quota va trang thai runtime.'
    },
    {
      icon: KeyRound,
      title: isEn ? 'Client API keys' : 'Key cho client',
      body: isEn
        ? 'Creates OpenAI-compatible keys for OpenClaw, Aira, Codex, and other dev tools.'
        : 'Tao key tuong thich OpenAI cho OpenClaw, Aira, Codex va cac cong cu dev.'
    },
    {
      icon: ServerCog,
      title: isEn ? 'Backend runtime' : 'Backend runtime',
      body: isEn
        ? 'Keeps the proxy service alive from the backend/CLI instead of relying on a browser tab.'
        : 'Giu API proxy chay bang backend/CLI thay vi phu thuoc vao tab trinh duyet.'
    },
    {
      icon: Network,
      title: isEn ? 'Localhost or tunnel' : 'Localhost hoac tunnel',
      body: isEn
        ? 'Runs local-first and exposes the dashboard publicly only when a tunnel is enabled.'
        : 'Uu tien localhost va chi public dashboard khi bat tunnel.'
    }
  ]

  const flows: FlowItem[] = [
    {
      icon: Bot,
      label: isEn ? 'OpenClaw / Aira' : 'OpenClaw / Aira',
      detail: isEn ? 'One client endpoint' : 'Mot endpoint client'
    },
    {
      icon: Zap,
      label: APP_NAME,
      detail: isEn ? 'Key, model, quota router' : 'Key, model, quota router'
    },
    {
      icon: Shield,
      label: isEn ? 'Kiro accounts' : 'Tai khoan Kiro',
      detail: isEn ? 'Health, quota, profile ARN' : 'Health, quota, profile ARN'
    }
  ]

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4 md:p-6 md:space-y-6">
      <div className="page-hero overflow-hidden p-5 md:p-8">
        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)] lg:items-center">
          <div className="min-w-0 space-y-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <img src={krouterLogo} alt={APP_NAME} className="h-16 w-auto max-w-full shrink-0 md:h-20" />
              <div className="min-w-0">
                <h1 className="text-2xl font-bold text-primary md:text-3xl">{APP_NAME}</h1>
                <p className="mt-1 max-w-2xl text-sm text-muted-foreground md:text-base">
                  {isEn ? APP_TAGLINE : APP_TAGLINE_VI}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {isEn ? 'Version' : 'Phien ban'} {version} · {APP_OWNER}
                </p>
              </div>
            </div>

            <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
              <div className="rounded-xl border border-primary/10 bg-white/45 p-3 dark:bg-white/5">
                <p className="font-semibold text-foreground">{isEn ? 'Web dashboard' : 'Dashboard web'}</p>
                <p className="mt-1 text-xs">{isEn ? 'Account control surface' : 'Noi quan ly tai khoan'}</p>
              </div>
              <div className="rounded-xl border border-primary/10 bg-white/45 p-3 dark:bg-white/5">
                <p className="font-semibold text-foreground">{isEn ? 'CLI runtime' : 'CLI runtime'}</p>
                <p className="mt-1 text-xs">{isEn ? 'Setup and tunnel control' : 'Setup va tunnel'}</p>
              </div>
              <div className="rounded-xl border border-primary/10 bg-white/45 p-3 dark:bg-white/5">
                <p className="font-semibold text-foreground">OpenClaw</p>
                <p className="mt-1 text-xs">provider: krouter</p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={checkForUpdates}
                disabled={isCheckingUpdate}
              >
                <RefreshCw className={cn('h-4 w-4', isCheckingUpdate && 'animate-spin')} />
                {isCheckingUpdate ? (isEn ? 'Checking...' : 'Dang kiem tra...') : (isEn ? 'Check updates' : 'Kiem tra cap nhat')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => openExternal(APP_GITHUB_URL)}
              >
                <Github className="h-4 w-4" />
                GitHub
                <ExternalLink className="h-3 w-3" />
              </Button>
            </div>
          </div>

          <div className="relative min-h-[260px] rounded-2xl border border-primary/10 bg-white/55 p-5 shadow-inner dark:bg-white/5">
            <div className="absolute right-5 top-5 rounded-full bg-primary/10 p-3">
              <img src={krouterMark} alt={APP_NAME} className="h-12 w-12" />
            </div>
            <div className="flex h-full flex-col justify-end gap-4 pt-20">
              {flows.map((flow, index) => {
                const Icon = flow.icon
                return (
                  <div key={flow.label} className="flex items-center gap-3">
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1 rounded-xl border border-primary/10 bg-background/70 px-3 py-2">
                      <p className="truncate text-sm font-semibold">{flow.label}</p>
                      <p className="truncate text-xs text-muted-foreground">{flow.detail}</p>
                    </div>
                    {index < flows.length - 1 && <ArrowRight className="hidden h-4 w-4 text-primary md:block" />}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {showUpdateModal && updateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowUpdateModal(false)} />
          <div className="relative z-10 max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl bg-card p-6 shadow-xl">
            {updateInfo.hasUpdate ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-success/10 p-2">
                    <Download className="h-6 w-6 text-success" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">{isEn ? 'New version available' : 'Co ban moi'}</h3>
                    <p className="text-sm text-muted-foreground">
                      {updateInfo.currentVersion} -&gt; {updateInfo.latestVersion}
                    </p>
                  </div>
                </div>

                {updateInfo.releaseName && (
                  <div className="rounded-lg bg-muted/50 p-3">
                    <p className="text-sm font-medium">{updateInfo.releaseName}</p>
                    {updateInfo.publishedAt && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(updateInfo.publishedAt).toLocaleDateString(isEn ? 'en-US' : 'vi-VN')}
                      </p>
                    )}
                  </div>
                )}

                {updateInfo.releaseNotes && (
                  <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted/30 p-3 text-sm text-muted-foreground">
                    {updateInfo.releaseNotes}
                  </div>
                )}

                {updateInfo.assets && updateInfo.assets.length > 0 && (
                  <div className="space-y-1">
                    {updateInfo.assets.slice(0, 6).map((asset) => (
                      <div key={asset.downloadUrl} className="flex items-center justify-between rounded bg-muted/30 px-2 py-1 text-xs">
                        <span className="truncate">{asset.name}</span>
                        <span className="ml-2 text-muted-foreground">{formatFileSize(asset.size)}</span>
                      </div>
                    ))}
                  </div>
                )}

                <Button className="w-full gap-2" onClick={() => openExternal(updateInfo.releaseUrl)}>
                  <ExternalLink className="h-4 w-4" />
                  {isEn ? 'Open release page' : 'Mo trang phat hanh'}
                </Button>
              </div>
            ) : updateInfo.error ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-red-500/10 p-2">
                    <AlertCircle className="h-6 w-6 text-red-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">{isEn ? 'Check failed' : 'Kiem tra loi'}</h3>
                    <p className="text-sm text-muted-foreground">{updateInfo.error}</p>
                  </div>
                </div>
                <Button variant="outline" className="w-full" onClick={checkForUpdates}>
                  {isEn ? 'Retry' : 'Thu lai'}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-success/10 p-2">
                    <CheckCircle className="h-6 w-6 text-success" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">{isEn ? 'Up to date' : 'Dang la ban moi nhat'}</h3>
                    <p className="text-sm text-muted-foreground">
                      {isEn ? `Version ${updateInfo.currentVersion}` : `Phien ban ${updateInfo.currentVersion}`}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {features.map((feature) => {
          const Icon = feature.icon
          return (
            <Card key={feature.title} className="hover-lift">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-primary/10 p-2">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{feature.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.body}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.05fr_0.95fr]">
        <Card className="hover-lift">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-3 text-base">
              <div className="rounded-lg bg-primary/10 p-2">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              {isEn ? 'What Krouter is for' : 'Krouter dung de lam gi'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">
            <p>
              {isEn
                ? 'Krouter is the control plane for a Kiro-based AI coding setup: it keeps account state visible, exposes one compatible API endpoint, and routes each request to a usable account.'
                : 'Krouter la control plane cho workflow AI coding dung Kiro: hien thi trang thai tai khoan, mo mot API endpoint tuong thich va dieu huong moi request den tai khoan dang dung duoc.'}
            </p>
            <p>
              {isEn
                ? 'The web dashboard handles operations. The backend service and CLI keep proxy, tunnel, API keys, and client imports running outside the browser.'
                : 'Dashboard web xu ly thao tac quan ly. Backend service va CLI giu API proxy, tunnel, API key va import client chay doc lap voi trinh duyet.'}
            </p>
          </CardContent>
        </Card>

        <Card className="hover-lift">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-3 text-base">
              <div className="rounded-lg bg-primary/10 p-2">
                <TerminalSquare className="h-4 w-4 text-primary" />
              </div>
              {isEn ? 'Runtime commands' : 'Lenh runtime'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-2 text-xs">
              {['krouter setup', 'krouter status', 'krouter tunnel start', 'krouter openclaw import'].map((command) => (
                <div key={command} className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 font-mono">
                  <Code className="h-3.5 w-3.5 text-primary" />
                  <span>{command}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="rounded-lg bg-primary/10 p-2">
              <MonitorUp className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Client integration' : 'Ket noi client'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 text-sm md:grid-cols-3">
            <div className="rounded-xl bg-muted/30 p-3">
              <p className="font-semibold">Endpoint</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">http://localhost:5580/v1</p>
            </div>
            <div className="rounded-xl bg-muted/30 p-3">
              <p className="font-semibold">API key</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">sk-...</p>
            </div>
            <div className="rounded-xl bg-muted/30 p-3">
              <p className="font-semibold">OpenClaw</p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">provider: krouter</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="rounded-lg bg-primary/10 p-2">
              <Github className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Project' : 'Du an'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">{APP_OWNER}</p>
              <p className="break-all text-sm text-muted-foreground">{APP_GITHUB_URL}</p>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => openExternal(APP_GITHUB_URL)}>
              <Github className="h-4 w-4" />
              GitHub
              <ExternalLink className="h-3 w-3" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
