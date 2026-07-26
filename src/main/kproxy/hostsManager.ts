import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { exec, execFile } from 'child_process'
import { promisify } from 'util'
import type { IdeType } from './modelMapper'

const execFileAsync = promisify(execFile)

export interface DNSEntry {
  ip: string
  hostname: string
  enabled: boolean
  ideType?: IdeType
}

const KROUTER_MARKER_START = '# Krouter MITM - START'
const KROUTER_MARKER_END = '# Krouter MITM - END'

const DEFAULT_DNS_ENTRIES: DNSEntry[] = [
  // Kiro IDE (AWS CodeWhisperer endpoints)
  { ip: '127.0.0.1', hostname: 'runtime.us-east-1.kiro.dev', enabled: true, ideType: 'kiro' },
  { ip: '127.0.0.1', hostname: 'q.us-east-1.amazonaws.com', enabled: true, ideType: 'kiro' },
  {
    ip: '127.0.0.1',
    hostname: 'codewhisperer.us-east-1.amazonaws.com',
    enabled: true,
    ideType: 'kiro'
  },
  // GitHub Copilot
  {
    ip: '127.0.0.1',
    hostname: 'api.individual.githubcopilot.com',
    enabled: true,
    ideType: 'copilot'
  },
  // Antigravity (Google Cloud Code / Gemini)
  {
    ip: '127.0.0.1',
    hostname: 'daily-cloudcode-pa.googleapis.com',
    enabled: true,
    ideType: 'antigravity'
  },
  {
    ip: '127.0.0.1',
    hostname: 'cloudcode-pa.googleapis.com',
    enabled: true,
    ideType: 'antigravity'
  },
  // Cursor
  { ip: '127.0.0.1', hostname: 'api2.cursor.sh', enabled: true, ideType: 'cursor' }
]

export class HostsManager {
  private hostsPath: string
  private platform: NodeJS.Platform

  constructor(options?: { hostsPath?: string; platform?: NodeJS.Platform }) {
    this.platform = options?.platform || process.platform
    this.hostsPath =
      options?.hostsPath ||
      (this.platform === 'win32'
        ? path.join(
            process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
            'System32',
            'drivers',
            'etc',
            'hosts'
          )
        : '/etc/hosts')
  }

  getDefaultEntries(): DNSEntry[] {
    return [...DEFAULT_DNS_ENTRIES]
  }

  async setEnabledIdeTypes(
    ideTypes: IdeType[]
  ): Promise<{ enabled: boolean; entries: DNSEntry[] }> {
    const allowed = new Set<IdeType>(['kiro', 'copilot', 'antigravity', 'cursor', 'custom'])
    const selected = new Set(ideTypes.filter((type) => allowed.has(type)))
    await this.addEntries(
      DEFAULT_DNS_ENTRIES.filter((entry) => entry.ideType && selected.has(entry.ideType))
    )
    return await this.getStatus()
  }

  async addEntries(entries: DNSEntry[]): Promise<void> {
    let content = await fs.promises.readFile(this.hostsPath, 'utf8')
    content = this.removeKrouterSection(content)

    const enabledEntries = entries.filter((e) => e.enabled)
    if (enabledEntries.length === 0) {
      await this.writeHostsFile(content)
      await this.flushDNS()
      return
    }

    const section = [
      '',
      KROUTER_MARKER_START,
      ...enabledEntries.map((e) => `${e.ip} ${e.hostname}`),
      KROUTER_MARKER_END,
      ''
    ].join('\n')

    content = content.trimEnd() + section
    await this.writeHostsFile(content)
    await this.flushDNS()
  }

  async removeEntries(): Promise<void> {
    let content = await fs.promises.readFile(this.hostsPath, 'utf8')
    content = this.removeKrouterSection(content)
    await this.writeHostsFile(content)
    await this.flushDNS()
  }

  async getStatus(): Promise<{ enabled: boolean; entries: DNSEntry[] }> {
    try {
      const content = await fs.promises.readFile(this.hostsPath, 'utf8')
      const startIdx = content.indexOf(KROUTER_MARKER_START)
      const endIdx = content.indexOf(KROUTER_MARKER_END)

      if (startIdx === -1 || endIdx === -1) {
        return { enabled: false, entries: [] }
      }

      const section = content.slice(startIdx + KROUTER_MARKER_START.length, endIdx).trim()
      const entries: DNSEntry[] = []

      for (const line of section.split('\n')) {
        const match = line.trim().match(/^([\d.]+)\s+(.+)$/)
        if (match) {
          const hostname = match[2]
          let ideType: IdeType = 'custom'
          if (
            hostname.includes('kiro.dev') ||
            hostname.includes('amazonaws.com') ||
            hostname.includes('codewhisperer')
          )
            ideType = 'kiro'
          else if (hostname.includes('githubcopilot.com')) ideType = 'copilot'
          else if (hostname.includes('googleapis.com')) ideType = 'antigravity'
          else if (hostname.includes('cursor.sh')) ideType = 'cursor'
          entries.push({ ip: match[1], hostname, enabled: true, ideType })
        }
      }

      return { enabled: entries.length > 0, entries }
    } catch {
      return { enabled: false, entries: [] }
    }
  }

  private removeKrouterSection(content: string): string {
    const startIdx = content.indexOf(KROUTER_MARKER_START)
    const endIdx = content.indexOf(KROUTER_MARKER_END)
    if (startIdx === -1 || endIdx === -1) return content
    return content.slice(0, startIdx) + content.slice(endIdx + KROUTER_MARKER_END.length)
  }

  private isPermissionError(error: unknown): boolean {
    const code = String((error as NodeJS.ErrnoException)?.code || '')
    const message = error instanceof Error ? error.message : String(error)
    return (
      code === 'EPERM' ||
      code === 'EACCES' ||
      /operation not permitted|permission denied|access is denied/i.test(message)
    )
  }

  /**
   * Giữ đúng MỘT bản sao lưu `<hosts>.krouter-backup` trước lần ghi đầu tiên.
   * Nếu file hosts hỏng thì vẫn còn bản gốc để khôi phục thủ công.
   * Không sao lưu được (thiếu quyền) thì bỏ qua — luồng ghi chính sẽ tự báo lỗi quyền.
   */
  private async backupHostsFileOnce(): Promise<void> {
    const backupPath = `${this.hostsPath}.krouter-backup`
    try {
      await fs.promises.access(backupPath)
      return // đã có bản sao lưu, tuyệt đối không ghi đè lên nó
    } catch {
      /* chưa có bản sao lưu */
    }
    try {
      const original = await fs.promises.readFile(this.hostsPath)
      await fs.promises.writeFile(backupPath, original)
    } catch {
      /* ignore */
    }
  }

  private async writeHostsFile(content: string): Promise<void> {
    try {
      await this.backupHostsFileOnce()
      // Ghi ra file tạm CÙNG thư mục rồi rename đè lên đích: rename trên cùng filesystem là
      // thao tác nguyên tử, nên tiến trình chết giữa chừng cũng không để lại /etc/hosts rỗng
      // (truncate-then-write trước đây sẽ phá localhost trên toàn hệ thống mà không còn gì để khôi phục).
      const tempPath = path.join(
        path.dirname(this.hostsPath),
        `.krouter-hosts-${process.pid}-${Date.now()}.tmp`
      )
      try {
        await fs.promises.writeFile(tempPath, content, { encoding: 'utf8', mode: 0o644 })
        await fs.promises.rename(tempPath, this.hostsPath)
      } catch (error) {
        await fs.promises.unlink(tempPath).catch(() => undefined)
        throw error
      }
      return
    } catch (error) {
      if (!this.isPermissionError(error)) throw error
      if (this.platform !== 'win32') {
        const permissionError = new Error(
          'Administrator/root permission is required to update the hosts file.'
        ) as NodeJS.ErrnoException
        permissionError.code = 'EACCES'
        throw permissionError
      }
    }

    await this.writeWindowsHostsElevated(content)
  }

  private async writeWindowsHostsElevated(content: string): Promise<void> {
    // mkdtemp sinh tên thư mục ngẫu nhiên (không đoán trước được) thay cho
    // `krouter-hosts-<pid>-<Date.now()>.tmp` cũ: tên cũ hoàn toàn dự đoán được nên một tiến trình
    // cùng user ở mức toàn vẹn trung bình có thể chiếm chỗ file rồi khiến PowerShell ĐÃ NÂNG QUYỀN
    // ghi nội dung tùy ý vào file hosts của hệ thống (TOCTOU).
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'krouter-'))
    const tempPath = path.join(tempDir, 'hosts.tmp')
    const payload = Buffer.from(content, 'utf8')
    // Băm được tính TRƯỚC khi giao file cho tiến trình nâng quyền và truyền vào như một tham số.
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex')
    await fs.promises.writeFile(tempPath, payload, { mode: 0o600 })

    const psQuote = (value: string): string => value.replace(/'/g, "''")
    const elevatedScript = [
      "$ErrorActionPreference='Stop'",
      `$source='${psQuote(tempPath)}'`,
      `$target='${psQuote(this.hostsPath)}'`,
      `$expected='${psQuote(expectedHash)}'`,
      '$bytes=[System.IO.File]::ReadAllBytes($source)',
      // Kiểm tra SHA-256 trước khi ghi: file tạm bị tráo giữa chừng thì hủy bỏ, không ghi gì cả.
      '$sha=[System.Security.Cryptography.SHA256]::Create()',
      '$actual=([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-","").ToLowerInvariant()',
      'if($actual -ne $expected){throw "krouter: hosts temp file checksum mismatch, aborting"}',
      '[System.IO.File]::WriteAllBytes($target,$bytes)',
      'ipconfig /flushdns | Out-Null'
    ].join(';')
    const encoded = Buffer.from(elevatedScript, 'utf16le').toString('base64')
    const launcher = [
      "$ErrorActionPreference='Stop'",
      `$process=Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}')`,
      'exit $process.ExitCode'
    ].join(';')

    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', launcher],
        {
          windowsHide: true,
          timeout: 120_000
        }
      )
      const written = await fs.promises.readFile(this.hostsPath, 'utf8')
      if (written !== content)
        throw new Error(
          'Windows reported success but the hosts file did not match the requested content.'
        )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Windows administrator approval is required to update DNS Redirect. Approve the UAC prompt and try again. (${detail})`
      )
    } finally {
      // Xóa cả thư mục tạm (không chỉ file) để không tích tụ thư mục rác qua từng lần chạy.
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private flushDNS(): Promise<void> {
    return new Promise((resolve) => {
      let cmd: string
      if (this.platform === 'win32') {
        cmd = 'ipconfig /flushdns'
      } else if (process.platform === 'darwin') {
        cmd = 'dscacheutil -flushcache && killall -HUP mDNSResponder 2>/dev/null || true'
      } else {
        cmd =
          'systemd-resolve --flush-caches 2>/dev/null || resolvectl flush-caches 2>/dev/null || true'
      }
      exec(cmd, () => resolve())
    })
  }
}

export const hostsManager = new HostsManager()
