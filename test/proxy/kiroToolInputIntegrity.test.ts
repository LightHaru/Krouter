import { describe, expect, it } from 'vitest'
import {
  isKiroToolInputIntegrityError,
  parseKiroToolInput
} from '../../src/main/proxy/kiroApi'

describe('Kiro tool input integrity', () => {
  it('accepts valid structured arguments with all required fields', () => {
    expect(parseKiroToolInput(
      '{"path":"index.html","content":"hello"}',
      {
        toolUseId: 'call_write_1',
        toolName: 'write',
        inputReceived: true,
        requiredKeys: ['path', 'content']
      }
    )).toEqual({
      path: 'index.html',
      content: 'hello'
    })
  })

  it('accepts an empty object when the tool has no required fields', () => {
    expect(parseKiroToolInput('', {
      toolUseId: 'call_status_1',
      toolName: 'status',
      inputReceived: false,
      requiredKeys: []
    })).toEqual({})
  })

  it('rejects missing required fields instead of emitting an empty object', () => {
    expect(() => parseKiroToolInput('{}', {
      toolUseId: 'call_write_2',
      toolName: 'write',
      inputReceived: true,
      requiredKeys: ['path', 'content']
    })).toThrow('arguments missing required fields: path, content')
  })

  it('rejects an absent payload for a tool with required fields', () => {
    expect(() => parseKiroToolInput('', {
      toolUseId: 'call_edit_1',
      toolName: 'edit',
      inputReceived: false,
      requiredKeys: ['path', 'oldText', 'newText']
    })).toThrow('no arguments for a tool with required fields')
  })

  it('rejects malformed or truncated JSON with a retryable integrity marker', () => {
    try {
      parseKiroToolInput('{"path":"index.html"', {
        toolUseId: 'call_write_3',
        toolName: 'write',
        inputReceived: true,
        requiredKeys: ['path', 'content']
      })
      throw new Error('Expected parseKiroToolInput to throw')
    } catch (error) {
      expect(isKiroToolInputIntegrityError(error)).toBe(true)
      expect((error as Error).message).toContain('[KIRO_TOOL_INPUT_INVALID]')
      expect((error as Error).message).toContain('malformed or truncated JSON')
    }
  })

  it('rejects arrays and primitive JSON values as tool arguments', () => {
    for (const input of ['[]', '"text"', '42', 'null']) {
      expect(() => parseKiroToolInput(input, {
        toolUseId: 'call_invalid_shape',
        toolName: 'write',
        inputReceived: true
      })).toThrow('non-object arguments')
    }
  })
})
