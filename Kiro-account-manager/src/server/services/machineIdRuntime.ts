import { exec, execSync } from 'child_process'
import { promises as fs } from 'fs'
import fsSync from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { promisify } from 'util'
import { getRuntimeUserDataPath } from '../../main/runtimePaths'

const execAsync = promisify(exec)

type OSType = 'windows' | 'macos' | 'linux' | 'unknown'

interface MachineIdResult {
  success: boolean
  machineId?: string
  error?: string
  requiresAdmin?: boolean
}

function getOSType(): OSType {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') return 'linux'
  return 'unknown'
}

function isValidMachineId(machineId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(machineId)
    || /^[0-9a-f]{32}$/i.test(machineId)
}

function formatAsUuid(value: string): string {
  const clean = value.replace(/-/g, '').toLowerCase()
  if (clean.length !== 32) return value.toLowerCase()
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20)}`
}

function findPowerShell(): string | null {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const candidates = [
    `${programFiles}\\PowerShell\\7\\pwsh.exe`,
    `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    `${systemRoot}\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe`,
    'pwsh.exe',
    'powershell.exe'
  ]

  for (const candidate of candidates) {
    try {
      if (path.isAbsolute(candidate)) {
        if (fsSync.existsSync(candidate)) return candidate
      } else {
        const result = execSync(`where.exe ${candidate}`, { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] })
        const found = result.trim().split('\n')[0]?.trim()
        if (found && fsSync.existsSync(found)) return found
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

async function getWindowsMachineId(): Promise<MachineIdResult> {
  try {
    const { stdout } = await execAsync('reg query "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { timeout: 5000 })
    const match = stdout.match(/MachineGuid\s+REG_SZ\s+([a-f0-9-]+)/i)
    if (match?.[1]) return { success: true, machineId: match[1].toLowerCase() }
  } catch {
    // Continue with PowerShell fallback.
  }

  const psPath = findPowerShell()
  if (psPath) {
    try {
      const { stdout } = await execAsync(`"${psPath}" -NoProfile -Command "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid"`, { timeout: 10000 })
      const machineId = stdout.trim().toLowerCase()
      if (isValidMachineId(machineId)) return { success: true, machineId }
    } catch {
      // Continue with WMIC fallback.
    }
  }

  try {
    const { stdout } = await execAsync('wmic csproduct get UUID', { timeout: 5000 })
    const uuid = stdout.split('\n').find((line) => line.trim() && !line.includes('UUID'))?.trim().toLowerCase()
    if (uuid && uuid !== 'ffffffff-ffff-ffff-ffff-ffffffffffff') return { success: true, machineId: uuid }
  } catch {
    // No more fallbacks.
  }

  return { success: false, error: 'Unable to read Windows machine ID' }
}

async function setWindowsMachineId(newMachineId: string): Promise<MachineIdResult> {
  try {
    await execAsync(`reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid /t REG_SZ /d "${newMachineId}" /f`, { timeout: 10000 })
    return { success: true, machineId: newMachineId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      success: false,
      error: message,
      requiresAdmin: /Access is denied|拒绝访问/i.test(message)
    }
  }
}

function macOverridePath(): string {
  return path.join(getRuntimeUserDataPath(), 'machine-id-override')
}

function macKiroMachineIdPath(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'machineid')
}

async function getMacMachineId(): Promise<MachineIdResult> {
  for (const filePath of [macOverridePath(), macKiroMachineIdPath()]) {
    try {
      const value = (await fs.readFile(filePath, 'utf8')).trim()
      if (isValidMachineId(value)) return { success: true, machineId: value.toLowerCase() }
    } catch {
      // Try the next source.
    }
  }

  try {
    const { stdout } = await execAsync("ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ { print $3 }'", { timeout: 5000 })
    const machineId = stdout.trim().replace(/"/g, '').toLowerCase()
    if (isValidMachineId(machineId)) return { success: true, machineId }
  } catch {
    // No fallback.
  }

  return { success: false, error: 'Unable to read macOS machine ID' }
}

async function setMacMachineId(newMachineId: string): Promise<MachineIdResult> {
  try {
    await fs.mkdir(path.dirname(macOverridePath()), { recursive: true })
    await fs.writeFile(macOverridePath(), newMachineId, 'utf8')
    await fs.mkdir(path.dirname(macKiroMachineIdPath()), { recursive: true })
    await fs.writeFile(macKiroMachineIdPath(), newMachineId, 'utf8')
    return { success: true, machineId: newMachineId }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to set macOS machine ID' }
  }
}

async function getLinuxMachineId(): Promise<MachineIdResult> {
  for (const filePath of linuxMachineIdPaths()) {
    try {
      const value = (await fs.readFile(filePath, 'utf8')).trim()
      if (value) return { success: true, machineId: formatAsUuid(value) }
    } catch {
      // Try next path.
    }
  }
  return { success: false, error: 'Unable to read Linux machine ID' }
}

function linuxMachineIdPaths(): string[] {
  if (process.env.KIRO_MACHINE_ID_FILE) return [path.resolve(process.env.KIRO_MACHINE_ID_FILE)]
  return ['/etc/machine-id', '/var/lib/dbus/machine-id']
}

function machineIdFileOverridePath(): string | null {
  return process.env.KIRO_MACHINE_ID_FILE ? path.resolve(process.env.KIRO_MACHINE_ID_FILE) : null
}

async function readMachineIdFileOverride(): Promise<MachineIdResult | null> {
  const filePath = machineIdFileOverridePath()
  if (!filePath) return null
  try {
    const value = (await fs.readFile(filePath, 'utf8')).trim()
    return value && isValidMachineId(value)
      ? { success: true, machineId: formatAsUuid(value) }
      : { success: false, error: `Machine ID override file is empty or invalid: ${filePath}` }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : `Unable to read machine ID override file: ${filePath}` }
  }
}

async function writeMachineIdFileOverride(newMachineId: string): Promise<MachineIdResult | null> {
  const filePath = machineIdFileOverridePath()
  if (!filePath) return null
  const raw = newMachineId.replace(/-/g, '').toLowerCase()
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, `${raw}\n`, 'utf8')
    return { success: true, machineId: formatAsUuid(raw) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : `Unable to write machine ID override file: ${filePath}` }
  }
}

async function setLinuxMachineId(newMachineId: string): Promise<MachineIdResult> {
  const raw = newMachineId.replace(/-/g, '').toLowerCase()
  const paths = linuxMachineIdPaths()
  let wrote = false

  for (const filePath of paths) {
    try {
      if (process.env.KIRO_MACHINE_ID_FILE) {
        await fs.mkdir(path.dirname(filePath), { recursive: true })
      } else {
        await fs.access(filePath)
      }
      await fs.writeFile(filePath, `${raw}\n`, 'utf8')
      wrote = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/EACCES|EPERM|permission/i.test(message)) {
        return { success: false, error: 'Administrator/root permission is required to modify machine-id on this VPS.', requiresAdmin: true }
      }
    }
  }

  return wrote
    ? { success: true, machineId: formatAsUuid(raw) }
    : { success: false, error: 'No Linux machine-id file was found' }
}

export function machineIdGetOSType(): OSType {
  return getOSType()
}

export function machineIdGenerateRandom(): string {
  return crypto.randomUUID().toLowerCase()
}

export async function machineIdGetCurrent(): Promise<MachineIdResult> {
  if (process.env.KIRO_MACHINE_ID_OVERRIDE) {
    const machineId = process.env.KIRO_MACHINE_ID_OVERRIDE.trim()
    return isValidMachineId(machineId)
      ? { success: true, machineId: formatAsUuid(machineId) }
      : { success: false, error: 'KIRO_MACHINE_ID_OVERRIDE has an invalid format' }
  }

  const overrideResult = await readMachineIdFileOverride()
  if (overrideResult) return overrideResult

  if (process.platform === 'win32') return getWindowsMachineId()
  if (process.platform === 'darwin') return getMacMachineId()
  if (process.platform === 'linux') return getLinuxMachineId()
  return { success: false, error: 'Unsupported operating system' }
}

export async function machineIdSet(newMachineId: string): Promise<MachineIdResult> {
  if (!isValidMachineId(newMachineId)) return { success: false, error: 'Invalid machine ID format' }
  const overrideResult = await writeMachineIdFileOverride(newMachineId)
  if (overrideResult) return overrideResult
  if (process.platform === 'win32') return setWindowsMachineId(newMachineId)
  if (process.platform === 'darwin') return setMacMachineId(newMachineId)
  if (process.platform === 'linux') return setLinuxMachineId(newMachineId)
  return { success: false, error: 'Unsupported operating system' }
}

export async function machineIdCheckAdmin(): Promise<boolean> {
  if (process.env.KIRO_MACHINE_ID_FILE) return true
  if (process.platform === 'linux') return process.getuid?.() === 0
  if (process.platform === 'darwin') return true
  if (process.platform !== 'win32') return false

  const psPath = findPowerShell()
  if (psPath) {
    try {
      const result = execSync(`"${psPath}" -NoProfile -Command "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"`, { encoding: 'utf8', timeout: 5000 })
      return result.trim().toLowerCase() === 'true'
    } catch {
      // Fall through to net session.
    }
  }
  try {
    execSync('net session', { stdio: 'ignore', timeout: 3000 })
    return true
  } catch {
    return false
  }
}

function backupPath(): string {
  if (process.env.KIRO_MACHINE_ID_BACKUP_PATH) return path.resolve(process.env.KIRO_MACHINE_ID_BACKUP_PATH)
  return path.join(getRuntimeUserDataPath(), 'machine-id-backup.json')
}

export async function machineIdBackupToFile(machineId: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(backupPath()), { recursive: true })
    await fs.writeFile(backupPath(), JSON.stringify({
      machineId,
      backupTime: Date.now(),
      osType: getOSType(),
      runtime: 'web-vps'
    }, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export async function machineIdRestoreFromFile(): Promise<MachineIdResult> {
  try {
    const data = JSON.parse(await fs.readFile(backupPath(), 'utf8')) as { machineId?: string }
    if (!data.machineId || !isValidMachineId(data.machineId)) return { success: false, error: 'Invalid backup file' }
    return { success: true, machineId: data.machineId }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read machine ID backup' }
  }
}
