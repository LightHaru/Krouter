import { describe, expect, it } from 'vitest'
import {
  mapKiroServiceRegion,
  regionalizeKiroEndpointUrl,
  regionFromProfileArn,
  resolveKiroServiceRegion
} from '../../src/main/proxy/kiroApi'

describe('mapKiroServiceRegion', () => {
  it('keeps us-east-1 for the default region', () => {
    expect(mapKiroServiceRegion('us-east-1')).toBe('us-east-1')
  })

  it('keeps us-east-1 when region is undefined', () => {
    expect(mapKiroServiceRegion(undefined)).toBe('us-east-1')
  })

  it('maps eu-north-1 to eu-central-1', () => {
    expect(mapKiroServiceRegion('eu-north-1')).toBe('eu-central-1')
  })

  it('maps eu-west-1 to eu-central-1', () => {
    expect(mapKiroServiceRegion('eu-west-1')).toBe('eu-central-1')
  })

  it('only remaps eu-* regions (ap-southeast-2 stays us-east-1)', () => {
    expect(mapKiroServiceRegion('ap-southeast-2')).toBe('us-east-1')
  })
})

describe('regionalizeKiroEndpointUrl', () => {
  it('regionalizes the codewhisperer generate endpoint for an EU account', () => {
    expect(
      regionalizeKiroEndpointUrl(
        'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse',
        'eu-north-1'
      )
    ).toBe('https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse')
  })

  it('regionalizes the q SendMessageStreaming endpoint for an EU account', () => {
    expect(
      regionalizeKiroEndpointUrl(
        'https://q.us-east-1.amazonaws.com/SendMessageStreaming',
        'eu-north-1'
      )
    ).toBe('https://q.eu-central-1.amazonaws.com/SendMessageStreaming')
  })

  it('leaves the URL unchanged for a us-east-1 account', () => {
    const url = 'https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse'
    expect(regionalizeKiroEndpointUrl(url, 'us-east-1')).toBe(url)
  })

  it('leaves the URL unchanged when region is undefined', () => {
    const url = 'https://q.us-east-1.amazonaws.com/SendMessageStreaming'
    expect(regionalizeKiroEndpointUrl(url, undefined)).toBe(url)
  })

  it('leaves the URL unchanged for a non-eu region (ap-southeast-2)', () => {
    const url = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse'
    expect(regionalizeKiroEndpointUrl(url, 'ap-southeast-2')).toBe(url)
  })
})

describe('regionFromProfileArn', () => {
  it('extracts us-east-1 from a profile ARN', () => {
    expect(regionFromProfileArn('arn:aws:codewhisperer:us-east-1:123:profile/X')).toBe('us-east-1')
  })

  it('extracts eu-central-1 from a profile ARN', () => {
    expect(regionFromProfileArn('arn:aws:codewhisperer:eu-central-1:1:profile/Y')).toBe('eu-central-1')
  })

  it('returns undefined for an empty region segment', () => {
    expect(regionFromProfileArn('arn:aws:codewhisperer::1:profile/Z')).toBeUndefined()
  })

  it('returns undefined when the ARN is undefined', () => {
    expect(regionFromProfileArn(undefined)).toBeUndefined()
  })

  it('returns undefined for a non-arn string', () => {
    expect(regionFromProfileArn('not-an-arn')).toBeUndefined()
  })
})

describe('resolveKiroServiceRegion', () => {
  it('prefers the profile region over the SSO region', () => {
    expect(
      resolveKiroServiceRegion({
        profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/X',
        region: 'eu-north-1',
        authMethod: 'IdC',
        provider: 'Enterprise'
      })
    ).toBe('us-east-1')
  })

  it('falls back to the SSO region when there is no profileArn (enterprise)', () => {
    expect(
      resolveKiroServiceRegion({
        region: 'eu-north-1',
        provider: 'enterprise'
      })
    ).toBe('eu-north-1')
  })

  it('falls back to us-east-1 when nothing is provided', () => {
    expect(resolveKiroServiceRegion({})).toBe('us-east-1')
  })
})
