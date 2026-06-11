import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { UserPlus, Mail, Key, Loader2, CheckCircle2, XCircle, Trash2, Play, Square, Clock, RotateCcw, RefreshCw, Download, Upload, Settings2, Link2, AtSign, Shuffle, Info, Pause, AlertTriangle, ShieldAlert, Gauge, Activity, CalendarClock, Timer, Network, Lock } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { useAccountsStore } from '@/store/accounts'
import { useTaskStore } from '@/store/tasks'
import { createRateLimiter, type RateLimiter, type RateLimiterSnapshot } from '@/store/rateLimiter'
import { useWebhookStore } from '@/store/webhooks'
import type { ProxyEntry, ProxyPoolConfig } from '@/types/proxy'
import type { Account } from '@/types/account'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Progress, Badge, Switch } from '../ui'
import { cn, randomUuid } from '@/lib/utils'
import { appendSubscriptionLink, updateSubscriptionLink } from './SubscriptionPage'
import { generateNextDotVariant, countSameRootVariants, totalVariantCount, splitEmail } from '@/lib/dotVariants'

const BUILDER_ID_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'

// 失败错误码归类：用于失败重试队列的过滤
type ErrCategory =
  | 'risk_control' | 'proxy_chain' | 'strict_proxy' | 'proxy_whitelist'
  | 'eof' | 'otp_timeout' | 'network' | 'email_used'
  | 'rate_limit' | 'auth' | 'suspended' | 'unknown'

interface ErrorDiagnosis {
  category: ErrCategory
  title: string
  reasons: string[]
  suggestions: string[]
}

/**
 * 把失败原因翻译成"普通话"的诊断 + 建议，覆盖批量注册里最常见的几类失败。
 * 优先级：风控 > 代理白名单 > 代理链 > 严格代理 > EOF > OTP超时 > 网络 > 邮箱已用 > 限流 > 鉴权 > suspended > unknown
 */
function diagnoseRegError(err: string | undefined): ErrorDiagnosis {
  const e = (err || '').toLowerCase()
  const isTesBlocked = e.includes('"errorcode":"blocked"')
    || e.includes('request was blocked by tes')
    || (e.includes('blocked') && e.includes('tes'))
  if (!e) {
    return { category: 'unknown', title: 'Lỗi không xác định', reasons: ['Không nhận được thông tin lỗi cụ thể'], suggestions: ['Xem nhật ký đầy đủ'] }
  }
  // AWS 风控
  if (isTesBlocked || e.includes('aws-risk-control') || e.includes('风控') || e.includes('请稍后再试') || e.includes('try again later')) {
    return {
      category: 'risk_control',
      title: 'AWS đã chặn yêu cầu',
      reasons: ['Yêu cầu đăng ký bị chính sách bảo mật AWS chặn', 'Nguyên nhân thường gặp: đăng ký hàng loạt trong thời gian ngắn, nhịp thao tác lặp lại, tên miền email bị liên kết hoặc thông tin tài khoản cần xác minh'],
      suggestions: ['Dừng tác vụ hàng loạt hiện tại và kiểm tra email hạn chế tài khoản', 'Giảm tốc độ xuống 10/phút hoặc thấp hơn và giữ tự động tạm dừng', 'Sử dụng nguồn email ổn định, hợp lệ và tránh đăng ký hàng loạt cùng một tên miền', 'Nếu tài khoản bị hạn chế, liên hệ Support theo hướng dẫn của AWS/Kiro']
    }
  }
  // bestproxy 610 / IP 白名单类
  if (e.includes('610') || e.includes('whitelist') || (e.includes('connect') && e.includes('http 4'))) {
    return {
      category: 'proxy_whitelist',
      title: 'Xác thực proxy hoặc danh sách cho phép thất bại',
      reasons: ['Proxy đích từ chối xác thực do sai thông tin đăng nhập hoặc IP nguồn chưa được cho phép', 'Mã 610 của bestproxy nghĩa là IP nguồn chưa được cấp quyền'],
      suggestions: ['Thêm IP đầu ra hiện tại vào danh sách cho phép của nhà cung cấp proxy', 'Hoặc dùng chế độ kết nối trực tiếp bằng tài khoản và bảo đảm vùng nguồn được cho phép', 'Kiểm tra cấu hình proxy trung chuyển']
    }
  }
  // 代理链失败
  if (e.includes('proxychain') || e.includes('代理链') || e.includes('上游中转')) {
    return {
      category: 'proxy_chain',
      title: 'Không thiết lập được chuỗi proxy',
      reasons: ['Bắt tay kết nối giữa proxy trung chuyển và proxy đích thất bại'],
      suggestions: ['Dùng chức năng Chẩn đoán tại trang Kho proxy để xác định lớp gặp lỗi', 'Xác nhận cổng proxy trung chuyển đang chạy', 'Nếu proxy đích yêu cầu danh sách cho phép, thêm IP đầu ra của proxy trung chuyển']
    }
  }
  // 严格代理（无可用代理时拒绝静默回退）
  if (e.includes('严格代理') || e.includes('strict') && e.includes('proxy')) {
    return {
      category: 'strict_proxy',
      title: 'Chế độ proxy nghiêm ngặt đã chặn yêu cầu',
      reasons: ['Kho proxy đang bật chế độ nghiêm ngặt nhưng không có proxy khả dụng'],
      suggestions: ['Kiểm tra kho proxy và bảo đảm có ít nhất một proxy hoạt động', 'Kiểm tra proxy có bị tự động vô hiệu hóa hay không', 'Có thể tạm bật lại proxy hoặc tắt tự động vô hiệu hóa khi thất bại']
    }
  }
  // EOF / status=0 网络抖动
  if (e.includes('eof') || (e.includes('status=0') && e.includes('failed to do request')) || e.includes('connection reset')) {
    return {
      category: 'eof',
      title: 'Kết nối mạng tạm thời bị ngắt (EOF)',
      reasons: ['Kết nối TLS bị phía bên kia đóng khi bắt tay hoặc truyền dữ liệu', 'Thường xảy ra khi proxy không ổn định, quá nhiều tác vụ đồng thời hoặc mạng trung gian chập chờn'],
      suggestions: ['Giảm số tác vụ đồng thời', 'Đổi proxy hoặc kiểm tra proxy trung chuyển', 'Lỗi đơn lẻ có thể tự thử lại; nếu xảy ra liên tục hãy đổi kết nối đầu ra']
    }
  }
  // OTP 超时
  if ((e.includes('timeout') || e.includes('超时')) && (e.includes('otp') || e.includes('验证码') || e.includes('code'))) {
    return {
      category: 'otp_timeout',
      title: 'Hết thời gian chờ mã xác minh',
      reasons: ['Email tạm chưa nhận được thư xác minh AWS trong thời hạn', 'AWS có thể không gửi, thư có thể vào mục rác hoặc dịch vụ email tạm bị chậm'],
      suggestions: ['Xác nhận dịch vụ email tạm đang hoạt động', 'Tạm dừng đăng ký hàng loạt và đổi sang nguồn email hợp lệ nếu tên miền bị AWS từ chối', 'Nếu lỗi lặp lại, hãy dừng hàng loạt và giảm tốc độ']
    }
  }
  // 一般网络
  if (e.includes('timeout') || e.includes('超时') || e.includes('etimedout') || e.includes('fetch failed') || e.includes('econnreset') || e.includes('econnrefused') || e.includes('enotfound') || e.includes('network')) {
    return {
      category: 'network',
      title: 'Lỗi mạng',
      reasons: ['Kết nối, DNS hoặc yêu cầu đã hết thời gian chờ'],
      suggestions: ['Kiểm tra mạng cục bộ và khả năng kết nối proxy', 'Giảm số tác vụ đồng thời rồi thử lại']
    }
  }
  // 邮箱已被注册
  if (e.includes('已注册') || (e.includes('email') && (e.includes('already') || e.includes('exists') || e.includes('used') || e.includes('已存在') || e.includes('已被')))) {
    return {
      category: 'email_used',
      title: 'Email đã được đăng ký',
      reasons: ['Địa chỉ email này đã tồn tại trên AWS'],
      suggestions: ['Tạo một địa chỉ email mới rồi thử lại', 'Sử dụng nhiều tên miền để giảm trùng lặp']
    }
  }
  // 限流
  if (e.includes('rate') || e.includes('limit') || e.includes('too many') || e.includes('限流') || e.includes('429')) {
    return {
      category: 'rate_limit',
      title: 'Đã chạm giới hạn tốc độ',
      reasons: ['Số yêu cầu trong thời gian ngắn vượt quá mức AWS chấp nhận'],
      suggestions: ['Giảm maxPerMinute và số tác vụ đồng thời', 'Bật tự động tạm dừng khi có cảnh báo rủi ro']
    }
  }
  // suspended
  if (e.includes('suspended')) {
    return {
      category: 'suspended',
      title: 'Tài khoản đã bị vô hiệu hóa',
      reasons: ['Quy trình đăng ký hoàn tất nhưng AWS đánh dấu tài khoản là suspended ở bước cuối', 'Đây thường là kết quả đánh giá bảo mật tổng hợp'],
      suggestions: ['Dừng đăng ký hàng loạt và kiểm tra email hạn chế tài khoản', 'Giảm tốc độ và không tiếp tục thử lại cùng loại lỗi', 'Liên hệ Support theo hướng dẫn của AWS/Kiro để xác minh tài khoản']
    }
  }
  // 鉴权
  if (e.includes('unauthorized') || e.includes('401') || e.includes('403')) {
    return {
      category: 'auth',
      title: 'Xác thực thất bại',
      reasons: ['API phía trên trả về 401/403'],
      suggestions: ['Kiểm tra thông tin đăng nhập và nội dung phản hồi API']
    }
  }
  return { category: 'unknown', title: 'Lỗi khác', reasons: [err || ''], suggestions: ['Xem nhật ký đầy đủ để xác định nguyên nhân'] }
}

/** 旧 API 兼容：现有 retryFailed 等用 classifyError 做筛选 */
function classifyError(err: string | undefined): 'network' | 'otp_timeout' | 'email_used' | 'rate_limit' | 'auth' | 'risk_control' | 'unknown' {
  const cat = diagnoseRegError(err).category
  if (cat === 'risk_control' || cat === 'suspended') return 'risk_control'
  if (cat === 'otp_timeout') return 'otp_timeout'
  if (cat === 'email_used') return 'email_used'
  if (cat === 'rate_limit') return 'rate_limit'
  if (cat === 'auth') return 'auth'
  if (cat === 'eof' || cat === 'network' || cat === 'proxy_chain' || cat === 'proxy_whitelist' || cat === 'strict_proxy') return 'network'
  return 'unknown'
}

interface TerminalBatchError {
  category: 'risk_control' | 'suspended' | 'auth_block'
  label: string
}

function getTerminalBatchError(err: string | undefined): TerminalBatchError | null {
  const raw = err || ''
  const e = raw.toLowerCase()
  if (!e) return null

  const diagnosis = diagnoseRegError(raw)
  if (diagnosis.category === 'risk_control') return { category: 'risk_control', label: 'AWS risk control' }
  if (diagnosis.category === 'suspended') return { category: 'suspended', label: 'account suspended' }

  const suspended =
    e.includes('accountsuspendedexception') ||
    e.includes('temporarily_suspended') ||
    e.includes('temporarily suspended') ||
    e.includes('account suspended') ||
    e.includes('restricted your ability to use kiro') ||
    (e.includes('user id is') && e.includes('suspended')) ||
    /\b423\b/.test(e)
  if (suspended) return { category: 'suspended', label: 'account suspended' }

  const authBlocked =
    diagnosis.category === 'auth' ||
    /\b(401|403)\b/.test(e) ||
    e.includes('unauthorized') ||
    e.includes('forbidden') ||
    e.includes('access denied') ||
    e.includes('redirect_mismatch')
  if (authBlocked) return { category: 'auth_block', label: '401/403 auth block' }

  return null
}

function isProfileArnOnlyLivenessError(err: string | undefined): boolean {
  const e = (err || '').toLowerCase()
  if (!e) return false
  if (!e.includes('profilearn')) return false
  if (getTerminalBatchError(err)) return false
  return e.includes('profilearn is required')
    || e.includes('no usable streaming profilearn')
    || e.includes('placeholder profilearn')
    || e.includes('fixed placeholder profilearn')
}

// 随机 session 值（字母数字），用于代理服务的会话粘性。
function randomSession(len = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

/**
 * 为代理 URL 注入单次注册任务的 session，确保同一任务内网络出口保持一致。
 * 1) url 含 {session} 占位符 → 替换为随机值（通用，适配任意服务商）；
 * 2) 参数化用户名（bestproxy 等，含 _area-/_life-/_city-/_state- 等）且未写 _session- → 自动补一个；
 * 其余情况（普通代理、已写 session）原样返回，不干扰。
 */
function injectProxySession(url: string): string {
  if (!url) return url
  const session = randomSession()
  if (url.includes('{session}')) {
    return url.replace(/\{session\}/g, session)
  }
  const m = url.match(/^(\w+:\/\/)([^@/]+)@(.+)$/)
  if (m) {
    const [, scheme, userinfo, hostpart] = m
    const ci = userinfo.indexOf(':')
    const username = ci >= 0 ? userinfo.slice(0, ci) : userinfo
    const password = ci >= 0 ? userinfo.slice(ci + 1) : ''
    const isParamStyle = /_(area|life|city|state|session|region|country)-/i.test(username)
    if (isParamStyle && !/_session-/i.test(username)) {
      const newUser = `${username}_session-${session}`
      return `${scheme}${newUser}${ci >= 0 ? ':' + password : ''}@${hostpart}`
    }
  }
  return url
}

type RegMode = 'manual' | 'outlook' | 'tempmail' | 'tingamefi' | 'proton' | 'mixed'
type AutoEmailSource = 'outlook' | 'tempmail' | 'tingamefi' | 'proton'
type RegistrationNetworkSource = 'server' | 'client-proxy'
/**
 * Phase 状态机：
 * - idle：未开始
 * - initializing：OIDC 设备授权初始化
 * - email：等待用户输入邮箱
 * - otp：等待用户输入验证码
 * - running：注册流程进行中（Verify/Password/Token 由日志关键字推断）
 * - done：核心注册流程完成（含 Token），未启用任何后处理时即为最终态
 * - importing：正在自动导入账号
 * - fetching-link：正在获取 Pro 订阅链接
 * - finalized：包含所有后处理在内的最终完成
 */
type Phase = 'idle' | 'initializing' | 'email' | 'otp' | 'running' | 'done' | 'importing' | 'fetching-link' | 'finalized'

interface FingerprintSnapshot {
  chromeVer: string
  ua: string
  gpuVendor: string
  gpuModel: string
  canvasHash: number
  screen: { width: number; height: number }
  proxyUrl?: string
  exitIP?: string
}

interface RegResult {
  status: 'success' | 'failed'
  email: string
  password?: string
  error?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  accessToken?: string
  region?: string
  provider?: string
  verify?: Record<string, unknown>
  fingerprint?: FingerprintSnapshot
}

function makeFailedRegResult(error: unknown, email = ''): RegResult {
  return {
    status: 'failed',
    email,
    error: error instanceof Error ? error.message : String(error || 'unknown')
  }
}

type ImportedAccountData = Omit<Account, 'id' | 'createdAt' | 'isActive'>

interface ImportWithLivenessResult {
  ok: boolean
  accountId?: string
  error?: string
}

type BatchItemStatus = 'pending' | 'running' | 'retrying' | 'success' | 'failed' | 'imported' | 'import_failed'

interface HistoryItem {
  id: string
  time: number
  email: string
  status: 'success' | 'failed'
  error?: string
  password?: string
  result?: RegResult
  imported: boolean
  subscriptionUrl?: string
}

type RegStepName =
  | 'init' | 'proxy-chain-ready' | 'tls-ready' | 'exit-ip'
  | 'oidc' | 'device' | 'email-created'
  | 'portal' | 'workflow-init' | 'submit-email'
  | 'signup' | 'send-otp' | 'waiting-otp' | 'otp-received'
  | 'create-identity' | 'set-password' | 'sso-workflow' | 'sso-token'
  | 'verify-alive' | 'done'

/** Nhãn ngắn cho từng bước đăng ký. */
const STEP_LABEL_VI: Record<RegStepName, string> = {
  'init': 'Khởi tạo',
  'proxy-chain-ready': 'Chuỗi proxy sẵn sàng',
  'tls-ready': 'TLS sẵn sàng',
  'exit-ip': 'Kiểm tra IP đầu ra',
  'oidc': 'OIDC',
  'device': 'Cấp quyền thiết bị',
  'email-created': 'Đã tạo email',
  'portal': 'Portal',
  'workflow-init': 'Quy trình',
  'submit-email': 'Gửi email',
  'signup': 'Signup',
  'send-otp': 'Gửi mã xác minh',
  'waiting-otp': 'Chờ mã xác minh',
  'otp-received': 'Đã nhận mã',
  'create-identity': 'Tạo danh tính',
  'set-password': 'Đặt mật khẩu',
  'sso-workflow': 'Quy trình SSO',
  'sso-token': 'Lấy Token',
  'verify-alive': 'Kiểm tra',
  'done': 'Hoàn tất'
}

interface BatchItem {
  id: string
  index: number
  status: BatchItemStatus
  email: string
  error?: string
  retryCount: number
  /** 实时进度：当前 step、起步时间、当前 step 起步时间、出口 IP */
  currentStep?: RegStepName
  startedAt?: number
  stepStartedAt?: number
  exitIp?: string
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, '0')}s`
}

/** 单行批量任务的展示：状态图标 + 邮箱 + 当前步骤 + 总耗时 + 出口 IP / 错误 + 失败诊断展开。
 * 拆为子组件可减少父组件重渲染时的工作量，并配合 batchClock 让总耗时随秒滚动。
 */
function BatchItemRow({
  item,
  t,
  batchClock
}: {
  item: BatchItem
  t: (k: string) => string
  batchClock: number
}): React.ReactNode {
  const isActive = item.status === 'running' || item.status === 'retrying'
  const now = isActive ? batchClock : (item.stepStartedAt || item.startedAt || 0)
  const totalMs = item.startedAt ? Math.max(0, now - item.startedAt) : undefined
  const stepLabel = item.currentStep ? STEP_LABEL_VI[item.currentStep] : ''
  const [diagOpen, setDiagOpen] = useState(false)
  const isFailed = item.status === 'failed' || item.status === 'import_failed'
  const diag = isFailed && item.error ? diagnoseRegError(item.error) : null

  return (
    <div className="border-b last:border-b-0 text-xs hover:bg-muted/50 transition-colors">
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="text-muted-foreground w-6 text-right shrink-0">#{item.index}</span>
          {item.status === 'pending' && <span className="text-muted-foreground shrink-0">—</span>}
          {item.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />}
          {item.status === 'retrying' && <RefreshCw className="h-3 w-3 animate-spin text-yellow-500 shrink-0" />}
          {item.status === 'success' && <CheckCircle2 className="h-3 w-3 text-green-500 shrink-0" />}
          {item.status === 'imported' && <Download className="h-3 w-3 text-green-600 shrink-0" />}
          {item.status === 'failed' && <XCircle className="h-3 w-3 text-red-500 shrink-0" />}
          {item.status === 'import_failed' && <XCircle className="h-3 w-3 text-orange-500 shrink-0" />}
          <span className="font-mono truncate">{item.email || <span className="text-muted-foreground italic">待生成</span>}</span>
          {isActive && stepLabel && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal shrink-0">{stepLabel}</Badge>
          )}
          {item.exitIp && (
            <span className="text-[10px] text-muted-foreground font-mono shrink-0 hidden sm:inline">IP {item.exitIp}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {totalMs !== undefined && (
            <span className="text-[10px] text-muted-foreground font-mono tabular-nums">{fmtMs(totalMs)}</span>
          )}
          <span className={cn('text-xs whitespace-nowrap',
            (item.status === 'success' || item.status === 'imported') && 'text-green-600',
            (item.status === 'failed' || item.status === 'import_failed') && 'text-red-500',
            item.status === 'retrying' && 'text-yellow-600',
            (item.status === 'pending' || item.status === 'running') && 'text-muted-foreground'
          )}>
            {item.status === 'pending' ? '' :
             item.status === 'running' ? '' :
             item.status === 'retrying' ? `${t('register.batchItemRetrying')} (${item.retryCount})` :
             item.status === 'success' ? t('register.batchItemSuccess') :
             item.status === 'imported' ? t('register.batchItemImported') :
             item.status === 'import_failed' ? t('register.batchItemImportFailed') :
             diag ? diag.title : (item.error || t('register.batchItemFailed'))}
          </span>
          {diag && (
            <button
              onClick={() => setDiagOpen((v) => !v)}
              className="ml-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-background hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
              title="Xem nguyên nhân và đề xuất"
            >
              {diagOpen ? 'Thu gọn' : 'Chẩn đoán'}
            </button>
          )}
        </div>
      </div>
      {diag && diagOpen && (
        <div className="px-3 pb-2 pl-12 pr-3 space-y-1.5">
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-1.5">
            <div className="font-medium text-red-700 dark:text-red-400 text-[11px]">{diag.title}</div>
            {diag.reasons.length > 0 && (
              <div className="text-[11px] text-foreground/80">
                <div className="text-muted-foreground">Nguyên nhân có thể:</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {diag.reasons.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {diag.suggestions.length > 0 && (
              <div className="text-[11px] text-foreground/80">
                <div className="text-muted-foreground">Đề xuất:</div>
                <ul className="list-disc pl-4 space-y-0.5">
                  {diag.suggestions.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {item.error && (
              <div className="text-[10px] text-muted-foreground font-mono break-all pt-1 border-t border-red-500/20">
                原始：{item.error}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function RegistrationErrorDiagnosisPanel({
  error,
  className,
  compact = false
}: {
  error?: string
  className?: string
  compact?: boolean
}): React.ReactNode {
  if (!error) return null
  const diag = diagnoseRegError(error)

  return (
    <div className={cn('rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 space-y-2', className)}>
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
        <div className="min-w-0">
          <div className={cn('font-medium text-red-700 dark:text-red-400', compact ? 'text-xs' : 'text-sm')}>
            {diag.title}
          </div>
          <div className={cn('mt-1 text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>
            {diag.category === 'risk_control'
              ? 'AWS/Kiro da chan yeu cau dang ky. Hay dung batch, giam toc do va kiem tra email/cau hinh proxy truoc khi thu tiep.'
              : 'Krouter da phan loai loi va goi y cach xu ly ben duoi.'}
          </div>
        </div>
      </div>

      {diag.reasons.length > 0 && (
        <div className={cn('text-foreground/80', compact ? 'text-[11px]' : 'text-xs')}>
          <div className="text-muted-foreground">Nguyen nhan co the:</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {diag.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
          </ul>
        </div>
      )}

      {diag.suggestions.length > 0 && (
        <div className={cn('text-foreground/80', compact ? 'text-[11px]' : 'text-xs')}>
          <div className="text-muted-foreground">De xuat:</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {diag.suggestions.map((suggestion, index) => <li key={index}>{suggestion}</li>)}
          </ul>
        </div>
      )}

      <div className="break-all border-t border-red-500/20 pt-2 font-mono text-[10px] text-muted-foreground">
        Raw: {error}
      </div>
    </div>
  )
}

/**
 * 注册进度的核心 6 步：OIDC → Email → Verify → Password → Token → Done
 * 后处理可选追加：Import（自动导入开启时）、ProLink（自动获取 Pro 链接开启时）
 */
const CORE_STEPS = ['OIDC', 'Email', 'Verify', 'Password', 'Token', 'Done'] as const

/**
 * 根据用户开关动态构建步骤列表
 * @param hasImport 是否启用了自动导入
 * @param hasProLink 是否启用了自动获取 Pro 链接
 */
function buildManualSteps(hasImport: boolean, hasProLink: boolean): readonly string[] {
  const extras: string[] = []
  if (hasImport) extras.push('Import')
  if (hasProLink) extras.push('ProLink')
  if (extras.length === 0) return CORE_STEPS
  // 在 Done 之前插入额外步骤；'Done' 永远在最后
  return [...CORE_STEPS.slice(0, -1), ...extras, 'Done']
}

/**
 * 将 phase + 最近日志推断到当前步骤索引（基于动态步骤数组）
 * @param phase 后端发出的注册阶段（含后处理阶段）
 * @param lastLog 最近一条日志（用于在 running 阶段细分到 Verify/Password/Token）
 * @param steps 通过 buildManualSteps 构造的动态步骤数组
 */
function phaseToStep(phase: Phase, lastLog: string | undefined, steps: readonly string[]): number {
  // 步骤索引辅助：找具体步骤名在动态数组中的位置
  const idxOf = (name: string): number => steps.indexOf(name)
  const lastIdx = steps.length - 1

  switch (phase) {
    case 'idle': return -1
    case 'initializing': return idxOf('OIDC')
    case 'email': return idxOf('Email')
    case 'otp': return idxOf('Verify')
    case 'done': return idxOf('Done')  // 核心流程完成（未启用后处理时即最终态）
    case 'importing': {
      const i = idxOf('Import')
      return i >= 0 ? i : idxOf('Done')
    }
    case 'fetching-link': {
      const i = idxOf('ProLink')
      return i >= 0 ? i : idxOf('Done')
    }
    case 'finalized': return lastIdx
    case 'running': {
      if (!lastLog) return Math.max(0, idxOf('Email'))
      const log = lastLog.toLowerCase()
      // 自动模式 OTP 提交时也走 running，这里识别后处理消息
      if (log.includes('正在获取 pro') || log.includes('pro link') || log.includes('fetching pro')) {
        const i = idxOf('ProLink')
        if (i >= 0) return i
      }
      if (log.includes('正在导入') || log.includes('importing') || log.includes('已导入')) {
        const i = idxOf('Import')
        if (i >= 0) return i
      }
      // [13] SSO Token / [12.5] complete-signup / 验活成功
      if (log.includes('sso') || log.includes('token') || log.includes('验活') || log.includes('complete') || log.includes('end-of-workflow')) return idxOf('Token')
      // [12] 设置密码 / SetPassword / 加密公钥
      if (log.includes('密码') || log.includes('password') || log.includes('加密公钥')) return idxOf('Password')
      // [9] OTP / [10] verify-email / signup verify
      if (log.includes('验证码') || log.includes('otp') || log.includes('verify')) return idxOf('Verify')
      // [7-8] Signup / SignupInit / Profile
      if (log.includes('signup') || log.includes('profile') || log.includes('注册初始化')) return idxOf('Verify')
      // [6] 提交邮箱 / SubmitEmail
      if (log.includes('提交邮箱') || log.includes('submit') || log.includes('邮箱')) return idxOf('Email')
      return Math.max(0, idxOf('Email'))
    }
  }
}

const STORAGE_KEY = 'kiro-register-config'
const HISTORY_KEY = 'kiro-register-history'
/** 已知占用邮箱黑名单：注册失败为 email_used 时加入，下次自动跳过 */
const EMAIL_BLACKLIST_KEY = 'kiro-register-email-blacklist'
/** 注册策略模板：完整 RegisterConfig 命名快照，便于一键切换场景 */
const TEMPLATES_KEY = 'kiro-register-templates'

interface RegisterTemplate {
  id: string
  name: string
  config: RegisterConfig
  createdAt: number
}

function loadTemplates(): RegisterTemplate[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY)
    return raw ? JSON.parse(raw) as RegisterTemplate[] : []
  } catch { return [] }
}

function saveTemplates(items: RegisterTemplate[]): void {
  try { localStorage.setItem(TEMPLATES_KEY, JSON.stringify(items)) } catch { /* ignore */ }
}

function loadEmailBlacklist(): Set<string> {
  try {
    const raw = localStorage.getItem(EMAIL_BLACKLIST_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(arr.map((e) => e.toLowerCase()))
  } catch {
    return new Set()
  }
}

function saveEmailBlacklist(set: Set<string>): void {
  try {
    // 限制最多 5000 条，避免无限增长
    const arr = Array.from(set).slice(-5000)
    localStorage.setItem(EMAIL_BLACKLIST_KEY, JSON.stringify(arr))
  } catch { /* ignore */ }
}

function clearEmailBlacklist(): void {
  try { localStorage.removeItem(EMAIL_BLACKLIST_KEY) } catch { /* ignore */ }
}

// 模块级状态：组件卸载后仍保留（同一会话内）
let _logs: string[] = []
let _phase: Phase = 'idle'
let _result: RegResult | null = null
let _lastRegistrationCompleteKey = ''
let _batchRunning = false
let _batchDone = 0
let _batchSuccess = 0
let _batchFail = 0
let _batchItems: BatchItem[] = []
const clampRunCount = (value: number, total: number): number => {
  const safeTotal = Math.max(0, total)
  if (safeTotal === 0) return 0
  return Math.min(Math.max(0, value), safeTotal)
}
// Proton 登录态缓存到模块级：切换页面回来不丢失显示（真实登录态持久化在 persist:proton session）
let _protonLoggedIn = false
/**
 * 模块级映射：taskId(后端) → batchItem.id(前端)，用于把 step 事件路由到对应行。
 * 必须放模块级 — 之前用 useRef 会在切换页面 unmount 时丢失，导致重新挂载后
 * 仍在跑的任务的 step/IP/耗时不再更新（页面回来后看起来"信息没保存"）。
 */
const _taskIdToItemId = new Map<string, string>()
let _batchExitIpGuard: ((exitIp: string, itemId: string) => void) | null = null
let _batchExpectedExitIp: string | null = null

function registrationCompleteKey(res: RegResult): string {
  return [
    res.status || '',
    res.email || '',
    res.refreshToken || '',
    res.error || ''
  ].join('|')
}

function formatLogPayload(payload: unknown): string {
  if (typeof payload === 'string') return payload
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'object') {
    const message = (payload as { message?: unknown }).message
    if (message !== undefined) return formatLogPayload(message)
    try { return JSON.stringify(payload) } catch { return String(payload) }
  }
  return String(payload)
}

/**
 * 模块级 step 事件订阅：注册一次后永不取消。
 * 旧实现把订阅放 useEffect，切到其它页面 unmount 时被 cleanup 取消，
 * 期间发生的所有 step 事件全部丢失，切回来后 UI 信息缺失。
 */
let _stepListenerRegistered = false
function ensureStepListenerRegistered(): void {
  if (_stepListenerRegistered) return
  _stepListenerRegistered = true
  window.api.onRegistrationStep(({ taskId, event }) => {
    if (!taskId) return
    const itemId = _taskIdToItemId.get(taskId)
    if (!itemId) return
    const now = event.ts || Date.now()
    // 写模块级数据 + 通知挂载中的 React 组件刷新（用 _refSetBatchItems）
    _batchItems = _batchItems.map((it) => {
      if (it.id !== itemId) return it
      return {
        ...it,
        currentStep: event.name as RegStepName,
        startedAt: it.startedAt ?? now,
        stepStartedAt: now,
        email: event.email || it.email,
        exitIp: event.exitIp || it.exitIp
      }
    })
    _refSetBatchItems?.([..._batchItems])
    if (event.exitIp) _batchExitIpGuard?.(event.exitIp, itemId)
  })
}

/**
 * 模块级 log 订阅同理：切页面期间发生的日志也不会丢。
 * 行为对齐 addLog：加时间戳前缀。
 */
let _logListenerRegistered = false
function ensureLogListenerRegistered(): void {
  if (_logListenerRegistered) return
  _logListenerRegistered = true
  window.api.onRegistrationLog((payload) => {
    const msg = formatLogPayload(payload)
    const next = [..._logs, `[${new Date().toLocaleTimeString()}] ${msg}`]
    if (next.length > 500) next.splice(0, next.length - 500)
    _logs = next
    _refSetLogs?.(next)
  })
}

// 模块级 React setter refs：异步代码跨组件生命周期调用最新 setter
let _refSetPhase: ((v: Phase) => void) | null = null
let _refSetResult: ((v: RegResult | null) => void) | null = null
let _refSetLogs: ((v: string[]) => void) | null = null
let _refSetBatchRunning: ((v: boolean) => void) | null = null
let _refSetBatchDone: ((v: number) => void) | null = null
let _refSetBatchSuccess: ((v: number) => void) | null = null
let _refSetBatchFail: ((v: number) => void) | null = null
let _refSetBatchItems: ((v: BatchItem[]) => void) | null = null
let _refSetHistory: ((v: HistoryItem[] | ((prev: HistoryItem[]) => HistoryItem[])) => void) | null = null

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveHistory(items: HistoryItem[]): void {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 100))) } catch { /* ignore */ }
}

/** 订阅计划类型（对应 Kiro 后端 qSubscriptionType）*/
export type ProPlanType = 'Q_DEVELOPER_STANDALONE_PRO' | 'Q_DEVELOPER_STANDALONE_PRO_PLUS' | 'Q_DEVELOPER_STANDALONE_POWER'

interface RegisterConfig {
  mode: RegMode
  networkSource?: RegistrationNetworkSource
  clientProxyUrl?: string
  clientProxyUpstream?: string
  outlookData: string
  fullName: string
  batchCount: number
  batchInterval: number
  batchAutoImport: boolean
  batchRetries: number
  batchConcurrency: number
  autoFetchProLink: boolean
  proPlanType: ProPlanType
  tempMailEmail: string
  tempMailEpin: string
  tempMailDomain: string
  tingamefiMailApiUrl: string
  tingamefiMailAdminPassword: string
  tingamefiMailDomain: string
  /** Proton 母邮箱（点号别名母号，如 evanbartellchae@protonmail.com）*/
  protonBaseEmail: string
  /** 手动模式 — 母邮箱（收验证码的真实邮箱）*/
  manualParentEmail: string
  /** 手动模式 — 启用匿名邮箱（点号变体）*/
  manualAnonymousEmail: boolean
  /** 混合模式 — 启用的邮箱源 */
  mixedEnabledSources?: AutoEmailSource[]
}

function loadConfig(): Partial<RegisterConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveConfig(cfg: RegisterConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)) } catch { /* ignore */ }
}

const REMOTE_SYNC_STORAGE_KEY = 'kiro-register-remote-sync'
const SYNCED_REMOTE_TAG_NAME = '\u0110\u00e3 \u0111\u1ed3ng b\u1ed9'

interface RemoteSyncConfig {
  targetUrl: string
  syncPassword: string
}

interface RemoteSyncUiResult {
  success: boolean
  message: string
  added?: number
  skipped?: number
  totalIncoming?: number
  remoteTotal?: number
  tagged?: number
}

function loadRemoteSyncConfig(): RemoteSyncConfig {
  try {
    const raw = localStorage.getItem(REMOTE_SYNC_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) as Partial<RemoteSyncConfig> : {}
    return {
      targetUrl: parsed.targetUrl || '',
      syncPassword: parsed.syncPassword || ''
    }
  } catch {
    return { targetUrl: '', syncPassword: '' }
  }
}

function saveRemoteSyncConfig(cfg: RemoteSyncConfig): void {
  try { localStorage.setItem(REMOTE_SYNC_STORAGE_KEY, JSON.stringify(cfg)) } catch { /* ignore */ }
}

function RegistrationNetworkSourcePanel({
  isEn,
  isDisabled,
  networkSource,
  setNetworkSource,
  clientProxyUrl,
  setClientProxyUrl,
  clientProxyUpstream,
  setClientProxyUpstream
}: {
  isEn: boolean
  isDisabled: boolean
  networkSource: RegistrationNetworkSource
  setNetworkSource: (value: RegistrationNetworkSource) => void
  clientProxyUrl: string
  setClientProxyUrl: (value: string) => void
  clientProxyUpstream: string
  setClientProxyUpstream: (value: string) => void
}): React.ReactNode {
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Network className="h-4 w-4 text-primary" />
          <div>
            <div className="text-sm font-medium">{isEn ? 'Registration IP source' : 'Nguon IP dang ky'}</div>
            <div className="text-xs text-muted-foreground">
              {isEn ? 'Choose where the registration request exits.' : 'Chon noi request dang ky di ra Internet.'}
            </div>
          </div>
        </div>
        <Badge variant="outline" className={networkSource === 'client-proxy' ? 'border-primary/40 text-primary' : ''}>
          {networkSource === 'client-proxy' ? (isEn ? 'Client route' : 'May ca nhan') : (isEn ? 'Backend route' : 'Backend/VPS')}
        </Badge>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => setNetworkSource('server')}
          className={cn(
            'rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50',
            networkSource === 'server'
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-background hover:border-primary/40'
          )}
        >
          <div className="text-sm font-medium">{isEn ? 'Backend / VPS' : 'Backend / VPS'}</div>
          <div className="text-xs text-muted-foreground">
            {isEn ? 'Use the machine running Krouter backend.' : 'Dung IP cua may dang chay backend Krouter.'}
          </div>
        </button>
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => setNetworkSource('client-proxy')}
          className={cn(
            'rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-50',
            networkSource === 'client-proxy'
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-background hover:border-primary/40'
          )}
        >
          <div className="text-sm font-medium">{isEn ? 'Personal machine' : 'May ca nhan'}</div>
          <div className="text-xs text-muted-foreground">
            {isEn ? 'Use a proxy/helper running on your PC.' : 'Dung proxy/helper dang chay tren may ca nhan.'}
          </div>
        </button>
      </div>

      {networkSource === 'client-proxy' && (
        <div className="space-y-3 rounded-md border border-dashed bg-background/70 p-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">{isEn ? 'Client proxy/helper URL' : 'Client proxy/helper URL'}</Label>
              <Input
                value={clientProxyUrl}
                onChange={(event) => setClientProxyUrl(event.target.value)}
                placeholder="http://user:pass@your-pc-ip:8080 or socks5://127.0.0.1:1080"
                disabled={isDisabled}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{isEn ? 'Upstream proxy (optional)' : 'Upstream proxy (optional)'}</Label>
              <Input
                value={clientProxyUpstream}
                onChange={(event) => setClientProxyUpstream(event.target.value)}
                placeholder="http://relay:port"
                disabled={isDisabled}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span>
              {isEn
                ? 'The browser alone cannot lend its IP to the VPS backend. This mode requires a reachable proxy/helper on your personal machine and will not silently fall back to the VPS IP.'
                : 'Trinh duyet khong the tu cho VPS muon IP. Che do nay can proxy/helper tren may ca nhan va khong tu roi ve IP VPS.'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function RemoteKrouterSyncPanel({
  isEn,
  accountCount,
  targetUrl,
  setTargetUrl,
  syncPassword,
  setSyncPassword,
  isSyncing,
  result,
  onSync
}: {
  isEn: boolean
  accountCount: number
  targetUrl: string
  setTargetUrl: (value: string) => void
  syncPassword: string
  setSyncPassword: (value: string) => void
  isSyncing: boolean
  result: RemoteSyncUiResult | null
  onSync: () => void
}): React.ReactNode {
  const disabled = isSyncing || !targetUrl.trim() || !syncPassword
  return (
    <Card className="hover-lift">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            {isEn ? 'Sync local accounts to VPS' : 'Dong bo tai khoan local len VPS'}
          </CardTitle>
          <Badge variant="outline">{accountCount} {isEn ? 'local accounts' : 'tai khoan local'}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div className="space-y-1.5 md:col-span-2">
            <Label className="text-xs">{isEn ? 'VPS Krouter tunnel URL' : 'URL tunnel Krouter VPS'}</Label>
            <Input
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
              placeholder="https://your-krouter.trycloudflare.com"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">{isEn ? 'Account sync password' : 'Mat khau dong bo account'}</Label>
            <Input
              value={syncPassword}
              onChange={(event) => setSyncPassword(event.target.value)}
              placeholder="ksync-..."
              type="password"
              className="font-mono text-xs"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onSync} disabled={disabled}>
            {isSyncing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
            {isEn ? 'Sync to VPS' : 'Dong bo len VPS'}
          </Button>
          <span className="text-xs text-muted-foreground">
            {isEn
              ? `Run ${'krouter sync-password'} on the VPS, then paste the current tunnel URL here. Existing accounts are skipped.`
              : `Chay ${'krouter sync-password'} tren VPS, dan link tunnel hien tai vao day. Tai khoan da co se duoc bo qua.`}
          </span>
        </div>

        {result && (
          <div className={cn(
            'rounded-md border px-3 py-2 text-xs',
            result.success
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/20 dark:text-emerald-300'
              : 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300'
          )}>
            <div className="font-medium">{result.message}</div>
            {result.success && (
              <div className="mt-1 text-muted-foreground">
                {isEn ? 'Added' : 'Da them'}: {result.added ?? 0} - {isEn ? 'Skipped existing' : 'Bo qua trung'}: {result.skipped ?? 0} - {isEn ? 'Tagged locally' : 'Da gan tag local'}: {result.tagged ?? 0} - {isEn ? 'Remote total' : 'Tong tren VPS'}: {result.remoteTotal ?? '-'}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function RegisterPage(): React.JSX.Element {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const saved = useRef(loadConfig()).current

  const [mode, setMode] = useState<RegMode>(saved.mode || 'manual')
  const [phase, _setPhase] = useState<Phase>(_phase)
  const [logs, setLogs] = useState<string[]>(_logs)
  const [result, _setResult] = useState<RegResult | null>(_result)
  const [imported, setImported] = useState(false)
  const [networkSource, setNetworkSource] = useState<RegistrationNetworkSource>(saved.networkSource === 'client-proxy' ? 'client-proxy' : 'server')
  const [clientProxyUrl, setClientProxyUrl] = useState(saved.clientProxyUrl || '')
  const [clientProxyUpstream, setClientProxyUpstream] = useState(saved.clientProxyUpstream || '')
  const remoteSyncSaved = useRef(loadRemoteSyncConfig()).current
  const [remoteSyncUrl, setRemoteSyncUrl] = useState(remoteSyncSaved.targetUrl)
  const [remoteSyncPassword, setRemoteSyncPassword] = useState(remoteSyncSaved.syncPassword)
  const [remoteSyncRunning, setRemoteSyncRunning] = useState(false)
  const [remoteSyncResult, setRemoteSyncResult] = useState<RemoteSyncUiResult | null>(null)

  const setPhase = useCallback((p: Phase) => { _phase = p; _refSetPhase?.(p) }, [])
  const setResult = useCallback((r: RegResult | null) => { _result = r; _refSetResult?.(r) }, [])

  // 手动模式
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState(saved.fullName || '')
  const [otp, setOtp] = useState('')
  const [parentEmail, setParentEmail] = useState(saved.manualParentEmail || '')
  const [anonymousEmail, setAnonymousEmail] = useState(saved.manualAnonymousEmail ?? false)

  // Outlook 配置
  const [outlookData, setOutlookData] = useState(saved.outlookData || '')

  // TempMail.Plus 配置
  const [tempMailEmail, setTempMailEmail] = useState(saved.tempMailEmail || '')
  const [tempMailEpin, setTempMailEpin] = useState(saved.tempMailEpin || '')
  const [tempMailDomain, setTempMailDomain] = useState(saved.tempMailDomain || '')
  const [tingamefiMailApiUrl, setTingamefiMailApiUrl] = useState(saved.tingamefiMailApiUrl || 'https://temp-email-worker.thienp1301.workers.dev')
  const [tingamefiMailAdminPassword, setTingamefiMailAdminPassword] = useState(saved.tingamefiMailAdminPassword || '')
  const [tingamefiMailDomain, setTingamefiMailDomain] = useState(saved.tingamefiMailDomain || 'mail.tingamefi.com')

  // Proton 配置（点号别名，webview 借壳官方网页取码，需先登录一次）
  const [protonBaseEmail, setProtonBaseEmail] = useState(saved.protonBaseEmail || '')
  // 初始值取模块级缓存：切到别的页面再回来仍保持登录态显示
  const [protonLoggedIn, _setProtonLoggedIn] = useState(_protonLoggedIn)
  const setProtonLoggedIn = useCallback((v: boolean): void => { _protonLoggedIn = v; _setProtonLoggedIn(v) }, [])
  const [protonChecking, setProtonChecking] = useState(false)

  const logContainerRef = useRef<HTMLDivElement>(null)
  const { addAccount, accounts } = useAccountsStore()

  /** 从代理池取下一个可用代理（如果启用），返回 proxy + upstreamProxy 供注册配置注入 */
  const getRegistrationProxy = useCallback((): { proxy: string; upstreamProxy: string; proxyId: string; label: string } | null => {
    const { pickNextProxy, proxyPoolConfig } = useAccountsStore.getState()
    const entry = pickNextProxy()
    if (!entry) return null
    const masked = entry.url.replace(/:([^:@/]+)@/, ':***@')
    return {
      proxy: entry.url,
      upstreamProxy: proxyPoolConfig.upstreamProxy || '',
      proxyId: entry.id,
      label: masked
    }
  }, [])

  const addLog = useCallback((msg: unknown) => {
    const next = [..._logs, `[${new Date().toLocaleTimeString()}] ${formatLogPayload(msg)}`]
    if (next.length > 500) next.splice(0, next.length - 500)
    _logs = next
    _refSetLogs?.(next)
  }, [])

  useEffect(() => {
    saveRemoteSyncConfig({
      targetUrl: remoteSyncUrl,
      syncPassword: remoteSyncPassword
    })
  }, [remoteSyncUrl, remoteSyncPassword])

  const tagSyncedLocalAccounts = useCallback((ids: string[] | undefined): number => {
    const state = useAccountsStore.getState()
    const localIds = (ids || []).filter((id) => state.accounts.has(id))
    if (localIds.length === 0) return 0
    const existingTag = Array.from(state.tags.values()).find((tag) => tag.name.trim().toLowerCase() === SYNCED_REMOTE_TAG_NAME.toLowerCase())
    const tagId = existingTag?.id || state.addTag({ name: SYNCED_REMOTE_TAG_NAME, color: '#10b981' })
    useAccountsStore.getState().addTagToAccounts(localIds, tagId)
    return localIds.length
  }, [])

  const handleRemoteSync = useCallback(async (): Promise<void> => {
    if (!remoteSyncUrl.trim()) {
      setRemoteSyncResult({ success: false, message: isEn ? 'Remote Krouter URL is required.' : 'Can nhap URL Krouter VPS.' })
      return
    }
    if (!remoteSyncPassword) {
      setRemoteSyncResult({ success: false, message: isEn ? 'Account sync password is required.' : 'Can nhap mat khau dong bo account.' })
      return
    }
    if (typeof window.api.syncAccountsToRemote !== 'function') {
      setRemoteSyncResult({ success: false, message: isEn ? 'This runtime does not support remote sync.' : 'Runtime nay chua ho tro dong bo remote.' })
      return
    }

    setRemoteSyncRunning(true)
    setRemoteSyncResult(null)
    try {
      await useAccountsStore.getState().flushSaveImmediately()
      const response = await window.api.syncAccountsToRemote({
        targetUrl: remoteSyncUrl.trim(),
        syncPassword: remoteSyncPassword,
        timeoutMs: 30000
      })
      if (!response.success) {
        const message = response.error || (isEn ? 'Remote sync failed.' : 'Dong bo len VPS that bai.')
        setRemoteSyncResult({ success: false, message })
        addLog(`[RemoteSync] ${message}`)
        return
      }
      const message = isEn
        ? `Synced to ${response.targetUrl || remoteSyncUrl.trim()}`
        : `Da dong bo len ${response.targetUrl || remoteSyncUrl.trim()}`
      const tagged = tagSyncedLocalAccounts(response.syncedAccountIds)
      if (tagged > 0) await useAccountsStore.getState().flushSaveImmediately()
      setRemoteSyncResult({
        success: true,
        message,
        added: response.added,
        skipped: response.skipped,
        totalIncoming: response.totalIncoming,
        remoteTotal: response.remoteTotal,
        tagged
      })
      addLog(`[RemoteSync] added=${response.added ?? 0}, skipped=${response.skipped ?? 0}, tagged=${tagged}, remoteTotal=${response.remoteTotal ?? '-'}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setRemoteSyncResult({ success: false, message })
      addLog(`[RemoteSync] ${message}`)
    } finally {
      setRemoteSyncRunning(false)
    }
  }, [addLog, isEn, remoteSyncUrl, remoteSyncPassword, tagSyncedLocalAccounts])

  const addImportedAccountWithLiveness = useCallback(async (accountData: ImportedAccountData): Promise<ImportWithLivenessResult> => {
    let lastError = accountData.lastError
    const incomingEmail = accountData.email.trim().toLowerCase()
    const incomingProvider = String(accountData.credentials.provider || accountData.idp || '').trim().toLowerCase()
    const incomingRefreshToken = String(accountData.credentials.refreshToken || '').trim()
    const incomingProfileArn = String(accountData.profileArn || '').trim().toLowerCase()
    const duplicate = Array.from(accounts.values()).find((account) => {
      if (incomingRefreshToken && account.credentials.refreshToken === incomingRefreshToken) return true
      if (incomingProfileArn && account.profileArn?.trim().toLowerCase() === incomingProfileArn) return true
      return Boolean(
        incomingEmail &&
        account.email.trim().toLowerCase() === incomingEmail &&
        String(account.credentials.provider || account.idp || '').trim().toLowerCase() === incomingProvider
      )
    })
    if (duplicate) {
      const message = isEn ? 'This account already exists' : 'Tai khoan da ton tai'
      addLog(`[Nhap] ${accountData.email}: ${message}`)
      return { ok: false, error: message }
    }

    if (accountData.credentials.accessToken) {
      const provider = accountData.credentials.provider || accountData.idp
      const isBuilderIdPlaceholder = accountData.profileArn === BUILDER_ID_PROFILE_ARN
        && [provider, accountData.idp, accountData.credentials.authMethod]
          .some(value => value?.toLowerCase() === 'builderid' || value?.toLowerCase() === 'idc')

      try {
        const liveness = await window.api.diagnoseAccountLiveness({
          account: {
            id: accountData.email,
            email: accountData.email,
            accessToken: accountData.credentials.accessToken,
            refreshToken: accountData.credentials.refreshToken,
            clientId: accountData.credentials.clientId,
            clientSecret: accountData.credentials.clientSecret,
            region: accountData.credentials.region || 'us-east-1',
            authMethod: accountData.credentials.authMethod,
            provider,
            profileArn: accountData.profileArn,
            machineId: accountData.machineId,
            expiresAt: accountData.credentials.expiresAt
          },
          model: 'claude-sonnet-4.5',
          message: 'Reply with pong only.',
          timeoutMs: 60000
        })

        const livenessText = liveness.error || liveness.content || ''
        const terminal = getTerminalBatchError(livenessText)

        if (liveness.success && terminal) {
          lastError = livenessText
        } else if (liveness.success) {
          if (liveness.model === 'credential-check') {
            addLog(`[Nhập] ${accountData.email}: kiểm tra credential/quota OK (bỏ qua model chat vì không có profileArn thật)`)
          } else {
            addLog(`[Nhập] ${accountData.email}: model liveness OK`)
          }
        } else if (isBuilderIdPlaceholder && isProfileArnOnlyLivenessError(liveness.error)) {
          addLog(`[Nhập] ${accountData.email}: Kiro không nhận profileArn placeholder; credential/quota đã OK nên bỏ qua model chat`)
        } else {
          lastError = liveness.error || 'Model liveness check failed'
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    } else {
      lastError = 'Missing access token for model liveness check'
    }

    if (lastError) {
      const terminal = getTerminalBatchError(lastError)
      const label = terminal?.label || 'model liveness failed'
      addLog(`[Nhập] ${accountData.email}: ${label}: ${lastError}`)
      return { ok: false, error: lastError }
    }

    const accountId = addAccount({
      ...accountData,
      status: 'active',
      lastError: undefined,
      lastCheckedAt: Date.now()
    })

    return { ok: true, accountId }
  }, [accounts, addAccount, addLog, isEn])

  useEffect(() => {
    const el = logContainerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  // 注册一次性的 log / step IPC 监听器：模块级注册，永不取消，
  // 避免切到其它页面时丢失中间的事件（之前用 useEffect 在 unmount 时取消会丢事件）
  useEffect(() => {
    ensureLogListenerRegistered()
    ensureStepListenerRegistered()
  }, [])

  // 页面挂载时检测注册流程状态
  useEffect(() => {
    window.api.registrationStatus().then((res) => {
      if (res.inProgress && _phase === 'idle') {
        // 后端有流程但前端无状态（应用重启场景），取消残留
        window.api.registrationCancel()
      }
    })
  }, [])

  const reset = (): void => {
    _phase = 'idle'
    _logs = []
    _result = null
    _lastRegistrationCompleteKey = ''
    setPhase('idle')
    setLogs([])
    setResult(null)
    setImported(false)
    setOtp('')
  }

  // ============ 手动模式 ============

  /** 收集本地已使用过的邮箱集合（帐号库存 + 注册历史 + 已知占用黑名单）*/
  const collectUsedEmails = useCallback((): Set<string> => {
    const used = new Set<string>()
    for (const acc of accounts.values()) {
      if (acc.email) used.add(acc.email.toLowerCase())
    }
    // 注册历史（包括未导入账号的历史记录）
    for (const item of loadHistory()) {
      if (item.email) used.add(item.email.toLowerCase())
    }
    // 已知占用邮箱黑名单
    for (const e of loadEmailBlacklist()) {
      used.add(e)
    }
    return used
  }, [accounts])

  // Proton 点号变体分配：会话级已分配集合，避免并发/连续注册生成重复变体
  const protonAllocatedRef = useRef<Set<string>>(new Set())
  /** 生成下一个未使用的 Proton 点号变体地址；母邮箱未填或变体用尽返回 null */
  const generateProtonEmail = useCallback((): string | null => {
    const base = protonBaseEmail.trim()
    if (!base || !splitEmail(base)) return null
    const used = new Set(collectUsedEmails())
    for (const e of protonAllocatedRef.current) used.add(e.toLowerCase())
    const result = generateNextDotVariant(base, used)
    if (result.variant) protonAllocatedRef.current.add(result.variant.toLowerCase())
    return result.variant
  }, [protonBaseEmail, collectUsedEmails])

  const startManual = async (): Promise<void> => {
    // 1. 预生成邮箱：开启匿名时从母邮箱生成点号变体；否则使用母邮箱本身（如果填了）
    let preEmail = ''
    if (anonymousEmail) {
      const parent = parentEmail.trim()
      if (!parent || !splitEmail(parent)) {
        addLog(t('register.logAnonymousNoParent'))
        return
      }
      const result = generateNextDotVariant(parent, collectUsedEmails())
      if (!result.variant) {
        addLog(t('register.logAnonymousExhausted'))
        return
      }
      preEmail = result.variant
      setEmail(preEmail)
      addLog(t('register.logAnonymousGenerated').replace('{email}', preEmail).replace('{dots}', String(result.dotCount)))
    } else if (parentEmail.trim()) {
      preEmail = parentEmail.trim()
      setEmail(preEmail)
    }

    setPhase('initializing')
    _logs = []; setLogs([])
    setResult(null)
    setImported(false)
    addLog(t('register.logManualInit'))

    const config: Record<string, string> = {}
    if (fullName.trim()) config.fullName = fullName.trim()

    // 代理池注入：如果代理池启用且有可用代理，自动取一个并传入 config
    if (networkSource === 'client-proxy') {
      const route = resolveRegistrationNetworkRoute()
      if (!route.success) {
        addLog(`[Network] ${route.error}`)
        setResult(makeFailedRegResult(route.error))
        setPhase('idle')
        return
      }
      Object.assign(config, route.patch)
      route.logLines.forEach(addLog)
    }
    const proxyInfo = networkSource === 'client-proxy' ? null : getRegistrationProxy()
    if (proxyInfo) {
      const proxiedUrl = injectProxySession(proxyInfo.proxy)
      config.proxy = proxiedUrl
      config.upstreamProxy = proxyInfo.upstreamProxy
      addLog(`[Proxy] Sử dụng kho proxy: ${config.proxy.replace(/:([^:@/]+)@/, ':***@')}`)
      if (proxiedUrl === proxyInfo.proxy) {
        addLog('[Proxy] This proxy URL has no {session} placeholder or supported session username pattern; if the provider assigns a fixed endpoint, the exit IP can remain unchanged.')
      }
    } else if (networkSource !== 'client-proxy') {
      addLog('[Proxy] Proxy pool is disabled or has no usable proxy; registration will use direct/system network, so the exit IP can remain unchanged.')
    }

    const res = await window.api.registrationManualPhase1(config)
    if (!res.success) {
      addLog(`${t('register.logInitFailed')} ${res.error}`)
      setResult(makeFailedRegResult(res.error, preEmail))
      setPhase('idle')
      return
    }
    addLog(t('register.logInitDone'))
    setPhase('email')

    // 2. 如果预填了邮箱，自动提交 phase2跳过手动输入阶段
    if (preEmail) {
      setPhase('running')
      addLog(`${t('register.logSubmitEmail')} ${preEmail}`)
      const phase2Res = await window.api.registrationManualPhase2(preEmail, fullName.trim() || undefined)
      if (phase2Res.success) {
        addLog(t('register.logOtpSent'))
        setPhase('otp')
      } else {
        addLog(`${t('register.logFailed')} ${phase2Res.error}`)
        setResult(makeFailedRegResult(phase2Res.error, preEmail))
        setPhase('idle')
      }
    }
  }

  const submitEmail = async (): Promise<void> => {
    if (!email.trim()) return
    setPhase('running')
    addLog(`${t('register.logSubmitEmail')} ${email}`)

    const res = await window.api.registrationManualPhase2(email.trim(), fullName.trim() || undefined)
    if (res.success) {
      addLog(t('register.logOtpSent'))
      setPhase('otp')
    } else {
      addLog(`${t('register.logFailed')} ${res.error}`)
      setResult(makeFailedRegResult(res.error, email.trim()))
      setPhase('idle')
    }
  }

  const submitOTP = async (): Promise<void> => {
    if (!otp.trim()) return
    setPhase('running')
    addLog(`${t('register.logSubmitOtp')} ${otp}`)

    const res = await window.api.registrationManualPhase3(otp.trim())
    if (res.success) {
      const regResult = res.result as RegResult
      setResult(regResult)
      setPhase('done')
      addHistory({ email: regResult.email, status: regResult.status, password: regResult.password, result: regResult })
      const isSuccess = regResult.status === 'success'
      const needImport = batchAutoImport && isSuccess
      const needProLink = autoFetchProLink && isSuccess

      if (needImport) {
        setPhase('importing')
        const ok = await autoImportResult(regResult)
        if (ok) {
          setImported(true)
          addLog(t('register.logImported'))
          setHistory((prev) => {
            const idx = prev.findIndex((h) => h.email === regResult.email && !h.imported)
            if (idx >= 0) { const u = [...prev]; u[idx] = { ...u[idx], imported: true }; return u }
            return prev
          })
        }
      }
      if (needProLink) {
        setPhase('fetching-link')
        await fetchProSubscriptionUrl(regResult, regResult.email)
      }
      // 后处理全部完成 → finalized；未启用任何后处理时保持 done（语义等价）
      if (needImport || needProLink) {
        setPhase('finalized')
      }
    } else {
      addLog(`${t('register.logFailed')} ${res.error}`)
      setResult(makeFailedRegResult(res.error, email.trim()))
      setPhase('idle')
    }
  }

  // ============ 自动模式 (MoEmail / Outlook) ============

  const startAuto = async (): Promise<void> => {
    setPhase('running')
    _logs = []; setLogs([])
    setResult(null)
    setImported(false)
    _lastRegistrationCompleteKey = ''
    const modeLabel = mode === 'tempmail' ? 'TempMail.Plus' : mode === 'tingamefi' ? 'Tingamefi Mail' : mode === 'proton' ? 'Proton' : 'Outlook'
    addLog(t('register.logAutoStart').replace('{mode}', modeLabel))

    const config: Record<string, unknown> = {}
    if (mode === 'outlook') {
      config.useOutlook = true
      config.outlookData = outlookData
    } else if (mode === 'tempmail') {
      config.useTempMailPlus = true
      config.tempMailPlusEmail = tempMailEmail
      config.tempMailPlusEpin = tempMailEpin
      config.tempMailPlusDomain = tempMailDomain
    } else if (mode === 'tingamefi') {
      config.useTingamefiMail = true
      config.tingamefiMailApiUrl = tingamefiMailApiUrl
      config.tingamefiMailAdminPassword = tingamefiMailAdminPassword
      config.tingamefiMailDomain = tingamefiMailDomain
    } else if (mode === 'proton') {
      const variant = generateProtonEmail()
      if (!variant) {
        addLog('[Proton] Chưa cấu hình email gốc hoặc đã dùng hết bí danh dấu chấm')
        setPhase('idle')
        return
      }
      config.useProton = true
      config.protonEmail = variant
      addLog(`[Proton] Sử dụng bí danh dấu chấm: ${variant}`)
    }

    // 代理池注入
    if (networkSource === 'client-proxy') {
      const route = resolveRegistrationNetworkRoute()
      if (!route.success) {
        addLog(`[Network] ${route.error}`)
        setResult(makeFailedRegResult(route.error))
        setPhase('idle')
        return
      }
      Object.assign(config, route.patch)
      route.logLines.forEach(addLog)
    }
    const proxyInfo = networkSource === 'client-proxy' ? null : getRegistrationProxy()
    if (proxyInfo) {
      const proxiedUrl = injectProxySession(proxyInfo.proxy)
      config.proxy = proxiedUrl
      config.upstreamProxy = proxyInfo.upstreamProxy
      addLog(`[Proxy] Sử dụng kho proxy: ${String(config.proxy).replace(/:([^:@/]+)@/, ':***@')}`)
      if (proxiedUrl === proxyInfo.proxy) {
        addLog('[Proxy] This proxy URL has no {session} placeholder or supported session username pattern; if the provider assigns a fixed endpoint, the exit IP can remain unchanged.')
      }
    } else if (networkSource !== 'client-proxy') {
      addLog('[Proxy] Proxy pool is disabled or has no usable proxy; registration will use direct/system network, so the exit IP can remain unchanged.')
    }

    try {
      const res = await window.api.registrationStartAuto(config as Parameters<typeof window.api.registrationStartAuto>[0])
      if (res.success && res.result) {
        await onRegComplete(res.result as RegResult)
      } else if (!res.success) {
        addLog(`${t('register.logStartFailed')} ${res.error}`)
        setResult(makeFailedRegResult(res.error))
        setPhase('idle')
      }
    } catch (error) {
      addLog(`${t('register.logStartFailed')} ${error instanceof Error ? error.message : String(error)}`)
      setResult(makeFailedRegResult(error))
      setPhase('idle')
    }
  }

  // ============ 取消 ============

  const cancel = async (): Promise<void> => {
    await window.api.registrationCancel()
    addLog(t('register.logCancelled'))
    setPhase('idle')
  }

  // ============ 导入账号 ============

  const importAccount = async (): Promise<void> => {
    if (!result || result.status !== 'success' || !result.refreshToken) return

    try {
      const verifyResult = await window.api.verifyAccountCredentials({
        refreshToken: result.refreshToken,
        clientId: result.clientId!,
        clientSecret: result.clientSecret!,
        region: result.region || 'us-east-1',
        authMethod: 'IdC',
        provider: 'BuilderId'
      })

      const now = Date.now()
      const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }

      if (verifyResult.success && verifyResult.data) {
        const expiresAt = verifyResult.data.expiresIn
          ? now + verifyResult.data.expiresIn * 1000
          : now + 3600000
        const email = verifyResult.data.email || result.email
        const accessToken = verifyResult.data.accessToken || result.accessToken || ''
        const usage = verifyResult.data.usage
          ? {
              ...verifyResult.data.usage,
              percentUsed: verifyResult.data.usage.limit > 0
                ? verifyResult.data.usage.current / verifyResult.data.usage.limit
                : 0,
              lastUpdated: now
            }
          : defaultUsage

        const importedAccount = await addImportedAccountWithLiveness({
          email,
          password: result.password,
          idp: 'BuilderId',
          profileArn: BUILDER_ID_PROFILE_ARN,
          status: 'active',
          credentials: {
            refreshToken: result.refreshToken,
            clientId: result.clientId!,
            clientSecret: result.clientSecret!,
            accessToken,
            csrfToken: '',
            region: result.region || 'us-east-1',
            authMethod: 'IdC' as const,
            provider: 'BuilderId' as const,
            expiresAt
          },
          subscription: {
            type: (verifyResult.data.subscriptionType as 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams') || 'Free',
            title: verifyResult.data.subscriptionTitle || 'Free Tier'
          },
          usage,
          tags: [],
          lastUsedAt: now
        })
        if (importedAccount.ok) {
          setImported(true)
          addLog(t('register.logImported'))
        } else {
          addLog(`${t('register.logImportFailed')} ${importedAccount.error}`)
        }
      } else {
        addLog(`${t('register.logVerifyFailed')} ${verifyResult.error}`)
      }
    } catch (err) {
      addLog(`${t('register.logImportFailed')} ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 'isRunning' 表示注册流程主线进行中（不含 idle/email/otp 等待用户输入态、也不含完成态）
  const isRunning = phase === 'initializing' || phase === 'running' || phase === 'importing' || phase === 'fetching-link'
  const isClientRouteMissing = networkSource === 'client-proxy' && !clientProxyUrl.trim()
  // manualSteps / currentStep 在下方"批量注册"区块的 state 定义之后计算

  // ============ 批量注册 ============

  const [batchCount, setBatchCount] = useState(saved.batchCount ?? 1)
  const [batchInterval, setBatchInterval] = useState(saved.batchInterval ?? 5)
  const [batchRunning, _setBatchRunning] = useState(_batchRunning)
  const [batchDone, _setBatchDone] = useState(_batchDone)
  const [batchSuccess, _setBatchSuccess] = useState(_batchSuccess)
  const [batchFail, _setBatchFail] = useState(_batchFail)
  const [batchAutoImport, setBatchAutoImport] = useState(saved.batchAutoImport ?? true)
  const [batchRetries, setBatchRetries] = useState(saved.batchRetries ?? 1)
  const [batchConcurrency, setBatchConcurrency] = useState(saved.batchConcurrency ?? 1)
  const [autoFetchProLink, setAutoFetchProLink] = useState(saved.autoFetchProLink ?? false)
  const [proPlanType, setProPlanType] = useState<ProPlanType>(saved.proPlanType ?? 'Q_DEVELOPER_STANDALONE_PRO')
  const [batchItems, _setBatchItems] = useState<BatchItem[]>(_batchItems)

  // taskId → batchItem.id 映射：直接引用模块级 Map，组件 unmount/remount 不影响
  const taskIdToItemId = useRef(_taskIdToItemId)

  /** 1Hz 心跳，让运行中任务的"总耗时"实时跳动（仅 batchRunning 时启用，省电） */
  const [batchClock, setBatchClock] = useState(Date.now())
  useEffect(() => {
    if (!batchRunning) return
    const id = setInterval(() => setBatchClock(Date.now()), 1000)
    return () => clearInterval(id)
  }, [batchRunning])

  // 动态构建注册步骤（根据是否启用自动导入 / Pro 链接）
  const manualSteps = useMemo(
    () => buildManualSteps(batchAutoImport, autoFetchProLink),
    [batchAutoImport, autoFetchProLink]
  )
  const lastLogText = logs.length > 0 ? logs[logs.length - 1] : undefined
  const currentStep = phaseToStep(phase, lastLogText, manualSteps)

  const setBatchRunning = (v: boolean) => { _batchRunning = v; _refSetBatchRunning?.(v) }
  const setBatchDone = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchDone) : v; _batchDone = next; _refSetBatchDone?.(next)
  }
  const setBatchSuccess = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchSuccess) : v; _batchSuccess = next; _refSetBatchSuccess?.(next)
  }
  const setBatchFail = (v: number | ((p: number) => number)) => {
    const next = typeof v === 'function' ? v(_batchFail) : v; _batchFail = next; _refSetBatchFail?.(next)
  }
  const setBatchItems = (v: BatchItem[] | ((p: BatchItem[]) => BatchItem[])) => {
    const next = typeof v === 'function' ? v(_batchItems) : v; _batchItems = next; _refSetBatchItems?.(next)
  }
  const batchAbort = useRef(false)
  // 暂停状态：仅暂停"启动新任务"，已并发执行的会跑完
  const batchPause = useRef(false)
  const [isPaused, setIsPaused] = useState(false)
  // 当前批量任务在任务中心的 ID（用于更新进度）
  const currentTaskCenterId = useRef<string | null>(null)
  const lastAutoImportError = useRef('')
  const proxyPreflightNoticeShown = useRef(false)
  const batchPinnedProxy = useRef<{ entry: ProxyEntry; url: string; upstreamProxy: string } | null>(null)
  const batchClientProxyRoute = useRef<{ url: string; upstreamProxy: string } | null>(null)
  const validateBatchNetworkRoute = useCallback(async (
    timeoutMs = 8000
  ): Promise<{ success: boolean; latencyMs?: number; externalIp?: string; route?: string; error?: string }> => {
    const pinned = batchPinnedProxy.current
    const clientRoute = batchClientProxyRoute.current
    const safeTimeoutMs = Math.max(5000, timeoutMs)
    if (clientRoute) {
      return window.api.proxyPoolValidate({
        url: clientRoute.url,
        upstreamProxy: clientRoute.upstreamProxy || undefined,
        testUrl: 'https://api.ipify.org?format=json',
        timeoutMs: safeTimeoutMs
      })
    }
    return pinned
      ? window.api.proxyPoolValidate({
          url: pinned.url,
          upstreamProxy: pinned.upstreamProxy || undefined,
          testUrl: 'https://api.ipify.org?format=json',
          timeoutMs: safeTimeoutMs
        })
      : window.api.networkRouteValidate({
          testUrl: 'https://api.ipify.org?format=json',
          timeoutMs: safeTimeoutMs
        })
  }, [])

  const resolveRegistrationNetworkRoute = useCallback((): {
    success: boolean
    patch?: { proxy?: string; upstreamProxy?: string; strictProxy?: boolean }
    logLines: string[]
    error?: string
  } => {
    if (networkSource === 'client-proxy') {
      const rawUrl = clientProxyUrl.trim()
      if (!rawUrl) {
        return {
          success: false,
          logLines: [],
          error: isEn
            ? 'Client IP mode needs a proxy/helper URL from your personal machine.'
            : 'Che do IP may ca nhan can proxy/helper URL chay tren may ca nhan.'
        }
      }
      const proxy = injectProxySession(rawUrl)
      const masked = proxy.replace(/:([^:@/]+)@/, ':***@')
      return {
        success: true,
        patch: {
          proxy,
          upstreamProxy: clientProxyUpstream.trim(),
          strictProxy: true
        },
        logLines: [
          `[Network] Client proxy/helper mode: ${masked}`,
          '[Network] Strict route is enabled; registration will stop instead of falling back to VPS/server IP if the client route fails.'
        ]
      }
    }

    const proxyInfo = getRegistrationProxy()
    if (proxyInfo) {
      const proxiedUrl = injectProxySession(proxyInfo.proxy)
      const logs = [`[Proxy] Sử dụng kho proxy: ${proxiedUrl.replace(/:([^:@/]+)@/, ':***@')}`]
      if (proxiedUrl === proxyInfo.proxy) {
        logs.push('[Proxy] This proxy URL has no {session} placeholder or supported session username pattern; if the provider assigns a fixed endpoint, the exit IP can remain unchanged.')
      }
      return {
        success: true,
        patch: {
          proxy: proxiedUrl,
          upstreamProxy: proxyInfo.upstreamProxy
        },
        logLines: logs
      }
    }

    return {
      success: true,
      patch: {},
      logLines: ['[Proxy] Proxy pool is disabled or has no usable proxy; registration will use backend/server direct network, so the exit IP can be the VPS/local backend IP.']
    }
  }, [networkSource, clientProxyUrl, clientProxyUpstream, getRegistrationProxy, isEn])

  const requestBatchStopForTerminalError = useCallback((err: string | undefined, context: string): boolean => {
    const terminal = getTerminalBatchError(err)
    if (!terminal) return false
    if (!batchAbort.current) {
      const detail = err || 'unknown error'
      batchAbort.current = true
      batchPause.current = false
      setIsPaused(false)
      addLog(`[BatchGuard] Stopped batch after ${terminal.label} in ${context}: ${detail}`)
      if (currentTaskCenterId.current) {
        useTaskStore.getState().updateTask(currentTaskCenterId.current, {
          status: 'failed',
          error: `${terminal.label}: ${detail}`,
          lastMessage: `Stopped after ${terminal.label}`
        })
      }
      void useWebhookStore.getState().triggerEvent('risk-warning', {
        title: 'Batch stopped after AWS/Kiro auth block',
        message: `${terminal.label}: ${detail}`,
        level: 'error',
        fields: { Context: context, Category: terminal.category, Error: detail }
      })
      void window.api.registrationCancel()
    }
    return true
  }, [addLog])

  const requestBatchStopForProxyConfigError = useCallback((err: string): void => {
    if (!batchAbort.current) {
      batchAbort.current = true
      batchPause.current = false
      setIsPaused(false)
      addLog(`[Proxy] ${err}`)
      if (currentTaskCenterId.current) {
        useTaskStore.getState().updateTask(currentTaskCenterId.current, {
          status: 'failed',
          error: err,
          lastMessage: 'Stopped by proxy preflight'
        })
      }
      void window.api.registrationCancel()
    }
  }, [addLog])

  useEffect(() => {
    _batchExitIpGuard = (exitIp: string, itemId: string): void => {
      if (!_batchRunning || batchAbort.current) return
      const normalized = exitIp.trim()
      if (!normalized) return

      if (!_batchExpectedExitIp) {
        _batchExpectedExitIp = normalized
        addLog(`[NetworkGuard] Locked batch exit IP to ${normalized}`)
        return
      }

      if (_batchExpectedExitIp !== normalized) {
        requestBatchStopForProxyConfigError(
          `Network route changed during batch (${_batchExpectedExitIp} -> ${normalized}, item ${itemId}); batch stopped`
        )
      }
    }
  }, [addLog, requestBatchStopForProxyConfigError])

  // ============ 注册策略模板 ============
  const [templates, setTemplates] = useState<RegisterTemplate[]>(loadTemplates)
  const [showTemplatesMenu, setShowTemplatesMenu] = useState(false)

  const collectCurrentConfig = useCallback((): RegisterConfig => {
    // mixedEnabledSources 在本组件内声明在更下方，避免 hoisting 限制：从 localStorage 读取最新值
    let mixed: AutoEmailSource[] = ['outlook', 'tempmail']
    try {
      const raw = localStorage.getItem('kiro-register-mixed-sources')
      if (raw) {
        const arr = JSON.parse(raw) as string[]
        mixed = arr.filter((x): x is AutoEmailSource => x === 'outlook' || x === 'tempmail' || x === 'tingamefi' || x === 'proton')
        if (mixed.length === 0) mixed = ['outlook', 'tempmail']
      }
    } catch { /* ignore */ }
    return {
      mode,
      networkSource,
      clientProxyUrl,
      clientProxyUpstream,
      outlookData,
      fullName,
      batchCount,
      batchInterval,
      batchAutoImport,
      batchRetries,
      batchConcurrency,
      autoFetchProLink,
      proPlanType,
      tempMailEmail,
      tempMailEpin,
      tempMailDomain,
      tingamefiMailApiUrl,
      tingamefiMailAdminPassword,
      tingamefiMailDomain,
      protonBaseEmail,
      manualParentEmail: parentEmail,
      manualAnonymousEmail: anonymousEmail,
      mixedEnabledSources: mixed
    }
  }, [mode, networkSource, clientProxyUrl, clientProxyUpstream, outlookData, fullName, batchCount, batchInterval, batchAutoImport, batchRetries, batchConcurrency, autoFetchProLink, proPlanType, tempMailEmail, tempMailEpin, tempMailDomain, tingamefiMailApiUrl, tingamefiMailAdminPassword, tingamefiMailDomain, protonBaseEmail, parentEmail, anonymousEmail])

  const applyTemplate = useCallback((tpl: RegisterTemplate) => {
    const c = tpl.config
    // 兼容老模板：mode === 'moemail' 时回退到 outlook
    setMode((c.mode === ('moemail' as RegMode) ? 'outlook' : c.mode) as RegMode)
    setNetworkSource(c.networkSource === 'client-proxy' ? 'client-proxy' : 'server')
    setClientProxyUrl(c.clientProxyUrl || '')
    setClientProxyUpstream(c.clientProxyUpstream || '')
    setOutlookData(c.outlookData || '')
    setFullName(c.fullName || '')
    setBatchCount(c.batchCount ?? 1)
    setBatchInterval(c.batchInterval ?? 5)
    setBatchAutoImport(c.batchAutoImport ?? true)
    setBatchRetries(c.batchRetries ?? 1)
    setBatchConcurrency(c.batchConcurrency ?? 1)
    setAutoFetchProLink(c.autoFetchProLink ?? false)
    setProPlanType(c.proPlanType ?? 'Q_DEVELOPER_STANDALONE_PRO')
    setTempMailEmail(c.tempMailEmail || '')
    setTempMailEpin(c.tempMailEpin || '')
    setTempMailDomain(c.tempMailDomain || '')
    setTingamefiMailApiUrl(c.tingamefiMailApiUrl || 'https://temp-email-worker.thienp1301.workers.dev')
    setTingamefiMailAdminPassword(c.tingamefiMailAdminPassword || '')
    setTingamefiMailDomain(c.tingamefiMailDomain || 'mail.tingamefi.com')
    setProtonBaseEmail(c.protonBaseEmail || '')
    setParentEmail(c.manualParentEmail || '')
    setAnonymousEmail(c.manualAnonymousEmail ?? false)
    if (c.mixedEnabledSources) setMixedEnabledSources(c.mixedEnabledSources)
    addLog(`[Mẫu] Đã áp dụng mẫu: ${tpl.name}`)
    setShowTemplatesMenu(false)
  }, [addLog])

  const saveCurrentAsTemplate = useCallback(() => {
    const name = prompt('Lưu cấu hình hiện tại thành mẫu, nhập tên mẫu:')?.trim()
    if (!name) return
    const tpl: RegisterTemplate = {
      id: randomUuid(),
      name,
      config: collectCurrentConfig(),
      createdAt: Date.now()
    }
    const next = [tpl, ...templates]
    setTemplates(next)
    saveTemplates(next)
    addLog(`[Mẫu] Đã lưu mẫu: ${name}`)
  }, [collectCurrentConfig, templates, addLog])

  const removeTemplate = useCallback((id: string) => {
    if (!confirm('Xóa mẫu này?')) return
    const next = templates.filter((t) => t.id !== id)
    setTemplates(next)
    saveTemplates(next)
  }, [templates])

  // ============ 定时任务 + 每日配额 ============
  // 每日已注册成功数（按本地日期聚合，跨日自动重置）
  const dailyQuotaKey = useMemo(() => {
    const d = new Date()
    return `kiro-register-quota-${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
  }, [])
  const [dailyQuotaUsed, setDailyQuotaUsedState] = useState<number>(() => {
    try { return parseInt(localStorage.getItem(dailyQuotaKey) || '0', 10) || 0 } catch { return 0 }
  })
  const incrementDailyQuota = useCallback((n: number) => {
    setDailyQuotaUsedState((prev) => {
      const next = prev + n
      try { localStorage.setItem(dailyQuotaKey, String(next)) } catch { /* ignore */ }
      return next
    })
  }, [dailyQuotaKey])

  const [dailyQuotaLimit, setDailyQuotaLimit] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-dailyquota-limit') || '0', 10) || 0 } catch { return 0 }
  })
  const [scheduleEnabled, setScheduleEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem('kiro-register-schedule-enabled') === '1' } catch { return false }
  })
  const [scheduleTime, setScheduleTime] = useState<string>(() => {
    try { return localStorage.getItem('kiro-register-schedule-time') || '03:00' } catch { return '03:00' }
  })
  /** C6: 星期掩码（位 0=周日 ... 位 6=周六），默认每天（127） */
  const [scheduleWeekMask, setScheduleWeekMask] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-schedule-week-mask') || '127', 10) } catch { return 127 }
  })

  useEffect(() => { try { localStorage.setItem('kiro-register-dailyquota-limit', String(dailyQuotaLimit)) } catch { /* ignore */ } }, [dailyQuotaLimit])
  useEffect(() => { try { localStorage.setItem('kiro-register-schedule-enabled', scheduleEnabled ? '1' : '0') } catch { /* ignore */ } }, [scheduleEnabled])
  useEffect(() => { try { localStorage.setItem('kiro-register-schedule-time', scheduleTime) } catch { /* ignore */ } }, [scheduleTime])
  useEffect(() => { try { localStorage.setItem('kiro-register-schedule-week-mask', String(scheduleWeekMask)) } catch { /* ignore */ } }, [scheduleWeekMask])

  // 定时任务：每分钟检查一次是否到点（含星期过滤）
  const scheduleTriggered = useRef<string>('')  // 标记今日是否已触发，防止重复
  useEffect(() => {
    if (!scheduleEnabled) return
    const tick = (): void => {
      if (batchRunning) return
      const now = new Date()
      const todayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`
      if (scheduleTriggered.current === todayKey) return
      // C6: 星期掩码过滤（位 0=周日 ... 位 6=周六）
      const dow = now.getDay()
      if (!(scheduleWeekMask & (1 << dow))) return
      const [hh, mm] = scheduleTime.split(':').map((s) => parseInt(s, 10))
      if (now.getHours() === hh && now.getMinutes() === mm) {
        scheduleTriggered.current = todayKey
        addLog(`[Lịch] Đã đến giờ ${scheduleTime}, tự động bắt đầu đăng ký hàng loạt`)
        void startBatch()
      }
    }
    const timer = setInterval(tick, 60_000)
    tick()
    return () => clearInterval(timer)
    // 故意忽略 startBatch 依赖（它依赖太多 state，引用每次都变化；scheduleTriggered 防止重入）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleEnabled, scheduleTime, scheduleWeekMask, batchRunning])

  // ============ 限速 + 风控 ============
  // 持久化用户的限速配置
  const [rateLimitEnabled, setRateLimitEnabled] = useState<boolean>(() => {
    try { const v = localStorage.getItem('kiro-register-ratelimit-enabled'); return v === null ? true : v === '1' } catch { return true }
  })
  const [maxPerMinute, setMaxPerMinute] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-ratelimit-max') || '10', 10) || 10 } catch { return 10 }
  })
  const [burstSize, setBurstSize] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-ratelimit-burst') || '3', 10) || 3 } catch { return 3 }
  })
  const [backoffBaseSec, setBackoffBaseSec] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-backoff-base-sec') || '8', 10) || 8 } catch { return 8 }
  })
  const [backoffMaxSec, setBackoffMaxSec] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('kiro-register-backoff-max-sec') || '120', 10) || 120 } catch { return 120 }
  })
  const [autoBackoff, setAutoBackoff] = useState<boolean>(() => {
    try { return localStorage.getItem('kiro-register-autobackoff') !== '0' } catch { return true }
  })
  // 风控触发后自动暂停（B3）
  const [autoPauseOnRisk, setAutoPauseOnRisk] = useState<boolean>(() => {
    try { const v = localStorage.getItem('kiro-register-autopause-risk'); return v === null ? true : v === '1' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('kiro-register-ratelimit-enabled', rateLimitEnabled ? '1' : '0') } catch { /* ignore */ } }, [rateLimitEnabled])
  useEffect(() => { try { localStorage.setItem('kiro-register-ratelimit-max', String(maxPerMinute)) } catch { /* ignore */ } }, [maxPerMinute])
  useEffect(() => { try { localStorage.setItem('kiro-register-ratelimit-burst', String(burstSize)) } catch { /* ignore */ } }, [burstSize])
  useEffect(() => { try { localStorage.setItem('kiro-register-backoff-base-sec', String(backoffBaseSec)) } catch { /* ignore */ } }, [backoffBaseSec])
  useEffect(() => { try { localStorage.setItem('kiro-register-backoff-max-sec', String(backoffMaxSec)) } catch { /* ignore */ } }, [backoffMaxSec])
  useEffect(() => { try { localStorage.setItem('kiro-register-autobackoff', autoBackoff ? '1' : '0') } catch { /* ignore */ } }, [autoBackoff])
  useEffect(() => { try { localStorage.setItem('kiro-register-autopause-risk', autoPauseOnRisk ? '1' : '0') } catch { /* ignore */ } }, [autoPauseOnRisk])

  // 限速器实例（单例 ref）
  const rateLimiterRef = useRef<RateLimiter | null>(null)
  // 限速器快照（每秒刷新一次到 React state）
  const [rateSnapshot, setRateSnapshot] = useState<RateLimiterSnapshot | null>(null)
  // 跟踪上次风控状态，避免持续触发 webhook
  const lastRiskWarningRef = useRef(false)
  useEffect(() => {
    if (!batchRunning) {
      setRateSnapshot(null)
      lastRiskWarningRef.current = false
      return
    }
    const timer = setInterval(() => {
      if (rateLimiterRef.current) {
        const snap = rateLimiterRef.current.snapshot()
        setRateSnapshot(snap)
        // 风控信号上升沿：从未警告 → 警告，触发 webhook + 可能自动暂停
        if (snap.riskWarning && !lastRiskWarningRef.current) {
          lastRiskWarningRef.current = true
          // 自动暂停
          if (autoPauseOnRisk && !batchPause.current) {
            batchPause.current = true
            setIsPaused(true)
            if (currentTaskCenterId.current) {
              useTaskStore.getState().updateTask(currentTaskCenterId.current, { status: 'paused' })
            }
            addLog(`[Kiểm soát rủi ro] Đã tự động tạm dừng do tỷ lệ thành công ${Math.round(snap.successRate * 100)}%`)
          }
          void useWebhookStore.getState().triggerEvent('risk-warning', {
            title: 'Cảnh báo rủi ro',
            message: `Tỷ lệ đăng ký hàng loạt giảm còn ${Math.round(snap.successRate * 100)}%${autoPauseOnRisk ? ', đã tự động tạm dừng' : ', nên tạm dừng để kiểm tra'}`,
            level: 'warn',
            fields: {
              成功率: `${Math.round(snap.successRate * 100)}%`,
              连续失败: snap.consecutiveFailures,
              吞吐: `${snap.throughputPerMinute}/min`,
              动作: autoPauseOnRisk ? '已自动暂停' : '请手动检查'
            }
          })
        } else if (!snap.riskWarning && lastRiskWarningRef.current) {
          // 风控恢复
          lastRiskWarningRef.current = false
        }
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [batchRunning])

  // 自动保存配置到 localStorage
  useEffect(() => {
    saveConfig({
      mode,
      networkSource,
      clientProxyUrl,
      clientProxyUpstream,
      outlookData,
      fullName,
      batchCount,
      batchInterval,
      batchAutoImport,
      batchRetries,
      batchConcurrency,
      autoFetchProLink,
      proPlanType,
      tempMailEmail,
      tempMailEpin,
      tempMailDomain,
      tingamefiMailApiUrl,
      tingamefiMailAdminPassword,
      tingamefiMailDomain,
      protonBaseEmail,
      manualParentEmail: parentEmail,
      manualAnonymousEmail: anonymousEmail
    })
  }, [mode, networkSource, clientProxyUrl, clientProxyUpstream, outlookData, fullName, batchCount, batchInterval, batchAutoImport, batchRetries, batchConcurrency, autoFetchProLink, proPlanType, tempMailEmail, tempMailEpin, tempMailDomain, tingamefiMailApiUrl, tingamefiMailAdminPassword, tingamefiMailDomain, protonBaseEmail, parentEmail, anonymousEmail])

  // 匿名邮箱预览计算 — 以 anonymousEmail/parentEmail/accounts 为依赖实时冷算下一个变体
  const anonymousPreview = useMemo(() => {
    if (!anonymousEmail) return null
    const parent = parentEmail.trim()
    if (!parent) return { error: 'empty' as const }
    const split = splitEmail(parent)
    if (!split) return { error: 'invalid' as const }
    const used = new Set<string>()
    for (const acc of accounts.values()) {
      if (acc.email) used.add(acc.email.toLowerCase())
    }
    for (const item of loadHistory()) {
      if (item.email) used.add(item.email.toLowerCase())
    }
    const result = generateNextDotVariant(parent, used)
    const sameRootCount = countSameRootVariants(parent, used)
    const localLen = split[0].replace(/\./g, '').length
    // 上限估算到 5 个点，足以应付绝大多数场景（避免大二项式造成 UI 误导）
    const totalCapacity = totalVariantCount(localLen, 5)
    return { ...result, sameRootCount, totalCapacity, localLen, error: null as null | 'empty' | 'invalid' }
  }, [anonymousEmail, parentEmail, accounts])

  // ============ 注册历史 ============

  const [history, _setHistory] = useState<HistoryItem[]>(loadHistory)

  const setHistory = useCallback((updater: HistoryItem[] | ((prev: HistoryItem[]) => HistoryItem[])) => {
    _refSetHistory?.((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      saveHistory(next)
      return next
    })
  }, [])

  const addHistory = useCallback((item: Omit<HistoryItem, 'id' | 'time' | 'imported'>) => {
    setHistory((prev) => [{
      ...item,
      id: randomUuid(),
      time: Date.now(),
      imported: false
    }, ...prev])
  }, [setHistory])

  // 注册模块级 setter refs，确保异步代码跨组件生命周期调用最新 setter
  useEffect(() => {
    _refSetPhase = _setPhase
    _refSetResult = _setResult
    _refSetLogs = setLogs
    _refSetBatchRunning = _setBatchRunning
    _refSetBatchDone = _setBatchDone
    _refSetBatchSuccess = _setBatchSuccess
    _refSetBatchFail = _setBatchFail
    _refSetBatchItems = _setBatchItems
    _refSetHistory = _setHistory
    // 组件重新挂载时同步模块级状态到 React state
    _setPhase(_phase)
    _setResult(_result)
    setLogs([..._logs])
    _setBatchRunning(_batchRunning)
    _setBatchDone(_batchDone)
    _setBatchSuccess(_batchSuccess)
    _setBatchFail(_batchFail)
    _setBatchItems([..._batchItems])
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 自动导入单个成功结果
  const autoImportResult = useCallback(async (regResult: RegResult): Promise<boolean> => {
    lastAutoImportError.current = ''
    if (!regResult.refreshToken || !regResult.clientId || !regResult.clientSecret) {
      lastAutoImportError.current = 'Thiếu bộ token để tự động nhập tài khoản'
      return false
    }
    const now = Date.now()
    const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }
    const region = regResult.region || 'us-east-1'

    // Luồng nhanh: máy chủ đã xác thực token và hạn mức thành công.
    // Không dùng API sinh nội dung làm điều kiện nhập vì Builder ID không có profileArn.
    const v = regResult.verify as Record<string, unknown> | undefined
    if (v && v.alive && regResult.accessToken) {
      const email = String(v.email || regResult.email)
      const expiresAt = now + 3600000
      const sub = String(v.subscription || 'KIRO FREE')
      const creditUsed = Number(v.credit_used) || 0
      const creditLimit = Number(v.credit_limit) || 0
      const subType = sub.includes('PRO_PLUS') ? 'Pro_Plus' as const
        : sub.includes('PRO') ? 'Pro' as const
        : sub.includes('POWER') ? 'Pro_Plus' as const
        : 'Free' as const
      const importedAccount = await addImportedAccountWithLiveness({
        email,
        password: regResult.password,
        idp: 'BuilderId',
        profileArn: BUILDER_ID_PROFILE_ARN,
        status: 'active',
        credentials: {
          refreshToken: regResult.refreshToken,
          clientId: regResult.clientId,
          clientSecret: regResult.clientSecret,
          accessToken: regResult.accessToken || '',
          csrfToken: '',
          region,
          authMethod: 'IdC' as const,
          provider: 'BuilderId' as const,
          expiresAt
        },
        subscription: { type: subType, title: sub },
        usage: creditLimit > 0
          ? { current: creditUsed, limit: creditLimit, percentUsed: creditUsed / creditLimit, lastUpdated: now }
          : defaultUsage,
        tags: [],
        lastUsedAt: now
      })
      if (!importedAccount.ok) {
        lastAutoImportError.current = importedAccount.error || 'Model liveness check failed'
        return false
      }
      return true
    }

    // Luồng dự phòng: lấy lại access token khi kết quả xác thực chưa đầy đủ.
    try {
      const verifyResult = await window.api.verifyAccountCredentials({
        refreshToken: regResult.refreshToken,
        clientId: regResult.clientId,
        clientSecret: regResult.clientSecret,
        region,
        authMethod: 'IdC',
        provider: 'BuilderId'
      })

      if (verifyResult.success && verifyResult.data) {
        const expiresAt = verifyResult.data.expiresIn ? now + verifyResult.data.expiresIn * 1000 : now + 3600000
        const accessToken = verifyResult.data.accessToken || regResult.accessToken || ''
        const email = verifyResult.data.email || regResult.email
        const usage = verifyResult.data.usage
          ? { ...verifyResult.data.usage, percentUsed: verifyResult.data.usage.limit > 0 ? verifyResult.data.usage.current / verifyResult.data.usage.limit : 0, lastUpdated: now }
          : defaultUsage
        const importedAccount = await addImportedAccountWithLiveness({
          email, password: regResult.password, idp: 'BuilderId', status: 'active',
          profileArn: BUILDER_ID_PROFILE_ARN,
          credentials: { refreshToken: regResult.refreshToken, clientId: regResult.clientId, clientSecret: regResult.clientSecret, accessToken, csrfToken: '', region, authMethod: 'IdC' as const, provider: 'BuilderId' as const, expiresAt },
          subscription: { type: (verifyResult.data.subscriptionType as 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams') || 'Free', title: verifyResult.data.subscriptionTitle || 'Free Tier' },
          usage, tags: [], lastUsedAt: now
        })
        if (!importedAccount.ok) {
          lastAutoImportError.current = importedAccount.error || 'Model liveness check failed'
          return false
        }
      } else {
        const msg = verifyResult.error || 'Lỗi không xác định'
        lastAutoImportError.current = msg
        addLog(`[Nhập] ${regResult.email}: kiểm tra thông tin đăng nhập thất bại: ${msg}`)
        return false
      }
      return true
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      lastAutoImportError.current = msg
      addLog(`[Nhập] ${regResult.email}: kiểm tra thông tin đăng nhập thất bại: ${msg}`)
      return false
    }
  }, [addImportedAccountWithLiveness, addLog])

  // 获取 Pro 订阅链接并写入订阅页面链接列表
  const fetchProSubscriptionUrl = useCallback(async (regResult: RegResult, email: string): Promise<string | undefined> => {
    const accessToken = regResult.accessToken
    if (!accessToken) return undefined
    const linkId = randomUuid()
    appendSubscriptionLink({ accountId: linkId, email, status: 'loading' })
    try {
      addLog(`[Pro Link] ${email}: ${t('register.fetchingProLink')} (${proPlanType.replace('Q_DEVELOPER_STANDALONE_', '')})...`)
      const result = await window.api.accountGetSubscriptionUrl(
        accessToken,
        proPlanType,
        regResult.region || 'us-east-1',
        BUILDER_ID_PROFILE_ARN,
        undefined,
        'BuilderId',
        'IdC',
        undefined
      )
      if (result.success && result.url) {
        addLog(`[Pro Link] ${email}: ${result.url}`)
        updateSubscriptionLink(linkId, { status: 'success', url: result.url })
        return result.url
      }
      const errMsg = result.error || 'Failed to get link'
      addLog(`[Pro Link] ${email}: ${errMsg}`)
      updateSubscriptionLink(linkId, { status: 'error', error: errMsg })
      return undefined
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      addLog(`[Pro Link] ${email}: ${errMsg}`)
      updateSubscriptionLink(linkId, { status: 'error', error: errMsg })
      return undefined
    }
  }, [addLog, t])

  // 监听注册完成 - 同时记录到历史 + 自动导入
  const onRegComplete = useCallback(async (res: RegResult) => {
    const completeKey = registrationCompleteKey(res)
    if (_lastRegistrationCompleteKey === completeKey) return
    _lastRegistrationCompleteKey = completeKey

    setResult(res)
    setPhase('done')
    if (res.status === 'success') {
      addLog(`${t('register.logRegSuccess')} ${res.email}`)
      addHistory({ email: res.email, status: 'success', password: res.password, result: res })
      // 触发 Webhook
      void useWebhookStore.getState().triggerEvent('register-success', {
        title: 'Đăng ký tài khoản thành công',
        message: `Đã đăng ký xong tài khoản mới ${res.email}`,
        level: 'success',
        fields: { Email: res.email, 'Chế độ': mode }
      })
      // 与手动模式 submitOTP 状态机保持一致：后处理期间推进 phase，
      // 避免后处理仍在跑时 phase 提前变 'done' 导致"新注册"按钮提前出现 + reset 竞态
      const needImport = batchAutoImport
      const needProLink = autoFetchProLink
      if (needImport) {
        setPhase('importing')
        const ok = await autoImportResult(res)
        if (ok) {
          setImported(true)
          addLog(t('register.logImported'))
          setHistory((prev) => {
            const idx = prev.findIndex((h) => h.email === res.email && !h.imported)
            if (idx >= 0) { const u = [...prev]; u[idx] = { ...u[idx], imported: true }; return u }
            return prev
          })
        }
      }
      if (needProLink) {
        setPhase('fetching-link')
        await fetchProSubscriptionUrl(res, res.email)
      }
      // 后处理全部完成 → finalized；未启用任何后处理时保持 done（语义等价）
      if (needImport || needProLink) {
        setPhase('finalized')
      }
    } else {
      addLog(`${t('register.logRegFailed')} ${res.error}`)
      addHistory({ email: res.email, status: res.status, error: res.error, password: res.password, result: res })
      // 单次模式失败补偿：邮箱已占用时加入黑名单（与批量 runSingleWithRetry 逻辑对齐），
      // 下次 generateProtonEmail / 匿名变体经 collectUsedEmails 自动跳过
      if (res.email && classifyError(res.error) === 'email_used') {
        const set = loadEmailBlacklist()
        set.add(res.email.toLowerCase())
        saveEmailBlacklist(set)
        addLog(`[Kiểm tra trước] Đã thêm email ${res.email} vào danh sách email đã sử dụng`)
      }
      // 触发 Webhook
      void useWebhookStore.getState().triggerEvent('register-failed', {
        title: 'Đăng ký tài khoản thất bại',
        message: `Đăng ký ${res.email || '(email không xác định)'} thất bại`,
        level: 'error',
        fields: { Email: res.email || '-', Lỗi: res.error || '-', 'Chế độ': mode }
      })
    }
  }, [addLog, addHistory, t, batchAutoImport, autoImportResult, autoFetchProLink, fetchProSubscriptionUrl, mode])

  // 覆盖原有的 onRegistrationComplete 监听
  useEffect(() => {
    const unsub = window.api.onRegistrationComplete(onRegComplete)
    return () => unsub()
  }, [onRegComplete])

  // 混合模式：启用的子源 + 权重 + 累积调度状态
  const [mixedEnabledSources, setMixedEnabledSources] = useState<AutoEmailSource[]>(() => {
    try {
      const raw = localStorage.getItem('kiro-register-mixed-sources')
      if (raw) {
        // 兼容老数据：过滤掉已废弃的 moemail
        const arr = JSON.parse(raw) as string[]
        const valid = arr.filter((x): x is AutoEmailSource => x === 'outlook' || x === 'tempmail' || x === 'tingamefi' || x === 'proton')
        return valid.length > 0 ? valid : ['outlook', 'tempmail']
      }
    } catch { /* ignore */ }
    return ['outlook', 'tempmail']
  })
  /** 每个源的权重（默认 1） — 加权轮询 */
  const [mixedWeights, setMixedWeights] = useState<Record<AutoEmailSource, number>>(() => {
    try {
      const raw = localStorage.getItem('kiro-register-mixed-weights')
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, number>
        return { outlook: parsed.outlook ?? 1, tempmail: parsed.tempmail ?? 1, tingamefi: parsed.tingamefi ?? 1, proton: parsed.proton ?? 1 }
      }
    } catch { /* ignore */ }
    return { outlook: 1, tempmail: 1, tingamefi: 1, proton: 1 }
  })
  useEffect(() => {
    try { localStorage.setItem('kiro-register-mixed-sources', JSON.stringify(mixedEnabledSources)) } catch { /* ignore */ }
  }, [mixedEnabledSources])
  useEffect(() => {
    try { localStorage.setItem('kiro-register-mixed-weights', JSON.stringify(mixedWeights)) } catch { /* ignore */ }
  }, [mixedWeights])

  // 加权轮询调度：维护各源的"信用"分数，每次选信用最高的，扣除后累积
  // 这是 Smooth Weighted Round-Robin 算法（nginx 用的同款）
  const mixedCredits = useRef<Record<AutoEmailSource, number>>({ outlook: 0, tempmail: 0, tingamefi: 0, proton: 0 })

  /** 在混合模式下按加权轮询挑选下一个有效子源 */
  const pickNextSource = useCallback((): AutoEmailSource | null => {
    const candidates = mixedEnabledSources.filter((src) => {
      // 子源必须填了对应的配置
      if (src === 'outlook') return !!outlookData.trim()
      if (src === 'tempmail') return !!(tempMailDomain.trim() && tempMailEmail.trim() && tempMailEpin.trim())
      if (src === 'tingamefi') return !!(tingamefiMailApiUrl.trim() && tingamefiMailAdminPassword.trim() && tingamefiMailDomain.trim())
      if (src === 'proton') return !!protonBaseEmail.trim()
      return false
    })
    if (candidates.length === 0) return null
    if (candidates.length === 1) return candidates[0]

    // SWRR：每次给所有候选 credit += weight，挑选 credit 最高的，然后该项 credit -= totalWeight
    let totalWeight = 0
    for (const c of candidates) totalWeight += Math.max(0, mixedWeights[c] || 0)
    if (totalWeight === 0) totalWeight = candidates.length // 兜底：全 0 权重时退化为简单轮询

    let best: AutoEmailSource | null = null
    let bestCredit = -Infinity
    for (const c of candidates) {
      const w = Math.max(0, mixedWeights[c] || 0) || 1
      mixedCredits.current[c] = (mixedCredits.current[c] || 0) + w
      if (mixedCredits.current[c] > bestCredit) {
        best = c
        bestCredit = mixedCredits.current[c]
      }
    }
    if (best) {
      mixedCredits.current[best] -= totalWeight
    }
    return best
  }, [mixedEnabledSources, mixedWeights, outlookData, tempMailDomain, tempMailEmail, tempMailEpin, tingamefiMailApiUrl, tingamefiMailAdminPassword, tingamefiMailDomain, protonBaseEmail])

  // 构建自动模式配置
  const buildAutoConfig = useCallback((): Parameters<typeof window.api.registrationStartAuto>[0] => {
    const config: Record<string, unknown> = {}

    // 混合模式：每次调用挑一个子源
    const effectiveMode: AutoEmailSource | null = mode === 'mixed'
      ? pickNextSource()
      : (mode === 'manual' ? null : (mode as AutoEmailSource))

    if (effectiveMode === 'tempmail') {
      config.useTempMailPlus = true
      config.tempMailPlusEmail = tempMailEmail
      config.tempMailPlusEpin = tempMailEpin
      config.tempMailPlusDomain = tempMailDomain
    } else if (effectiveMode === 'outlook') {
      config.useOutlook = true
      config.outlookData = outlookData
    } else if (effectiveMode === 'tingamefi') {
      config.useTingamefiMail = true
      config.tingamefiMailApiUrl = tingamefiMailApiUrl
      config.tingamefiMailAdminPassword = tingamefiMailAdminPassword
      config.tingamefiMailDomain = tingamefiMailDomain
    } else if (effectiveMode === 'proton') {
      config.useProton = true
      const variant = generateProtonEmail()
      if (variant) config.protonEmail = variant
    }
    return config as Parameters<typeof window.api.registrationStartAuto>[0]
  }, [mode, pickNextSource, outlookData, tempMailEmail, tempMailEpin, tempMailDomain, tingamefiMailApiUrl, tingamefiMailAdminPassword, tingamefiMailDomain, generateProtonEmail])

  // 代理池：注册时为每个任务自动挑选一个出口代理（启用后生效）
  const { proxyPool, proxyPoolConfig, pickNextProxy, reportProxyResult } = useAccountsStore()

  /**
   * Outlook 单行池：批量启动时 shuffle 一次，每个 task 独占一行避免并发抢占。
   * 之前的 bug：所有 task 共享同一份 outlookData，主进程用 Math.random() 挑选 → 并发任务可能撞同一个邮箱。
   */
  const outlookPoolRef = useRef<string[]>([])

  // 执行单次注册（含重试）— 每次都重新 buildAutoConfig，让 mixed 模式权重正确生效
  const runSingleWithRetry = useCallback(async (
    itemId: string,
    taskId: string,
    maxRetries: number
  ): Promise<{ success: boolean; result?: RegResult }> => {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 暂停时阻塞等待恢复；停止时立即退出 —— 让暂停/停止对"重试"也即时生效
      while (batchPause.current && !batchAbort.current) {
        await new Promise((r) => setTimeout(r, 300))
      }
      if (batchAbort.current) return { success: false }

      if (attempt > 0) {
        setBatchItems((prev) => prev.map((it) =>
          it.id === itemId ? { ...it, status: 'retrying' as BatchItemStatus, retryCount: attempt } : it
        ))
        addLog(t('register.batchRetrying').replace('{current}', String(attempt)).replace('{max}', String(maxRetries)))
        // 可中断的重试等待（每 100ms 检查一次 abort，最多 3s）
        for (let w = 0; w < 30 && !batchAbort.current; w++) {
          await new Promise((r) => setTimeout(r, 100))
        }
        if (batchAbort.current) return { success: false }
      } else {
        setBatchItems((prev) => prev.map((it) =>
          it.id === itemId ? { ...it, status: 'running' as BatchItemStatus } : it
        ))
      }

      // 每次都重新 build：混合模式下每个 task / 每次重试都独立挑源（权重正确生效）
      const config = buildAutoConfig()
      const enrichedConfig: Record<string, unknown> = { ...config, taskId }

      // Outlook 模式：从 shuffle 后的池里取单行（不同 task 不会抢同一个邮箱）
      // 池空时回退到完整列表（主进程 random pick，兼容兜底）
      if (config.useOutlook && outlookPoolRef.current.length > 0) {
        const line = outlookPoolRef.current.shift()
        if (line) {
          enrichedConfig.outlookData = line
          addLog(`[Outlook] Đã phân bổ email: ${line.split('----')[0]}`)
        }
      }

      // 从代理池挑一个代理（仅在启用时）；每次重试也重新挑，让失效代理自动回避
      const liveProxyState = useAccountsStore.getState()
      const liveProxyPoolConfig = liveProxyState.proxyPoolConfig
      const liveProxyPool = liveProxyState.proxyPool
      let pickedProxy: ReturnType<typeof pickNextProxy> = null
      if (networkSource === 'client-proxy') {
        const clientRoute = batchClientProxyRoute.current
        if (!clientRoute) {
          requestBatchStopForProxyConfigError('Client proxy/helper route was not pinned before batch launch')
          return { success: false, result: { status: 'failed', email: '', error: 'No client proxy/helper route' } as RegResult }
        }
        enrichedConfig.proxy = clientRoute.url
        enrichedConfig.strictProxy = true
        if (clientRoute.upstreamProxy) {
          enrichedConfig.upstreamProxy = clientRoute.upstreamProxy
        }
        if (!proxyPreflightNoticeShown.current) {
          proxyPreflightNoticeShown.current = true
          addLog('[NetworkGuard] Reusing client proxy/helper route for this batch')
        }
      } else if (!liveProxyPoolConfig.enabled) {
        if (!proxyPreflightNoticeShown.current) {
          proxyPreflightNoticeShown.current = true
          addLog('[Proxy] Proxy pool is disabled; registration will use direct/system network, so the exit IP can remain unchanged.')
        }
      } else {
        // 严格代理模式：代理池启用时必须走显式配置，避免配置失效后静默回退。
        if (liveProxyPool.size === 0) {
          requestBatchStopForProxyConfigError('代理池已启用但池中无任何代理，已中止批量注册（请先在「代理池」页面添加代理）')
          return { success: false, result: { status: 'failed', email: '', error: '代理池已启用但池为空' } as RegResult }
        }
        const pinned = batchPinnedProxy.current
        if (!pinned) {
          requestBatchStopForProxyConfigError('Proxy pool is enabled but no stable batch route was pinned')
          return { success: false, result: { status: 'failed', email: '', error: 'No stable batch proxy route' } as RegResult }
        }
        pickedProxy = pinned.entry
        enrichedConfig.proxy = pinned.url
        enrichedConfig.strictProxy = true
        if (pinned.upstreamProxy) {
          enrichedConfig.upstreamProxy = pinned.upstreamProxy
        }
        addLog(`[NetworkGuard] Reusing pinned route ${pickedProxy.protocol}://${pickedProxy.host}:${pickedProxy.port}`)
      }

      const res = await window.api.registrationStartAuto(enrichedConfig as typeof config)

      // 上报代理使用结果
      if (pickedProxy) {
        const ok = res.success && (res.result as RegResult | undefined)?.status === 'success'
        const emailUsed = (res.result as RegResult | undefined)?.email
        const errMsg = res.error || (res.result as RegResult | undefined)?.error
        liveProxyState.reportProxyResult(pickedProxy.id, ok, emailUsed, errMsg)
      }

      if (res.success && res.result) {
        const regResult = res.result as RegResult
        if (regResult.status === 'success') {
          return { success: true, result: regResult }
        }
        if (requestBatchStopForTerminalError(regResult.error || res.error, `registration ${regResult.email || itemId}`)) {
          return { success: false, result: regResult }
        }
        if (attempt === maxRetries) {
          return { success: false, result: regResult }
        }
      } else if (!res.success) {
        if (requestBatchStopForTerminalError(res.error, `registration ${itemId}`)) {
          return { success: false, result: { status: 'failed', email: '', error: res.error || 'terminal registration error' } as RegResult }
        }
        if (attempt === maxRetries) return { success: false }
      }
    }
    return { success: false }
  }, [addLog, t, proxyPool, proxyPoolConfig.enabled, pickNextProxy, reportProxyResult, buildAutoConfig, requestBatchStopForTerminalError, requestBatchStopForProxyConfigError, networkSource])

  // 处理单个批量注册任务完成
  const handleBatchOutcome = async (
    itemId: string,
    outcome: { success: boolean; result?: RegResult }
  ): Promise<void> => {
    if (outcome.success && outcome.result) {
      setBatchSuccess((p) => p + 1)
      // 每日配额计数（仅成功才扣减）
      if (dailyQuotaLimit > 0) incrementDailyQuota(1)
      setBatchItems((prev) => prev.map((it) =>
        it.id === itemId ? { ...it, status: 'success', email: outcome.result!.email } : it
      ))
      addHistory({ email: outcome.result.email, status: 'success', password: outcome.result.password, result: outcome.result })

      if (batchAutoImport) {
        const imported = await autoImportResult(outcome.result)
        const importError = lastAutoImportError.current
        setBatchItems((prev) => prev.map((it) =>
          it.id === itemId ? { ...it, status: imported ? 'imported' : 'import_failed', error: imported ? undefined : (importError || 'auto import failed') } : it
        ))
        if (imported) {
          addLog(t('register.logImported'))
          setHistory((prev) => {
            const idx = prev.findIndex((h) => h.email === outcome.result!.email && !h.imported)
            if (idx >= 0) {
              const updated = [...prev]
              updated[idx] = { ...updated[idx], imported: true }
              return updated
            }
            return prev
          })
        } else {
          requestBatchStopForTerminalError(importError, `auto import ${outcome.result.email}`)
        }
      }
      if (autoFetchProLink) {
        await fetchProSubscriptionUrl(outcome.result, outcome.result.email)
      }
    } else {
      setBatchFail((p) => p + 1)
      const errEmail = outcome.result?.email || ''
      const errMsg = outcome.result?.error || 'unknown'
      setBatchItems((prev) => prev.map((it) =>
        it.id === itemId ? { ...it, status: 'failed', email: errEmail, error: errMsg } : it
      ))
      if (outcome.result) {
        addHistory({ email: errEmail, status: 'failed', error: errMsg })
      }
      const errCategory = classifyError(errMsg)
      // 经验型预校验：邮箱已占用错误加入黑名单
      if (errEmail && errCategory === 'email_used') {
        const set = loadEmailBlacklist()
        set.add(errEmail.toLowerCase())
        saveEmailBlacklist(set)
        addLog(`[Kiểm tra trước] Đã thêm email ${errEmail} vào danh sách email đã sử dụng`)
      }
      // AWS 风控触发：立即暂停（如启用自动暂停）
      if (errCategory === 'risk_control' && autoPauseOnRisk && !batchPause.current) {
        batchPause.current = true
        setIsPaused(true)
        if (currentTaskCenterId.current) {
          useTaskStore.getState().updateTask(currentTaskCenterId.current, { status: 'paused' })
        }
        addLog(`[Kiểm soát rủi ro] AWS đã hạn chế ${errEmail || 'tài khoản'}, tự động tạm dừng đăng ký hàng loạt`)
        void useWebhookStore.getState().triggerEvent('risk-warning', {
          title: 'AWS đã chặn yêu cầu, tác vụ đã tự động tạm dừng',
          message: `Tài khoản ${errEmail || '(đang tạo)'} đã chạm giới hạn bảo mật AWS. Hệ thống đã dừng đăng ký hàng loạt; hãy kiểm tra email hạn chế, giảm tốc độ và xác minh tài khoản theo hướng dẫn AWS/Kiro.`,
          level: 'error',
          fields: { Email: errEmail || '-', Lỗi: errMsg }
        })
      }
    }
    setBatchDone((p) => p + 1)
  }

  // 批量注册主逻辑（支持并发 + 暂停/恢复 + 任务中心进度上报）
  // 第二个参数 retryItems 用于"从失败重试队列"启动：仅重跑指定 items 而非创建新 N 个
  const startBatch = async (retryItems?: BatchItem[]): Promise<void> => {
    if (mode === 'manual') return

    // 每日配额检查
    if (dailyQuotaLimit > 0) {
      const remainingQuota = Math.max(0, dailyQuotaLimit - dailyQuotaUsed)
      if (remainingQuota === 0) {
        addLog(`[Hạn mức] Đã hết hạn mức hôm nay (${dailyQuotaUsed}/${dailyQuotaLimit}), không khởi chạy`)
        alert(`Đã dùng hết quota đăng ký hôm nay (${dailyQuotaUsed}/${dailyQuotaLimit})`)
        return
      }
      const want = retryItems ? retryItems.length : batchCount
      if (want > remainingQuota) {
        addLog(`[Hạn mức] Yêu cầu ${want} tài khoản nhưng hôm nay chỉ còn ${remainingQuota}, tự động giảm xuống ${remainingQuota}`)
        if (!retryItems) {
          setBatchCount(remainingQuota)
        }
      }
    }

    const liveProxyState = useAccountsStore.getState()
    let liveProxyPoolConfig: ProxyPoolConfig = liveProxyState.proxyPoolConfig
    let liveProxyPool: Map<string, ProxyEntry> = liveProxyState.proxyPool
    if (!liveProxyPoolConfig.enabled && (!liveProxyState.hasLoadedStorage || liveProxyState.isLoading)) {
      try {
        const persisted = await window.api.loadAccounts()
        const persistedConfig = persisted && persisted.proxyPoolConfig && typeof persisted.proxyPoolConfig === 'object'
          ? { ...liveProxyPoolConfig, ...(persisted.proxyPoolConfig as Partial<ProxyPoolConfig>) }
          : null
        if (persisted && persistedConfig?.enabled) {
          liveProxyPoolConfig = persistedConfig
          liveProxyPool = persisted.proxyPool && typeof persisted.proxyPool === 'object'
            ? new Map(Object.entries(persisted.proxyPool as Record<string, ProxyEntry>))
            : new Map<string, ProxyEntry>()
          useAccountsStore.setState({
            proxyPool: liveProxyPool,
            proxyPoolConfig: liveProxyPoolConfig,
            proxyPoolCursor: typeof persisted.proxyPoolCursor === 'number' ? persisted.proxyPoolCursor : liveProxyState.proxyPoolCursor
          })
        }
      } catch (err) {
        addLog(`[Proxy] Failed to reload proxy pool config before batch: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    batchPinnedProxy.current = null
    batchClientProxyRoute.current = null
    _batchExpectedExitIp = null
    batchAbort.current = false
    batchPause.current = false
    if (networkSource === 'client-proxy') {
      const route = resolveRegistrationNetworkRoute()
      if (!route.success || !route.patch?.proxy) {
        setPhase('idle')
        setBatchRunning(false)
        setIsPaused(false)
        setBatchDone(0)
        setBatchSuccess(0)
        setBatchFail(0)
        setBatchItems([])
        addLog(`[Network] ${route.error || 'Client proxy/helper URL is missing'}`)
        return
      }
      batchClientProxyRoute.current = {
        url: route.patch.proxy,
        upstreamProxy: route.patch.upstreamProxy || ''
      }
      route.logLines.forEach(addLog)
    } else if (liveProxyPoolConfig.enabled) {
      const usableProxyCount = Array.from(liveProxyPool.values()).filter((p) => p.enabled && p.status !== 'dead').length
      if (liveProxyPool.size === 0) {
        setPhase('idle')
        setBatchRunning(false)
        setIsPaused(false)
        setBatchDone(0)
        setBatchSuccess(0)
        setBatchFail(0)
        setBatchItems([])
        addLog('[Proxy] Kho proxy đã bật nhưng đang trống, chưa bắt đầu đăng ký hàng loạt')
        return
      }
      if (usableProxyCount === 0) {
        setPhase('idle')
        setBatchRunning(false)
        setIsPaused(false)
        setBatchDone(0)
        setBatchSuccess(0)
        setBatchFail(0)
        setBatchItems([])
        addLog('[Proxy] Kho proxy đã bật nhưng không có proxy khả dụng, chưa bắt đầu đăng ký hàng loạt')
        return
      }

      const pinnedEntry = useAccountsStore.getState().pickNextProxy()
      if (!pinnedEntry) {
        setPhase('idle')
        setBatchRunning(false)
        setIsPaused(false)
        setBatchDone(0)
        setBatchSuccess(0)
        setBatchFail(0)
        setBatchItems([])
        addLog('[NetworkGuard] Could not pin a stable route for this batch')
        return
      }

      const stableUrl = injectProxySession(pinnedEntry.url)
      batchPinnedProxy.current = {
        entry: pinnedEntry,
        url: stableUrl,
        upstreamProxy: liveProxyPoolConfig.upstreamProxy?.trim() || ''
      }
      addLog(`[NetworkGuard] Pinned ${pinnedEntry.protocol}://${pinnedEntry.host}:${pinnedEntry.port} for the entire batch`)
    } else {
      batchPinnedProxy.current = null
    }

    addLog('[NetworkGuard] Checking the batch network route before launch...')
    let networkCheck: { success: boolean; latencyMs?: number; externalIp?: string; route?: string; error?: string }
    try {
      networkCheck = await validateBatchNetworkRoute(liveProxyPoolConfig.testTimeoutMs || 8000)
    } catch (error) {
      networkCheck = { success: false, error: error instanceof Error ? error.message : String(error) }
    }

    if (!networkCheck.success || !networkCheck.externalIp) {
      setPhase('idle')
      setBatchRunning(false)
      setIsPaused(false)
      setBatchDone(0)
      setBatchSuccess(0)
      setBatchFail(0)
      setBatchItems([])
      batchPinnedProxy.current = null
      batchClientProxyRoute.current = null
      addLog(`[NetworkGuard] Batch not started because the exit IP could not be verified: ${networkCheck.error || 'missing exit IP'}`)
      return
    }

    _batchExpectedExitIp = networkCheck.externalIp
    addLog(`[NetworkGuard] Preflight passed: exit IP ${networkCheck.externalIp}, ${networkCheck.latencyMs ?? 0}ms${networkCheck.route ? `, route ${networkCheck.route}` : ''}`)

    setBatchRunning(true)
    proxyPreflightNoticeShown.current = false
    setIsPaused(false)

    let items: BatchItem[]
    if (retryItems && retryItems.length > 0) {
      // 仅重置传入项的状态
      items = retryItems.map((it) => ({ ...it, status: 'pending' as BatchItemStatus, error: undefined, retryCount: 0 }))
      // 合并回完整列表，保持其它成功项可见
      const ids = new Set(items.map((i) => i.id))
      setBatchItems((prev) => [
        ...prev.filter((it) => !ids.has(it.id)),
        ...items
      ])
      // 重试模式下统计仅重置失败计数
      setBatchDone(0)
      setBatchSuccess(0)
      setBatchFail(0)
    } else {
      setBatchDone(0)
      setBatchSuccess(0)
      setBatchFail(0)
      items = Array.from({ length: batchCount }, (_, i) => ({
        id: randomUuid(),
        index: i + 1,
        status: 'pending' as BatchItemStatus,
        email: '',
        retryCount: 0
      }))
      setBatchItems(items)
    }

    const concurrency = Math.max(1, batchConcurrency)
    const totalCount = items.length

    // 初始化 Outlook 单行池（avoid 并发抢占）—— 仅当 outlook / mixed 启用且填了 outlookData
    const needsOutlook = mode === 'outlook' || (mode === 'mixed' && mixedEnabledSources.includes('outlook'))
    if (needsOutlook && outlookData.trim()) {
      const lines = outlookData.split('\n').map((s) => s.trim()).filter((s) => s.includes('----'))
      // Fisher-Yates shuffle
      for (let i = lines.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[lines[i], lines[j]] = [lines[j], lines[i]]
      }
      outlookPoolRef.current = lines
      if (lines.length < totalCount) {
        addLog(`[Outlook] Cảnh báo: kho chỉ có ${lines.length} email cho ${totalCount} tác vụ, phần vượt quá sẽ dùng lại ngẫu nhiên`)
      } else {
        addLog(`[Outlook] Kho email đã sẵn sàng (${lines.length} email, phân bổ sau khi xáo trộn)`)
      }
    } else {
      outlookPoolRef.current = []
    }

    setPhase('running')

    // 初始化限速器（如启用）
    if (rateLimitEnabled) {
      const cfg = {
        maxPerMinute,
        burst: burstSize,
        backoffBaseMs: backoffBaseSec * 1000,
        backoffMaxMs: backoffMaxSec * 1000,
        consecutiveFailureThreshold: autoBackoff ? 5 : 999999  // 关闭自动退避时通过大阈值禁用
      }
      if (!rateLimiterRef.current) {
        rateLimiterRef.current = createRateLimiter(cfg)
      } else {
        rateLimiterRef.current.updateConfig(cfg)
        rateLimiterRef.current.reset()
      }
      addLog(`[Giới hạn tốc độ] Đã bật: ${maxPerMinute}/phút, burst=${burstSize}, chờ ${backoffBaseSec}~${backoffMaxSec} giây, tự động chờ: ${autoBackoff ? 'bật' : 'tắt'}`)
    } else {
      rateLimiterRef.current = null
    }

    // 在任务中心创建任务条目
    const taskCenter = useTaskStore.getState()
    const taskCenterId = taskCenter.createTask({
      kind: 'register-batch',
      title: retryItems ? `Thử lại ${totalCount} tác vụ thất bại` : `Đăng ký hàng loạt ${totalCount} tài khoản`,
      subtitle: `${mode === 'outlook' ? 'Outlook' : mode === 'tempmail' ? 'TempMail.Plus' : mode === 'tingamefi' ? 'Tingamefi' : mode === 'mixed' ? 'Hỗn hợp' : 'Thủ công'}, đồng thời ${concurrency}${liveProxyPoolConfig.enabled ? ' + kho proxy' : ''}${rateLimitEnabled ? ` + ${maxPerMinute}/phút` : ''}`,
      total: totalCount,
      onPause: () => {
        batchPause.current = true
        setIsPaused(true)
        useTaskStore.getState().updateTask(taskCenterId, { status: 'paused' })
      },
      onResume: () => {
        batchPause.current = false
        setIsPaused(false)
        useTaskStore.getState().updateTask(taskCenterId, { status: 'running' })
      },
      onCancel: () => {
        batchAbort.current = true
        window.api.registrationCancel()
      }
    })
    currentTaskCenterId.current = taskCenterId

    // 并发池执行
    const executing = new Set<Promise<void>>()
    let launched = 0

    for (let i = 0; i < items.length; i++) {
      if (batchAbort.current) {
        addLog(t('register.batchStopped').replace('{done}', String(launched)).replace('{total}', String(totalCount)))
        break
      }

      // 暂停：等待恢复
      while (batchPause.current && !batchAbort.current) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (batchAbort.current) break

      // 限速：等待令牌（含退避）
      if (rateLimiterRef.current) {
        await rateLimiterRef.current.waitForSlot({ get aborted() { return batchAbort.current } })
        if (batchAbort.current) break
      }

      let taskRouteCheck: { success: boolean; latencyMs?: number; externalIp?: string; error?: string }
      try {
        taskRouteCheck = await validateBatchNetworkRoute(liveProxyPoolConfig.testTimeoutMs || 8000)
      } catch (error) {
        taskRouteCheck = { success: false, error: error instanceof Error ? error.message : String(error) }
      }
      if (!taskRouteCheck.success || !taskRouteCheck.externalIp) {
        requestBatchStopForProxyConfigError(
          `Network route check failed before task ${i + 1}/${totalCount}: ${taskRouteCheck.error || 'missing exit IP'}`
        )
        break
      }
      if (_batchExpectedExitIp && taskRouteCheck.externalIp !== _batchExpectedExitIp) {
        requestBatchStopForProxyConfigError(
          `Network route changed before task ${i + 1}/${totalCount} (${_batchExpectedExitIp} -> ${taskRouteCheck.externalIp}); batch stopped`
        )
        break
      }
      _batchExpectedExitIp = taskRouteCheck.externalIp
      addLog(`[NetworkGuard] Task ${i + 1}/${totalCount} route verified: ${taskRouteCheck.externalIp}, ${taskRouteCheck.latencyMs ?? 0}ms`)

      const itemId = items[i].id
      const taskId = `batch-${itemId.slice(0, 8)}`
      taskIdToItemId.current.set(taskId, itemId)
      addLog(`--- Batch ${i + 1}/${totalCount} ---`)
      launched++

      const task = (async () => {
        const outcome = await runSingleWithRetry(itemId, taskId, batchRetries)
        taskIdToItemId.current.delete(taskId)
        await handleBatchOutcome(itemId, outcome)
        // 上报限速器结果（用于动态退避 + 风控判定）
        if (rateLimiterRef.current) {
          rateLimiterRef.current.reportResult(outcome.success)
        }
        // 上报任务中心进度
        const doneForRun = clampRunCount(_batchDone, totalCount)
        useTaskStore.getState().updateTask(taskCenterId, {
          done: doneForRun,
          successCount: _batchSuccess,
          failedCount: _batchFail,
          progress: totalCount > 0 ? Math.round((doneForRun / totalCount) * 100) : 0
        })
      })()

      const tracked = task.finally(() => executing.delete(tracked))
      executing.add(tracked)

      // 控制并发数：池满时等待空位
      if (executing.size >= concurrency) {
        await Promise.race(executing)
      }

      // 每次启动任务后等待间隔（0 则不等待）
      if (i < items.length - 1 && !batchAbort.current && batchInterval > 0) {
        await new Promise((r) => setTimeout(r, batchInterval * 1000))
      }
    }

    // 等待所有正在执行的任务完成
    await Promise.all(executing)
    const stoppedEarly = batchAbort.current
    const doneForRun = clampRunCount(_batchDone, totalCount)

    setBatchRunning(false)
    setIsPaused(false)
    setPhase('idle')
    addLog(stoppedEarly
      ? t('register.batchStopped').replace('{done}', String(doneForRun)).replace('{total}', String(totalCount))
      : t('register.batchCompleted')
    )

    // 完成任务中心条目
    const taskState = useTaskStore.getState().tasks.get(taskCenterId)
    if (stoppedEarly) {
      if (taskState?.status !== 'cancelled') {
        useTaskStore.getState().completeTask(taskCenterId, {
          successCount: _batchSuccess,
          failedCount: _batchFail,
          error: 'Batch stopped before all tasks finished'
        })
      }
    } else {
      useTaskStore.getState().completeTask(taskCenterId, {
        successCount: _batchSuccess,
        failedCount: _batchFail
      })
    }
    currentTaskCenterId.current = null

    // 触发 Webhook 通知
    void useWebhookStore.getState().triggerEvent(stoppedEarly ? 'batch-error' : 'batch-completed', {
      title: stoppedEarly ? `Đăng ký hàng loạt${retryItems ? ' thử lại' : ''} đã dừng` : `Đăng ký hàng loạt${retryItems ? ' thử lại' : ''} đã hoàn tất`,
      message: stoppedEarly
        ? `Tổng ${totalCount} tác vụ, đã hoàn thành ${doneForRun}, thành công ${_batchSuccess}, thất bại ${_batchFail}`
        : `Tổng ${totalCount} tác vụ, thành công ${_batchSuccess}, thất bại ${_batchFail}`,
      level: stoppedEarly ? 'error' : (_batchFail === 0 ? 'success' : (_batchSuccess === 0 ? 'error' : 'warn')),
      fields: {
        'Chế độ': mode === 'outlook' ? 'Outlook' : mode === 'tempmail' ? 'TempMail.Plus' : mode === 'tingamefi' ? 'Tingamefi' : mode === 'mixed' ? 'Hỗn hợp' : 'Thủ công',
        'Đồng thời': concurrency,
        'Thành công': _batchSuccess,
        'Thất bại': _batchFail,
        Tổng: totalCount
      }
    })
    batchPinnedProxy.current = null
    batchClientProxyRoute.current = null
    _batchExpectedExitIp = null
  }

  /** 暂停 / 恢复批量注册 */
  const togglePauseBatch = (): void => {
    if (!batchRunning) return
    if (batchPause.current) {
      batchPause.current = false
      setIsPaused(false)
      if (currentTaskCenterId.current) {
        useTaskStore.getState().updateTask(currentTaskCenterId.current, { status: 'running' })
      }
    } else {
      batchPause.current = true
      setIsPaused(true)
      if (currentTaskCenterId.current) {
        useTaskStore.getState().updateTask(currentTaskCenterId.current, { status: 'paused' })
      }
    }
  }

  const stopBatch = (): void => {
    batchAbort.current = true
    // 同时解除暂停，避免暂停态下主循环 / 重试循环卡在 while 等待
    batchPause.current = false
    setIsPaused(false)
    addLog('[Hàng loạt] Đang dừng và hủy các yêu cầu đang chạy...')
    // 取消后端所有在途注册（中断当前正在跑的 registrationStartAuto）
    window.api.registrationCancel()
    if (currentTaskCenterId.current) {
      useTaskStore.getState().cancelTask(currentTaskCenterId.current)
      currentTaskCenterId.current = null
    }
  }

  /** 从失败列表中按筛选条件重试 */
  const retryFailed = (filter?: 'network' | 'otp_timeout' | 'rate_limit' | 'all'): void => {
    const failedItems = _batchItems.filter((it) => {
      if (it.status !== 'failed' && it.status !== 'import_failed') return false
      if (getTerminalBatchError(it.error)) return false
      if (!filter || filter === 'all') return true
      return classifyError(it.error) === filter
    })
    if (failedItems.length === 0) {
      addLog('[Thử lại] Không có tác vụ thất bại phù hợp để thử lại')
      return
    }
    addLog(`[Thử lại] Thử lại ${failedItems.length} tác vụ thất bại (bộ lọc: ${filter || 'tất cả'})`)
    void startBatch(failedItems)
  }

  // 导入历史中的账号
  const importHistoryItem = async (item: HistoryItem): Promise<void> => {
    if (!item.result || item.result.status !== 'success' || !item.result.refreshToken) return
    const r = item.result

    try {
      const verifyResult = await window.api.verifyAccountCredentials({
        refreshToken: r.refreshToken!,
        clientId: r.clientId!,
        clientSecret: r.clientSecret!,
        region: r.region || 'us-east-1',
        authMethod: 'IdC',
        provider: 'BuilderId'
      })

      const now = Date.now()
      const defaultUsage = { current: 0, limit: 0, percentUsed: 0, lastUpdated: now }
      let importedAccount: ImportWithLivenessResult | null = null

      if (verifyResult.success && verifyResult.data) {
        const expiresAt = verifyResult.data.expiresIn ? now + verifyResult.data.expiresIn * 1000 : now + 3600000
        const usage = verifyResult.data.usage
          ? { ...verifyResult.data.usage, percentUsed: verifyResult.data.usage.limit > 0 ? verifyResult.data.usage.current / verifyResult.data.usage.limit : 0, lastUpdated: now }
          : defaultUsage

        importedAccount = await addImportedAccountWithLiveness({
          email: verifyResult.data.email || r.email,
          idp: 'BuilderId', status: 'active',
          profileArn: BUILDER_ID_PROFILE_ARN,
          credentials: { refreshToken: r.refreshToken!, clientId: r.clientId!, clientSecret: r.clientSecret!, accessToken: verifyResult.data.accessToken || r.accessToken || '', csrfToken: '', region: r.region || 'us-east-1', authMethod: 'IdC' as const, provider: 'BuilderId' as const, expiresAt },
          subscription: { type: (verifyResult.data.subscriptionType as 'Free' | 'Pro' | 'Pro_Plus' | 'Enterprise' | 'Teams') || 'Free', title: verifyResult.data.subscriptionTitle || 'Free Tier' },
          usage, tags: [], lastUsedAt: now
        })
      } else {
        importedAccount = await addImportedAccountWithLiveness({
          email: r.email, idp: 'BuilderId', status: 'active',
          profileArn: BUILDER_ID_PROFILE_ARN,
          credentials: { refreshToken: r.refreshToken!, clientId: r.clientId!, clientSecret: r.clientSecret!, accessToken: r.accessToken || '', csrfToken: '', region: r.region || 'us-east-1', authMethod: 'IdC' as const, provider: 'BuilderId' as const, expiresAt: now + 3600000 },
          subscription: { type: 'Free', title: 'Free Tier' }, usage: defaultUsage, tags: [], lastUsedAt: now
        })
      }

      if (importedAccount?.ok) {
        setHistory((prev) => prev.map((h) => h.id === item.id ? { ...h, imported: true } : h))
      }
    } catch { /* ignore */ }
  }

  const batchProgressTotal = Math.max(0, batchItems.length || batchCount)
  const batchProgressDone = clampRunCount(batchDone, batchProgressTotal)
  const batchObservedExitIps = Array.from(new Set(
    batchItems.map((item) => item.exitIp?.trim()).filter((ip): ip is string => Boolean(ip))
  ))
  const batchLockedExitIp = _batchExpectedExitIp || batchObservedExitIps[0]
  const batchNetworkChanged = Boolean(batchLockedExitIp)
    && batchObservedExitIps.some((ip) => ip !== batchLockedExitIp)

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary/10">
            <UserPlus className="h-7 w-7 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">{t('register.title')}</h1>
            <p className="text-sm text-muted-foreground">{isEn ? 'Register new Kiro accounts automatically or manually' : 'Đăng ký tài khoản Kiro tự động hoặc thủ công'}</p>
          </div>
        </div>
      </div>

      {/* 模式选择 + 配置 */}
      <Card className="hover-lift">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-primary" />
            {t('register.mode')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex w-full flex-wrap gap-1 rounded-lg bg-muted p-1 sm:w-fit">
            {([
              ['manual', t('register.manual')],
              ['outlook', 'Outlook'],
              ['tempmail', t('register.tempmail')],
              ['tingamefi', 'Tingamefi'],
              ['proton', 'Proton'],
              ['mixed', isEn ? 'Mixed' : 'Kết hợp']
            ] as [RegMode, string][]).map(([m, label]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                disabled={isRunning || batchRunning}
                className={cn(
                  'min-w-[88px] flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 sm:flex-none',
                  mode === m
                    ? 'bg-background shadow text-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <RegistrationNetworkSourcePanel
            isEn={isEn}
            isDisabled={isRunning || batchRunning}
            networkSource={networkSource}
            setNetworkSource={setNetworkSource}
            clientProxyUrl={clientProxyUrl}
            setClientProxyUrl={setClientProxyUrl}
            clientProxyUpstream={clientProxyUpstream}
            setClientProxyUpstream={setClientProxyUpstream}
          />

          {/* 自动导入开关 */}
          <div className="flex items-start gap-3">
            <Switch
              checked={batchAutoImport}
              onCheckedChange={setBatchAutoImport}
              disabled={isRunning || batchRunning}
            />
            <div className="register-option-row min-w-0">
              <Download className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">{t('register.batchAutoImport')}</span>
              <span className="text-xs text-muted-foreground">— {t('register.batchAutoImportDesc')}</span>
            </div>
          </div>

          {/* 自动获取 Pro 订阅链接开关 + 计划选择 */}
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-3">
              <Switch
                checked={autoFetchProLink}
                onCheckedChange={setAutoFetchProLink}
                disabled={isRunning || batchRunning}
              />
              <div className="register-option-row min-w-0">
                <Link2 className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{t('register.autoFetchProLink')}</span>
                <span className="text-xs text-muted-foreground">— {t('register.autoFetchProLinkDesc')}</span>
              </div>
            </div>

            {/* 计划类型选择（仅开关开启时显示）*/}
            {autoFetchProLink && (
              <div className="ml-11 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{isEn ? 'Plan:' : 'Gói:'}</span>
                {([
                  { value: 'Q_DEVELOPER_STANDALONE_PRO' as ProPlanType, label: 'Pro', color: 'bg-blue-500' },
                  { value: 'Q_DEVELOPER_STANDALONE_PRO_PLUS' as ProPlanType, label: 'Pro+', color: 'bg-purple-500' },
                  { value: 'Q_DEVELOPER_STANDALONE_POWER' as ProPlanType, label: 'Power', color: 'bg-amber-500' }
                ]).map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setProPlanType(opt.value)}
                    disabled={isRunning || batchRunning}
                    className={`px-3 h-7 rounded-md text-xs font-medium transition-all flex items-center gap-1.5 border ${
                      proPlanType === opt.value
                        ? `${opt.color} text-white border-transparent shadow-sm`
                        : 'bg-background border-border text-muted-foreground hover:text-foreground hover:border-primary/40'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {proPlanType === opt.value && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                    {opt.label}
                  </button>
                ))}
                <span className="text-[10px] text-muted-foreground ml-1 italic">
                  {isEn ? '(Plan ID will be sent to Kiro API)' : '(Plan ID sẽ được gửi như loại đăng ký)'}
                </span>
              </div>
            )}
          </div>

          {/* Outlook 配置（独立模式 或 混合模式启用了 outlook 时显示） */}
          {(mode === 'outlook' || (mode === 'mixed' && mixedEnabledSources.includes('outlook'))) && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-1.5">
              <Label>{t('register.outlookAccounts')} ({t('register.outlookFormat')})</Label>
              <textarea
                value={outlookData}
                onChange={(e) => setOutlookData(e.target.value)}
                placeholder={t('register.outlookPlaceholder')}
                rows={3}
                disabled={isRunning || batchRunning}
                className="w-full px-3 py-2 bg-background border rounded-lg text-sm font-mono disabled:opacity-50 resize-none"
              />
            </div>
          )}

          {/* 混合模式配置：勾选要参与轮询的子源 + 权重 */}
          {mode === 'mixed' && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-3">
              <Label>{isEn ? 'Enabled email sources (Weighted Round-Robin)' : 'Nguồn email đang bật (xoay tua có trọng số)'}</Label>
              <div className="space-y-2">
                {(['outlook', 'tempmail', 'tingamefi', 'proton'] as AutoEmailSource[]).map((src) => {
                  const enabled = mixedEnabledSources.includes(src)
                  const label = src === 'outlook' ? 'Outlook' : src === 'tempmail' ? 'TempMail.Plus' : src === 'tingamefi' ? 'Tingamefi' : 'Proton'
                  const configured = src === 'outlook' ? !!outlookData.trim()
                    : src === 'proton' ? !!protonBaseEmail.trim()
                    : src === 'tingamefi' ? !!(tingamefiMailApiUrl.trim() && tingamefiMailAdminPassword.trim() && tingamefiMailDomain.trim())
                    : !!(tempMailDomain.trim() && tempMailEmail.trim() && tempMailEpin.trim())
                  return (
                    <div key={src} className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setMixedEnabledSources((prev) =>
                            enabled ? prev.filter((s) => s !== src) : [...prev, src]
                          )
                        }}
                        disabled={isRunning || batchRunning}
                        className={cn(
                          'flex-1 px-3 py-2 rounded-md border text-sm transition-colors flex items-center gap-2',
                          enabled
                            ? 'border-primary bg-primary/10 text-primary font-medium'
                            : 'border-border hover:border-primary/50',
                          !configured && 'opacity-60'
                        )}
                        title={!configured ? 'Nguồn này chưa được cấu hình, sẽ bị bỏ qua' : ''}
                      >
                        {enabled
                          ? <CheckCircle2 className="h-4 w-4" />
                          : <Square className="h-4 w-4" />
                        }
                        {label}
                        {!configured && <span className="text-[10px] text-amber-500 ml-auto">{isEn ? 'not configured' : 'Chưa cấu hình'}</span>}
                      </button>
                      {enabled && configured && (
                        <div className="flex items-center gap-1 text-xs">
                          <span className="text-muted-foreground">{isEn ? 'Weight:' : 'Trọng số:'}</span>
                          <Input
                            type="number" min={0} max={100}
                            value={mixedWeights[src] || 0}
                            onChange={(e) => {
                              const v = parseInt(e.target.value, 10)
                              if (!isNaN(v) && v >= 0) {
                                setMixedWeights((prev) => ({ ...prev, [src]: v }))
                              }
                            }}
                            disabled={isRunning || batchRunning}
                            className="h-8 w-16 text-xs text-center"
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'Smooth Weighted Round-Robin: e.g. moemail=4 + tempmail=1 means 80% / 20%. Set 0 to disable.'
                  : 'Xoay tua có trọng số: ví dụ moemail=4 + tempmail=1 tương đương 80% / 20%. Trọng số 0 nghĩa là không tham gia.'
                }
              </p>
              {mixedEnabledSources.length === 0 && (
                <p className="text-xs text-amber-500">
                  {isEn ? 'Please enable at least one source.' : 'Vui lòng bật ít nhất một nguồn.'}
                </p>
              )}
            </div>
          )}

          {/* TempMail.Plus 配置（独立模式 或 混合模式启用了 tempmail 时显示） */}
          {(mode === 'tempmail' || (mode === 'mixed' && mixedEnabledSources.includes('tempmail'))) && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailDomain')}</Label>
                  <Input
                    value={tempMailDomain}
                    onChange={(e) => setTempMailDomain(e.target.value)}
                    placeholder="example.com  domain2.com  domain3.com"
                    disabled={isRunning || batchRunning}
                    className="font-mono text-xs"
                  />
                  {tempMailDomain.trim() && (() => {
                    const list = tempMailDomain.split(/[\s,;]+/).filter(Boolean)
                    return list.length > 1
                      ? <p className="text-[11px] text-muted-foreground">Pool domain có {list.length} domain, hãy đảm bảo nguồn ổn định và hợp lệ</p>
                      : <p className="text-[11px] text-muted-foreground">Có thể nhập nhiều domain đã được ủy quyền, phân tách bằng khoảng trắng hoặc dấu phẩy</p>
                  })()}
                </div>
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailEmail')}</Label>
                  <Input
                    value={tempMailEmail}
                    onChange={(e) => setTempMailEmail(e.target.value)}
                    placeholder={t('register.tempMailEmailPlaceholder')}
                    disabled={isRunning || batchRunning}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{t('register.tempMailEpin')}</Label>
                  <Input
                    type="password"
                    value={tempMailEpin}
                    onChange={(e) => setTempMailEpin(e.target.value)}
                    disabled={isRunning || batchRunning}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('register.tempMailDesc')}</p>
            </div>
          )}

          {/* Tingamefi mail configuration */}
          {(mode === 'tingamefi' || (mode === 'mixed' && mixedEnabledSources.includes('tingamefi'))) && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-1.5 md:col-span-3">
                  <Label>{isEn ? 'Tingamefi Worker API' : 'Tingamefi Worker API'}</Label>
                  <Input
                    value={tingamefiMailApiUrl}
                    onChange={(e) => setTingamefiMailApiUrl(e.target.value)}
                    placeholder="https://temp-email-worker.thienp1301.workers.dev"
                    disabled={isRunning || batchRunning}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>{isEn ? 'Domain' : 'Domain'}</Label>
                  <Input
                    value={tingamefiMailDomain}
                    onChange={(e) => setTingamefiMailDomain(e.target.value)}
                    placeholder="mail.tingamefi.com"
                    disabled={isRunning || batchRunning}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>{isEn ? 'Admin password' : 'Admin password'}</Label>
                  <Input
                    type="password"
                    value={tingamefiMailAdminPassword}
                    onChange={(e) => setTingamefiMailAdminPassword(e.target.value)}
                    placeholder="Enter admin password"
                    disabled={isRunning || batchRunning}
                    autoComplete="off"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {isEn
                  ? 'Creates a fresh address via /admin/new_address and reads AWS verification mail from /admin/mails.'
                  : 'Tạo địa chỉ mới qua /admin/new_address và đọc mail xác thực AWS từ /admin/mails.'}
              </p>
            </div>
          )}

          {(mode === 'proton' || (mode === 'mixed' && mixedEnabledSources.includes('proton'))) && (
            <div className="p-4 bg-muted/30 rounded-lg border border-dashed space-y-3">
              <div className="space-y-1.5">
                <Label>{isEn ? 'Proton base email (dot-alias parent)' : 'Email Proton gốc (tạo alias bằng dấu chấm)'}</Label>
                <Input
                  type="email"
                  value={protonBaseEmail}
                  onChange={(e) => setProtonBaseEmail(e.target.value)}
                  placeholder="evanbartellchae@protonmail.com"
                  disabled={isRunning || batchRunning}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                {protonBaseEmail.trim() && (() => {
                  const split = splitEmail(protonBaseEmail.trim())
                  if (!split) return <p className="text-[11px] text-destructive">{isEn ? 'Invalid email' : 'Email không hợp lệ'}</p>
                  const localLen = split[0].replace(/\./g, '').length
                  const capacity = totalVariantCount(localLen, 5)
                  return <p className="text-[11px] text-muted-foreground">{isEn ? `Auto-generates dot-variants of the local part, ~${capacity.toLocaleString()} available` : `Tự tạo biến thể dấu chấm cho tên email, còn khoảng ${capacity.toLocaleString()} địa chỉ khả dụng`}</p>
                })()}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  disabled={protonChecking}
                  onClick={async () => {
                    setProtonChecking(true)
                    try {
                      const r = await window.api.protonOpenLogin()
                      setProtonLoggedIn(r.loggedIn)
                      addLog(r.loggedIn
                        ? (isEn ? '[Proton] Already logged in' : '[Proton] Đã đăng nhập')
                        : (isEn ? '[Proton] Please complete login in the popup window' : '[Proton] Vui lòng đăng nhập trong cửa sổ bật lên'))
                    } catch (err) {
                      addLog(`[Proton] ${err instanceof Error ? err.message : String(err)}`)
                    } finally {
                      setProtonChecking(false)
                    }
                  }}
                  className="px-3 py-1.5 rounded-md border border-primary bg-primary/10 text-primary text-sm font-medium transition-colors hover:bg-primary/20 disabled:opacity-50"
                >
                  {protonChecking ? (isEn ? 'Opening...' : 'Đang mở...') : (isEn ? 'Login Proton' : 'Đăng nhập Proton')}
                </button>
                <button
                  type="button"
                  disabled={protonChecking}
                  onClick={async () => {
                    setProtonChecking(true)
                    try {
                      const r = await window.api.protonLoginStatus()
                      setProtonLoggedIn(r.loggedIn)
                      addLog(r.loggedIn ? '[Proton] Đã đăng nhập' : '[Proton] Chưa đăng nhập')
                    } finally {
                      setProtonChecking(false)
                    }
                  }}
                  className="px-3 py-1.5 rounded-md border border-border text-sm transition-colors hover:border-primary/50 disabled:opacity-50"
                >
                  {isEn ? 'Check status' : 'Kiểm tra trạng thái'}
                </button>
                <span className={cn('text-xs', protonLoggedIn ? 'text-green-500' : 'text-muted-foreground')}>
                  {protonLoggedIn ? (isEn ? '● Logged in' : '● Đã đăng nhập') : (isEn ? '○ Not logged in' : '○ Chưa đăng nhập')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-snug">
                {isEn
                  ? 'Reads codes via the official Proton web page (login once, session persists). Each account uses a dot-variant of the base email (e.g. evanbar.tellcha.e@), all landing in the same inbox. Recommended concurrency: 1.'
                  : 'Dùng trang Proton chính thức để lấy mã xác minh (đăng nhập một lần, giữ phiên). Mỗi tài khoản dùng một biến thể dấu chấm của email gốc, tất cả thư vẫn về cùng một hộp thư. Nên đặt song song = 1.'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 手动模式母邮箱输入 + 匿名邮箱开关（仅 phase=idle） */}
      {mode === 'manual' && phase === 'idle' && !batchRunning && (
        <Card className="hover-lift">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <AtSign className="h-4 w-4 text-primary" />
              {t('register.parentEmailSection')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="parentEmail" className="text-xs">{t('register.parentEmailLabel')}</Label>
                <Input
                  id="parentEmail"
                  type="email"
                  value={parentEmail}
                  onChange={(e) => setParentEmail(e.target.value)}
                  placeholder={t('register.parentEmailPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-[11px] text-muted-foreground leading-snug">{t('register.parentEmailHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fullNameIdle" className="text-xs">{t('register.fullNameRandom')}</Label>
                <Input
                  id="fullNameIdle"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('register.fullNamePlaceholder')}
                />
              </div>
            </div>

            <div className="flex items-start gap-3 pt-1">
              <Switch
                id="anonymousEmail"
                checked={anonymousEmail}
                onCheckedChange={setAnonymousEmail}
              />
              <div className="flex-1 space-y-0.5">
                <Label htmlFor="anonymousEmail" className="cursor-pointer text-sm flex items-center gap-1.5">
                  <Shuffle className="h-3.5 w-3.5 text-primary" />
                  {t('register.anonymousEmailLabel')}
                </Label>
                <p className="text-[11px] text-muted-foreground leading-snug">{t('register.anonymousEmailHint')}</p>
              </div>
            </div>

            {/* 预览面板 */}
            {anonymousEmail && (
              <div className="text-xs">
                {anonymousPreview?.error === 'empty' && (
                  <div className="flex items-center gap-1.5 text-warning">
                    <Info className="h-3.5 w-3.5" />
                    <span>{t('register.anonymousNoParent')}</span>
                  </div>
                )}
                {anonymousPreview?.error === 'invalid' && (
                  <div className="flex items-center gap-1.5 text-destructive">
                    <Info className="h-3.5 w-3.5" />
                    <span>{t('register.anonymousInvalid')}</span>
                  </div>
                )}
                {anonymousPreview && !anonymousPreview.error && anonymousPreview.variant && (
                  <div className="bg-primary/[0.06] border border-primary/20 rounded-md p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="text-muted-foreground flex items-center gap-1"><Shuffle className="h-3 w-3" /> {t('register.nextVariant')}:</span>
                      <code className="bg-background px-2 py-0.5 rounded font-mono text-foreground border">
                        {anonymousPreview.variant}
                      </code>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground gap-2">
                      <span>{t('register.dotCount')}: <strong className="text-foreground">{anonymousPreview.dotCount}</strong></span>
                      <span>{t('register.sameRoot')}: <strong className="text-foreground">{anonymousPreview.sameRootCount}</strong> / ~{anonymousPreview.totalCapacity}</span>
                    </div>
                  </div>
                )}
                {anonymousPreview && !anonymousPreview.error && !anonymousPreview.variant && (
                  <div className="flex items-center gap-1.5 text-warning">
                    <Info className="h-3.5 w-3.5" />
                    <span>{t('register.anonymousExhausted')}</span>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 手动模式进度步骤条（动态步骤：6-8 步，根据开关启用 Import / ProLink） */}
      {mode === 'manual' && phase !== 'idle' && (
        <div className="bg-card border rounded-xl p-4">
          <div className="flex items-center justify-between">
            {manualSteps.map((step, i) => {
              const isLast = i === manualSteps.length - 1
              const isDone = i < currentStep
              const isCurrent = i === currentStep
              // 区分核心步骤 vs 后处理步骤（用不同颜色）
              const isExtra = step === 'Import' || step === 'ProLink'
              return (
                <div key={step} className={cn('flex items-center', isLast ? '' : 'flex-1 min-w-0')}>
                  <div
                    className={cn(
                      'flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold transition-all flex-shrink-0',
                      isDone && (isExtra
                        ? 'bg-cyan-500 text-white shadow-sm shadow-cyan-500/30'
                        : 'bg-green-500 text-white shadow-sm shadow-green-500/30'),
                      isCurrent && 'bg-primary text-primary-foreground animate-pulse shadow-sm shadow-primary/30',
                      !isDone && !isCurrent && 'bg-muted text-muted-foreground'
                    )}
                  >
                    {isDone ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                  </div>
                  <span
                    className={cn(
                      'ml-1.5 text-xs font-medium whitespace-nowrap',
                      (isDone || isCurrent) ? 'text-foreground' : 'text-muted-foreground'
                    )}
                  >
                    {step}
                  </span>
                  {!isLast && (
                    <div
                      className={cn(
                        'flex-1 h-0.5 mx-2 transition-colors',
                        isDone
                          ? (isExtra ? 'bg-cyan-500' : 'bg-green-500')
                          : 'bg-muted'
                      )}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 操作区 */}
      <Card className="hover-lift">
        <CardContent className="pt-5 space-y-4">
          {/* 手动模式 email/otp 输入 */}
          {mode === 'manual' && phase === 'email' && (
            <div className="space-y-4 p-4 bg-muted/30 rounded-lg border border-dashed">
              <div className="space-y-1.5">
                <Label>{t('register.emailLabel')}</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('register.emailPlaceholder')}
                  onKeyDown={(e) => e.key === 'Enter' && submitEmail()}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t('register.fullNameRandom')}</Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder={t('register.fullNamePlaceholder')}
                />
              </div>
              <Button onClick={submitEmail} size="sm">
                <Mail className="h-4 w-4 mr-2" />
                {t('register.submitEmail')}
              </Button>
            </div>
          )}

          {mode === 'manual' && phase === 'otp' && (
            <div className="space-y-4 p-4 bg-muted/30 rounded-lg border border-dashed">
              <div className="space-y-1.5">
                <Label>{t('register.otpLabel')}</Label>
                <Input
                  value={otp}
                  onChange={(e) => setOtp(e.target.value)}
                  placeholder="123456"
                  maxLength={6}
                  className="font-mono text-lg tracking-widest"
                  onKeyDown={(e) => e.key === 'Enter' && submitOTP()}
                />
                <p className="text-xs text-muted-foreground">
                  {t('register.otpSentTo')} {email}
                </p>
              </div>
              <Button onClick={submitOTP} size="sm">
                <Key className="h-4 w-4 mr-2" />
                {t('register.submitOtp')}
              </Button>
            </div>
          )}

          {/* 按钮 */}
          <div className="flex gap-3">
            {phase === 'idle' && !batchRunning && (
              <Button
                onClick={mode === 'manual' ? startManual : startAuto}
                disabled={
                  isClientRouteMissing ||
                  (mode === 'outlook' && !outlookData.trim()) ||
                  (mode === 'tempmail' && (!tempMailDomain.trim() || !tempMailEmail.trim() || !tempMailEpin.trim())) ||
                  (mode === 'tingamefi' && (!tingamefiMailApiUrl.trim() || !tingamefiMailAdminPassword.trim() || !tingamefiMailDomain.trim()))
                }
              >
                <Play className="h-4 w-4 mr-2" />
                {t('register.startRegistration')}
              </Button>
            )}

            {(isRunning || batchRunning || phase === 'email' || phase === 'otp') && (
              <Button variant="destructive" onClick={batchRunning ? stopBatch : cancel}>
                <Square className="h-4 w-4 mr-2" />
                {t('register.cancel')}
              </Button>
            )}

            {(phase === 'done' || phase === 'finalized') && !batchRunning && (
              <Button variant="outline" onClick={reset}>
                <RotateCcw className="h-4 w-4 mr-2" />
                {t('register.newRegistration')}
              </Button>
            )}
          </div>

          {isRunning && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              {t('register.processing')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 日志（紧跟"开始注册"卡片，方便观察进度，不再放到页面最底部） */}
      {logs.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader className="py-3 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">{t('register.log')}</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => { _logs = []; setLogs([]) }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div ref={logContainerRef} className="h-48 overflow-y-auto p-3 font-mono text-xs space-y-0.5 bg-muted/20">
              {logs.map((line, i) => (
                <div key={i} className="text-muted-foreground leading-relaxed">{line}</div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 批量注册 (非手动模式) */}
      {mode !== 'manual' && (
        <Card className="hover-lift">
          <CardHeader className="pb-3 flex flex-row items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Play className="h-4 w-4 text-primary" />
              {t('register.batchTitle')}
            </CardTitle>
            {/* 策略模板 */}
            <div className="relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowTemplatesMenu(!showTemplatesMenu)}
                disabled={batchRunning}
              >
                <Settings2 className="h-4 w-4 mr-1" />
                {isEn ? 'Templates' : 'Mẫu'} ({templates.length})
              </Button>
              {showTemplatesMenu && (
                <div className="absolute right-0 top-full mt-2 z-50 min-w-[280px] max-h-[400px] overflow-y-auto bg-popover border rounded-lg shadow-lg p-2">
                  <div className="flex items-center justify-between mb-2 px-2">
                    <span className="text-xs font-medium uppercase text-muted-foreground">{isEn ? 'Strategy Templates' : 'Mẫu chiến lược'}</span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" onClick={saveCurrentAsTemplate} className="h-7 text-xs">
                        <Download className="h-3 w-3 mr-1" />
                        {isEn ? 'Save current' : 'Lưu hiện tại'}
                      </Button>
                      {/* C8: 导入/导出 */}
                      <button
                        type="button"
                        onClick={() => {
                          const blob = new Blob([JSON.stringify(templates, null, 2)], { type: 'application/json' })
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `kiro-register-templates-${new Date().toISOString().slice(0, 10)}.json`
                          a.click()
                          setTimeout(() => URL.revokeObjectURL(url), 1000)
                        }}
                        title={isEn ? 'Export all templates' : 'Xuất tất cả mẫu'}
                        className="p-1 rounded hover:bg-muted text-muted-foreground"
                      >
                        <Download className="h-3 w-3" />
                      </button>
                      <label className="p-1 rounded hover:bg-muted text-muted-foreground cursor-pointer" title={isEn ? 'Import templates' : 'Nhập mẫu'}>
                        <input
                          type="file"
                          accept="application/json,.json"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            try {
                              const text = await file.text()
                              const arr = JSON.parse(text) as RegisterTemplate[]
                              if (!Array.isArray(arr)) throw new Error('Định dạng tệp không hợp lệ')
                              const merged = [...arr, ...templates]
                              // 按 ID 去重，新文件优先
                              const seen = new Set<string>()
                              const dedup: RegisterTemplate[] = []
                              for (const t of merged) {
                                if (seen.has(t.id)) continue
                                seen.add(t.id)
                                dedup.push(t)
                              }
                              setTemplates(dedup)
                              saveTemplates(dedup)
                              addLog(`[Mẫu] Đã nhập ${arr.length} mẫu`)
                            } catch (err) {
                              alert(`Nhập thất bại: ${err instanceof Error ? err.message : String(err)}`)
                            }
                            e.currentTarget.value = ''
                          }}
                        />
                        <Upload className="h-3 w-3" />
                      </label>
                    </div>
                  </div>
                  <div className="border-t mb-1" />
                  {templates.length === 0 ? (
                    <div className="py-6 text-center text-xs text-muted-foreground">
                      {isEn ? 'No templates yet. Click "Save current" to save the current config as a template.' : 'Chưa có mẫu. Bấm "Lưu hiện tại" để lưu cấu hình đang dùng thành mẫu.'}
                    </div>
                  ) : (
                    templates.map((tpl) => (
                      <div
                        key={tpl.id}
                        className="flex items-center justify-between gap-2 px-2 py-1.5 hover:bg-muted rounded transition-colors"
                      >
                        <button
                          onClick={() => applyTemplate(tpl)}
                          className="flex-1 text-left min-w-0"
                        >
                          <div className="text-sm truncate">{tpl.name}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {tpl.config.mode} · {isEn ? 'count' : 'Số lượng'} {tpl.config.batchCount} · {isEn ? 'conc.' : 'Song song'} {tpl.config.batchConcurrency}
                          </div>
                        </button>
                        <button
                          onClick={() => removeTemplate(tpl.id)}
                          className="p-1 rounded hover:bg-destructive/10 text-destructive"
                          title={isEn ? 'Delete' : 'Xóa'}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* 配置行 */}
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchCount')}</Label>
                <Input
                  type="number" min={1} max={100}
                  value={batchCount}
                  onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setBatchCount(v) }}
                  onBlur={() => { if (batchCount < 1) setBatchCount(1) }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchInterval')}</Label>
                <Input
                  type="number" min={0} max={300}
                  value={batchInterval}
                  onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 0) setBatchInterval(v) }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchRetries')}</Label>
                <Input
                  type="number" min={0} max={10}
                  value={batchRetries}
                  onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 0) setBatchRetries(v) }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('register.batchConcurrency')}</Label>
                <Input
                  type="number" min={1} max={100}
                  value={batchConcurrency}
                  onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v) && v >= 1) setBatchConcurrency(v) }}
                  onBlur={() => { if (batchConcurrency < 1) setBatchConcurrency(1) }}
                  disabled={batchRunning}
                  className="w-24"
                />
              </div>
              <Button
                variant={batchRunning ? 'destructive' : 'default'}
                onClick={batchRunning ? stopBatch : () => void startBatch()}
                disabled={
                  (!batchRunning && isRunning) ||
                  (!batchRunning && isClientRouteMissing) ||
                  (mode === 'outlook' && !outlookData.trim()) ||
                  (mode === 'tempmail' && (!tempMailDomain.trim() || !tempMailEmail.trim() || !tempMailEpin.trim())) ||
                  (mode === 'tingamefi' && (!tingamefiMailApiUrl.trim() || !tingamefiMailAdminPassword.trim() || !tingamefiMailDomain.trim())) ||
                  (mode === 'mixed' && pickNextSource() == null)
                }
              >
                {batchRunning ? <><Square className="h-4 w-4 mr-2" />{t('register.batchStop')}</> : <><Play className="h-4 w-4 mr-2" />{t('register.batchStart')}</>}
              </Button>
              {batchRunning && (
                <Button variant="outline" onClick={togglePauseBatch} title={isPaused ? 'Tiếp tục' : 'Tạm dừng'}>
                  {isPaused ? <><Play className="h-4 w-4 mr-2" />{isEn ? 'Resume' : 'Tiếp tục'}</> : <><Pause className="h-4 w-4 mr-2" />{isEn ? 'Pause' : 'Tạm dừng'}</>}
                </Button>
              )}
            </div>

            {/* 定时任务 + 每日配额 */}
            <div className="flex items-center gap-4 flex-wrap p-3 rounded-lg bg-muted/30 border border-dashed">
              <div className="flex items-center gap-2">
                <Switch checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} disabled={batchRunning} />
                <Label className="text-sm cursor-pointer flex items-center gap-1.5">
                  <CalendarClock className="h-4 w-4 text-primary" />
                  Lên lịch chạy
                </Label>
              </div>
              {scheduleEnabled && (
                <>
                  <div className="flex items-center gap-1.5 text-xs">
                    <Input
                      type="time"
                      value={scheduleTime}
                      onChange={(e) => setScheduleTime(e.target.value)}
                      disabled={batchRunning}
                      className="h-8 w-28 text-xs"
                    />
                  </div>
                  {/* C6: 星期选择 */}
                  <div className="flex items-center gap-1 text-xs">
                    {(isEn ? ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] : ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']).map((label, i) => {
                      const checked = !!(scheduleWeekMask & (1 << i))
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setScheduleWeekMask(scheduleWeekMask ^ (1 << i))}
                          disabled={batchRunning}
                          className={cn(
                            'w-7 h-7 rounded text-[10px] border transition-colors',
                            checked
                              ? 'border-primary bg-primary/10 text-primary font-medium'
                              : 'border-border text-muted-foreground hover:border-primary/50'
                          )}
                        >
                          {label}
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      onClick={() => setScheduleWeekMask(scheduleWeekMask === 127 ? 0b0111110 : 127)}
                      disabled={batchRunning}
                      className="text-[10px] text-primary hover:underline ml-1"
                      title={isEn ? 'Toggle: all / weekdays only' : 'Chuyển: tất cả / chỉ ngày làm việc'}
                    >
                      {scheduleWeekMask === 127 ? (isEn ? 'Weekdays' : 'Ngày làm việc') : (isEn ? 'Daily' : 'Hàng ngày')}
                    </button>
                  </div>
                </>
              )}
              <div className="w-px h-6 bg-border" />
              <div className="flex items-center gap-1.5 text-xs">
                <Timer className="h-4 w-4 text-primary" />
                <span className="text-muted-foreground">{isEn ? 'Daily quota:' : 'Quota mỗi ngày:'}</span>
                <Input
                  type="number" min={0} max={9999}
                  value={dailyQuotaLimit}
                  onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) setDailyQuotaLimit(v) }}
                  disabled={batchRunning}
                  className="h-8 w-20 text-xs text-center"
                />
                <span className="text-muted-foreground">{isEn ? '/day' : '/ngày'}</span>
                {dailyQuotaLimit > 0 && (
                  <>
                    <Badge
                      variant="outline"
                      className={cn(
                        'text-[10px]',
                        dailyQuotaUsed >= dailyQuotaLimit
                          ? 'text-red-600 border-red-200'
                          : dailyQuotaUsed >= dailyQuotaLimit * 0.8
                            ? 'text-amber-600 border-amber-200'
                            : 'text-muted-foreground'
                      )}
                    >
                      {isEn ? 'Today' : 'Hôm nay'}: {dailyQuotaUsed} / {dailyQuotaLimit}
                    </Badge>
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(isEn ? `Reset today's used quota (currently ${dailyQuotaUsed})?` : `Đặt lại quota đã dùng hôm nay (hiện tại ${dailyQuotaUsed})?`)) {
                          setDailyQuotaUsedState(0)
                          try { localStorage.setItem(dailyQuotaKey, '0') } catch { /* ignore */ }
                          addLog('[Hạn mức] Đã đặt lại bộ đếm hạn mức hôm nay')
                        }
                      }}
                      className="text-[10px] text-muted-foreground hover:text-foreground underline"
                      title={isEn ? "Manually reset today's used quota" : 'Đặt lại thủ công quota đã dùng hôm nay'}
                    >
                      {isEn ? 'Reset' : 'Đặt lại'}
                    </button>
                  </>
                )}
                {dailyQuotaLimit === 0 && (
                  <span className="text-[10px] text-muted-foreground italic">{isEn ? '(0 = unlimited)' : '(0 = không giới hạn)'}</span>
                )}
              </div>
            </div>

            {/* 限速 + 退避配置 */}
            <div className="flex items-center gap-4 flex-wrap p-3 rounded-lg bg-muted/30 border border-dashed">
              <div className="flex items-center gap-2">
                <Switch checked={rateLimitEnabled} onCheckedChange={setRateLimitEnabled} disabled={batchRunning} />
                <Label className="text-sm cursor-pointer flex items-center gap-1.5">
                  <Gauge className="h-4 w-4 text-primary" />
                  {isEn ? 'Rate limit' : 'Giới hạn tốc độ'}
                </Label>
              </div>
              {rateLimitEnabled && (
                <>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">{isEn ? 'Max launch rate:' : 'Tốc độ khởi chạy tối đa:'}</span>
                    <Input
                      type="number" min={1} max={300}
                      value={maxPerMinute}
                      onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setMaxPerMinute(v) }}
                      disabled={batchRunning}
                      className="w-20 h-8 text-xs text-center"
                    />
                    <span className="text-muted-foreground">{isEn ? '/ min' : '/ phút'}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={autoBackoff} onCheckedChange={setAutoBackoff} disabled={batchRunning} />
                    <Label className="text-xs cursor-pointer">
                      {isEn ? 'Auto backoff on consecutive failures (exponential)' : 'Tự giãn cách khi lỗi liên tiếp (lũy tiến)'}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch checked={autoPauseOnRisk} onCheckedChange={setAutoPauseOnRisk} disabled={batchRunning} />
                    <Label className="text-xs cursor-pointer flex items-center gap-1">
                      <ShieldAlert className="h-3 w-3 text-amber-500" />
                      {isEn ? 'Auto pause on risk control' : 'Tự tạm dừng khi gặp kiểm soát rủi ro'}
                    </Label>
                  </div>
                  {/* C3: 高级配置 */}
                  <div className="w-full flex items-center gap-3 text-xs flex-wrap pt-2 border-t border-dashed">
                    <span className="text-muted-foreground">{isEn ? 'Advanced:' : 'Nâng cao:'}</span>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">{isEn ? 'Burst cap' : 'Giới hạn burst'}</span>
                      <Input
                        type="number" min={1} max={100}
                        value={burstSize}
                        onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setBurstSize(v) }}
                        disabled={batchRunning}
                        className="w-16 h-7 text-xs text-center"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">{isEn ? 'Backoff start' : 'Giãn cách ban đầu'}</span>
                      <Input
                        type="number" min={1} max={300}
                        value={backoffBaseSec}
                        onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setBackoffBaseSec(v) }}
                        disabled={batchRunning}
                        className="w-16 h-7 text-xs text-center"
                      />
                      <span className="text-muted-foreground">{isEn ? 'sec' : 'giây'}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-muted-foreground">{isEn ? 'Backoff cap' : 'Giới hạn giãn cách'}</span>
                      <Input
                        type="number" min={1} max={3600}
                        value={backoffMaxSec}
                        onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) setBackoffMaxSec(v) }}
                        disabled={batchRunning}
                        className="w-20 h-7 text-xs text-center"
                      />
                      <span className="text-muted-foreground">{isEn ? 'sec' : 'giây'}</span>
                    </div>
                  </div>
                </>
              )}
              {!rateLimitEnabled && (
                <span className="text-xs text-muted-foreground">
                  {isEn
                    ? 'When enabled, a token bucket paces launches and auto-extends intervals on consecutive failures.'
                    : 'Khi bật, hệ thống dùng token bucket để kiểm soát nhịp khởi chạy và tự kéo dài khoảng chờ khi lỗi liên tiếp'}
                </span>
              )}
            </div>

            {/* 运行中：实时速率 + 风控信号 */}
            {batchRunning && rateSnapshot && (
              <div className={cn(
                'p-3 rounded-lg border space-y-2 transition-colors',
                rateSnapshot.riskWarning
                  ? 'bg-red-50 dark:bg-red-950/20 border-red-300 dark:border-red-800'
                  : (rateSnapshot.backoffRemainingMs > 0
                    ? 'bg-amber-50 dark:bg-amber-950/20 border-amber-300 dark:border-amber-800'
                    : 'bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-800')
              )}>
                <div className="flex items-center gap-2">
                  {rateSnapshot.riskWarning ? (
                    <>
                      <ShieldAlert className="h-4 w-4 text-red-500 animate-pulse" />
                      <span className="text-sm font-medium text-red-600 dark:text-red-400">
                        {isEn ? 'Risk warning: success rate too low' : 'Cảnh báo rủi ro: tỷ lệ thành công quá thấp'} ({Math.round(rateSnapshot.successRate * 100)}%)
                      </span>
                    </>
                  ) : rateSnapshot.backoffRemainingMs > 0 ? (
                    <>
                      <Clock className="h-4 w-4 text-amber-500" />
                      <span className="text-sm font-medium text-amber-600 dark:text-amber-400">
                        {isEn ? `Backing off: resuming in ${Math.ceil(rateSnapshot.backoffRemainingMs / 1000)}s` : `Đang giãn cách: tiếp tục sau ${Math.ceil(rateSnapshot.backoffRemainingMs / 1000)} giây`}
                      </span>
                    </>
                  ) : (
                    <>
                      <Activity className="h-4 w-4 text-blue-500" />
                      <span className="text-sm font-medium text-blue-600 dark:text-blue-400">{isEn ? 'Running' : 'Đang chạy'}</span>
                    </>
                  )}
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{isEn ? 'Throughput:' : 'Thông lượng:'}</span>
                    <span className="font-mono tabular-nums">{rateSnapshot.throughputPerMinute}/min</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{isEn ? 'Success rate:' : 'Tỷ lệ thành công:'}</span>
                    <span className={cn(
                      'font-mono tabular-nums font-medium',
                      rateSnapshot.successRate >= 0.8 ? 'text-green-600' :
                      rateSnapshot.successRate >= 0.5 ? 'text-amber-600' : 'text-red-600'
                    )}>{Math.round(rateSnapshot.successRate * 100)}%</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{isEn ? 'Window:' : 'Cửa sổ:'}</span>
                    <span className="font-mono tabular-nums">
                      <span className="text-green-600">✓{rateSnapshot.windowSuccess}</span>
                      <span className="text-muted-foreground mx-0.5">/</span>
                      <span className="text-red-500">✗{rateSnapshot.windowFailed}</span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">{isEn ? 'Consec. fails:' : 'Lỗi liên tiếp:'}</span>
                    <span className={cn(
                      'font-mono tabular-nums',
                      rateSnapshot.consecutiveFailures >= 3 ? 'text-red-600 font-medium' : ''
                    )}>{rateSnapshot.consecutiveFailures}</span>
                  </div>
                </div>
              </div>
            )}

            {/* 失败重试面板（仅有失败时显示） */}
            {!batchRunning && batchFail > 0 && batchItems.some(it => it.status === 'failed' || it.status === 'import_failed') && (() => {
              // 按错误类型分桶
              const buckets: Record<string, number> = { network: 0, otp_timeout: 0, email_used: 0, rate_limit: 0, risk_control: 0, auth: 0, unknown: 0 }
              for (const it of batchItems) {
                if (it.status !== 'failed' && it.status !== 'import_failed') continue
                const k = classifyError(it.error)
                buckets[k] = (buckets[k] || 0) + 1
              }
              const labels: Record<string, string> = isEn ? {
                network: 'Network error',
                otp_timeout: 'OTP timeout',
                email_used: 'Email in use',
                rate_limit: 'Rate limited',
                risk_control: 'AWS risk control',
                auth: 'Auth error',
                unknown: 'Other/Unknown'
              } : {
                network: 'Lỗi mạng',
                otp_timeout: 'OTP quá hạn',
                email_used: 'Email đã được dùng',
                rate_limit: 'Bị giới hạn tốc độ',
                risk_control: 'AWS kiểm soát rủi ro',
                auth: 'Lỗi xác thực',
                unknown: 'Khác/không rõ'
              }
              return (
                <div className="p-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600" />
                    <span className="text-sm font-medium">{isEn ? `${batchFail} tasks failed` : `${batchFail} tác vụ thất bại`}</span>
                    <Button size="sm" variant="default" className="ml-auto" onClick={() => retryFailed('all')}>
                      <RefreshCw className="h-3.5 w-3.5 mr-1" />
                      {isEn ? 'Retry all' : 'Thử lại tất cả'}
                    </Button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(buckets).filter(([, c]) => c > 0).map(([k, c]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => retryFailed(k as 'network' | 'otp_timeout' | 'rate_limit' | 'all')}
                        className="px-2 py-0.5 rounded text-[10px] bg-amber-100 dark:bg-amber-900/40 text-amber-900 dark:text-amber-100 hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors"
                        title={isEn ? 'Click to retry this category' : 'Bấm để thử lại nhóm lỗi này'}
                      >
                        {labels[k]} ({c})
                      </button>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* 进度 + 每项状态 */}
            {(batchRunning || batchDone > 0) && (
              <div className="space-y-3">
                <div className={cn(
                  'border rounded-md px-3 py-2.5 space-y-2',
                  batchNetworkChanged
                    ? 'border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/20'
                    : 'border-emerald-200 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20'
                )}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Network className={cn('h-4 w-4', batchNetworkChanged ? 'text-red-600' : 'text-emerald-600')} />
                    <span className="text-sm font-medium">
                      {isEn ? 'Stable batch network route' : 'Kết nối mạng ổn định cho batch'}
                    </span>
                    <Badge
                      variant="outline"
                      className={cn(
                        'ml-auto',
                        batchNetworkChanged
                          ? 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300'
                          : 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300'
                      )}
                    >
                      <Lock className="h-3 w-3 mr-1" />
                      {batchNetworkChanged
                        ? (isEn ? 'Route changed - stopped' : 'IP đã đổi - batch đã dừng')
                        : batchLockedExitIp
                          ? (isEn ? 'Exit IP locked' : 'Đã khóa IP đầu ra')
                          : (isEn ? 'Checking exit IP' : 'Đang kiểm tra IP đầu ra')}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {isEn ? 'Route' : 'Route'}: {networkSource === 'client-proxy'
                        ? (isEn ? 'Client proxy/helper from personal machine' : 'Proxy/helper tren may ca nhan')
                        : proxyPoolConfig.enabled
                        ? (isEn ? 'One pinned proxy session for the entire batch' : 'Một proxy/session cố định cho toàn bộ batch')
                        : (isEn ? 'Direct/system VPN connection' : 'Kết nối trực tiếp/VPN hệ thống')}
                    </span>
                    <span className="font-mono">
                      {isEn ? 'Exit IP' : 'IP đầu ra'}: {batchLockedExitIp || (isEn ? 'waiting...' : 'đang chờ...')}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isEn
                      ? 'The batch automatically stops if the observed exit IP changes.'
                      : 'Batch sẽ tự động dừng nếu hệ thống phát hiện IP đầu ra thay đổi.'}
                  </p>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  <span className="font-medium">{t('register.batchProgress')}: {batchProgressDone}/{batchProgressTotal}</span>
                  <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50 dark:bg-green-950/30">{t('register.batchSuccess')}: {batchSuccess}</Badge>
                  <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50 dark:bg-red-950/30">{t('register.batchFail')}: {batchFail}</Badge>
                </div>
                <Progress value={batchProgressTotal > 0 ? (batchProgressDone / batchProgressTotal) * 100 : 0} className="h-2" />

                {/* 每项状态列表 */}
                {batchItems.length > 0 && (
                  <div className="max-h-60 overflow-y-auto border rounded-lg bg-muted/20">
                    {batchItems.map((item) => <BatchItemRow key={item.id} item={item} t={t} batchClock={batchClock} />)}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 结果 */}
      <RemoteKrouterSyncPanel
        isEn={isEn}
        accountCount={accounts.size}
        targetUrl={remoteSyncUrl}
        setTargetUrl={setRemoteSyncUrl}
        syncPassword={remoteSyncPassword}
        setSyncPassword={setRemoteSyncPassword}
        isSyncing={remoteSyncRunning}
        result={remoteSyncResult}
        onSync={() => void handleRemoteSync()}
      />

      {result && (
        <Card className={cn('border shadow-sm',
          result.status === 'success' ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
        )}>
          <CardContent className="pt-5 space-y-3">
            <div className="flex items-center gap-2">
              {result.status === 'success' ? (
                <div className="p-1.5 rounded-full bg-green-100 dark:bg-green-900/50">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
              ) : (
                <div className="p-1.5 rounded-full bg-red-100 dark:bg-red-900/50">
                  <XCircle className="h-5 w-5 text-red-600" />
                </div>
              )}
              <h3 className="text-lg font-semibold">
                {result.status === 'success' ? t('register.success') : t('register.failed')}
              </h3>
            </div>

            {result.status === 'success' && (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm p-3 bg-background/50 rounded-lg">
                  <div><span className="text-muted-foreground">{t('register.emailField')}</span> <span className="font-mono font-medium">{result.email}</span></div>
                  <div><span className="text-muted-foreground">{t('register.passwordField')}</span> <span className="font-mono font-medium">{result.password}</span></div>
                </div>
                <Button
                  onClick={importAccount}
                  disabled={imported}
                  variant={imported ? 'outline' : 'default'}
                  className={imported ? 'text-green-600 border-green-300' : ''}
                  size="sm"
                >
                  {imported ? (
                    <><CheckCircle2 className="h-4 w-4 mr-2" />{t('register.imported')}</>
                  ) : (
                    <><UserPlus className="h-4 w-4 mr-2" />{t('register.importToManager')}</>
                  )}
                </Button>
              </>
            )}

            {result.status === 'failed' && (
              <RegistrationErrorDiagnosisPanel error={result.error} />
            )}
          </CardContent>
        </Card>
      )}

      {/* 注册结果分析报表（视觉升级版） */}
      {history.length >= 5 && <RegisterAnalyticsReport history={history} />}

      {/* 占用邮箱黑名单管理 */}
      <EmailBlacklistManager />

      {/* 注册历史 */}
      {history.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader className="py-3 border-b">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" />
                {t('register.historyTitle')} ({history.length})
              </CardTitle>
              <Button variant="ghost" size="sm" onClick={() => setHistory([])}>
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {t('register.historyClear')}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-48 overflow-y-auto">
              {history.map((item) => {
                const fp = item.result?.fingerprint
                const failedError = item.status === 'failed' ? (item.error || item.result?.error) : undefined
                return (
                  <div key={item.id} className="border-b last:border-b-0 hover:bg-muted/50 transition-colors">
                    <div className="flex items-center justify-between px-4 py-2.5">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                      {item.status === 'success' ? <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" /> : <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />}
                      <span className="font-mono text-xs truncate">{item.email}</span>
                      <span className="text-xs text-muted-foreground flex-shrink-0">{new Date(item.time).toLocaleTimeString()}</span>
                      {/* 指纹摘要徽章（B7） */}
                      {fp && (
                        <span
                          className="text-[9px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono flex-shrink-0 cursor-help"
                          title={`Chrome ${fp.chromeVer}\nUA: ${fp.ua}\nGPU: ${fp.gpuVendor} ${fp.gpuModel}\nCanvas: ${fp.canvasHash}\nScreen: ${fp.screen.width}x${fp.screen.height}\nProxy: ${fp.proxyUrl || '(direct)'}\nExit IP: ${fp.exitIP || 'N/A'}`}
                        >
                          🔒 {fp.chromeVer.split('.')[0]}・{fp.screen.width}×{fp.screen.height}{fp.exitIP ? `・${fp.exitIP}` : ''}
                        </span>
                      )}
                      </div>
                    {item.status === 'success' && item.result?.refreshToken && (
                      <Badge
                        variant="outline"
                        className={cn('cursor-pointer text-xs', item.imported ? 'text-green-600 border-green-200' : 'text-primary border-primary/30 hover:bg-primary/10')}
                        onClick={() => !item.imported && importHistoryItem(item)}
                      >
                        {item.imported ? t('register.imported') : t('register.historyImport')}
                      </Badge>
                    )}
                    </div>
                    {failedError && (
                      <div className="px-4 pb-3 pl-11">
                        <RegistrationErrorDiagnosisPanel error={failedError} compact />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

    </div>
  )
}

// ============ 注册结果分析报表（视觉升级版） ============

interface RegisterAnalyticsProps {
  history: HistoryItem[]
}

function RegisterAnalyticsReport({ history }: RegisterAnalyticsProps): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const analytics = useMemo(() => {
    const total = history.length
    let success = 0, failed = 0
    const byMode: Record<string, { success: number; failed: number }> = {}
    const byHour: Record<number, { success: number; failed: number }> = {}
    const byDay: Record<string, { success: number; failed: number }> = {}  // 7 日趋势
    const errorBuckets: Record<string, number> = {}

    const now = Date.now()
    // 准备最近 7 天的桶（含今天）
    const sevenDays: string[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 86400000)
      const key = `${d.getMonth() + 1}/${d.getDate()}`
      sevenDays.push(key)
      byDay[key] = { success: 0, failed: 0 }
    }

    for (const h of history) {
      if (h.status === 'success') success++; else failed++
      const m = (h.result as { provider?: string } | undefined)?.provider || 'BuilderId'
      if (!byMode[m]) byMode[m] = { success: 0, failed: 0 }
      if (h.status === 'success') byMode[m].success++; else byMode[m].failed++
      const dt = new Date(h.time)
      const hr = dt.getHours()
      if (!byHour[hr]) byHour[hr] = { success: 0, failed: 0 }
      if (h.status === 'success') byHour[hr].success++; else byHour[hr].failed++
      // 日桶（7 天内）
      const dayKey = `${dt.getMonth() + 1}/${dt.getDate()}`
      if (byDay[dayKey]) {
        if (h.status === 'success') byDay[dayKey].success++; else byDay[dayKey].failed++
      }
      if (h.status === 'failed') {
        const cat = classifyError(h.error)
        errorBuckets[cat] = (errorBuckets[cat] || 0) + 1
      }
    }
    const successRate = total > 0 ? success / total : 0
    const peakHours = Object.entries(byHour)
      .filter(([, v]) => v.success + v.failed >= 2)  // 至少 2 个样本
      .sort((a, b) => {
        const ar = a[1].success / (a[1].success + a[1].failed)
        const br = b[1].success / (b[1].success + b[1].failed)
        return br - ar
      })
      .slice(0, 3)
    const topErrors = Object.entries(errorBuckets).sort((a, b) => b[1] - a[1])

    return { total, success, failed, successRate, byMode, byHour, byDay, sevenDays, peakHours, topErrors }
  }, [history])

  const handleExportCSV = useCallback((): void => {
    const lines = ['time,email,status,error,password']
    for (const h of history) {
      const csvEsc = (v: string | undefined): string => {
        if (!v) return ''
        const escaped = v.replace(/"/g, '""')
        return /[,"\n]/.test(escaped) ? `"${escaped}"` : escaped
      }
      lines.push([
        new Date(h.time).toISOString(),
        csvEsc(h.email),
        h.status,
        csvEsc(h.error),
        csvEsc(h.password)
      ].join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `register-history-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, [history])

  const errorLabels: Record<string, { label: string; color: string }> = {
    network: { label: isEn ? 'Network error' : 'Lỗi mạng', color: 'bg-blue-500' },
    otp_timeout: { label: isEn ? 'OTP timeout' : 'OTP quá hạn', color: 'bg-amber-500' },
    email_used: { label: isEn ? 'Email in use' : 'Email đã được dùng', color: 'bg-slate-500' },
    rate_limit: { label: isEn ? 'Rate limited' : 'Bị giới hạn tốc độ', color: 'bg-orange-500' },
    risk_control: { label: isEn ? 'AWS risk control' : 'AWS kiểm soát rủi ro', color: 'bg-red-500' },
    auth: { label: isEn ? 'Auth error' : 'Lỗi xác thực', color: 'bg-purple-500' },
    unknown: { label: isEn ? 'Other/Unknown' : 'Khác/không rõ', color: 'bg-gray-500' }
  }

  const successColor = analytics.successRate >= 0.85 ? '#22c55e'
    : analytics.successRate >= 0.6 ? '#f59e0b' : '#ef4444'

  // SVG 圆环图参数
  const ringRadius = 36
  const ringStroke = 8
  const ringCircum = 2 * Math.PI * ringRadius
  const ringOffset = ringCircum * (1 - analytics.successRate)

  return (
    <Card className="hover-lift overflow-hidden">
      <CardHeader className="pb-2 bg-gradient-to-br from-primary/5 to-transparent">
        <CardTitle className="text-sm flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-primary/10">
            <Activity className="h-4 w-4 text-primary" />
          </div>
          <span>{isEn ? 'Registration Analytics' : 'Phân tích kết quả đăng ký'}</span>
          <Badge variant="outline" className="text-[10px] ml-auto">
            {isEn ? 'Samples' : 'Mẫu'} {analytics.total}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-[10px] -mr-1"
            onClick={handleExportCSV}
          >
            <Download className="h-3 w-3 mr-1" />
            CSV
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        {/* 顶部：圆环图 + 关键指标 */}
        <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-4 items-center">
          {/* 圆环图 */}
          <div className="relative flex items-center justify-center">
            <svg width="120" height="120" viewBox="0 0 100 100">
              {/* 底圈 */}
              <circle
                cx="50" cy="50" r={ringRadius}
                fill="none"
                stroke="currentColor"
                strokeWidth={ringStroke}
                opacity="0.1"
              />
              {/* 成功率圈 */}
              <circle
                cx="50" cy="50" r={ringRadius}
                fill="none"
                stroke={successColor}
                strokeWidth={ringStroke}
                strokeLinecap="round"
                strokeDasharray={ringCircum}
                strokeDashoffset={ringOffset}
                transform="rotate(-90 50 50)"
                className="transition-all duration-700"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-2xl font-bold tabular-nums" style={{ color: successColor }}>
                {Math.round(analytics.successRate * 100)}%
              </div>
              <div className="text-[10px] text-muted-foreground">{isEn ? 'Success rate' : 'Tỷ lệ thành công'}</div>
            </div>
          </div>

          {/* 关键指标 */}
          <div className="grid grid-cols-2 gap-2">
            <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">{isEn ? 'Success' : 'Thành công'}</span>
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              </div>
              <div className="text-xl font-bold tabular-nums text-green-600 mt-0.5">{analytics.success}</div>
            </div>
            <div className="p-3 rounded-lg bg-red-500/5 border border-red-500/20">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">{isEn ? 'Failed' : 'Thất bại'}</span>
                <XCircle className="h-3 w-3 text-red-500" />
              </div>
              <div className="text-xl font-bold tabular-nums text-red-600 mt-0.5">{analytics.failed}</div>
            </div>
            <div className="p-3 rounded-lg bg-blue-500/5 border border-blue-500/20 col-span-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {isEn ? 'Top 3 success hours' : 'Top 3 khung giờ thành công'}
                </span>
              </div>
              {analytics.peakHours.length === 0 ? (
                <p className="text-xs text-muted-foreground">{isEn ? 'Not enough data' : 'Chưa đủ dữ liệu'}</p>
              ) : (
                <div className="flex gap-2">
                  {analytics.peakHours.map(([h, v]) => {
                    const sr = Math.round(v.success / (v.success + v.failed) * 100)
                    return (
                      <div key={h} className="flex-1 text-center">
                        <div className="text-sm font-bold font-mono">{h.padStart(2, '0')}:00</div>
                        <div className="text-[10px] text-green-600 font-mono">{sr}%</div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 24 小时分布（SVG 平滑曲线 + 渐变填充） */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium">{isEn ? '24-hour distribution' : 'Phân bố 24 giờ'}</span>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500" /> {isEn ? 'Success' : 'Thành công'}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500" /> {isEn ? 'Failed' : 'Thất bại'}
              </span>
            </div>
          </div>
          <HourDistributionChart byHour={analytics.byHour} />
        </div>

        {/* 7 日趋势 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium">{isEn ? '7-day trend' : 'Xu hướng 7 ngày'}</span>
            <span className="text-[10px] text-muted-foreground">{isEn ? 'Registrations' : 'Lượt đăng ký'}</span>
          </div>
          <SevenDayChart sevenDays={analytics.sevenDays} byDay={analytics.byDay} />
        </div>

        {/* 失败原因分布（精致版） */}
        {analytics.topErrors.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium">{isEn ? 'Failure reasons' : 'Phân bố lý do thất bại'}</span>
              <span className="text-[10px] text-muted-foreground">{isEn ? `${analytics.failed} failures total` : `Tổng ${analytics.failed} lần thất bại`}</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {analytics.topErrors.map(([cat, count]) => {
                const meta = errorLabels[cat] || { label: cat, color: 'bg-gray-500' }
                const pct = Math.round((count / analytics.failed) * 100)
                return (
                  <div key={cat} className="p-2 rounded-lg border bg-card hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-2 mb-1">
                      <div className={cn('w-2 h-2 rounded-full', meta.color)} />
                      <span className="text-xs font-medium flex-1 truncate">{meta.label}</span>
                      <span className="text-xs font-mono tabular-nums text-muted-foreground">{count}</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className={cn('h-full transition-all', meta.color)} style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-right text-[10px] text-muted-foreground tabular-nums mt-0.5">{pct}%</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 登录方式对比 */}
        {Object.keys(analytics.byMode).length > 1 && (
          <div>
            <div className="text-xs font-medium mb-2">{isEn ? 'Mode comparison' : 'So sánh phương thức đăng ký'}</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {Object.entries(analytics.byMode).map(([m, v]) => {
                const tot = v.success + v.failed
                const sr = tot > 0 ? Math.round(v.success / tot * 100) : 0
                const srColor = sr >= 80 ? 'text-green-600' : sr >= 50 ? 'text-amber-600' : 'text-red-600'
                const srBg = sr >= 80 ? 'bg-green-500' : sr >= 50 ? 'bg-amber-500' : 'bg-red-500'
                return (
                  <div key={m} className="p-3 rounded-lg border bg-card">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium">{m}</span>
                      <span className={cn('text-xs font-mono tabular-nums font-bold', srColor)}>{sr}%</span>
                    </div>
                    <div className="h-1 bg-muted rounded-full overflow-hidden">
                      <div className={cn('h-full', srBg)} style={{ width: `${sr}%` }} />
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      ✓{v.success} / ✗{v.failed} ({isEn ? 'total' : 'Tổng'} {tot})
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** 24 小时分布 SVG 图（平滑曲线 + 渐变填充） */
function HourDistributionChart({ byHour }: { byHour: Record<number, { success: number; failed: number }> }): React.ReactNode {
  const width = 720, height = 100, padTop = 8, padBottom = 18, padX = 12
  const innerH = height - padTop - padBottom
  const stepX = (width - padX * 2) / 23  // 24 个点

  // 计算最大值
  let maxVal = 0
  for (let h = 0; h < 24; h++) {
    const v = byHour[h] || { success: 0, failed: 0 }
    maxVal = Math.max(maxVal, v.success + v.failed)
  }
  if (maxVal === 0) maxVal = 1

  const pointAt = (h: number, count: number): [number, number] => {
    const x = padX + h * stepX
    const y = padTop + innerH - (count / maxVal) * innerH
    return [x, y]
  }

  // 生成两条平滑路径
  const buildPath = (key: 'success' | 'failed'): { line: string; area: string } => {
    const points: [number, number][] = []
    for (let h = 0; h < 24; h++) {
      const v = byHour[h] || { success: 0, failed: 0 }
      points.push(pointAt(h, v[key]))
    }
    // 平滑曲线（Catmull-Rom 转 Bezier）
    let line = `M${points[0][0]},${points[0][1]}`
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? i : i - 1]
      const p1 = points[i]
      const p2 = points[i + 1]
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1]
      const cp1x = p1[0] + (p2[0] - p0[0]) / 6
      const cp1y = p1[1] + (p2[1] - p0[1]) / 6
      const cp2x = p2[0] - (p3[0] - p1[0]) / 6
      const cp2y = p2[1] - (p3[1] - p1[1]) / 6
      line += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`
    }
    // 闭合下方区域
    const area = line + ` L${padX + 23 * stepX},${padTop + innerH} L${padX},${padTop + innerH} Z`
    return { line, area }
  }

  const succ = buildPath('success')
  const fail = buildPath('failed')

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible" preserveAspectRatio="none">
      <defs>
        <linearGradient id="succGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="rgb(34 197 94)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="failGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(239 68 68)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="rgb(239 68 68)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* 网格 */}
      {[0.25, 0.5, 0.75].map((p) => (
        <line
          key={p}
          x1={padX} x2={width - padX}
          y1={padTop + innerH * p} y2={padTop + innerH * p}
          stroke="currentColor" strokeOpacity="0.06" strokeDasharray="2,3"
        />
      ))}

      {/* 失败区域和线 */}
      <path d={fail.area} fill="url(#failGradient)" />
      <path d={fail.line} fill="none" stroke="rgb(239 68 68)" strokeWidth="1.5" opacity="0.8" />

      {/* 成功区域和线 */}
      <path d={succ.area} fill="url(#succGradient)" />
      <path d={succ.line} fill="none" stroke="rgb(34 197 94)" strokeWidth="2" />

      {/* 数据点 */}
      {Array.from({ length: 24 }).map((_, h) => {
        const v = byHour[h] || { success: 0, failed: 0 }
        if (v.success === 0 && v.failed === 0) return null
        return (
          <g key={h}>
            {v.success > 0 && (() => {
              const [x, y] = pointAt(h, v.success)
              return <circle cx={x} cy={y} r="2.5" fill="rgb(34 197 94)" />
            })()}
            {v.failed > 0 && (() => {
              const [x, y] = pointAt(h, v.failed)
              return <circle cx={x} cy={y} r="2" fill="rgb(239 68 68)" />
            })()}
          </g>
        )
      })}

      {/* X 轴刻度 */}
      {[0, 6, 12, 18, 23].map((h) => {
        const x = padX + h * stepX
        return (
          <g key={h}>
            <line x1={x} x2={x} y1={padTop + innerH} y2={padTop + innerH + 3} stroke="currentColor" opacity="0.3" />
            <text x={x} y={height - 4} fontSize="9" fill="currentColor" opacity="0.5" textAnchor="middle">
              {h.toString().padStart(2, '0')}:00
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/** 7 日趋势柱状图（叠加 + 渐变） */
function SevenDayChart({ sevenDays, byDay }: {
  sevenDays: string[]
  byDay: Record<string, { success: number; failed: number }>
}): React.ReactNode {
  const width = 720, height = 80, padTop = 8, padBottom = 18, padX = 16
  const innerH = height - padTop - padBottom
  const barW = (width - padX * 2) / sevenDays.length * 0.6
  const gap = (width - padX * 2) / sevenDays.length

  let maxTotal = 0
  for (const k of sevenDays) {
    const v = byDay[k] || { success: 0, failed: 0 }
    maxTotal = Math.max(maxTotal, v.success + v.failed)
  }
  if (maxTotal === 0) maxTotal = 1

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible" preserveAspectRatio="none">
      <defs>
        <linearGradient id="barSuccGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity="1" />
          <stop offset="100%" stopColor="rgb(34 197 94)" stopOpacity="0.6" />
        </linearGradient>
        <linearGradient id="barFailGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(239 68 68)" stopOpacity="1" />
          <stop offset="100%" stopColor="rgb(239 68 68)" stopOpacity="0.6" />
        </linearGradient>
      </defs>

      {/* 网格 */}
      {[0.5].map((p) => (
        <line
          key={p}
          x1={padX} x2={width - padX}
          y1={padTop + innerH * p} y2={padTop + innerH * p}
          stroke="currentColor" strokeOpacity="0.06" strokeDasharray="2,3"
        />
      ))}

      {sevenDays.map((day, i) => {
        const v = byDay[day] || { success: 0, failed: 0 }
        const total = v.success + v.failed
        const totalH = (total / maxTotal) * innerH
        const succH = total > 0 ? (v.success / total) * totalH : 0
        const failH = total > 0 ? (v.failed / total) * totalH : 0
        const x = padX + i * gap + (gap - barW) / 2
        const yBase = padTop + innerH

        return (
          <g key={day}>
            {/* 失败（上面） */}
            {v.failed > 0 && (
              <rect
                x={x} y={yBase - totalH}
                width={barW} height={failH}
                fill="url(#barFailGrad)"
                rx="2"
              />
            )}
            {/* 成功（下面） */}
            {v.success > 0 && (
              <rect
                x={x} y={yBase - succH}
                width={barW} height={succH}
                fill="url(#barSuccGrad)"
                rx="2"
              />
            )}
            {/* 总数标签 */}
            {total > 0 && (
              <text
                x={x + barW / 2}
                y={yBase - totalH - 3}
                fontSize="9"
                fill="currentColor"
                opacity="0.6"
                textAnchor="middle"
              >
                {total}
              </text>
            )}
            {/* X 轴标签 */}
            <text
              x={x + barW / 2}
              y={height - 4}
              fontSize="10"
              fill="currentColor"
              opacity={i === sevenDays.length - 1 ? 1 : 0.5}
              fontWeight={i === sevenDays.length - 1 ? 'bold' : 'normal'}
              textAnchor="middle"
            >
              {day}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

/**
 * 占用邮箱黑名单管理（A5 边缘修复）
 * 用户可以查看 / 搜索 / 删除单个 / 清空黑名单中的邮箱
 */
function EmailBlacklistManager(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [expanded, setExpanded] = useState(false)
  const [items, setItems] = useState<string[]>(() => Array.from(loadEmailBlacklist()))
  const [filter, setFilter] = useState('')

  const refresh = useCallback((): void => {
    setItems(Array.from(loadEmailBlacklist()))
  }, [])

  const removeOne = useCallback((email: string): void => {
    const set = loadEmailBlacklist()
    set.delete(email.toLowerCase())
    saveEmailBlacklist(set)
    refresh()
  }, [refresh])

  const clearAll = useCallback((): void => {
    if (!confirm(isEn ? `Clear all ${items.length} emails from blacklist?` : `Xóa toàn bộ ${items.length} email khỏi danh sách đen?`)) return
    clearEmailBlacklist()
    refresh()
  }, [items.length, refresh, isEn])

  const filtered = useMemo(() => {
    if (!filter.trim()) return items
    const q = filter.toLowerCase()
    return items.filter((e) => e.includes(q))
  }, [items, filter])

  if (items.length === 0 && !expanded) return null

  return (
    <Card className="hover-lift">
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => { setExpanded(!expanded); if (!expanded) refresh() }}
          className="w-full flex items-center justify-between"
        >
          <CardTitle className="text-sm flex items-center gap-2">
            <XCircle className="h-4 w-4 text-amber-500" />
            {isEn ? 'Used-email blacklist' : 'Danh sách đen email đã dùng'}
            <Badge variant="outline" className="text-[10px]">{items.length}</Badge>
          </CardTitle>
          <span className="text-xs text-muted-foreground">{expanded ? (isEn ? '▼ Collapse' : '▼ Thu gọn') : (isEn ? '▶ Expand' : '▶ Mở rộng')}</span>
        </button>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={isEn ? 'Search email...' : 'Tìm email...'}
              className="h-8 text-xs max-w-xs"
            />
            <Button size="sm" variant="ghost" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> {isEn ? 'Refresh' : 'Làm mới'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive ml-auto"
              onClick={clearAll}
              disabled={items.length === 0}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" /> {isEn ? 'Clear all' : 'Xóa tất cả'}
            </Button>
          </div>

          {items.length === 0 ? (
            <div className="py-6 text-center text-xs text-muted-foreground">
              {isEn ? 'Blacklist is empty' : 'Danh sách đen đang trống'}
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {isEn ? 'No matches' : 'Không có kết quả'}
            </div>
          ) : (
            <div className="max-h-60 overflow-y-auto border rounded">
              {filtered.map((email) => (
                <div
                  key={email}
                  className="flex items-center justify-between gap-2 px-2 py-1 border-b last:border-b-0 hover:bg-muted/40 text-xs"
                >
                  <span className="font-mono truncate flex-1" title={email}>{email}</span>
                  <button
                    onClick={() => removeOne(email)}
                    className="p-1 rounded hover:bg-destructive/10 text-destructive"
                    title={isEn ? 'Remove from blacklist' : 'Xóa khỏi danh sách đen'}
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-muted-foreground italic">
            Danh sách đen được tự động thêm khi đăng ký lỗi kiểu "email_used". Email trong danh sách này sẽ bị bỏ qua ở các lần đăng ký hàng loạt sau.
            Nếu Kiro đã giải phóng email cũ, anh có thể xóa thủ công tại đây để cho email đó tham gia đăng ký lại.
          </p>
        </CardContent>
      )}
    </Card>
  )
}
