import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'

function kiroRoot(): string {
  return path.resolve(process.env.KIRO_CONFIG_HOME || path.join(os.homedir(), '.kiro'))
}

function settingsPath(): string {
  if (process.platform === 'win32' && !process.env.KIRO_CONFIG_HOME) {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'settings.json')
  }
  return path.join(kiroRoot(), 'settings', 'settings.json')
}

function mcpPath(type: 'user' | 'workspace'): string {
  return type === 'workspace'
    ? path.join(process.cwd(), '.kiro', 'settings', 'mcp.json')
    : path.join(kiroRoot(), 'settings', 'mcp.json')
}

function steeringDir(): string {
  return path.join(kiroRoot(), 'steering')
}

function steeringFilePath(filename: string): string {
  const safeName = path.basename(filename)
  if (!safeName.endsWith('.md')) throw new Error('Only markdown steering files are allowed')
  return path.join(steeringDir(), safeName)
}

function parseJsonc(content: string): Record<string, unknown> {
  const cleaned = content
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/,(\s*[}\]])/g, '$1')
  return JSON.parse(cleaned)
}

async function readJsonFile(filePath: string, fallback: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return parseJsonc(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

function uiSettingsFromKiro(parsed: Record<string, unknown>): Record<string, unknown> {
  return {
    modelSelection: parsed['kiroAgent.modelSelection'],
    agentAutonomy: parsed['kiroAgent.agentAutonomy'],
    enableDebugLogs: parsed['kiroAgent.enableDebugLogs'],
    enableTabAutocomplete: parsed['kiroAgent.enableTabAutocomplete'],
    enableCodebaseIndexing: parsed['kiroAgent.enableCodebaseIndexing'],
    usageSummary: parsed['kiroAgent.usageSummary'],
    codeReferences: parsed['kiroAgent.codeReferences.referenceTracker'],
    configureMCP: parsed['kiroAgent.configureMCP'],
    trustedCommands: parsed['kiroAgent.trustedCommands'],
    trustedTools: parsed['kiroAgent.trustedTools'],
    commandDenylist: parsed['kiroAgent.commandDenylist'],
    ignoreFiles: parsed['kiroAgent.ignoreFiles'],
    mcpApprovedEnvVars: parsed['kiroAgent.mcpApprovedEnvVars'],
    notificationsActionRequired: parsed['kiroAgent.notifications.agent.actionRequired'],
    notificationsFailure: parsed['kiroAgent.notifications.agent.failure'],
    notificationsSuccess: parsed['kiroAgent.notifications.agent.success'],
    notificationsBilling: parsed['kiroAgent.notifications.billing']
  }
}

function kiroSettingsFromUi(existing: Record<string, unknown>, settings: Record<string, unknown>): Record<string, unknown> {
  return {
    ...existing,
    'kiroAgent.modelSelection': settings.modelSelection,
    'kiroAgent.agentAutonomy': settings.agentAutonomy,
    'kiroAgent.enableDebugLogs': settings.enableDebugLogs,
    'kiroAgent.enableTabAutocomplete': settings.enableTabAutocomplete,
    'kiroAgent.enableCodebaseIndexing': settings.enableCodebaseIndexing,
    'kiroAgent.usageSummary': settings.usageSummary,
    'kiroAgent.codeReferences.referenceTracker': settings.codeReferences,
    'kiroAgent.configureMCP': settings.configureMCP,
    'kiroAgent.trustedCommands': settings.trustedCommands,
    'kiroAgent.trustedTools': settings.trustedTools,
    'kiroAgent.commandDenylist': settings.commandDenylist,
    'kiroAgent.ignoreFiles': settings.ignoreFiles,
    'kiroAgent.mcpApprovedEnvVars': settings.mcpApprovedEnvVars,
    'kiroAgent.notifications.agent.actionRequired': settings.notificationsActionRequired,
    'kiroAgent.notifications.agent.failure': settings.notificationsFailure,
    'kiroAgent.notifications.agent.success': settings.notificationsSuccess,
    'kiroAgent.notifications.billing': settings.notificationsBilling
  }
}

export async function getKiroSettings(): Promise<{
  settings?: Record<string, unknown>
  mcpConfig?: { mcpServers: Record<string, unknown> }
  steeringFiles?: string[]
  paths?: Record<string, string>
  error?: string
}> {
  try {
    const rawSettings = await readJsonFile(settingsPath(), {})
    const mcpConfig = await readJsonFile(mcpPath('user'), { mcpServers: {} }) as { mcpServers: Record<string, unknown> }
    let steeringFiles: string[] = []
    try {
      steeringFiles = (await fs.readdir(steeringDir())).filter((file) => file.endsWith('.md'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return {
      settings: uiSettingsFromKiro(rawSettings),
      mcpConfig,
      steeringFiles,
      paths: {
        root: kiroRoot(),
        settings: settingsPath(),
        mcp: mcpPath('user'),
        steering: steeringDir()
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Failed to get Kiro settings' }
  }
}

export async function saveKiroSettings(settings: Record<string, unknown>): Promise<{ success: boolean; error?: string }> {
  try {
    const existing = await readJsonFile(settingsPath(), {})
    await writeJsonFile(settingsPath(), kiroSettingsFromUi(existing, settings))
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save Kiro settings' }
  }
}

export async function ensureKiroSettingsFile(): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const filePath = settingsPath()
    try {
      await fs.access(filePath)
    } catch {
      await writeJsonFile(filePath, {
        'workbench.colorTheme': 'Kiro Light',
        'kiroAgent.modelSelection': 'claude-haiku-4.5'
      })
    }
    return { success: true, path: filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create settings file' }
  }
}

export async function ensureMcpConfig(type: 'user' | 'workspace'): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const filePath = mcpPath(type)
    try {
      await fs.access(filePath)
    } catch {
      await writeJsonFile(filePath, { mcpServers: {} })
    }
    return { success: true, path: filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create MCP config' }
  }
}

export async function ensureSteeringFolder(): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    await fs.mkdir(steeringDir(), { recursive: true })
    return { success: true, path: steeringDir() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create steering folder' }
  }
}

export async function createDefaultRules(): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    await fs.mkdir(steeringDir(), { recursive: true })
    const filePath = steeringFilePath('rules.md')
    const content = [
      '# Kiro Rules',
      '',
      '- Keep code modular and maintainable.',
      '- Prefer clear, testable changes.',
      '- Surface uncertainty instead of guessing.'
    ].join('\n')
    await fs.writeFile(filePath, content, 'utf8')
    return { success: true, path: filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to create default rules' }
  }
}

export async function readSteeringFile(filename: string): Promise<{ success: boolean; content?: string; error?: string }> {
  try {
    return { success: true, content: await fs.readFile(steeringFilePath(filename), 'utf8') }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to read steering file' }
  }
}

export async function saveSteeringFile(filename: string, content: string): Promise<{ success: boolean; error?: string }> {
  try {
    await fs.mkdir(steeringDir(), { recursive: true })
    await fs.writeFile(steeringFilePath(filename), content, 'utf8')
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save steering file' }
  }
}

export async function deleteSteeringFile(filename: string): Promise<{ success: boolean; error?: string }> {
  try {
    await fs.unlink(steeringFilePath(filename))
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to delete steering file' }
  }
}

export async function saveMcpServer(
  name: string,
  config: { command: string; args?: string[]; env?: Record<string, string> },
  oldName?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const filePath = mcpPath('user')
    const current = await readJsonFile(filePath, { mcpServers: {} }) as { mcpServers?: Record<string, unknown> }
    current.mcpServers = current.mcpServers || {}
    if (oldName && oldName !== name) delete current.mcpServers[oldName]
    current.mcpServers[name] = config
    await writeJsonFile(filePath, current)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to save MCP server' }
  }
}

export async function deleteMcpServer(name: string): Promise<{ success: boolean; error?: string }> {
  try {
    const filePath = mcpPath('user')
    const current = await readJsonFile(filePath, { mcpServers: {} }) as { mcpServers?: Record<string, unknown> }
    if (!current.mcpServers?.[name]) return { success: false, error: 'MCP server not found' }
    delete current.mcpServers[name]
    await writeJsonFile(filePath, current)
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to delete MCP server' }
  }
}
