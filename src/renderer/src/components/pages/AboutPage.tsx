import { useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  Code,
  Download,
  ExternalLink,
  Github,
  Info,
  KeyRound,
  Network,
  RefreshCw,
  Route,
  Shield,
  Zap,
  type LucideIcon
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, Button } from '../ui'
import krouterLogo from '@/assets/krouter-logo.svg'
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
      title: isEn ? 'Account Router' : 'Xoay tua tài khoản',
      body: isEn
        ? 'Routes requests across the available Kiro accounts by model and account health.'
        : 'Phân phối request theo model, trạng thái tài khoản và quota khả dụng.'
    },
    {
      icon: KeyRound,
      title: isEn ? 'Client Keys' : 'Key cho client',
      body: isEn
        ? 'Creates compatible API keys for OpenClaw and OpenAI-style clients.'
        : 'Tạo key tương thích cho OpenClaw và các client dùng chuẩn OpenAI.'
    },
    {
      icon: Network,
      title: isEn ? 'Tunnel Dashboard' : 'Dashboard qua tunnel',
      body: isEn
        ? 'Keeps the web dashboard local-first while exposing a tunnel only when needed.'
        : 'Ưu tiên chạy localhost, bật tunnel public khi cần truy cập từ xa.'
    },
    {
      icon: Shield,
      title: isEn ? 'Operational Guardrails' : 'Giám sát vận hành',
      body: isEn
        ? 'Tracks liveness, quota, request logs, rate limits, and suspended accounts.'
        : 'Theo dõi liveness, quota, log request, rate limit và tài khoản bị khóa.'
    }
  ]

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      <div className="page-hero p-8">
        <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-4">
            <img src={krouterLogo} alt={APP_NAME} className="h-20 w-auto shrink-0" />
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-primary">{APP_NAME}</h1>
              <p className="text-sm text-muted-foreground">{isEn ? APP_TAGLINE : APP_TAGLINE_VI}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {isEn ? 'Version' : 'Phiên bản'} {version} · {APP_OWNER}
              </p>
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
              {isCheckingUpdate ? (isEn ? 'Checking...' : 'Đang kiểm tra...') : (isEn ? 'Check Updates' : 'Kiểm tra cập nhật')}
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
      </div>

      {showUpdateModal && updateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => setShowUpdateModal(false)} />
          <div className="relative z-10 max-h-[80vh] w-full max-w-md overflow-y-auto rounded-xl bg-card p-6 shadow-xl">
            {updateInfo.hasUpdate ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-success/10 p-2">
                    <Download className="h-6 w-6 text-success" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">{isEn ? 'New Version Available' : 'Có bản mới'}</h3>
                    <p className="text-sm text-muted-foreground">
                      {updateInfo.currentVersion} → {updateInfo.latestVersion}
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
                  {isEn ? 'Open Release Page' : 'Mở trang phát hành'}
                </Button>
              </div>
            ) : updateInfo.error ? (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-red-500/10 p-2">
                    <AlertCircle className="h-6 w-6 text-red-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">{isEn ? 'Check Failed' : 'Kiểm tra lỗi'}</h3>
                    <p className="text-sm text-muted-foreground">{updateInfo.error}</p>
                  </div>
                </div>
                <Button variant="outline" className="w-full" onClick={checkForUpdates}>
                  {isEn ? 'Retry' : 'Thử lại'}
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="rounded-full bg-success/10 p-2">
                    <CheckCircle className="h-6 w-6 text-success" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">{isEn ? 'Up to Date' : 'Đang là bản mới nhất'}</h3>
                    <p className="text-sm text-muted-foreground">
                      {isEn ? `Version ${updateInfo.currentVersion}` : `Phiên bản ${updateInfo.currentVersion}`}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="rounded-lg bg-primary/10 p-2">
              <Info className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'About Krouter' : 'Giới thiệu Krouter'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            {isEn
              ? 'Krouter is the web-first control surface for managing Kiro accounts and serving a compatible API proxy for developer tools.'
              : 'Krouter là bảng điều khiển web để quản lý tài khoản Kiro và cung cấp API proxy tương thích cho công cụ developer.'}
          </p>
          <p>
            {isEn
              ? 'The dashboard handles account state, quota checks, client key setup, tunnel links, and operational logs while the backend keeps the proxy runtime local and service-based.'
              : 'Dashboard xử lý trạng thái tài khoản, kiểm tra quota, cấu hình key client, tunnel và log vận hành; backend giữ proxy chạy ở tầng service/CLI.'}
          </p>
        </CardContent>
      </Card>

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
                  <div>
                    <p className="text-sm font-semibold">{feature.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{feature.body}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="rounded-lg bg-primary/10 p-2">
              <Code className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Stack' : 'Công nghệ'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {['React', 'TypeScript', 'Vite', 'Node.js', 'Kiro API Proxy', 'OpenClaw'].map((tech) => (
              <span key={tech} className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
                {tech}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="hover-lift">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-3 text-base">
            <div className="rounded-lg bg-primary/10 p-2">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            {isEn ? 'Maintainer' : 'Người duy trì'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">{APP_OWNER}</p>
              <p className="text-sm text-muted-foreground">{APP_GITHUB_URL}</p>
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
