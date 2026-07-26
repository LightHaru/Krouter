import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const servers: http.Server[] = []
const pngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
  'base64'
)

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Krouter image OpenClaw skill', () => {
  it('discovers a Krouter provider from an agent profile without command-line credentials', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krouter-image-skill-'))
    temporaryDirectories.push(root)
    const openclawHome = path.join(root, '.openclaw')
    const agentDirectory = path.join(openclawHome, 'agents', 'image-agent', 'agent')
    fs.mkdirSync(agentDirectory, { recursive: true })

    let receivedAuthorization = ''
    const server = http.createServer((request, response) => {
      receivedAuthorization = String(request.headers.authorization || '')
      if (request.method === 'POST' && request.url === '/v1/images/generations') {
        request.resume()
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          created: Date.now(),
          data: [{ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/images/result.png` }]
        }))
        return
      }
      if (request.method === 'GET' && request.url === '/v1/images/result.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' })
        response.end(pngBytes)
        return
      }
      response.writeHead(404)
      response.end()
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port

    fs.writeFileSync(path.join(agentDirectory, 'models.json'), JSON.stringify({
      providers: {
        krouter: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: '${TEST_KROUTER_KEY}'
        }
      }
    }))

    const output = path.join(root, 'generated', 'test.png')
    const script = path.resolve('docs/skills/krouter-image/scripts/generate-image.cjs')
    const result = await execFileAsync(process.execPath, [
      script,
      '--prompt', 'A green Krouter verification mark',
      '--output', output
    ], {
      env: {
        ...process.env,
        OPENCLAW_HOME: openclawHome,
        TEST_KROUTER_KEY: 'secret-test-key'
      }
    })

    expect(receivedAuthorization).toBe('Bearer secret-test-key')
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      path: output,
      contentType: 'image/png',
      model: 'gpt-image-2'
    })
    expect(fs.readFileSync(output)).toEqual(pngBytes)
    expect(result.stdout).not.toContain('secret-test-key')
    expect(result.stderr).toBe('')
  })
})
