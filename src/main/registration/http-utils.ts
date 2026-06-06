import crypto from 'crypto'

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36'
export const DEFAULT_SEC_UA =
  '"Chromium";v="146", "Not/A)Brand";v="24", "Google Chrome";v="146"'

/** 生成 4 位随机十六进制 */
function hex4(): string {
  const chars = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * 16)]
  return s
}

/** 生成随机 visitor ID (UUID v4-like) */
export function visitorId(): string {
  return `${hex4()}${hex4()}-${hex4()}-7${hex4().slice(1)}-${hex4()}-${hex4()}${hex4()}${hex4()}`
}

/** 生成 awsccc cookie 值 */
export function awsccc(): string {
  const d = {
    e: 1,
    p: 1,
    f: 1,
    a: 1,
    i: `${hex4()}${hex4()}-${hex4()}-4${hex4().slice(1)}-${hex4()}-${hex4()}${hex4()}${hex4()}`,
    v: '1'
  }
  return Buffer.from(JSON.stringify(d)).toString('base64')
}

/** 生成 ubid cookie 值 */
export function ubidGen(): string {
  const d7 = Array.from({ length: 7 }, () => Math.floor(Math.random() * 10)).join('')
  const d6 = Array.from({ length: 6 }, () => Math.floor(Math.random() * 10)).join('')
  return `186-${d7}-${d6}`
}

/** 生成 Kiro visitor ID */
export function kiroVisitorId(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 11; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return `${Date.now()}-${s}`
}

/** 生成 PKCE code_verifier 和 code_challenge */
export function pkce(): { verifier: string; challenge: string } {
  const raw = crypto.randomBytes(32)
  const verifier = raw.toString('base64url')
  const hash = crypto.createHash('sha256').update(verifier).digest()
  const challenge = hash.toString('base64url')
  return { verifier, challenge }
}

/** 生成 UUID */
export function newUUID(): string {
  const b = crypto.randomBytes(16)
  return [
    b.subarray(0, 4).toString('hex'),
    b.subarray(4, 6).toString('hex'),
    b.subarray(6, 8).toString('hex'),
    b.subarray(8, 10).toString('hex'),
    b.subarray(10, 16).toString('hex')
  ].join('-')
}

/** 生成 GMT 日期字符串 */
export function gmtDate(): string {
  return new Date().toUTCString()
}

/** 从 URL 中提取查询参数 */
export function extractParam(rawURL: string, key: string): string {
  try {
    const u = new URL(rawURL)
    return u.searchParams.get(key) || ''
  } catch {
    return ''
  }
}

/** 从字符串中提取分隔符后的内容 */
export function splitAfter(s: string, sep: string): string {
  const idx = s.indexOf(sep)
  if (idx < 0) return ''
  const rest = s.slice(idx + sep.length)
  const ampIdx = rest.indexOf('&')
  return ampIdx >= 0 ? rest.slice(0, ampIdx) : rest
}

/** 获取嵌套 map 值 */
export function getNestedMap(
  data: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | null {
  let current: unknown = data
  for (const k of keys) {
    if (typeof current !== 'object' || current === null) return null
    current = (current as Record<string, unknown>)[k]
  }
  return typeof current === 'object' && current !== null
    ? (current as Record<string, unknown>)
    : null
}

/** 获取嵌套的 string map */
export function getNestedStringMap(
  data: Record<string, unknown>,
  key: string
): Record<string, string> | null {
  if (!data) return null
  const nested = data[key]
  if (typeof nested !== 'object' || nested === null) return null
  const result: Record<string, string> = {}
  for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
    if (typeof v === 'string') result[k] = v
  }
  return Object.keys(result).length > 0 ? result : null
}

/** 从 Set-Cookie 头中提取并保存 cookies */
export function saveCookies(
  cookies: Map<string, string>,
  headers: Record<string, string | string[] | undefined>
): void {
  const skip = new Set(['path', 'domain', 'expires', 'max-age', 'secure', 'httponly', 'samesite'])
  const setCookieHeader = headers['set-cookie']
  if (!setCookieHeader) return

  const values = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]
  for (const raw of values) {
    if (!raw.includes('=')) continue
    const mainPart = raw.split(';')[0]
    const eqIdx = mainPart.indexOf('=')
    if (eqIdx < 0) continue
    const k = mainPart.slice(0, eqIdx).trim()
    const v = mainPart.slice(eqIdx + 1).trim()
    if (!skip.has(k.toLowerCase()) && k) {
      cookies.set(k, v)
    }
  }
}
