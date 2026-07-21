import * as fs from 'fs'
import { exec } from 'child_process'
import type { IdeType } from './modelMapper'

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
  { ip: '127.0.0.1', hostname: 'codewhisperer.us-east-1.amazonaws.com', enabled: true, ideType: 'kiro' },
  // GitHub Copilot
  { ip: '127.0.0.1', hostname: 'api.individual.githubcopilot.com', enabled: true, ideType: 'copilot' },
  // Antigravity (Google Cloud Code / Gemini)
  { ip: '127.0.0.1', hostname: 'daily-cloudcode-pa.googleapis.com', enabled: true, ideType: 'antigravity' },
  { ip: '127.0.0.1', hostname: 'cloudcode-pa.googleapis.com', enabled: true, ideType: 'antigravity' },
  // Cursor
  { ip: '127.0.0.1', hostname: 'api2.cursor.sh', enabled: true, ideType: 'cursor' },
]

export class HostsManager {
  private hostsPath: string

  constructor() {
    this.hostsPath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts'
  }

  getDefaultEntries(): DNSEntry[] {
    return [...DEFAULT_DNS_ENTRIES]
  }

  async addEntries(entries: DNSEntry[]): Promise<void> {
    let content = await fs.promises.readFile(this.hostsPath, 'utf8')
    content = this.removeKrouterSection(content)

    const enabledEntries = entries.filter(e => e.enabled)
    if (enabledEntries.length === 0) return

    const section = [
      '',
      KROUTER_MARKER_START,
      ...enabledEntries.map(e => `${e.ip} ${e.hostname}`),
      KROUTER_MARKER_END,
      ''
    ].join('\n')

    content = content.trimEnd() + section
    await fs.promises.writeFile(this.hostsPath, content, 'utf8')
    await this.flushDNS()
  }

  async removeEntries(): Promise<void> {
    let content = await fs.promises.readFile(this.hostsPath, 'utf8')
    content = this.removeKrouterSection(content)
    await fs.promises.writeFile(this.hostsPath, content, 'utf8')
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
          if (hostname.includes('kiro.dev') || hostname.includes('amazonaws.com') || hostname.includes('codewhisperer')) ideType = 'kiro'
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

  private flushDNS(): Promise<void> {
    return new Promise((resolve) => {
      let cmd: string
      if (process.platform === 'win32') {
        cmd = 'ipconfig /flushdns'
      } else if (process.platform === 'darwin') {
        cmd = 'dscacheutil -flushcache && killall -HUP mDNSResponder 2>/dev/null || true'
      } else {
        cmd = 'systemd-resolve --flush-caches 2>/dev/null || resolvectl flush-caches 2>/dev/null || true'
      }
      exec(cmd, () => resolve())
    })
  }
}

export const hostsManager = new HostsManager()
