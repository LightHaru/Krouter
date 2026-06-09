import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Sandbox HOME so the E2E never touches the developer's real ~/.claude,
// ~/.openclaw, ~/.codex, etc. We mock os.homedir() to a temp dir, then run the
// REAL configureProxyClients against the real filesystem inside that sandbox.
const SANDBOX = mkdtempSync(join(tmpdir(), 'krouter-clientcfg-'))

vi.mock('os', async (importActual) => {
  const actual = await importActual<typeof import('os')>()
  return { ...actual, homedir: () => SANDBOX, default: { ...actual, homedir: () => SANDBOX } }
})

// Import AFTER the mock so clientConfig's homedir() resolves to the sandbox.
const { configureProxyClients } = await import('../../src/main/proxy/clientConfig')

const INPUT = {
  clients: ['claudeCode', 'opencode', 'codex', 'gemini', 'hermes', 'openclaw'] as const,
  host: '127.0.0.1',
  port: 5580,
  tlsEnabled: false,
  apiKey: 'sk-test-e2e-key-1234567890',
  modelId: 'claude-sonnet-4.5',
  modelName: 'Claude Sonnet 4.5',
  models: [
    { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 },
    { id: 'claude-opus-4.8', name: 'Claude Opus 4.8', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 },
    { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', inputTypes: ['TEXT', 'IMAGE'], maxInputTokens: 200000, maxOutputTokens: 64000 }
  ]
}

let result: Awaited<ReturnType<typeof configureProxyClients>>

beforeAll(async () => {
  result = await configureProxyClients({ ...INPUT, clients: [...INPUT.clients] })
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, 'utf-8'))
}

describe('configureProxyClients E2E (sandboxed HOME)', () => {
  it('all six clients configured successfully', () => {
    expect(result.success).toBe(true)
    const byClient = Object.fromEntries(result.results.map((r) => [r.client, r]))
    for (const c of INPUT.clients) {
      expect(byClient[c]?.success, `${c} should succeed: ${byClient[c]?.error}`).toBe(true)
      expect(byClient[c]?.paths.length).toBeGreaterThan(0)
    }
    expect(result.openaiBaseUrl).toBe('http://127.0.0.1:5580/v1')
    expect(result.apiKey.key).toBe(INPUT.apiKey)
  })

  it('Claude Code -> ~/.claude/settings.json with env block', () => {
    const p = join(SANDBOX, '.claude', 'settings.json')
    expect(existsSync(p)).toBe(true)
    const cfg = readJson(p)
    expect(cfg.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5580')
    expect(cfg.env.ANTHROPIC_AUTH_TOKEN).toBe(INPUT.apiKey)
    expect(cfg.env.ANTHROPIC_API_KEY).toBe(INPUT.apiKey)
    expect(cfg.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4.5')
    expect(cfg.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4.5')
    expect(cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4.8')
  })

  it('OpenCode -> ~/.config/opencode/opencode.json with provider.kiro', () => {
    const p = join(SANDBOX, '.config', 'opencode', 'opencode.json')
    expect(existsSync(p)).toBe(true)
    const cfg = readJson(p)
    expect(cfg.provider.kiro.npm).toBe('@ai-sdk/openai-compatible')
    expect(cfg.provider.kiro.options.baseURL).toBe('http://127.0.0.1:5580/v1')
    expect(cfg.provider.kiro.options.apiKey).toBe(INPUT.apiKey)
    expect(cfg.model).toBe('kiro/claude-sonnet-4.5')
    // each selected model present
    expect(Object.keys(cfg.provider.kiro.models)).toEqual(
      expect.arrayContaining(['claude-sonnet-4.5', 'claude-opus-4.8', 'claude-haiku-4.5'])
    )
  })

  it('Codex CLI -> ~/.codex/auth.json + config.toml with model_providers.kiro', () => {
    const auth = join(SANDBOX, '.codex', 'auth.json')
    const conf = join(SANDBOX, '.codex', 'config.toml')
    expect(existsSync(auth)).toBe(true)
    expect(existsSync(conf)).toBe(true)
    expect(readJson(auth).OPENAI_API_KEY).toBe(INPUT.apiKey)
    const toml = readFileSync(conf, 'utf-8')
    expect(toml).toContain('model_provider = "kiro"')
    expect(toml).toContain('model = "claude-sonnet-4.5"')
    expect(toml).toContain('[model_providers.kiro]')
    expect(toml).toContain('base_url = "http://127.0.0.1:5580/v1"')
    expect(toml).toContain('wire_api = "responses"')
  })

  it('Gemini CLI -> ~/.gemini/.env + settings.json', () => {
    const env = join(SANDBOX, '.gemini', '.env')
    const settings = join(SANDBOX, '.gemini', 'settings.json')
    expect(existsSync(env)).toBe(true)
    expect(existsSync(settings)).toBe(true)
    const envText = readFileSync(env, 'utf-8')
    expect(envText).toContain(`GEMINI_API_KEY=${INPUT.apiKey}`)
    expect(envText).toContain('GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:5580/v1beta')
    expect(envText).toContain('GEMINI_MODEL=claude-sonnet-4.5')
    expect(readJson(settings).security.auth.selectedType).toBe('gemini-api-key')
  })

  it('Hermes -> ~/.hermes/config.yaml with kiro custom provider', () => {
    const p = join(SANDBOX, '.hermes', 'config.yaml')
    expect(existsSync(p)).toBe(true)
    const yaml = readFileSync(p, 'utf-8')
    expect(yaml).toContain('custom_providers:')
    expect(yaml).toContain('- name: kiro')
    expect(yaml).toContain('base_url: http://127.0.0.1:5580/v1')
    expect(yaml).toContain(`api_key: ${INPUT.apiKey}`)
    expect(yaml).toContain('default: "kiro/claude-sonnet-4.5"')
  })

  it('OpenClaw -> ~/.openclaw/openclaw.json with krouter provider', () => {
    const p = join(SANDBOX, '.openclaw', 'openclaw.json')
    expect(existsSync(p)).toBe(true)
    const cfg = readJson(p)
    const provider = cfg.models.providers.krouter
    expect(provider).toBeTruthy()
    expect(provider.baseUrl).toBe('http://127.0.0.1:5580/v1')
    expect(provider.apiKey).toBe(INPUT.apiKey)
    expect(provider.api).toBe('openai-completions')
    expect(provider.auth).toBe('api-key')
    expect(Array.isArray(provider.models)).toBe(true)
    expect(provider.models.map((m: any) => m.id)).toEqual(
      expect.arrayContaining(['claude-sonnet-4.5', 'claude-opus-4.8', 'claude-haiku-4.5'])
    )
    // agents.defaults.model primary + fallbacks reference the krouter provider
    expect(cfg.agents.defaults.model.primary).toBe('krouter/claude-sonnet-4.5')
    expect(Array.isArray(cfg.agents.defaults.model.fallbacks)).toBe(true)
    for (const ref of cfg.agents.defaults.model.fallbacks) {
      expect(String(ref).startsWith('krouter/')).toBe(true)
    }
  })

  it('merges + backs up an existing OpenClaw config instead of clobbering', async () => {
    // Pre-existing config with a user provider and a legacy kiro-manager provider.
    const { mkdirSync, writeFileSync, readdirSync } = await import('node:fs')
    const dir = join(SANDBOX, 'merge-home', '.openclaw')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'openclaw.json')
    writeFileSync(file, JSON.stringify({
      models: { providers: { myProvider: { baseUrl: 'http://x', models: [] } } },
      somethingElse: { keep: true }
    }, null, 2))

    // Point homedir at this sub-home for one call.
    const os = await import('os')
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(join(SANDBOX, 'merge-home'))
    try {
      const r = await configureProxyClients({ ...INPUT, clients: ['openclaw'] })
      expect(r.success).toBe(true)
    } finally {
      spy.mockRestore()
    }

    const cfg = readJson(file)
    // user provider preserved
    expect(cfg.models.providers.myProvider).toBeTruthy()
    // unrelated top-level field preserved
    expect(cfg.somethingElse.keep).toBe(true)
    // krouter provider added
    expect(cfg.models.providers.krouter).toBeTruthy()
    // a backup file was created
    const backups = readdirSync(dir).filter((f) => f.includes('.kiro-backup-'))
    expect(backups.length).toBeGreaterThan(0)
  })
})
