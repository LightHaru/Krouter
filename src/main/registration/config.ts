import { randomFullName } from './browser-identity'

export interface RegistrationConfig {
  // AWS
  oidcBase: string
  signinBase: string
  profileBase: string
  viewBase: string
  portalBase: string
  directoryId: string
  startURL: string

  // 默认值
  password: string
  fullName: string

  // 运行时
  proxy: string
  /** 上游中转代理（可选，用于代理链）：让对 proxy(目标代理) 的连接经非大陆中转发起 */
  upstreamProxy: string
  /**
   * 严格代理模式：开启后任何「代理缺失/代理链失败/回退环境变量」情况都立即抛错中止注册，
   * 杜绝代理配置失效后静默回退到未配置网络路径。批量注册启用代理池时由前端强制开启。
   */
  strictProxy: boolean

  // MoEmail 配置
  moEmailBaseURL: string
  moEmailAPIKey: string

  // Outlook 模式
  useOutlook: boolean
  outlookData: string

  // TempMail.Plus + 自建域名
  useTempMailPlus: boolean
  tempMailPlusEmail: string  // tempmail.plus 用户名（不含 @mailto.plus）
  tempMailPlusEpin: string
  tempMailPlusDomain: string // 自建域名
  useTingamefiMail: boolean
  tingamefiMailApiUrl: string
  tingamefiMailAdminPassword: string
  tingamefiMailDomain: string

  // Proton 点号别名（webview 借壳官方网页取码，需先在应用内登录 Proton）
  useProton: boolean
  protonEmail: string // 本次注册使用的 Proton 邮箱地址（母邮箱或其点号变体，由前端生成）

  // 手动模式
  manualMode: boolean
}

export function genPassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const lower = 'abcdefghijklmnopqrstuvwxyz'
  const digits = '0123456789'
  const special = '!@#$%^&*'

  let pw = ''
  for (let i = 0; i < 3; i++) pw += upper[Math.floor(Math.random() * upper.length)]
  for (let i = 0; i < 6; i++) pw += lower[Math.floor(Math.random() * lower.length)]
  for (let i = 0; i < 3; i++) pw += digits[Math.floor(Math.random() * digits.length)]
  for (let i = 0; i < 2; i++) pw += special[Math.floor(Math.random() * special.length)]

  const arr = pw.split('')
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('')
}

export function newConfig(overrides?: Partial<RegistrationConfig>): RegistrationConfig {
  return {
    oidcBase: 'https://oidc.us-east-1.amazonaws.com',
    signinBase: 'https://us-east-1.signin.aws',
    profileBase: 'https://profile.aws.amazon.com',
    viewBase: 'https://view.awsapps.com',
    portalBase: 'https://portal.sso.us-east-1.amazonaws.com',
    directoryId: 'd-9067642ac7',
    startURL: 'https://view.awsapps.com/start',
    password: genPassword(),
    fullName: randomFullName(),
    proxy: '',
    upstreamProxy: '',
    strictProxy: false,
    moEmailBaseURL: '',
    moEmailAPIKey: '',
    useOutlook: false,
    outlookData: '',
    useTempMailPlus: false,
    tempMailPlusEmail: '',
    tempMailPlusEpin: '',
    tempMailPlusDomain: '',
    useTingamefiMail: false,
    tingamefiMailApiUrl: 'https://temp-email-worker.thienp1301.workers.dev',
    tingamefiMailAdminPassword: '',
    tingamefiMailDomain: 'mail.tingamefi.com',
    useProton: false,
    protonEmail: '',
    manualMode: false,
    ...overrides
  }
}
