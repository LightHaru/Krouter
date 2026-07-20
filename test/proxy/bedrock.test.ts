import { describe, it, expect } from 'vitest'
import {
  isBedrockModel,
  stripBedrockPrefix,
  signBedrockRequest,
  openAIToConverse,
  converseToOpenAI,
  claudeToConverse,
  converseToClaude,
  decodeEventStream,
  resolveBedrockCredentials,
  isBedrockConfigured,
  matchBedrockModelForKiroId,
  type BedrockConfig,
  type ConverseResponse
} from '../../src/main/proxy/bedrock'

const enabled: BedrockConfig = {
  enabled: true,
  accessKeyId: 'AKIA_TEST',
  secretAccessKey: 'secret',
  region: 'us-east-1'
}

describe('bedrock model detection', () => {
  it('matches known provider prefixes when enabled', () => {
    expect(isBedrockModel('anthropic.claude-3-5-sonnet-20240620-v1:0', enabled)).toBe(true)
    expect(isBedrockModel('amazon.nova-pro-v1:0', enabled)).toBe(true)
    expect(isBedrockModel('us.meta.llama3-1-70b-instruct-v1:0', enabled)).toBe(true)
    expect(isBedrockModel('us.anthropic.claude-opus-4-5-20251101-v1:0', enabled)).toBe(true)
    expect(isBedrockModel('global.anthropic.claude-opus-4-5-20251101-v1:0', enabled)).toBe(true)
    expect(isBedrockModel('bedrock/anything', enabled)).toBe(true)
  })
  it('does not match plain kiro/claude ids', () => {
    expect(isBedrockModel('claude-sonnet-4.5', enabled)).toBe(false)
    expect(isBedrockModel('gpt-4o', enabled)).toBe(false)
  })
  it('is inert when disabled', () => {
    expect(isBedrockModel('anthropic.claude', { ...enabled, enabled: false })).toBe(false)
  })
  it('matches explicitly configured model ids', () => {
    const cfg: BedrockConfig = { ...enabled, models: ['my-custom.model'] }
    expect(isBedrockModel('my-custom.model', cfg)).toBe(true)
  })
  it('strips bedrock/ prefix', () => {
    expect(stripBedrockPrefix('bedrock/anthropic.claude')).toBe('anthropic.claude')
    expect(stripBedrockPrefix('anthropic.claude')).toBe('anthropic.claude')
  })
})

describe('bedrock credentials', () => {
  it('resolves from config', () => {
    const creds = resolveBedrockCredentials(enabled)
    expect(creds?.accessKeyId).toBe('AKIA_TEST')
    expect(creds?.region).toBe('us-east-1')
  })
  it('returns null when missing', () => {
    expect(resolveBedrockCredentials({ enabled: true })).toBe(null)
    expect(isBedrockConfigured({ enabled: true })).toBe(false)
    expect(isBedrockConfigured(enabled)).toBe(true)
  })
})

describe('sigv4 signing', () => {
  it('produces deterministic AWS4-HMAC-SHA256 authorization headers', () => {
    const creds = {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1'
    }
    const a = signBedrockRequest({
      creds,
      service: 'bedrock',
      method: 'POST',
      host: 'bedrock-runtime.us-east-1.amazonaws.com',
      path: '/model/x/converse',
      body: '{"a":1}',
      extraHeaders: { 'content-type': 'application/json' }
    })
    expect(a.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request/
    )
    expect(a.headers.Authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date'
    )
    expect(a.headers['x-amz-content-sha256']).toHaveLength(64)
  })
})

describe('openai <-> converse translation', () => {
  it('maps system/user/assistant + tools', () => {
    const body = openAIToConverse({
      model: 'anthropic.claude',
      messages: [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hi' }
      ],
      max_tokens: 100,
      temperature: 0.5,
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'w', parameters: { type: 'object' } }
        }
      ]
    })
    expect(body.system?.[0].text).toBe('You are helpful')
    expect(body.messages[0].role).toBe('user')
    expect(body.inferenceConfig?.maxTokens).toBe(100)
    expect(body.toolConfig?.tools[0].toolSpec.name).toBe('get_weather')
  })
  it('converts converse response with tool use to openai', () => {
    const resp: ConverseResponse = {
      output: {
        message: {
          role: 'assistant',
          content: [
            { text: 'Hello' },
            { toolUse: { toolUseId: 't1', name: 'fn', input: { x: 1 } } }
          ]
        }
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 5 }
    }
    const oai = converseToOpenAI(resp, 'anthropic.claude')
    expect(oai.choices[0].message.content).toBe('Hello')
    expect(oai.choices[0].message.tool_calls?.[0].function.name).toBe('fn')
    expect(oai.choices[0].finish_reason).toBe('tool_calls')
    expect(oai.usage.total_tokens).toBe(15)
  })
})

describe('claude <-> converse translation', () => {
  it('maps system string and text blocks', () => {
    const body = claudeToConverse({
      model: 'anthropic.claude',
      system: 'sys',
      max_tokens: 50,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'yo' }] }]
    })
    expect(body.system?.[0].text).toBe('sys')
    expect(body.messages[0].content[0]).toEqual({ text: 'yo' })
  })
  it('converts converse response to claude message', () => {
    const resp: ConverseResponse = {
      output: { message: { role: 'assistant', content: [{ text: 'Hi there' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 3, outputTokens: 2 }
    }
    const claude = converseToClaude(resp, 'anthropic.claude')
    expect(claude.content[0]).toEqual({ type: 'text', text: 'Hi there' })
    expect(claude.stop_reason).toBe('end_turn')
    expect(claude.usage.input_tokens).toBe(3)
  })
})

describe('event stream decoder', () => {
  it('decodes a single framed event', () => {
    // build one AWS event-stream frame: headers = :event-type -> "contentBlockDelta"
    const payloadObj = { delta: { text: 'hi' }, contentBlockIndex: 0 }
    const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8')
    const headerName = ':event-type'
    const headerValue = 'contentBlockDelta'
    const nameBuf = Buffer.from(headerName, 'utf8')
    const valBuf = Buffer.from(headerValue, 'utf8')
    const headerBuf = Buffer.concat([
      Buffer.from([nameBuf.length]),
      nameBuf,
      Buffer.from([7]),
      (() => {
        const b = Buffer.alloc(2)
        b.writeUInt16BE(valBuf.length)
        return b
      })(),
      valBuf
    ])
    const totalLen = 12 + headerBuf.length + payload.length + 4
    const frame = Buffer.alloc(totalLen)
    frame.writeUInt32BE(totalLen, 0)
    frame.writeUInt32BE(headerBuf.length, 4)
    frame.writeUInt32BE(0, 8) // prelude crc (not validated)
    headerBuf.copy(frame, 12)
    payload.copy(frame, 12 + headerBuf.length)
    // last 4 bytes msg crc left as 0
    const { events, rest } = decodeEventStream(frame)
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe('contentBlockDelta')
    expect((events[0].payload as any).delta.text).toBe('hi')
    expect(rest.length).toBe(0)
  })
})

describe('matchBedrockModelForKiroId', () => {
  const available = [
    'us.anthropic.claude-opus-4-1-20250805-v1:0',
    'us.anthropic.claude-opus-4-5-20251101-v1:0',
    'global.anthropic.claude-opus-4-5-20251101-v1:0',
    'us.anthropic.claude-sonnet-4-6-v1',
    'nvidia.nemotron-nano-12b-v2'
  ]
  it('maps friendly opus id to a us. profile of the same version', () => {
    expect(matchBedrockModelForKiroId('claude-opus-4.1', available)).toBe('us.anthropic.claude-opus-4-1-20250805-v1:0')
  })
  it('prefers us. over global. for the same version', () => {
    expect(matchBedrockModelForKiroId('claude-opus-4.5', available)).toBe('us.anthropic.claude-opus-4-5-20251101-v1:0')
  })
  it('maps sonnet 4.6', () => {
    expect(matchBedrockModelForKiroId('claude-sonnet-4.6', available)).toBe('us.anthropic.claude-sonnet-4-6-v1')
  })
  it('matches major version when no minor is requested', () => {
    expect(matchBedrockModelForKiroId('claude-opus-4', available)).not.toBeNull()
  })
  it('returns null when version does not exist', () => {
    expect(matchBedrockModelForKiroId('claude-opus-9.9', available)).toBeNull()
  })
  it('returns null for non-claude ids', () => {
    expect(matchBedrockModelForKiroId('gpt-4o', available)).toBeNull()
  })
})

describe('openAIToConverse toolConfig synthesis', () => {
  it('synthesizes toolConfig from history when tools are omitted on a follow-up turn', () => {
    const req = {
      model: 'claude-opus-4.1',
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'get_weather', arguments: '{\"city\":\"hanoi\"}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'sunny' }
      ]
    } as unknown as Parameters<typeof openAIToConverse>[0]
    const body = openAIToConverse(req)
    expect(body.toolConfig).toBeDefined()
    expect(body.toolConfig!.tools.map((t) => t.toolSpec.name)).toContain('get_weather')
  })
  it('leaves toolConfig undefined when there are no tools at all', () => {
    const req = { model: 'claude-opus-4.1', messages: [{ role: 'user', content: 'hi' }] } as unknown as Parameters<typeof openAIToConverse>[0]
    const body = openAIToConverse(req)
    expect(body.toolConfig).toBeUndefined()
  })
})
