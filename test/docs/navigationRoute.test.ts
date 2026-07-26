import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_PROVIDER_ROUTES,
  PAGE_ROUTES,
  accountProviderFromLocation,
  accountProviderToHash,
  customApiProviderIdFromLocation,
  customApiProviderToHash,
  pageFromLocation,
  pageToHash
} from '../../src/renderer/src/lib/docsRoute'

describe('dashboard navigation routes', () => {
  it('round-trips every page through its durable hash URL', () => {
    for (const page of Object.keys(PAGE_ROUTES) as Array<keyof typeof PAGE_ROUTES>) {
      expect(pageFromLocation('/', pageToHash(page))).toBe(page)
    }
  })

  it('prefers a hash route and accepts direct web paths', () => {
    expect(pageFromLocation('/docs', '#/accounts')).toBe('accounts')
    expect(pageFromLocation('/proxy-api')).toBe('proxy')
    expect(pageFromLocation('/unknown')).toBeNull()
  })

  it('normalizes trailing slashes and query fragments', () => {
    expect(pageFromLocation('/', '#/machine-id/?tab=history')).toBe('machineId')
    expect(pageFromLocation('/settings/')).toBe('settings')
  })

  it('gives every account provider a durable route', () => {
    for (const provider of Object.keys(ACCOUNT_PROVIDER_ROUTES) as Array<keyof typeof ACCOUNT_PROVIDER_ROUTES>) {
      const hash = accountProviderToHash(provider)
      expect(pageFromLocation('/', hash)).toBe('accounts')
      expect(accountProviderFromLocation('/', hash)).toBe(provider)
    }
  })

  it('supports direct provider paths and keeps the legacy accounts route on Kiro', () => {
    expect(accountProviderFromLocation('/accounts/chatgpt')).toBe('chatgpt')
    expect(accountProviderFromLocation('/accounts/bedrock/')).toBe('bedrock')
    expect(accountProviderFromLocation('/', '#/accounts/custom-api?view=list')).toBe('customApi')
    expect(accountProviderFromLocation('/accounts')).toBe('kiro')
    expect(pageFromLocation('/accounts')).toBe('accounts')
  })

  it('round-trips a Custom API provider detail route', () => {
    const hash = customApiProviderToHash('openai-compatible/team alpha')
    expect(hash).toBe('#/accounts/custom-api/openai-compatible%2Fteam%20alpha')
    expect(pageFromLocation('/', hash)).toBe('accounts')
    expect(accountProviderFromLocation('/', hash)).toBe('customApi')
    expect(customApiProviderIdFromLocation('/', hash)).toBe('openai-compatible/team alpha')
    expect(customApiProviderIdFromLocation('/accounts/custom-api/acme')).toBe('acme')
    expect(customApiProviderIdFromLocation('/accounts/chatgpt')).toBeNull()
  })
})
