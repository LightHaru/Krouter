import { execSync } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import {
  generateDeviceId,
  initKProxyService,
  type CACertInfo,
  type DeviceIdMapping,
  type KProxyConfig,
  type KProxyService
} from '../../main/kproxy'
import { getRuntimeUserDataPath } from '../../main/runtimePaths'
import type { WebStore } from '../store'
import type { MitmHttpsServer } from '../../main/kproxy/mitmHttpsServer'

type EmitFn = (channel: string, ...args: unknown[]) => void

function serializeCaInfo(caInfo: CACertInfo | null): Record<string, unknown> | null {
  if (!caInfo) return null
  return {
    certPath: caInfo.certPath,
    keyPath: caInfo.keyPath,
    fingerprint: caInfo.fingerprint,
    validFrom: caInfo.validFrom instanceof Date ? caInfo.validFrom.toISOString() : caInfo.validFrom,
    validTo: caInfo.validTo instanceof Date ? caInfo.validTo.toISOString() : caInfo.validTo
  }
}

export class KProxyRuntime {
  private service: KProxyService | null = null

  constructor(
    private readonly store: WebStore,
    private readonly userId: string,
    private readonly emit: EmitFn
  ) {}

  private get savedConfig(): Partial<KProxyConfig> {
    return this.store.getUserSetting<Partial<KProxyConfig>>(this.userId, 'kproxyConfig', {})
  }

  private get mappings(): DeviceIdMapping[] {
    return this.store.getUserSetting<DeviceIdMapping[]>(this.userId, 'kproxyDeviceMappings', [])
  }

  private async persistConfig(): Promise<void> {
    if (this.service) await this.store.setUserSetting(this.userId, 'kproxyConfig', this.service.getConfig())
  }

  private async persistMappings(): Promise<void> {
    if (this.service) await this.store.setUserSetting(this.userId, 'kproxyDeviceMappings', this.service.getAllDeviceIdMappings())
  }

  private getOrCreateService(config?: Partial<KProxyConfig>): KProxyService {
    if (!this.service) {
      this.service = initKProxyService({ ...this.savedConfig, ...config }, {
        onRequest: (info) => this.emit('kproxy-request', info),
        onResponse: (info) => this.emit('kproxy-response', info),
        onError: (error) => this.emit('kproxy-error', error.message),
        onStatusChange: (running, port) => this.emit('kproxy-status-change', { running, port }),
        onMitmIntercept: (host, modified) => this.emit('kproxy-mitm', { host, modified })
      })
      for (const mapping of this.mappings) this.service.addDeviceIdMapping(mapping)
    } else if (config) {
      this.service.updateConfig(config)
    }
    return this.service
  }

  async init(): Promise<{ success: boolean; caInfo?: unknown; error?: string }> {
    try {
      const service = this.getOrCreateService()
      const caInfo = await service.initialize()
      await this.persistConfig()
      return { success: true, caInfo: serializeCaInfo(caInfo) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to initialize K-Proxy' }
    }
  }

  async start(config?: Partial<KProxyConfig>): Promise<{ success: boolean; port?: number; error?: string }> {
    try {
      const service = this.getOrCreateService(config)
      await service.start()
      await this.persistConfig()
      return { success: true, port: service.getConfig().port }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start K-Proxy' }
    }
  }

  async stop(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.service) await this.service.stop()
      await this.persistConfig()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop K-Proxy' }
    }
  }

  getStatus(): { running: boolean; config: unknown; stats: unknown; caInfo: unknown } {
    const service = this.getOrCreateService()
    return {
      running: service.isRunning(),
      config: service.getConfig(),
      stats: service.getStats(),
      caInfo: serializeCaInfo(service.getCACertInfo())
    }
  }

  async updateConfig(config: Partial<KProxyConfig>): Promise<{ success: boolean; config?: unknown; error?: string }> {
    try {
      const service = this.getOrCreateService(config)
      await this.persistConfig()
      return { success: true, config: service.getConfig() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update K-Proxy config' }
    }
  }

  async setDeviceId(deviceId: string): Promise<{ success: boolean; error?: string }> {
    try {
      this.getOrCreateService().setDeviceId(deviceId)
      await this.persistConfig()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set device ID' }
    }
  }

  generateDeviceId(): { success: boolean; deviceId: string } {
    return { success: true, deviceId: generateDeviceId() }
  }

  async addDeviceMapping(mapping: DeviceIdMapping): Promise<{ success: boolean; error?: string }> {
    try {
      this.getOrCreateService().addDeviceIdMapping(mapping)
      await this.persistMappings()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add device mapping' }
    }
  }

  getDeviceMappings(): { success: boolean; mappings: DeviceIdMapping[] } {
    return { success: true, mappings: this.getOrCreateService().getAllDeviceIdMappings() }
  }

  async switchToAccount(accountId: string): Promise<{ success: boolean; error?: string }> {
    const service = this.getOrCreateService()
    const success = service.switchToAccount(accountId)
    await this.persistConfig()
    await this.persistMappings()
    return { success, error: success ? undefined : 'No device ID mapping for account' }
  }

  async getCaCert(): Promise<{ success: boolean; certPem?: string; certPath?: string; fingerprint?: string; error?: string }> {
    const initResult = await this.init()
    if (!initResult.success) return { success: false, error: initResult.error }
    const service = this.getOrCreateService()
    const certPem = service.getCACertPem()
    const caInfo = service.getCACertInfo()
    if (!certPem || !caInfo) return { success: false, error: 'CA certificate not available' }
    return { success: true, certPem, certPath: caInfo.certPath, fingerprint: caInfo.fingerprint }
  }

  async exportCaCert(exportPath?: string): Promise<{ success: boolean; path?: string; error?: string }> {
    const cert = await this.getCaCert()
    if (!cert.success || !cert.certPem) return { success: false, error: cert.error || 'CA certificate not available' }
    const baseDir = path.resolve(getRuntimeUserDataPath())
    const targetPath = path.resolve(exportPath || path.join(baseDir, 'kproxy-ca.crt'))
    // Đường dẫn do client gửi lên phải nằm trong thư mục dữ liệu runtime, nếu
    // không một request có thể ghi đè bất kỳ file nào (kể cả store.json).
    if (!targetPath.startsWith(baseDir + path.sep)) {
      return { success: false, error: `Export path must stay inside ${baseDir}` }
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    await fs.writeFile(targetPath, cert.certPem, 'utf8')
    return { success: true, path: targetPath }
  }

  async checkCaCertInstalled(): Promise<{ success: boolean; installed: boolean; error?: string }> {
    try {
      const cert = await this.getCaCert()
      if (!cert.success) return { success: false, installed: false, error: cert.error }
      if (process.platform === 'win32') {
        try {
          const output = execSync('certutil -store -user Root "K-Proxy CA"', { encoding: 'utf8' })
          return { success: true, installed: output.includes('K-Proxy CA') }
        } catch {
          return { success: true, installed: false }
        }
      }
      if (process.platform === 'darwin') {
        try {
          execSync('security find-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db', { encoding: 'utf8' })
          return { success: true, installed: true }
        } catch {
          return { success: true, installed: false }
        }
      }
      const linuxPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
      try {
        await fs.access(linuxPath)
        return { success: true, installed: true }
      } catch {
        return { success: true, installed: false }
      }
    } catch (error) {
      return { success: false, installed: false, error: error instanceof Error ? error.message : 'Failed to check CA certificate' }
    }
  }

  async installCaCert(): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const cert = await this.getCaCert()
      if (!cert.success || !cert.certPath) return { success: false, error: cert.error || 'CA certificate not available' }
      if (process.platform === 'win32') {
        execSync(`certutil -addstore -user Root "${cert.certPath}"`, { encoding: 'utf8' })
        return { success: true, message: 'CA certificate installed to Windows certificate store' }
      }
      if (process.platform === 'darwin') {
        execSync(`security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${cert.certPath}"`)
        return { success: true, message: 'CA certificate installed to macOS Keychain' }
      }
      const linuxPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
      await fs.copyFile(cert.certPath, linuxPath)
      execSync('update-ca-certificates')
      return { success: true, message: 'CA certificate installed to Linux CA store' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to install CA certificate' }
    }
  }

  async uninstallCaCert(): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      if (process.platform === 'win32') {
        execSync('certutil -delstore -user Root "K-Proxy CA"', { encoding: 'utf8' })
        return { success: true, message: 'CA certificate removed from Windows certificate store' }
      }
      if (process.platform === 'darwin') {
        execSync('security delete-certificate -c "K-Proxy CA" ~/Library/Keychains/login.keychain-db')
        return { success: true, message: 'CA certificate removed from macOS Keychain' }
      }
      const linuxPath = '/usr/local/share/ca-certificates/kproxy-ca.crt'
      try { await fs.unlink(linuxPath) } catch { /* not installed */ }
      execSync('update-ca-certificates --fresh')
      return { success: true, message: 'CA certificate removed from Linux CA store' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to uninstall CA certificate' }
    }
  }

  resetStats(): { success: boolean } {
    this.getOrCreateService().resetStats()
    return { success: true }
  }

  // Phase 12: Model mappings
  getModelMappings(): { mappings: unknown[] } {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- nạp trễ module kproxy: bản server chỉ tải khi người dùng thật sự bật K-Proxy
      const { modelMapper } = require('../../main/kproxy/modelMapper')
      return { mappings: modelMapper.getMappings() }
    } catch {
      return { mappings: [] }
    }
  }

  saveModelMappings(mappings: unknown[]): { success: boolean } {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- nạp trễ module kproxy: bản server chỉ tải khi người dùng thật sự bật K-Proxy
      const { modelMapper } = require('../../main/kproxy/modelMapper')
      modelMapper.setMappings(mappings)
      return { success: true }
    } catch {
      return { success: false }
    }
  }

  private mitmServer: MitmHttpsServer | null = null

  // Phase 12: MITM HTTPS Server
  async mitmGetStatus(): Promise<{
    running: boolean
    port: number
    listenerReachable: boolean
    routerReachable: boolean
    lastDiagnosticAt: number | null
    lastDiagnosticError: string | null
    connections: number
    interceptedRequests: number
    passthroughRequests: number
    byIdeType: Record<string, number>
    routerSuccesses: number
    routerFailures: number
    lastRequestAt: number | null
    lastInterceptAt: number | null
    lastRouterStatus: number | null
    recentDecisions: Array<Record<string, unknown>>
  }> {
    const empty = {
      running: false,
      port: 443,
      listenerReachable: false,
      routerReachable: false,
      lastDiagnosticAt: null,
      lastDiagnosticError: null,
      connections: 0,
      interceptedRequests: 0,
      passthroughRequests: 0,
      byIdeType: {},
      routerSuccesses: 0,
      routerFailures: 0,
      lastRequestAt: null,
      lastInterceptAt: null,
      lastRouterStatus: null,
      recentDecisions: []
    }
    try {
      if (this.mitmServer) {
        const stats = this.mitmServer.getStats()
        return { ...empty, ...stats, recentDecisions: Array.isArray(stats.recentDecisions) ? (stats.recentDecisions as unknown as Record<string, unknown>[]) : [] }
      }
      return empty
    } catch {
      return empty
    }
  }

  async mitmStart(opts?: { port?: number }): Promise<{ success: boolean; error?: string }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- nạp trễ module kproxy: bản server chỉ tải khi người dùng thật sự bật K-Proxy
      const { MitmHttpsServer } = require('../../main/kproxy/mitmHttpsServer')
      const service = this.getOrCreateService()
      const caInfo = await service.initialize()
      if (!caInfo) return { success: false, error: 'Failed to initialize certificates' }
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- nạp trễ module kproxy: bản server chỉ tải khi người dùng thật sự bật K-Proxy
      const { createCertManager } = require('../../main/kproxy/certManager')
      const certMgr = service.getCertManager() || createCertManager(getRuntimeUserDataPath() + '/kproxy')

      // Chỉ nhánh "chưa có instance" mới đọc opts.port, nên lần start thứ hai với cổng khác
      // trước đây bị bỏ qua im lặng. Dựng lại instance khi cổng yêu cầu khác cổng hiện tại
      // (server đang chạy thì giữ nguyên — muốn đổi cổng phải stop trước).
      if (this.mitmServer && opts?.port && !this.mitmServer.isRunning() && this.mitmServer.getStats().port !== opts.port) {
        this.mitmServer = null
      }
      if (!this.mitmServer) {
        const config = opts?.port ? { port: opts.port } : undefined
        this.mitmServer = new MitmHttpsServer(config) as MitmHttpsServer
      }
      // Giữ tham chiếu cục bộ để TS thu hẹp được kiểu (this.mitmServer là nullable và là
      // thuộc tính có thể thay đổi, nên TS không giữ được kết quả thu hẹp qua các lời gọi).
      const mitmServer: MitmHttpsServer = this.mitmServer
      mitmServer.setCertManager(certMgr)
      mitmServer.setOnRequest((info) => this.emit('mitm-request', info))

      // Set the router API key from proxy config so MITM can forward authenticated requests
      const proxyConfig = this.store.getUserSetting<{ port?: number; apiKey?: string; apiKeys?: Array<{ key?: string; enabled?: boolean }> }>(this.userId, 'proxyConfig', {})
      const apiKeys = proxyConfig?.apiKeys || []
      const activeKey = apiKeys.find((k) => k.enabled)
      const routerApiKey = activeKey?.key || proxyConfig?.apiKey
      if (routerApiKey) {
        mitmServer.setRouterApiKey(routerApiKey)
      }

      // Parity với main/index.ts (mitm-start): phải bơm cổng proxy đang cấu hình vào MITM.
      // Không gọi thì routerBase giữ mặc định 127.0.0.1:5580, runStartupDiagnostics ->
      // probeRouter fail và start() reject — nghĩa là KHÔNG thể bật MITM từ dashboard web
      // khi proxy chạy ở cổng khác, kèm thông báo lỗi trỏ vào cổng người dùng chưa từng đặt.
      mitmServer.setRouterBase(`http://127.0.0.1:${proxyConfig?.port || 5580}`)

      await mitmServer.start()
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  async mitmStop(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.mitmServer) {
        await this.mitmServer.stop()
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  // Phase 12: Hosts file management
  async getHostsStatus(): Promise<{ enabled: boolean; entries: unknown[] }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- nạp trễ module kproxy: bản server chỉ tải khi người dùng thật sự bật K-Proxy
      const { hostsManager } = require('../../main/kproxy/hostsManager')
      return await hostsManager.getStatus()
    } catch {
      return { enabled: false, entries: [] }
    }
  }

  async toggleHosts(enabled: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- nạp trễ module kproxy: bản server chỉ tải khi người dùng thật sự bật K-Proxy
      const { hostsManager } = require('../../main/kproxy/hostsManager')
      if (enabled) {
        await hostsManager.addEntries(hostsManager.getDefaultEntries())
      } else {
        await hostsManager.removeEntries()
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  async setHostsIdeTypes(ideTypes: string[]): Promise<{ success: boolean; enabled?: boolean; entries?: unknown[]; error?: string }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- nạp trễ module kproxy: bản server chỉ tải khi người dùng thật sự bật K-Proxy
      const { hostsManager } = require('../../main/kproxy/hostsManager')
      const status = await hostsManager.setEnabledIdeTypes(ideTypes)
      return { success: true, ...status }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }
}

const runtimes = new Map<string, KProxyRuntime>()

export function getKProxyRuntime(store: WebStore, userId: string, emit: EmitFn): KProxyRuntime {
  const existing = runtimes.get(userId)
  if (existing) return existing
  const runtime = new KProxyRuntime(store, userId, emit)
  runtimes.set(userId, runtime)
  return runtime
}
