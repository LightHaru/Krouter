import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import path from 'path'

export interface DashboardTunnelStatus {
  running: boolean
  requested: boolean
  localUrl: string
  httpHostHeader?: string
  publicUrl?: string
  startedAt?: number
  pid?: number
  binary: string
  error?: string
  logs: string[]
}

export interface DashboardTunnelStartInput {
  localUrl?: string
  binary?: string
  httpHostHeader?: string
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i
const MAX_LOGS = 80
const PID_FILE = 'dashboard-tunnel-cloudflared.pid'

function dataDir(): string {
  return (
    process.env.KIRO_RUNTIME_DATA_DIR ||
    process.env.KIRO_WEB_DATA_DIR ||
    path.join(process.cwd(), '.web-data')
  )
}

function tunnelDir(): string {
  return path.join(dataDir(), 'tunnel')
}

function pidPath(): string {
  return path.join(tunnelDir(), PID_FILE)
}

function savePid(pid?: number): void {
  if (!pid) return
  mkdirSync(tunnelDir(), { recursive: true })
  writeFileSync(pidPath(), String(pid), 'utf8')
}

function loadPid(): number | undefined {
  try {
    if (!existsSync(pidPath())) return undefined
    const pid = Number(readFileSync(pidPath(), 'utf8').trim())
    return Number.isFinite(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function clearPid(): void {
  try {
    if (existsSync(pidPath())) unlinkSync(pidPath())
  } catch {
    // best effort
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function commandLineForPid(pid: number): string {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')
    } catch {
      return ''
    }
  }
  return ''
}

function killSavedCloudflaredPid(): void {
  const pid = loadPid()
  if (!pid) return
  if (!isPidAlive(pid)) {
    clearPid()
    return
  }
  const commandLine = commandLineForPid(pid)
  if (commandLine && !/cloudflared/i.test(commandLine)) return
  try {
    process.kill(pid, process.platform === 'win32' ? undefined : 'SIGTERM')
  } catch {
    // best effort
  }
  clearPid()
}

function defaultTunnelTarget(): string {
  return (
    process.env.DASHBOARD_TUNNEL_TARGET ||
    process.env.KROUTER_DASHBOARD_TUNNEL_TARGET ||
    process.env.KAM_DASHBOARD_TUNNEL_TARGET ||
    process.env.KROUTER_DASHBOARD_URL ||
    process.env.KAM_DASHBOARD_URL ||
    process.env.PUBLIC_DASHBOARD_URL ||
    process.env.DASHBOARD_URL ||
    `http://127.0.0.1:${process.env.PORT || '4010'}`
  ).trim()
}

function defaultCloudflaredBinary(): string {
  return (process.env.CLOUDFLARED_BIN || process.env.KROUTER_CLOUDFLARED_BIN || process.env.KAM_CLOUDFLARED_BIN || 'cloudflared').trim()
}

function defaultHttpHostHeader(localUrl: string): string {
  const explicit = process.env.DASHBOARD_TUNNEL_HOST_HEADER || process.env.KROUTER_DASHBOARD_TUNNEL_HOST_HEADER || process.env.KAM_DASHBOARD_TUNNEL_HOST_HEADER || process.env.TUNNEL_HTTP_HOST_HEADER
  if (explicit !== undefined) return explicit.trim()
  try {
    return new URL(localUrl).host
  } catch {
    return ''
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

class DashboardTunnelRuntime {
  private process: ChildProcess | null = null
  private cleanupRegistered = false
  private status: DashboardTunnelStatus = {
    running: false,
    requested: false,
    localUrl: defaultTunnelTarget(),
    httpHostHeader: defaultHttpHostHeader(defaultTunnelTarget()),
    binary: defaultCloudflaredBinary(),
    logs: []
  }

  constructor() {
    this.registerCleanup()
  }

  getStatus(): DashboardTunnelStatus {
    if (this.process && this.process.exitCode === null && !this.process.killed) {
      this.status.running = true
      this.status.pid = this.process.pid
    } else if (this.process) {
      this.process = null
      this.status.running = false
      delete this.status.pid
      delete this.status.publicUrl
    }
    this.status.localUrl = this.status.localUrl || defaultTunnelTarget()
    this.status.httpHostHeader = this.status.httpHostHeader || defaultHttpHostHeader(this.status.localUrl)
    this.status.binary = this.status.binary || defaultCloudflaredBinary()
    return { ...this.status, logs: [...this.status.logs] }
  }

  async start(input: DashboardTunnelStartInput = {}): Promise<{ success: boolean; status: DashboardTunnelStatus; error?: string }> {
    const existing = this.getStatus()
    const localUrl = (input.localUrl || defaultTunnelTarget()).trim()
    const binary = (input.binary || defaultCloudflaredBinary()).trim()
    const httpHostHeader = (input.httpHostHeader || defaultHttpHostHeader(localUrl)).trim()
    if (existing.running) {
      if (existing.localUrl === localUrl && (existing.httpHostHeader || '') === httpHostHeader) {
        return { success: true, status: existing }
      }
      await this.stop()
    }

    if (!isHttpUrl(localUrl)) {
      const error = 'Tunnel target must be an HTTP/HTTPS URL.'
      this.status = { ...this.status, localUrl, httpHostHeader, binary, requested: false, running: false, error }
      return { success: false, status: this.getStatus(), error }
    }

    this.status = {
      running: false,
      requested: true,
      localUrl,
      httpHostHeader,
      binary,
      startedAt: Date.now(),
      logs: [],
      error: undefined
    }

    try {
      killSavedCloudflaredPid()

      const args = ['tunnel', '--url', localUrl]
      if (httpHostHeader) args.push('--http-host-header', httpHostHeader)
      args.push('--no-autoupdate')

      const child = spawn(binary, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.process = child
      this.status.pid = child.pid
      savePid(child.pid)

      child.stdout?.on('data', chunk => this.appendOutput(String(chunk)))
      child.stderr?.on('data', chunk => this.appendOutput(String(chunk)))
      child.once('error', error => {
        this.status.error = `Cannot start cloudflared: ${error.message}`
        this.status.running = false
        this.status.requested = false
        this.process = null
      })
      child.once('exit', (code, signal) => {
        if (loadPid() === child.pid) clearPid()
        this.status.running = false
        this.status.requested = false
        delete this.status.pid
        delete this.status.publicUrl
        if (!this.status.error && code !== 0) {
          this.status.error = `cloudflared exited with ${signal || code}`
        }
        this.process = null
      })

      const detected = await this.waitForUrlOrExit(12000)
      const status = this.getStatus()
      if (!status.running && status.error) return { success: false, status, error: status.error }
      return {
        success: true,
        status,
        error: detected ? undefined : 'Tunnel started, but public URL was not detected yet.'
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start tunnel'
      this.status.running = false
      this.status.requested = false
      this.status.error = message
      this.process = null
      return { success: false, status: this.getStatus(), error: message }
    }
  }

  async stop(): Promise<{ success: boolean; status: DashboardTunnelStatus; error?: string }> {
    const child = this.process
    if (!child || child.killed || child.exitCode !== null) {
      this.process = null
      this.status.running = false
      this.status.requested = false
      delete this.status.pid
      return { success: true, status: this.getStatus() }
    }

    child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 500))
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL')
    this.process = null
    this.status.running = false
    this.status.requested = false
    delete this.status.pid
    delete this.status.publicUrl
    clearPid()
    return { success: true, status: this.getStatus() }
  }

  private stopSync(): void {
    const child = this.process
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.kill(process.platform === 'win32' ? undefined : 'SIGTERM')
      } catch {
        // best effort
      }
    } else {
      killSavedCloudflaredPid()
    }
    clearPid()
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) return
    this.cleanupRegistered = true
    const cleanup = (): void => {
      this.stopSync()
      process.exit(0)
    }
    process.once('SIGINT', cleanup)
    process.once('SIGTERM', cleanup)
  }

  private appendOutput(output: string): void {
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      const match = line.match(URL_RE)
      if (match) {
        this.status.publicUrl = match[0]
        this.status.running = true
      }
      this.status.logs.push(line)
      if (this.status.logs.length > MAX_LOGS) {
        this.status.logs.splice(0, this.status.logs.length - MAX_LOGS)
      }
    }
  }

  private waitForUrlOrExit(timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const start = Date.now()
      const timer = setInterval(() => {
        if (this.status.publicUrl) {
          clearInterval(timer)
          resolve(true)
          return
        }
        if (!this.process || this.process.exitCode !== null || Date.now() - start >= timeoutMs) {
          clearInterval(timer)
          resolve(Boolean(this.status.publicUrl))
        }
      }, 200)
    })
  }
}

const dashboardTunnelRuntime = new DashboardTunnelRuntime()

export function getDashboardTunnelRuntime(): DashboardTunnelRuntime {
  return dashboardTunnelRuntime
}
