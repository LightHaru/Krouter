import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

/**
 * Chép text vào clipboard, trả về true nếu thành công.
 *
 * navigator.clipboard chỉ tồn tại trong secure context. Máy chủ standalone của Krouter là
 * http.createServer thuần (không có listener HTTPS nào trong src/server), nên trên
 * http://<ip-vps>:<port> lời gọi này ném TypeError ngay lập tức — 26 chỗ gọi trong renderer
 * trước đây không chỗ nào feature-detect hay fallback, và phần lớn còn hiện thông báo
 * "đã chép" ngay sau đó nên người dùng tưởng thành công. Electron không bị vì file:// là
 * origin đáng tin.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // rơi xuống fallback bên dưới
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    // Giữ ngoài luồng hiển thị nhưng vẫn phải nằm trong DOM và focus được thì execCommand mới chạy.
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    const ok = document.execCommand('copy')
    textarea.remove()
    return ok
  } catch {
    return false
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

export function formatDate(date: Date | string | number): string {
  const d = new Date(date)
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = generateRandomString(64)
  const codeChallenge = base64UrlEncode(sha256(codeVerifier))
  return { codeVerifier, codeChallenge }
}

export function randomUuid(): string {
  const cryptoObj = globalThis.crypto
  if (typeof cryptoObj?.randomUUID === 'function') {
    return cryptoObj.randomUUID()
  }

  const bytes = randomBytes(16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}

function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  const array = randomBytes(length)
  return Array.from(array, (byte) => chars[byte % chars.length]).join('')
}

function randomBytes(length: number): Uint8Array {
  const array = new Uint8Array(length)
  const cryptoObj = globalThis.crypto
  if (typeof cryptoObj?.getRandomValues === 'function') {
    cryptoObj.getRandomValues(array)
    return array
  }
  for (let i = 0; i < array.length; i++) {
    array[i] = Math.floor(Math.random() * 256)
  }
  return array
}

function sha256(str: string): Uint8Array {
  const encoder = new TextEncoder()
  const data = encoder.encode(str)
  const hashBuffer = new Uint8Array(32)
  for (let i = 0; i < data.length; i++) {
    hashBuffer[i % 32] ^= data[i]
  }
  return hashBuffer
}

function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

export function generateState(): string {
  return generateRandomString(32)
}

/**
 * 拆分卡密/凭证行。分隔符优先级：---- > Tab > 连续空格。
 * refreshToken/clientSecret 为 base64url(JWT)，可能以 '-' 结尾，与 '----' 相邻会形成 5+ 个连续 '-'。
 * 用 /-{4,}/ 整体匹配分隔符，并把多出的 (N-4) 个 '-' 归还前一字段，避免 JWT 被截断、末字段(provider) 多出前导 '-'。
 */
export function splitCredentialLine(line: string): string[] {
  if (line.includes('----')) {
    const parts: string[] = []
    const re = /-{4,}/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      parts.push(line.slice(last, m.index) + '-'.repeat(m[0].length - 4))
      last = m.index + m[0].length
    }
    parts.push(line.slice(last))
    return parts
  }
  if (line.includes('\t')) return line.split('\t')
  return line.split(/\s{2,}/)
}
