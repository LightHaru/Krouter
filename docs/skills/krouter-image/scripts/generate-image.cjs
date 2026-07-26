#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    const value = argv[index + 1]
    if (value && !value.startsWith('--')) {
      args[key.slice(2)] = value
      index++
    } else {
      args[key.slice(2)] = true
    }
  }
  return args
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function providerFromConfig(config) {
  return config?.models?.providers?.krouter || config?.providers?.krouter
}

function agentModelConfigs(openclawHome) {
  const agentsDir = path.join(openclawHome, 'agents')
  if (!fs.existsSync(agentsDir)) return []
  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(agentsDir, entry.name, 'agent', 'models.json'))
}

function resolveEnvironmentValue(value) {
  if (typeof value !== 'string') return undefined
  const match = value.match(/^\$\{([A-Z0-9_]+)\}$/i)
  return match ? process.env[match[1]] : value
}

function loadConnection(args) {
  const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw')
  const candidates = [
    typeof args.config === 'string' ? args.config : undefined,
    process.env.OPENCLAW_CONFIG_PATH,
    path.join(openclawHome, 'openclaw.json'),
    path.join(openclawHome, 'agents', 'main', 'agent', 'models.json'),
    ...agentModelConfigs(openclawHome)
  ].filter(Boolean)

  const providers = []
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    try {
      const provider = providerFromConfig(readJson(candidate))
      if (provider) providers.push(provider)
    } catch {
      if (candidate === args.config) throw new Error('Unable to read the requested OpenClaw config')
    }
  }

  const apiKey = resolveEnvironmentValue(
    args['api-key']
      || process.env.KROUTER_API_KEY
      || providers.find(provider => provider.apiKey || provider.api_key)?.apiKey
      || providers.find(provider => provider.apiKey || provider.api_key)?.api_key
  )
  const baseUrl = resolveEnvironmentValue(
    args['base-url']
      || process.env.KROUTER_BASE_URL
      || providers.find(provider => provider.baseUrl || provider.base_url)?.baseUrl
      || providers.find(provider => provider.baseUrl || provider.base_url)?.base_url
      || 'http://127.0.0.1:5580'
  )
  if (!baseUrl) throw new Error('Krouter base URL could not be resolved')
  return { apiKey, baseUrl }
}

function imageExtension(contentType, bytes) {
  if (contentType.includes('png') || bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png'
  if (contentType.includes('jpeg') || bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return '.jpg'
  if (contentType.includes('webp') || bytes.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp'
  throw new Error(`Krouter returned unsupported image bytes (${contentType || 'unknown content type'})`)
}

function safeMessage(error) {
  return String(error?.message || error)
    .replace(/bearer\s+[^\s,;}]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:code|state)=)[^&\s]+/gi, '$1[redacted]')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const prompt = typeof args.prompt === 'string'
    ? args.prompt.trim()
    : typeof args['prompt-file'] === 'string'
      ? fs.readFileSync(args['prompt-file'], 'utf8').trim()
      : ''
  if (!prompt) throw new Error('Usage: generate-image.cjs --prompt "description" [--output path]')

  const connection = loadConnection(args)
  const apiKey = connection.apiKey
  const baseUrl = String(connection.baseUrl).replace(/\/v1\/?$/, '')
  const authHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  const response = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: typeof args.model === 'string' ? args.model : 'gpt-image-2',
      prompt,
      size: typeof args.size === 'string' ? args.size : '1024x1024',
      quality: typeof args.quality === 'string' ? args.quality : 'auto',
      response_format: 'url'
    })
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error?.message || `Krouter image request failed (${response.status})`)

  const imageUrl = payload?.data?.[0]?.url
  if (typeof imageUrl !== 'string') throw new Error('Krouter image response did not include a URL')
  const localUrl = imageUrl.replace('://0.0.0.0:', '://127.0.0.1:').replace('://[::]:', '://127.0.0.1:')
  const imageResponse = await fetch(localUrl, { headers: authHeaders })
  if (!imageResponse.ok) throw new Error(`Generated image download failed (${imageResponse.status})`)
  const contentType = imageResponse.headers.get('content-type') || ''
  const bytes = Buffer.from(await imageResponse.arrayBuffer())
  if (!contentType.toLowerCase().startsWith('image/') || bytes.length === 0) {
    throw new Error(`Generated artifact is not an image (${contentType || 'missing content type'}, ${bytes.length} bytes)`)
  }

  const extension = imageExtension(contentType.toLowerCase(), bytes)
  const requestedOutput = typeof args.output === 'string'
    ? path.resolve(args.output)
    : path.resolve(process.cwd(), 'generated-images', `krouter-${Date.now()}${extension}`)
  const output = path.extname(requestedOutput) ? requestedOutput : `${requestedOutput}${extension}`
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, bytes, { mode: 0o600 })
  process.stdout.write(`${JSON.stringify({
    ok: true,
    path: output,
    bytes: bytes.length,
    contentType,
    model: typeof args.model === 'string' ? args.model : 'gpt-image-2'
  })}\n`)
}

main().catch(error => {
  process.stderr.write(`${safeMessage(error)}\n`)
  process.exitCode = 1
})
