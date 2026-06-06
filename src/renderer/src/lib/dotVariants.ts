/**
 * 点号变体邮箱生成器（Dot Alias Generator）
 *
 * 原理：Gmail 等邮箱服务忽略 local 部分的 `.`，所以 `john.doe@gmail.com` 与
 *      `johndoe@gmail.com` 实际上是同一个邮箱。利用这个特性，从一个母邮箱可以
 *      生成大量"看起来不同但实际收件相同"的变体，用于注册多个账号。
 *
 * 注意：此特性仅对部分邮箱服务有效（Gmail / Outlook / iCloud / Yandex 等），
 *      ProtonMail / Yahoo / 自建邮箱通常不支持点号别名。是否启用由用户决定。
 *
 * 算法：
 *  1. 规范化母邮箱（去除 local 部分所有 `.`）
 *  2. 按 dotCount = 1, 2, 3, ... 升序遍历
 *  3. 每个 dotCount 内枚举所有可能的点号位置组合（C(n, k)）
 *  4. 过滤掉已在 usedEmails 黑名单里的变体
 *  5. 从剩余候选里随机选一个返回
 *  6. 全部用完返回 null
 */

/** 生成 [0, n) 中选 k 个不重复元素的所有组合（递增序） */
function* combinations(n: number, k: number, start = 0, prefix: number[] = []): Generator<number[]> {
  if (prefix.length === k) {
    yield [...prefix]
    return
  }
  // 剪枝：剩余位置不够填满 k 时直接退出
  if (n - start < k - prefix.length) return
  for (let i = start; i < n; i++) {
    prefix.push(i)
    yield* combinations(n, k, i + 1, prefix)
    prefix.pop()
  }
}

/**
 * 在 local 字符串的指定位置后插入点号
 * @param positions 字符 index 列表（递增），含义：在 local[idx] 字符之后插入一个 `.`
 *                  取值范围 0 ≤ idx ≤ local.length - 2
 */
function insertDots(local: string, positions: number[]): string {
  const positionSet = new Set(positions)
  let result = ''
  for (let i = 0; i < local.length; i++) {
    result += local[i]
    if (i < local.length - 1 && positionSet.has(i)) result += '.'
  }
  return result
}

/** 拆分邮箱为 [local, domain]，无效邮箱返回 null */
export function splitEmail(email: string): [string, string] | null {
  const trimmed = email.trim()
  const atIndex = trimmed.indexOf('@')
  if (atIndex <= 0 || atIndex === trimmed.length - 1) return null
  const local = trimmed.slice(0, atIndex)
  const domain = trimmed.slice(atIndex + 1)
  if (!local || !domain || domain.indexOf('.') < 0) return null
  return [local, domain]
}

/**
 * 规范化邮箱：去除 local 的所有 `.`，整体转小写
 * 用于：判定多个邮箱"是否实际上是同一个母号"
 */
export function normalizeEmail(email: string): string {
  const split = splitEmail(email)
  if (!split) return email.toLowerCase()
  const [local, domain] = split
  return `${local.replace(/\./g, '').toLowerCase()}@${domain.toLowerCase()}`
}

/** 计算二项式系数 C(n, k)，避免大数溢出（用于估算总变体数）*/
export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  if (k === 0 || k === n) return 1
  k = Math.min(k, n - k)
  let result = 1
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1)
  }
  return Math.round(result)
}

/** 计算给定 local 长度下，所有 dotCount=1..maxDot 的总变体数 */
export function totalVariantCount(localLength: number, maxDot = Number.POSITIVE_INFINITY): number {
  const positions = localLength - 1
  if (positions <= 0) return 0
  let sum = 0
  for (let k = 1; k <= Math.min(positions, maxDot); k++) {
    sum += binomial(positions, k)
  }
  return sum
}

/**
 * 统计 usedEmails 中有多少个属于「同一母邮箱」的变体
 * 即：local 去点后相同 + domain 相同
 */
export function countSameRootVariants(parentEmail: string, usedEmails: Iterable<string>): number {
  const parentSplit = splitEmail(parentEmail)
  if (!parentSplit) return 0
  const baseLocal = parentSplit[0].replace(/\./g, '').toLowerCase()
  const baseDomain = parentSplit[1].toLowerCase()
  let count = 0
  for (const e of usedEmails) {
    const split = splitEmail(e)
    if (!split) continue
    const [local, domain] = split
    if (domain.toLowerCase() === baseDomain && local.replace(/\./g, '').toLowerCase() === baseLocal) {
      count++
    }
  }
  return count
}

export interface DotVariantResult {
  /** 选中的下一个变体邮箱，全部用完返回 null */
  variant: string | null
  /** 当前使用的点号数（1..n）；返回 null 时为 0 */
  dotCount: number
  /** 同 dotCount 下还剩多少未使用候选 */
  remainingInBucket: number
  /** 母邮箱去点规范化后的 local 长度，用于上层估算总容量 */
  localLength: number
}

/**
 * 生成下一个未使用的点号变体
 *
 * @param parentEmail 母邮箱（可带可不带原始点号）
 * @param usedEmails  已使用邮箱集合（不分大小写、保留点号原样比较）
 *                    通常包含：本地账号库存中的所有 email + 注册历史中的 email
 * @returns DotVariantResult；若所有变体都已用过，variant=null
 */
export function generateNextDotVariant(
  parentEmail: string,
  usedEmails: Iterable<string>
): DotVariantResult {
  const split = splitEmail(parentEmail)
  if (!split) return { variant: null, dotCount: 0, remainingInBucket: 0, localLength: 0 }

  const local = split[0].replace(/\./g, '')
  const domain = split[1].toLowerCase()
  const localLength = local.length
  const positions = localLength - 1

  if (positions <= 0) {
    return { variant: null, dotCount: 0, remainingInBucket: 0, localLength }
  }

  // 黑名单：保留点号原样 + 全小写
  const used = new Set<string>()
  for (const e of usedEmails) {
    const t = e.trim().toLowerCase()
    if (t) used.add(t)
  }
  // 母邮箱本身（原样 + 去点版本）也排除：避免把验证码发到母号占用方
  used.add(parentEmail.trim().toLowerCase())
  used.add(`${local.toLowerCase()}@${domain}`)

  // 按 dotCount 升序优先：1 个点 → 2 个点 → ...
  for (let k = 1; k <= positions; k++) {
    const candidates: string[] = []
    for (const combo of combinations(positions, k)) {
      const variant = `${insertDots(local, combo)}@${domain}`
      if (!used.has(variant.toLowerCase())) {
        candidates.push(variant)
      }
    }
    if (candidates.length > 0) {
      // 同一 dotCount 内随机选取一个，避免每次都从字典序最小开始
      const variant = candidates[Math.floor(Math.random() * candidates.length)]
      return {
        variant,
        dotCount: k,
        remainingInBucket: candidates.length - 1,
        localLength
      }
    }
  }

  return { variant: null, dotCount: 0, remainingInBucket: 0, localLength }
}
