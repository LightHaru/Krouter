import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { HostsManager } from '../../src/main/kproxy/hostsManager'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function createHostsManager(): Promise<{ manager: HostsManager; hostsPath: string; original: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'krouter-hosts-test-'))
  tempDirs.push(dir)
  const hostsPath = path.join(dir, 'hosts')
  const original = '127.0.0.1 localhost\n10.0.0.2 internal.example\n'
  await fs.writeFile(hostsPath, original, 'utf8')
  return { manager: new HostsManager({ hostsPath, platform: 'linux' }), hostsPath, original }
}

describe('HostsManager', () => {
  it('adds a marked Krouter section and reports installed entries', async () => {
    const { manager, hostsPath, original } = await createHostsManager()
    const entries = manager.getDefaultEntries().slice(0, 2)

    await manager.addEntries(entries)

    const content = await fs.readFile(hostsPath, 'utf8')
    expect(content).toContain(original.trimEnd())
    expect(content).toContain('# Krouter MITM - START')
    expect(content).toContain(`127.0.0.1 ${entries[0].hostname}`)
    await expect(manager.getStatus()).resolves.toMatchObject({ enabled: true })
  })

  it('removes only the Krouter section and preserves unrelated hosts', async () => {
    const { manager, hostsPath, original } = await createHostsManager()
    await manager.addEntries(manager.getDefaultEntries())

    await manager.removeEntries()

    const content = await fs.readFile(hostsPath, 'utf8')
    expect(content).not.toContain('# Krouter MITM')
    expect(content.trim()).toBe(original.trim())
    await expect(manager.getStatus()).resolves.toEqual({ enabled: false, entries: [] })
  })

  it('clears an existing Krouter section when all requested entries are disabled', async () => {
    const { manager, hostsPath } = await createHostsManager()
    await manager.addEntries(manager.getDefaultEntries())

    await manager.addEntries(manager.getDefaultEntries().map((entry) => ({ ...entry, enabled: false })))

    expect(await fs.readFile(hostsPath, 'utf8')).not.toContain('# Krouter MITM')
  })

  it('writes DNS routes only for the selected IDE profiles', async () => {
    const { manager, hostsPath } = await createHostsManager()

    const kiro = await manager.setEnabledIdeTypes(['kiro'])
    const kiroContent = await fs.readFile(hostsPath, 'utf8')
    expect(kiro.enabled).toBe(true)
    expect(kiro.entries).toHaveLength(3)
    expect(kiroContent).toContain('runtime.us-east-1.kiro.dev')
    expect(kiroContent).not.toContain('api.individual.githubcopilot.com')
    expect(kiroContent).not.toContain('api2.cursor.sh')

    const mixed = await manager.setEnabledIdeTypes(['kiro', 'cursor'])
    const mixedContent = await fs.readFile(hostsPath, 'utf8')
    expect(mixed.entries).toHaveLength(4)
    expect(mixedContent).toContain('runtime.us-east-1.kiro.dev')
    expect(mixedContent).toContain('api2.cursor.sh')

    const cursorOnly = await manager.setEnabledIdeTypes(['cursor'])
    const cursorContent = await fs.readFile(hostsPath, 'utf8')
    expect(cursorOnly.entries).toHaveLength(1)
    expect(cursorContent).not.toContain('runtime.us-east-1.kiro.dev')
    expect(cursorContent).toContain('api2.cursor.sh')
  })
})
