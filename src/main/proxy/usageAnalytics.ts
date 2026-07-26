import crypto from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { getRuntimeUserDataPath } from '../runtimePaths'

export const USAGE_ANALYTICS_PERIODS = ['today', '24h', '7d', '30d', '60d', 'all'] as const
export type UsageAnalyticsPeriod = (typeof USAGE_ANALYTICS_PERIODS)[number]

export interface UsageResponseInfo {
  path: string
  model?: string
  status: number
  tokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  credits?: number
  responseTime?: number
  accountId?: string
  accountEmail?: string
  error?: string
}

export interface UsageAnalyticsEvent {
  id: string
  timestamp: number
  path: string
  endpoint: string
  model: string
  provider: string
  providerLabel: string
  accountId?: string
  accountLabel?: string
  status: number
  success: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  credits: number
  responseTime: number
  estimatedCostUsd?: number
  pricingAvailable: boolean
  error?: string
}

export interface UsageAnalyticsTotals {
  requests: number
  successfulRequests: number
  failedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  credits: number
  estimatedCostUsd: number
  pricedRequests: number
  avgResponseTime: number
  p95ResponseTime: number
}

export interface UsageAnalyticsBreakdown extends UsageAnalyticsTotals {
  key: string
  label: string
  provider?: string
  model?: string
  accountId?: string
  path?: string
  endpoint?: string
  lastUsedAt: number
}

export interface UsageAnalyticsBucket {
  key: string
  label: string
  startAt: number
  requests: number
  failedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  totalTokens: number
  estimatedCostUsd: number
}

export interface UsageAnalyticsSnapshot {
  generatedAt: number
  period: UsageAnalyticsPeriod
  startAt: number | null
  endAt: number
  retentionDays: number
  priceCatalogVersion: string
  totals: UsageAnalyticsTotals
  series: UsageAnalyticsBucket[]
  byProvider: UsageAnalyticsBreakdown[]
  byModel: UsageAnalyticsBreakdown[]
  byAccount: UsageAnalyticsBreakdown[]
  byEndpoint: UsageAnalyticsBreakdown[]
  recentRequests: UsageAnalyticsEvent[]
}

const RETENTION_DAYS = 90
const MAX_RECORDS = 50_000
const COMPACT_EVERY_WRITES = 250
const PRICE_CATALOG_VERSION = 'krouter-reference-2026-07'
const DAY_MS = 24 * 60 * 60 * 1000

type PriceRule = {
  pattern: RegExp
  inputPerMillion: number
  outputPerMillion: number
  cachedInputPerMillion: number
}

// Reference prices are only used for comparison. Experimental/private model IDs
// intentionally remain unpriced instead of presenting a misleading dollar value.
const PRICE_RULES: PriceRule[] = [
  {
    pattern: /claude.*haiku/i,
    inputPerMillion: 1,
    outputPerMillion: 5,
    cachedInputPerMillion: 0.1
  },
  {
    pattern: /claude.*sonnet/i,
    inputPerMillion: 3,
    outputPerMillion: 15,
    cachedInputPerMillion: 0.3
  },
  { pattern: /claude.*opus/i, inputPerMillion: 5, outputPerMillion: 25, cachedInputPerMillion: 0.5 }
]

function finiteNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function sanitizeUsageError(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/("(?:access|refresh|id)?_?token"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2')
    .slice(0, 500)
}

function resolveProvider(info: UsageResponseInfo): { id: string; label: string } {
  const model = String(info.model || '')
    .trim()
    .toLowerCase()
  const accountId = String(info.accountId || '')
    .trim()
    .toLowerCase()
  const requestPath = String(info.path || '')
    .trim()
    .toLowerCase()

  if (
    model.startsWith('chatgpt/') ||
    accountId.startsWith('chatgpt') ||
    (requestPath.endsWith('/images/generations') &&
      Boolean(accountId) &&
      !model.startsWith('bedrock/'))
  ) {
    return { id: 'chatgpt', label: 'ChatGPT / Codex' }
  }
  if (model.startsWith('bedrock/') || accountId === 'bedrock') {
    return { id: 'bedrock', label: 'Amazon Bedrock' }
  }
  if (model.startsWith('xpixi/') || accountId === 'xpixi') {
    return { id: 'xpixi', label: 'Xpixi' }
  }
  if (model.startsWith('custom/') || accountId.startsWith('custom:')) {
    const customId = accountId.startsWith('custom:') ? accountId.slice(7) : model.split('/')[1]
    return {
      id: `custom:${customId || 'api'}`,
      label: info.accountEmail || customId || 'Custom API'
    }
  }
  return { id: 'kiro', label: 'Kiro' }
}

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number
): number | undefined {
  if (model.toLowerCase().startsWith('chatgpt/')) return undefined
  const rule = PRICE_RULES.find((candidate) => candidate.pattern.test(model))
  if (!rule) return undefined
  const regularInput = Math.max(0, inputTokens - cacheReadTokens)
  return (
    (regularInput * rule.inputPerMillion +
      cacheReadTokens * rule.cachedInputPerMillion +
      outputTokens * rule.outputPerMillion) /
    1_000_000
  )
}

function normalizeEvent(info: UsageResponseInfo): UsageAnalyticsEvent {
  const inputTokens = finiteNumber(info.inputTokens)
  const outputTokens = finiteNumber(info.outputTokens)
  const cacheReadTokens = finiteNumber(info.cacheReadTokens)
  const cacheWriteTokens = finiteNumber(info.cacheWriteTokens)
  const reasoningTokens = finiteNumber(info.reasoningTokens)
  const reportedTotal = finiteNumber(info.tokens)
  const model = String(info.model || 'unknown')
  const endpoint = String(info.path || 'unknown')
  const provider = resolveProvider(info)
  const estimatedCostUsd = estimateCost(model, inputTokens, outputTokens, cacheReadTokens)

  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    path: endpoint,
    endpoint,
    model,
    provider: provider.id,
    providerLabel: provider.label,
    accountId: info.accountId ? String(info.accountId) : undefined,
    accountLabel: info.accountEmail ? String(info.accountEmail) : undefined,
    status: Number.isFinite(Number(info.status)) ? Number(info.status) : 500,
    success: Number(info.status) >= 200 && Number(info.status) < 400,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: reportedTotal || inputTokens + outputTokens,
    credits: finiteNumber(info.credits),
    responseTime: finiteNumber(info.responseTime),
    estimatedCostUsd,
    pricingAvailable: estimatedCostUsd !== undefined,
    error: sanitizeUsageError(info.error)
  }
}

function emptyTotals(): UsageAnalyticsTotals {
  return {
    requests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    credits: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    avgResponseTime: 0,
    p95ResponseTime: 0
  }
}

function addEvent(target: UsageAnalyticsTotals, event: UsageAnalyticsEvent): void {
  target.requests += 1
  target.successfulRequests += event.success ? 1 : 0
  target.failedRequests += event.success ? 0 : 1
  target.inputTokens += event.inputTokens
  target.outputTokens += event.outputTokens
  target.cacheReadTokens += event.cacheReadTokens
  target.cacheWriteTokens += event.cacheWriteTokens
  target.reasoningTokens += event.reasoningTokens
  target.totalTokens += event.totalTokens
  target.credits += event.credits
  target.estimatedCostUsd += event.estimatedCostUsd || 0
  target.pricedRequests += event.pricingAvailable ? 1 : 0
}

function finishLatency(target: UsageAnalyticsTotals, responseTimes: number[]): void {
  const measurable = responseTimes.filter((value) => value > 0).sort((a, b) => a - b)
  if (measurable.length === 0) return
  target.avgResponseTime = measurable.reduce((sum, value) => sum + value, 0) / measurable.length
  target.p95ResponseTime =
    measurable[Math.min(measurable.length - 1, Math.ceil(measurable.length * 0.95) - 1)]
}

function periodStart(period: UsageAnalyticsPeriod, now: number): number | null {
  if (period === 'all') return null
  if (period === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  if (period === '24h') return now - DAY_MS
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return start.getTime() - (Number.parseInt(period, 10) - 1) * DAY_MS
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function buildSeries(
  events: UsageAnalyticsEvent[],
  period: UsageAnalyticsPeriod,
  startAt: number | null,
  now: number
): UsageAnalyticsBucket[] {
  const hourly = period === 'today' || period === '24h'
  const bucketCount =
    period === 'today' || period === '24h'
      ? 24
      : period === '7d'
        ? 7
        : period === '30d'
          ? 30
          : period === '60d'
            ? 60
            : Math.max(1, Math.ceil((now - (startAt || now)) / DAY_MS) + 1)
  const buckets: UsageAnalyticsBucket[] = []

  if (hourly) {
    const first =
      period === 'today' ? startAt || now : Math.floor(now / 3_600_000) * 3_600_000 - 23 * 3_600_000
    for (let index = 0; index < bucketCount; index += 1) {
      const bucketStart = first + index * 3_600_000
      buckets.push({
        key: new Date(bucketStart).toISOString(),
        label: new Date(bucketStart).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }),
        startAt: bucketStart,
        requests: 0,
        failedRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0
      })
    }
    for (const event of events) {
      const index = Math.floor((event.timestamp - first) / 3_600_000)
      if (index >= 0 && index < buckets.length) addBucketEvent(buckets[index], event)
    }
    return buckets
  }

  const firstDate =
    period === 'all'
      ? new Date(startAt || events[0]?.timestamp || now)
      : new Date(now - (bucketCount - 1) * DAY_MS)
  firstDate.setHours(0, 0, 0, 0)
  const bucketMap = new Map<string, UsageAnalyticsBucket>()
  for (let index = 0; index < bucketCount; index += 1) {
    const bucketStart = firstDate.getTime() + index * DAY_MS
    const key = localDayKey(bucketStart)
    const bucket: UsageAnalyticsBucket = {
      key,
      label: new Date(bucketStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      startAt: bucketStart,
      requests: 0,
      failedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0
    }
    buckets.push(bucket)
    bucketMap.set(key, bucket)
  }
  for (const event of events) {
    const bucket = bucketMap.get(localDayKey(event.timestamp))
    if (bucket) addBucketEvent(bucket, event)
  }
  return buckets
}

function addBucketEvent(bucket: UsageAnalyticsBucket, event: UsageAnalyticsEvent): void {
  bucket.requests += 1
  bucket.failedRequests += event.success ? 0 : 1
  bucket.inputTokens += event.inputTokens
  bucket.outputTokens += event.outputTokens
  bucket.cacheReadTokens += event.cacheReadTokens
  bucket.reasoningTokens += event.reasoningTokens
  bucket.totalTokens += event.totalTokens
  bucket.estimatedCostUsd += event.estimatedCostUsd || 0
}

function buildBreakdown(
  events: UsageAnalyticsEvent[],
  keyFor: (event: UsageAnalyticsEvent) => string,
  metadataFor: (event: UsageAnalyticsEvent) => Partial<UsageAnalyticsBreakdown>
): UsageAnalyticsBreakdown[] {
  const groups = new Map<string, { value: UsageAnalyticsBreakdown; latencies: number[] }>()
  for (const event of events) {
    const key = keyFor(event)
    let group = groups.get(key)
    if (!group) {
      group = {
        value: {
          ...emptyTotals(),
          key,
          label: key,
          lastUsedAt: event.timestamp,
          ...metadataFor(event)
        },
        latencies: []
      }
      groups.set(key, group)
    }
    addEvent(group.value, event)
    group.value.lastUsedAt = Math.max(group.value.lastUsedAt, event.timestamp)
    if (event.responseTime > 0) group.latencies.push(event.responseTime)
  }
  return [...groups.values()]
    .map((group) => {
      finishLatency(group.value, group.latencies)
      return group.value
    })
    .sort((left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests)
}

function parseLines(raw: string): UsageAnalyticsEvent[] {
  const events: UsageAnalyticsEvent[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as UsageAnalyticsEvent
      if (typeof parsed.timestamp === 'number' && typeof parsed.model === 'string')
        events.push(parsed)
    } catch {
      // A partially written final line must not make the analytics page unavailable.
    }
  }
  return events
}

export class UsageAnalyticsStore {
  private writeQueue: Promise<void> = Promise.resolve()
  private writeCount = 0
  private readonly filePath: string

  constructor(scope: string, baseDir = getRuntimeUserDataPath()) {
    const scopeHash = crypto
      .createHash('sha256')
      .update(scope || 'default')
      .digest('hex')
      .slice(0, 16)
    this.filePath = path.join(baseDir, 'usage', `usage-${scopeHash}.jsonl`)
  }

  append(info: UsageResponseInfo): Promise<void> {
    const event = normalizeEvent(info)
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8')
        this.writeCount += 1
        if (this.writeCount % COMPACT_EVERY_WRITES === 0) await this.compact()
      })
    return this.writeQueue
  }

  async getSnapshot(
    periodInput: UsageAnalyticsPeriod | string = 'today',
    recentLimit = 100
  ): Promise<UsageAnalyticsSnapshot> {
    await this.writeQueue.catch(() => undefined)
    const period = USAGE_ANALYTICS_PERIODS.includes(periodInput as UsageAnalyticsPeriod)
      ? (periodInput as UsageAnalyticsPeriod)
      : 'today'
    const events = await this.readAll()
    const now = Date.now()
    const startAt = periodStart(period, now)
    const filtered = events
      .filter((event) => startAt === null || event.timestamp >= startAt)
      .sort((left, right) => left.timestamp - right.timestamp)
    const totals = emptyTotals()
    const latencies: number[] = []
    for (const event of filtered) {
      addEvent(totals, event)
      if (event.responseTime > 0) latencies.push(event.responseTime)
    }
    finishLatency(totals, latencies)

    return {
      generatedAt: now,
      period,
      startAt,
      endAt: now,
      retentionDays: RETENTION_DAYS,
      priceCatalogVersion: PRICE_CATALOG_VERSION,
      totals,
      series: buildSeries(filtered, period, startAt ?? filtered[0]?.timestamp ?? now, now),
      byProvider: buildBreakdown(
        filtered,
        (event) => event.provider,
        (event) => ({ label: event.providerLabel, provider: event.provider })
      ),
      byModel: buildBreakdown(
        filtered,
        (event) => `${event.provider}|${event.model}`,
        (event) => ({ label: event.model, provider: event.provider, model: event.model })
      ),
      byAccount: buildBreakdown(
        filtered,
        (event) => `${event.provider}|${event.accountId || 'unknown'}`,
        (event) => ({
          label: event.accountLabel || event.accountId || 'Unknown account',
          provider: event.provider,
          accountId: event.accountId
        })
      ),
      byEndpoint: buildBreakdown(
        filtered,
        (event) => event.path,
        (event) => ({ label: event.path, path: event.path, endpoint: event.path })
      ),
      recentRequests: filtered
        .slice(-Math.min(500, Math.max(1, recentLimit)))
        .reverse()
        .map((event) => ({ ...event, endpoint: event.endpoint || event.path }))
    }
  }

  async clear(): Promise<{ success: true }> {
    await this.writeQueue.catch(() => undefined)
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, '', 'utf8')
    return { success: true }
  }

  private async readAll(): Promise<UsageAnalyticsEvent[]> {
    try {
      return parseLines(await fs.readFile(this.filePath, 'utf8')).map((event) => {
        const resolvedProvider = resolveProvider({
          path: event.path,
          model: event.model,
          status: event.status,
          accountId: event.accountId,
          accountEmail: event.accountLabel
        })
        return {
          ...event,
          endpoint: event.endpoint || event.path,
          provider: resolvedProvider.id,
          providerLabel: resolvedProvider.label
        }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async compact(): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS
    const retained = (await this.readAll())
      .filter((event) => event.timestamp >= cutoff)
      .slice(-MAX_RECORDS)
    const tempPath = `${this.filePath}.tmp`
    await fs.writeFile(
      tempPath,
      retained.map((event) => JSON.stringify(event)).join('\n') + (retained.length ? '\n' : ''),
      'utf8'
    )
    await fs.rename(tempPath, this.filePath)
  }
}
