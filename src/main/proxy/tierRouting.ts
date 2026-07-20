// Smart tier-based routing — pure, synchronous, side-effect-free helpers.
//
// This module centralizes ALL tier-classification logic so proxyServer.ts no
// longer carries two conflicting notions of "tier" (the subscriptionType TAG vs
// the capability cache). Everything here is pure: no network, no capability
// cache, no mutation. proxyServer wires the capability-cache confirmation as a
// SECOND (hybrid) step on top of these tag-based decisions.
//
// Design summary (see plan curious-wibbling-floyd.md):
// - Tag is used for FAST pre-grouping and preference ordering, NOT as a hard
//   exclusion when the tag is 'unknown'. An account with an absent/unrecognized
//   tag is a valid premium candidate (tried AFTER paid) and only excluded once
//   the capability cache CONFIRMS it cannot serve the model.
// - Only an account whose tag is definitively 'free' is hard-excluded from a
//   premium model up front (Free tier provably never has Opus etc.).

import type { KiroTier, ProxyAccount, TierEligibilityRule } from './types'
import {
  DEFAULT_TIER_ELIGIBILITY_MAP,
  isPaidKiroTier,
  matchesModelPattern,
  normalizeKiroModelIdForCompare,
  normalizeKiroTier
} from './modelCatalog'

export type ModelClass = 'premium' | 'standard'

/** Ordered tier groups used for preference. Free quota is spent first, paid last. */
export const TIER_PREFERENCE_ORDER: KiroTier[] = [
  'free',
  'unknown',
  'pro',
  'pro_plus',
  'teams',
  'enterprise',
  'power'
]

/**
 * Tag tier của một account, chỉ dựa vào subscriptionType (KHÔNG đụng capability cache).
 * Absent/empty/unrecognized => 'unknown'.
 */
export function tagTierOf(account: Pick<ProxyAccount, 'subscriptionType'>): KiroTier {
  return normalizeKiroTier(account?.subscriptionType)
}

/**
 * Phân loại một model theo Tier_Eligibility_Map. Rule đầu tiên khớp sẽ thắng.
 * Model không có rule => 'standard' (mọi tier phục vụ được).
 */
export function classifyModel(
  modelId: string | undefined,
  map: TierEligibilityRule[] = DEFAULT_TIER_ELIGIBILITY_MAP
): ModelClass {
  if (!modelId) return 'standard'
  const normalized = normalizeKiroModelIdForCompare(modelId)
  for (const rule of map) {
    if (matchesModelPattern(normalized, rule.modelPattern)) return rule.class
  }
  return 'standard'
}

/**
 * Tập tier được phép phục vụ model (dùng cho annotate UI + eligibility cứng).
 * Standard/unmapped => tất cả tier. Premium => allowedTiers của rule khớp.
 */
export function allowedTiersForModel(
  modelId: string | undefined,
  map: TierEligibilityRule[] = DEFAULT_TIER_ELIGIBILITY_MAP
): KiroTier[] {
  if (!modelId) return [...TIER_PREFERENCE_ORDER]
  const normalized = normalizeKiroModelIdForCompare(modelId)
  for (const rule of map) {
    if (matchesModelPattern(normalized, rule.modelPattern)) {
      return rule.class === 'standard' ? [...TIER_PREFERENCE_ORDER] : [...rule.allowedTiers]
    }
  }
  return [...TIER_PREFERENCE_ORDER]
}

/**
 * Hard tag-eligibility (HYBRID rule). Trả false CHỈ khi chắc chắn loại được bằng tag:
 * - Standard model => luôn true.
 * - Premium model + tag 'free' => false (Free provably không có premium model).
 * - Premium model + tag paid => true.
 * - Premium model + tag 'unknown' => true (chưa chắc; capability cache xác nhận sau).
 *
 * Điểm khác biệt với logic cũ (đã gây bug loại oan): 'unknown' KHÔNG bị loại cứng.
 */
export function isTagEligibleForModel(
  account: Pick<ProxyAccount, 'subscriptionType'>,
  modelId: string | undefined,
  map: TierEligibilityRule[] = DEFAULT_TIER_ELIGIBILITY_MAP
): boolean {
  if (classifyModel(modelId, map) === 'standard') return true
  const tier = tagTierOf(account)
  if (tier === 'free') return false
  // paid hoặc unknown => ứng viên hợp lệ (unknown chờ capability xác nhận).
  return true
}

/**
 * Thứ tự nhóm tier để thử cho model, ưu tiên trước.
 * - Premium => chỉ các tier trong allowedTiers, cộng 'unknown' (thử cuối, chờ capability
 *   xác nhận) — KHÔNG gồm 'free'.
 * - Standard => toàn bộ TIER_PREFERENCE_ORDER (free trước, paid sau).
 */
export function tierPreferenceGroups(
  modelId: string | undefined,
  map: TierEligibilityRule[] = DEFAULT_TIER_ELIGIBILITY_MAP
): KiroTier[] {
  if (classifyModel(modelId, map) === 'standard') return [...TIER_PREFERENCE_ORDER]
  const allowed = new Set(allowedTiersForModel(modelId, map))
  const groups = TIER_PREFERENCE_ORDER.filter((tier) => tier !== 'free' && allowed.has(tier))
  // 'unknown' luôn là ứng viên cuối cho premium (capability cache sẽ xác nhận).
  if (!groups.includes('unknown')) groups.push('unknown')
  return groups
}

/**
 * Nhóm các account theo tag tier. Dùng để chọn account MỘT LẦN mỗi request thay vì
 * quét toàn pool nhiều lần (sửa bug O(N^2)).
 */
export function groupAccountsByTier(accounts: ProxyAccount[]): Map<KiroTier, ProxyAccount[]> {
  const groups = new Map<KiroTier, ProxyAccount[]>()
  for (const account of accounts) {
    const tier = tagTierOf(account)
    const bucket = groups.get(tier)
    if (bucket) bucket.push(account)
    else groups.set(tier, [account])
  }
  return groups
}

/** Tập các tier hiện có trong pool (theo tag). Dùng annotate model UI. */
export function poolTierSet(accounts: ProxyAccount[]): Set<KiroTier> {
  const set = new Set<KiroTier>()
  for (const account of accounts) set.add(tagTierOf(account))
  return set
}

/**
 * Pool có phục vụ được model này theo TAG không (nhanh, không network)?
 * - Standard => true nếu pool có bất kỳ account nào.
 * - Premium => true nếu pool có ít nhất một account paid HOẶC unknown (unknown có thể là paid
 *   chưa hydrate; UI/route sẽ để capability cache xác nhận).
 */
export function poolCanServeByTag(
  accounts: ProxyAccount[],
  modelId: string | undefined,
  map: TierEligibilityRule[] = DEFAULT_TIER_ELIGIBILITY_MAP
): boolean {
  if (accounts.length === 0) return false
  if (classifyModel(modelId, map) === 'standard') return true
  return accounts.some((account) => {
    const tier = tagTierOf(account)
    return tier === 'unknown' || isPaidKiroTier(tier)
  })
}
