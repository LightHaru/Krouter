// Bedrock E2E probe: boots the real compiled Krouter ProxyServer with a Bedrock
// provider config, lists Bedrock models, then exercises each text model through
// the OpenAI + Anthropic compatible proxy endpoints (non-stream and stream).
//
// Credentials are read ONLY from environment variables:
//   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION (optional session token)
//
// Usage: node test/bedrock-e2e/run.mjs [--models id1,id2] [--max N]

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..', '..')

const { ProxyServer } = require(path.join(repoRoot, 'out-server/main/proxy/proxyServer.js'))
const bedrock = require(path.join(repoRoot, 'out-server/main/proxy/bedrock.js'))

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
const accessKeyId = process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
const sessionToken = process.env.AWS_SESSION_TOKEN

if (!accessKeyId || !secretAccessKey) {
  console.error(
    'MISSING CREDENTIALS: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in the environment.'
  )
  process.exit(2)
}

const argv = process.argv.slice(2)
function argVal(flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const onlyModels = (argVal('--models') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const maxModels = Number(argVal('--max') || '0') || 0
const apiKey = 'sk-bedrock-e2e-test-key'

const bedrockConfig = { enabled: true, accessKeyId, secretAccessKey, sessionToken, region }

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.unref()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      s.close((e) => (e ? reject(e) : resolve(port)))
    })
  })
}

function httpJson(port, pathName, body, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathName,
        method: body ? 'POST' : 'GET',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {})
        }
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => resolve({ status: res.statusCode, body: buf, stream }))
      }
    )
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function parseSSEContent(raw) {
  let text = ''
  let sawDone = false
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (payload === '[DONE]') {
      sawDone = true
      continue
    }
    try {
      const obj = JSON.parse(payload)
      const delta = obj.choices?.[0]?.delta
      if (delta?.content) text += delta.content
    } catch {
      /* ignore */
    }
  }
  return { text, sawDone }
}

async function main() {
  // sanity: verify credentials before wasting time on model calls
  process.stdout.write(`Region: ${region}\nAccessKeyId length: ${accessKeyId.length}\n`)
  let listedModels = []
  try {
    listedModels = await bedrock.listBedrockModels(bedrockConfig)
  } catch (e) {
    console.error(
      '\nFATAL: ListFoundationModels failed. Credentials are likely invalid or lack bedrock:ListFoundationModels.'
    )
    console.error(String(e.message || e))
    process.exit(3)
  }
  const textModels = listedModels.filter((m) => (m.outputModalities || []).includes('TEXT'))
  const onDemand = textModels.filter((m) => (m.inferenceTypesSupported || []).includes('ON_DEMAND'))
  console.log(
    `\nTotal foundation models: ${listedModels.length}; text models: ${textModels.length}; ON_DEMAND text: ${onDemand.length}`
  )

  const server = new ProxyServer(
    {
      enabled: true,
      port: await freePort(),
      host: '127.0.0.1',
      apiKeys: [
        {
          id: 'k1',
          name: 'e2e',
          key: apiKey,
          format: 'sk',
          enabled: true,
          createdAt: Date.now(),
          usage: {
            totalRequests: 0,
            totalCredits: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            daily: {}
          }
        }
      ],
      enableMultiAccount: false,
      selectedAccountIds: [],
      logRequests: false,
      maxConcurrent: 4,
      bedrock: bedrockConfig
    },
    {}
  )
  const port = server['config'].port
  await server.start()
  console.log(`Proxy started on 127.0.0.1:${port}`)

  // Confirm /v1/models exposes bedrock ids
  const modelsResp = await httpJson(port, '/v1/models')
  let exposed = []
  try {
    const parsed = JSON.parse(modelsResp.body)
    exposed = (parsed.data || []).map((m) => m.id)
  } catch {
    /* ignore */
  }
  console.log(`/v1/models returned ${exposed.length} models (status ${modelsResp.status})`)

  // choose candidate models: prefer ON_DEMAND (invokable without an inference profile)
  let candidates = onDemand.map((m) => m.modelId)
  if (onlyModels.length) candidates = onlyModels
  if (maxModels > 0) candidates = candidates.slice(0, maxModels)

  const results = []
  for (const modelId of candidates) {
    const entry = { modelId, chat: null, chatStream: null, messages: null }
    // non-stream chat
    try {
      const r = await httpJson(port, '/v1/chat/completions', {
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with exactly the word: PONG' }],
        max_tokens: 1024
      })
      let ok = false,
        note = ''
      if (r.status === 200) {
        const j = JSON.parse(r.body)
        const content = j.choices?.[0]?.message?.content || ''
        ok = typeof content === 'string' && content.length > 0
        note = content.slice(0, 40)
      } else {
        note = r.body.slice(0, 160)
      }
      entry.chat = { status: r.status, ok, note }
    } catch (e) {
      entry.chat = { status: 0, ok: false, note: String(e.message || e).slice(0, 160) }
    }

    // stream chat
    try {
      const r = await httpJson(
        port,
        '/v1/chat/completions',
        {
          model: modelId,
          messages: [{ role: 'user', content: 'Say PONG' }],
          max_tokens: 1024,
          stream: true
        },
        { stream: true }
      )
      let ok = false,
        note = ''
      if (r.status === 200) {
        const { text, sawDone } = parseSSEContent(r.body)
        ok = sawDone && text.length > 0
        note = text.slice(0, 40)
      } else note = r.body.slice(0, 160)
      entry.chatStream = { status: r.status, ok, note }
    } catch (e) {
      entry.chatStream = { status: 0, ok: false, note: String(e.message || e).slice(0, 160) }
    }

    // anthropic messages (only meaningful for anthropic models, but harmless otherwise)
    try {
      const r = await httpJson(port, '/v1/messages', {
        model: modelId,
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Say PONG' }]
      })
      let ok = false,
        note = ''
      if (r.status === 200) {
        const j = JSON.parse(r.body)
        const content = Array.isArray(j.content) ? j.content.map((b) => b.text || '').join('') : ''
        ok = content.length > 0
        note = content.slice(0, 40)
      } else note = r.body.slice(0, 160)
      entry.messages = { status: r.status, ok, note }
    } catch (e) {
      entry.messages = { status: 0, ok: false, note: String(e.message || e).slice(0, 160) }
    }

    const flag = entry.chat?.ok ? 'WORKS' : 'FAIL'
    console.log(
      `[${flag}] ${modelId}  chat=${entry.chat?.status}/${entry.chat?.ok} stream=${entry.chatStream?.status}/${entry.chatStream?.ok} messages=${entry.messages?.status}/${entry.messages?.ok}  "${entry.chat?.note || ''}"`
    )
    results.push(entry)
  }

  const working = results.filter((r) => r.chat?.ok).map((r) => r.modelId)
  console.log(`\n==== SUMMARY ====`)
  console.log(`Candidates tested: ${results.length}`)
  console.log(`Working (chat non-stream): ${working.length}`)
  for (const w of working) console.log(`  - ${w}`)

  const report = {
    generatedAt: new Date().toISOString(),
    region,
    totals: {
      foundationModels: listedModels.length,
      textModels: textModels.length,
      onDemandText: onDemand.length
    },
    candidatesTested: results.length,
    working,
    results
  }
  try {
    fs.mkdirSync('.web-data-dev', { recursive: true })
    fs.writeFileSync('.web-data-dev/bedrock-e2e-report.json', JSON.stringify(report, null, 2))
    console.log('\nReport written to .web-data-dev/bedrock-e2e-report.json')
  } catch (e) {
    console.error('report write failed', e)
  }

  await server.stop()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
