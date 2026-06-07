import {
  fetchAvailableSubscriptions,
  fetchKiroModels,
  fetchSubscriptionToken,
  setUserPreference
} from '../../main/proxy/kiroApi'
import { KIRO_PROXY_MODEL_PRESETS } from '../../main/proxy/modelCatalog'
import type { ProxyAccount } from '../../main/proxy/types'

function accountFromArgs(args: unknown[], fallbackId: string): ProxyAccount | null {
  const [accessToken, , region, profileArn, machineId, provider, authMethod, accountId] = args as [
    string | undefined,
    unknown,
    string | undefined,
    string | undefined,
    string | undefined,
    string | undefined,
    ProxyAccount['authMethod'] | undefined,
    string | undefined
  ]
  if (!accessToken) return null
  return {
    id: accountId || fallbackId,
    accessToken,
    region: region || 'us-east-1',
    profileArn,
    machineId,
    provider,
    authMethod
  }
}

export async function accountGetModels(args: unknown[]): Promise<{
  success: boolean
  models: Array<Record<string, unknown>>
  error?: string
}> {
  const account = accountFromArgs([args[0], undefined, args[1], args[2], args[3], args[4], args[5], args[6]], 'model-list-request')
  if (!account) return { success: false, error: 'Missing access token', models: [] }
  try {
    const models = await fetchKiroModels(account)
    const output = models.map((model) => ({
      id: model.modelId,
      name: model.modelName,
      description: model.description,
      inputTypes: model.supportedInputTypes,
      maxInputTokens: model.tokenLimits?.maxInputTokens,
      maxOutputTokens: model.tokenLimits?.maxOutputTokens,
      rateMultiplier: model.rateMultiplier,
      rateUnit: model.rateUnit
    }))
    const seen = new Set(output.map((model) => String(model.id)))
    for (const preset of KIRO_PROXY_MODEL_PRESETS) {
      if (!seen.has(preset.id)) {
        seen.add(preset.id)
        output.push({
          id: preset.id,
          name: preset.name,
          description: preset.description,
          inputTypes: preset.inputTypes,
          maxInputTokens: preset.maxInputTokens,
          maxOutputTokens: preset.maxOutputTokens,
          rateMultiplier: undefined,
          rateUnit: undefined
        })
      }
    }
    return {
      success: true,
      models: output
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get models', models: [] }
  }
}

export async function accountGetSubscriptions(args: unknown[]): Promise<{
  success: boolean
  plans: unknown[]
  disclaimer?: string[]
  error?: string
}> {
  const account = accountFromArgs(args, 'subscription-request')
  if (!account) return { success: false, error: 'Missing access token', plans: [] }
  try {
    const result = await fetchAvailableSubscriptions(account)
    if (result.subscriptionPlans) return { success: true, plans: result.subscriptionPlans, disclaimer: result.disclaimer }
    return { success: false, error: 'No subscription plans returned', plans: [] }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get subscriptions', plans: [] }
  }
}

export async function accountGetSubscriptionUrl(args: unknown[]): Promise<{
  success: boolean
  url?: string
  status?: string
  error?: string
}> {
  const account = accountFromArgs([args[0], undefined, args[2], args[3], args[4], args[5], args[6], args[7]], 'subscription-request')
  if (!account) return { success: false, error: 'Missing access token' }
  try {
    const result = await fetchSubscriptionToken(account, args[1] as string | undefined)
    if (result.encodedVerificationUrl) return { success: true, url: result.encodedVerificationUrl, status: result.status }
    return { success: false, error: result.message || 'No subscription URL returned' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to get subscription URL' }
  }
}

export async function accountSetOverage(args: unknown[]): Promise<{ success: boolean; error?: string }> {
  const overageStatus = args[1] as 'ENABLED' | 'DISABLED'
  if (overageStatus !== 'ENABLED' && overageStatus !== 'DISABLED') return { success: false, error: 'Invalid overage status' }
  const account = accountFromArgs([args[0], undefined, args[2], args[3], args[4], args[5], args[6], args[7]], 'subscription-request')
  if (!account) return { success: false, error: 'Missing access token' }
  try {
    return await setUserPreference(account, overageStatus)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to set overage' }
  }
}
