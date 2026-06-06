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
    const targetPath = exportPath || path.join(getRuntimeUserDataPath(), 'kproxy-ca.crt')
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
}

const runtimes = new Map<string, KProxyRuntime>()

export function getKProxyRuntime(store: WebStore, userId: string, emit: EmitFn): KProxyRuntime {
  const existing = runtimes.get(userId)
  if (existing) return existing
  const runtime = new KProxyRuntime(store, userId, emit)
  runtimes.set(userId, runtime)
  return runtime
}
