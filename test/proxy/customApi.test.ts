import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock('undici', () => ({ fetch: mocks.fetch }))

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('Custom API providers', () => {
  beforeEach(() => mocks.fetch.mockReset())

  it('discovers OpenAI-compatible models and exposes them through an isolated prefix', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'gpt-4.1', name: 'GPT 4.1' }, { id: 'o3' }] }))
    const { listCustomApiModels } = await import('../../src/main/proxy/customApi')
    const models = await listCustomApiModels({ id: 'acme', name: 'Acme', enabled: true, protocol: 'openai', apiKey: 'sk-test', baseUrl: 'https://api.acme.test', routePrefix: 'acme' })

    expect(models.map((model) => model.id)).toEqual(['acme/gpt-4.1', 'acme/o3'])
    expect(mocks.fetch).toHaveBeenCalledWith('https://api.acme.test/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-test' })
    }))
  })

  it('converts OpenAI chat requests to Anthropic and converts the response back', async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'pong' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 }
    }))
    const { callCustomApiOpenAI } = await import('../../src/main/proxy/customApi')
    const response = await callCustomApiOpenAI(
      { model: 'claude-site/claude-sonnet-4-5', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8 },
      { id: 'claude-site', name: 'Claude Site', enabled: true, protocol: 'anthropic', apiKey: 'ant-key', baseUrl: 'https://claude.example/v1', routePrefix: 'claude-site' },
      'claude-sonnet-4-5'
    )

    expect(response.choices[0].message.content).toBe('pong')
    expect(response.model).toBe('claude-site/claude-sonnet-4-5')
    const [url, options] = mocks.fetch.mock.calls[0]
    expect(url).toBe('https://claude.example/v1/messages')
    expect(options.headers).toMatchObject({ 'x-api-key': 'ant-key', 'anthropic-version': '2023-06-01' })
    expect(JSON.parse(options.body)).toMatchObject({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'ping' }], stream: false })
  })

  it('keeps legacy Xpixi model ids routable without adding a new prefix', async () => {
    const { findCustomProvider, legacyXpixiProvider, exposedCustomModelId } = await import('../../src/main/proxy/customApi')
    const legacy = legacyXpixiProvider({ enabled: true, apiKey: 'sk-old', baseUrl: 'https://api.xpiki.com', models: ['kr/claude-sonnet'] })
    expect(legacy).toBeDefined()
    expect(exposedCustomModelId(legacy!, 'kr/claude-sonnet')).toBe('kr/claude-sonnet')
    expect(findCustomProvider('kr/claude-sonnet', [], { enabled: true, apiKey: 'sk-old', models: ['kr/claude-sonnet'] })?.upstreamModelId).toBe('kr/claude-sonnet')
  })

  it('migrates a legacy single key into the multi-key connection list', async () => {
    const { customApiKeyCandidates, normalizeCustomProvider } = await import('../../src/main/proxy/customApi')
    const provider = normalizeCustomProvider({
      id: 'legacy-provider',
      name: 'Legacy Provider',
      enabled: true,
      protocol: 'openai',
      apiKey: 'sk-legacy',
      baseUrl: 'https://legacy.example'
    })

    expect(provider.keys).toEqual([
      expect.objectContaining({
        id: 'legacy-provider-key-1',
        name: 'Key 1',
        apiKey: 'sk-legacy',
        enabled: true
      })
    ])
    expect(customApiKeyCandidates(provider).map((key) => key.apiKey)).toEqual(['sk-legacy'])
  })

  it('fails over to the next enabled key for model discovery', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({ error: 'expired' }, 401))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 'gpt-failover' }] }))
    const { listCustomApiModels } = await import('../../src/main/proxy/customApi')
    const models = await listCustomApiModels({
      id: 'multi',
      name: 'Multi Key',
      enabled: true,
      protocol: 'openai',
      baseUrl: 'https://multi.example',
      keys: [
        { id: 'first', name: 'First', apiKey: 'sk-expired', enabled: true },
        { id: 'second', name: 'Second', apiKey: 'sk-live', enabled: true }
      ]
    })

    expect(models.map((model) => model.id)).toEqual(['multi/gpt-failover'])
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-expired')
    expect(mocks.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer sk-live')
  })

  it('applies provider Thinking and preserves an explicit request override', async () => {
    mocks.fetch
      .mockResolvedValueOnce(jsonResponse({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-reasoning',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'chatcmpl_2',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-reasoning',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      }))
    const { callCustomApiOpenAI } = await import('../../src/main/proxy/customApi')
    const provider = {
      id: 'reasoning',
      name: 'Reasoning',
      enabled: true,
      protocol: 'openai' as const,
      apiKey: 'sk-test',
      baseUrl: 'https://reasoning.example',
      reasoningEffort: 'high' as const
    }

    await callCustomApiOpenAI(
      { model: 'reasoning/gpt-reasoning', messages: [{ role: 'user', content: 'ping' }] },
      provider,
      'gpt-reasoning'
    )
    await callCustomApiOpenAI(
      { model: 'reasoning/gpt-reasoning', messages: [{ role: 'user', content: 'ping' }], reasoning_effort: 'low' },
      provider,
      'gpt-reasoning'
    )

    expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toMatchObject({ model: 'gpt-reasoning', reasoning_effort: 'high' })
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toMatchObject({ model: 'gpt-reasoning', reasoning_effort: 'low' })
  })
})
