import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import {
  buildChatGPTCodexHeaders,
  buildCodexPayloadFromChat,
  buildCodexPayloadFromResponses,
  chatGPTCodexThinkingEfforts,
  DEFAULT_CHATGPT_CODEX_CONFIG,
  extractChatGPTCodexError,
  isChatGPTCodexModel,
  iterateCodexSse,
  listChatGPTCodexModels,
  parseChatGPTUsage
} from '../../src/main/proxy/chatgptCodex'
import type { ChatGPTAccountState } from '../../src/main/proxy/chatgptOAuth'
import { ProxyServer } from '../../src/main/proxy/proxyServer'

function account(): ChatGPTAccountState {
  const now = Date.now()
  return {
    id: 'account-1',
    accessToken: 'private-access-token',
    refreshToken: 'private-refresh-token',
    expiresAt: now + 3600_000,
    accountId: 'workspace-1',
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now
  }
}

async function listenOnRandomPort(server: ReturnType<typeof createHttpServer>): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

async function availablePort(): Promise<number> {
  const server = createHttpServer()
  const port = await listenOnRandomPort(server)
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

describe('ChatGPT/Codex experimental provider', () => {
  it('publishes only namespaced models when explicitly enabled', () => {
    expect(isChatGPTCodexModel('chatgpt/gpt-5.4', { enabled: true })).toBe(true)
    expect(isChatGPTCodexModel('gpt-5.4', { enabled: true })).toBe(false)
    expect(isChatGPTCodexModel('chatgpt/gpt-5.4', { enabled: false })).toBe(false)
    expect(listChatGPTCodexModels().length).toBeGreaterThan(3)
  })

  it('merges ChatGPT models into the control-room catalog even without a Kiro account', async () => {
    const server = new ProxyServer({
      chatgptCodex: { ...DEFAULT_CHATGPT_CODEX_CONFIG, enabled: true },
      chatgptAccounts: [account()]
    })
    const result = await server.getAvailableModels()
    expect(result.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'chatgpt/gpt-5.6-sol',
        modelProvider: 'chatgpt',
        supportsThinking: true,
        thinkingEfforts: expect.arrayContaining(['xhigh', 'max'])
      })
    ]))
  })

  it('builds a Codex Responses payload from chat history and strips the namespace', () => {
    const payload = buildCodexPayloadFromChat({
      model: 'chatgpt/gpt-5.4',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' }
      ],
      stream: false,
      reasoning_effort: 'high'
    })

    expect(payload).toMatchObject({
      model: 'gpt-5.4',
      instructions: 'Be concise.',
      stream: true,
      store: false,
      reasoning: { effort: 'high' }
    })
    expect(payload.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }])
  })

  it('accepts OpenClaw assistant tool calls with null content', () => {
    const payload = buildCodexPayloadFromChat({
      model: 'chatgpt/gpt-5.6-sol',
      messages: [
        { role: 'user', content: 'Read the skill' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read', arguments: '{"path":"SKILL.md"}' }
          }]
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'skill contents' }
      ]
    } as Parameters<typeof buildCodexPayloadFromChat>[0])

    expect(payload.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call', call_id: 'call-1', name: 'read' }),
      expect.objectContaining({ type: 'function_call_output', call_id: 'call-1', output: 'skill contents' })
    ]))
  })

  it('applies the configured reasoning effort only when the request did not override it', () => {
    expect(buildCodexPayloadFromChat({
      model: 'chatgpt/gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Hello' }]
    }, 'max').reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
    expect(buildCodexPayloadFromResponses({
      model: 'chatgpt/gpt-5.5',
      input: 'Hello',
      reasoning: { effort: 'low' }
    }, 'high').reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(buildCodexPayloadFromChat({
      model: 'chatgpt/gpt-5.3-codex-spark',
      messages: [{ role: 'user', content: 'Hello' }]
    }, 'minimal').reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect(chatGPTCodexThinkingEfforts('gpt-5.6-sol')).toContain('max')
    expect(chatGPTCodexThinkingEfforts('gpt-5.6-sol')).toContain('none')
    expect(chatGPTCodexThinkingEfforts('gpt-5.6-sol')).not.toContain('minimal')
  })

  it('persists the backend default and forwards it through the real chat endpoint', async () => {
    let capturedPayload: Record<string, unknown> | undefined
    const upstream = createHttpServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        capturedPayload = JSON.parse(body) as Record<string, unknown>
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.end([
          'data: {"type":"response.output_text.delta","delta":"OK"}',
          '',
          'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
          '',
          ''
        ].join('\n'))
      })
    })
    const upstreamPort = await listenOnRandomPort(upstream)
    const proxyPort = await availablePort()
    const codexConfig = {
      ...DEFAULT_CHATGPT_CODEX_CONFIG,
      enabled: true,
      baseUrl: `http://127.0.0.1:${upstreamPort}/responses`,
      reasoningEffort: 'high' as const
    }
    const proxy = new ProxyServer({
      host: '127.0.0.1',
      port: proxyPort,
      autoStart: false,
      chatgptCodex: codexConfig,
      chatgptAccounts: [account()]
    })

    try {
      proxy.updateConfig({
        chatgptCodex: { ...codexConfig, reasoningEffort: 'none' }
      })
      expect(proxy.getChatGPTOAuthStatus().reasoningEffort).toBe('none')
      expect(proxy.getConfig().chatgptCodex?.reasoningEffort).toBe('none')
      expect(new ProxyServer(proxy.getConfig()).getChatGPTOAuthStatus().reasoningEffort).toBe('none')

      await proxy.start()
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'chatgpt/gpt-5.6-sol',
          messages: [{ role: 'user', content: 'Reply OK' }],
          stream: false
        })
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        model: 'chatgpt/gpt-5.6-sol',
        choices: [{ message: { content: 'OK' } }]
      })
      expect(capturedPayload).toMatchObject({
        model: 'gpt-5.6-sol',
        reasoning: { effort: 'none', summary: 'auto' },
        stream: true,
        store: false
      })
    } finally {
      await proxy.stop()
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
    }
  })

  it('rejects unsupported persisted reasoning values safely', () => {
    const server = new ProxyServer({
      chatgptCodex: {
        ...DEFAULT_CHATGPT_CODEX_CONFIG,
        reasoningEffort: 'unsupported' as typeof DEFAULT_CHATGPT_CODEX_CONFIG.reasoningEffort
      }
    })
    expect(server.getChatGPTOAuthStatus().reasoningEffort).toBe('auto')
  })

  it('strips unsupported Codex fields and flattens Chat Completions tools', () => {
    const payload = buildCodexPayloadFromResponses({
      model: 'chatgpt/gpt-5.4',
      input: 'Use the tool',
      max_output_tokens: 10,
      temperature: 0.2,
      previous_response_id: 'resp_server_only',
      metadata: { secret: 'not-forwarded' },
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup a value',
          parameters: { type: 'object', properties: {} }
        }
      }]
    } as Parameters<typeof buildCodexPayloadFromResponses>[0])
    expect(payload).not.toHaveProperty('max_output_tokens')
    expect(payload).not.toHaveProperty('temperature')
    expect(payload).not.toHaveProperty('previous_response_id')
    expect(payload).not.toHaveProperty('metadata')
    expect(payload.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use the tool' }] }])
    expect(payload.tools).toEqual([expect.objectContaining({ type: 'function', name: 'lookup' })])
  })

  it('binds the ChatGPT workspace without exposing refresh credentials', () => {
    const headers = buildChatGPTCodexHeaders(account())
    expect(headers.Authorization).toBe('Bearer private-access-token')
    expect(headers['ChatGPT-Account-ID']).toBe('workspace-1')
    expect(JSON.stringify(headers)).not.toContain('private-refresh-token')
  })

  it('parses session, weekly and review quota reset windows', () => {
    expect(parseChatGPTUsage({
      rate_limit: { used_percent: 25, reset_at: 1_800_000_000 },
      secondary_window: { remaining_percent: 40, reset_time: 1_900_000_000 },
      code_review_rate_limit: { limit_window: { used_percent: 5, reset_at: 2_000_000_000 } }
    })).toEqual([
      expect.objectContaining({ key: 'session', usedPercent: 25, remainingPercent: 75, resetAt: 1_800_000_000_000 }),
      expect.objectContaining({ key: 'weekly', remainingPercent: 40, resetAt: 1_900_000_000_000 }),
      expect.objectContaining({ key: 'review', usedPercent: 5, remainingPercent: 95, resetAt: 2_000_000_000_000 })
    ])
  })

  it('parses the nested Codex wham usage shape and reset timestamp variants', () => {
    expect(parseChatGPTUsage({
      rate_limits: {
        rate_limit: {
          primary_window: {
            percent_used: 100,
            resets_at: '2030-05-06T21:28:00.000Z',
            limit_window_seconds: 18_000
          },
          secondary_window: {
            used_percent: 0,
            reset_at: '2000000000',
            limit_window_seconds: 604_800
          }
        }
      },
      rate_limits_by_limit_id: {
        code_review: {
          primary_window: {
            remaining_percent: 80,
            resetAt: 2_100_000_000_000
          }
        }
      }
    })).toEqual([
      expect.objectContaining({
        key: 'session',
        usedPercent: 100,
        remainingPercent: 0,
        resetAt: Date.parse('2030-05-06T21:28:00.000Z'),
        limitWindowSeconds: 18_000
      }),
      expect.objectContaining({
        key: 'weekly',
        usedPercent: 0,
        remainingPercent: 100,
        resetAt: 2_000_000_000_000,
        limitWindowSeconds: 604_800
      }),
      expect.objectContaining({
        key: 'review',
        remainingPercent: 80,
        resetAt: 2_100_000_000_000
      })
    ])
  })

  it('labels long primary windows from their upstream duration', () => {
    expect(parseChatGPTUsage({
      rate_limit: {
        primary_window: { used_percent: 28, reset_at: 2_000_000_000, limit_window_seconds: 604_800 }
      }
    })[0]).toMatchObject({ key: 'weekly', label: 'Weekly', remainingPercent: 72 })

    expect(parseChatGPTUsage({
      rate_limit: {
        primary_window: { used_percent: 91, reset_at: 2_100_000_000, limit_window_seconds: 2_592_000 }
      }
    })[0]).toMatchObject({ key: 'monthly', label: 'Monthly', remainingPercent: 9 })
  })

  it('parses fragmented SSE and sanitizes sensitive upstream errors', async () => {
    async function* chunks(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('event: response.output_text.delta\ndata: {"type":"response.output_text.')
      yield Buffer.from('delta","delta":"hello"}\n\ndata: [DONE]\n\n')
    }
    const events = []
    for await (const event of iterateCodexSse(chunks())) events.push(event)
    expect(events).toHaveLength(2)
    expect(events[0].value).toMatchObject({ delta: 'hello' })

    const error = extractChatGPTCodexError(401, '{"error":{"message":"Bearer top-secret"}}')
    expect(error.message).toContain('Bearer [redacted]')
    expect(error.message).not.toContain('top-secret')
  })
})
