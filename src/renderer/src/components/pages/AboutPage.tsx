import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2, Cloud, Download, ExternalLink, Github, KeyRound, Loader2, RefreshCw, Route, Server, ShieldCheck, TerminalSquare, Users } from 'lucide-react'
import { Badge, Button } from '../ui'
import krouterMark from '@/assets/krouter-mark.svg'
import { APP_GITHUB_URL, APP_NAME, APP_OWNER, APP_TAGLINE, APP_TAGLINE_VI } from '@/brand'
import { useTranslation } from '@/hooks/useTranslation'

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion?: string
  latestVersion?: string
  releaseNotes?: string
  releaseName?: string
  releaseUrl?: string
  publishedAt?: string
  error?: string
}

export function AboutPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [version, setVersion] = useState('...')
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<UpdateInfo | null>(null)

  useEffect(() => { window.api.getAppVersion().then(setVersion).catch(() => setVersion('unknown')) }, [])

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    try { setUpdate(await window.api.checkForUpdatesManual()) }
    catch (cause) { setUpdate({ hasUpdate: false, error: cause instanceof Error ? cause.message : 'Update check failed' }) }
    finally { setChecking(false) }
  }

  const open = (url?: string): void => { if (url) void window.api.openExternal(url) }

  return (
    <div className="about-manifest flex-1 overflow-auto p-4 md:p-6">
      <header className="about-head">
        <div className="about-brand-block"><img src={krouterMark} alt={APP_NAME} /><div><span>AI ROUTING CONTROL PLANE</span><h1>{APP_NAME}</h1><p>{isEn ? APP_TAGLINE : APP_TAGLINE_VI}</p></div></div>
        <div className="about-release"><img src={krouterMark} alt="" /><div><small>{isEn ? 'INSTALLED BUILD' : 'BAN DANG CAI'}</small><strong>v{version}</strong><span>{APP_OWNER}</span></div><Badge variant="success">STABLE</Badge></div>
      </header>

      <section className="about-actions"><div><ShieldCheck /><span>{isEn ? 'Local-first runtime' : 'Runtime local-first'}</span></div><div><Route /><span>{isEn ? 'One endpoint, three sources' : 'Mot endpoint, ba nguon'}</span></div><div><KeyRound /><span>{isEn ? 'Client key isolation' : 'Tach biet client key'}</span></div><Button variant="outline" onClick={() => void checkUpdates()} disabled={checking}>{checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}{isEn ? 'Check updates' : 'Kiem tra update'}</Button><Button onClick={() => open(APP_GITHUB_URL)}><Github />GitHub<ExternalLink /></Button></section>

      <div className="about-grid">
        <section className="about-routing-map">
          <div className="about-section-title"><span>SYSTEM ARCHITECTURE</span><h2>{isEn ? 'How a request moves' : 'Duong di cua request'}</h2></div>
          <div className="about-route-line">
            <RouteNode icon={TerminalSquare} label={isEn ? 'AI clients' : 'AI client'} detail="OpenAI / Anthropic" />
            <i />
            <RouteNode icon={Server} label="Krouter API" detail="localhost:5580" active />
            <i />
            <div className="about-provider-stack"><RouteNode icon={Users} label="Kiro" detail={isEn ? 'account pool' : 'pool tai khoan'} /><RouteNode icon={Cloud} label="Bedrock" detail="AWS identity" /><RouteNode icon={KeyRound} label="Custom API" detail="provider prefix" /></div>
          </div>
          <div className="about-contract"><div><small>BASE URL</small><code>http://localhost:5580/v1</code></div><div><small>AUTH</small><code>Authorization: Bearer sk-...</code></div><div><small>HEALTH</small><code>GET /health</code></div></div>
        </section>

        <aside className="about-runtime-card">
          <div className="about-section-title"><span>OPERATOR NOTES</span><h2>{isEn ? 'Runtime contract' : 'Hop dong runtime'}</h2></div>
          <p>{isEn ? 'The dashboard is the control surface. The backend owns proxy lifecycle, token refresh, account rotation, tunnel state and durable configuration.' : 'Dashboard la be mat dieu khien. Backend quan ly proxy, refresh token, xoay tai khoan, tunnel va cau hinh ben vung.'}</p>
          <div className="about-command-list">{['krouter setup', 'krouter status', 'krouter tunnel start', 'krouter openclaw import'].map((command) => <code key={command}><span>$</span>{command}</code>)}</div>
        </aside>
      </div>

      <section className="about-principles">
        <ManifestItem number="01" title={isEn ? 'Observable by default' : 'Quan sat mac dinh'} body={isEn ? 'Health, quota, latency and route errors remain visible at the operating surface.' : 'Health, quota, latency va route error luon hien tren man hinh van hanh.'} />
        <ManifestItem number="02" title={isEn ? 'Provider neutral' : 'Khong le thuoc provider'} body={isEn ? 'Kiro, Bedrock and compatible APIs participate in one model catalog.' : 'Kiro, Bedrock va compatible API cung tham gia mot model catalog.'} />
        <ManifestItem number="03" title={isEn ? 'Local before public' : 'Local truoc public'} body={isEn ? 'The service stays on loopback unless an operator explicitly enables LAN or tunnel access.' : 'Service giu tren loopback den khi operator chu dong bat LAN hoac tunnel.'} />
      </section>

      {update && <div className="about-update-overlay" onClick={() => setUpdate(null)}><div className="about-update-dialog" onClick={(event) => event.stopPropagation()}>{update.error ? <><AlertCircle className="error" /><h2>{isEn ? 'Update check failed' : 'Kiem tra update that bai'}</h2><p>{update.error}</p><Button variant="outline" onClick={() => void checkUpdates()}>Retry</Button></> : update.hasUpdate ? <><Download /><h2>{update.releaseName || (isEn ? 'New version available' : 'Co phien ban moi')}</h2><p>{update.currentVersion} -&gt; {update.latestVersion}</p>{update.releaseNotes && <pre>{update.releaseNotes}</pre>}<Button onClick={() => open(update.releaseUrl)}><ExternalLink />{isEn ? 'Open release' : 'Mo release'}</Button></> : <><CheckCircle2 className="ok" /><h2>{isEn ? 'Krouter is up to date' : 'Krouter da la ban moi nhat'}</h2><p>v{update.currentVersion || version}</p><Button variant="outline" onClick={() => setUpdate(null)}>Close</Button></>}</div></div>}
    </div>
  )
}

function RouteNode({ icon: Icon, label, detail, active = false }: { icon: React.ElementType; label: string; detail: string; active?: boolean }): React.ReactNode {
  return <div className={active ? 'about-route-node active' : 'about-route-node'}><Icon /><div><strong>{label}</strong><span>{detail}</span></div></div>
}

function ManifestItem({ number, title, body }: { number: string; title: string; body: string }): React.ReactNode {
  return <article><span>{number}</span><h2>{title}</h2><p>{body}</p></article>
}
