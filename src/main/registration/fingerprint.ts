import { BrowserIdentity } from './browser-identity'
import { encryptFingerprint, getTESVersion } from './xxtea'

function randInt(max: number): number {
  return Math.floor(Math.random() * max)
}

function crc32Str(str: string): number {
  let crc = 0xffffffff >>> 0
  const table = getCrc32Table()
  for (let i = 0; i < str.length; i++) {
    crc = ((crc >>> 8) ^ table[(crc ^ str.charCodeAt(i)) & 0xff]) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

let _t: Uint32Array | null = null
function getCrc32Table(): Uint32Array {
  if (_t) return _t
  _t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i >>> 0
    for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
    _t[i] = c
  }
  return _t
}

// ============ OrderedMap ============

export class OrderedMap {
  private keys: string[] = []
  private values: Map<string, unknown> = new Map()

  set(key: string, value: unknown): void {
    if (!this.values.has(key)) this.keys.push(key)
    this.values.set(key, value)
  }

  toJSON(): string {
    const parts: string[] = []
    for (const k of this.keys) {
      parts.push(`${JSON.stringify(k)}:${JSON.stringify(this.values.get(k))}`)
    }
    return `{${parts.join(',')}}`
  }
}

// ============ Performance Timing ============

export interface FingerprintContext {
  identity: BrowserIdentity
  canvasHash: number
  histogramBins: number[]
  lsUbidSignin: string
  lsUbidProfile: string
  perfTiming: Record<string, number> | null
  startTime: number | null
}

export function newFPContext(identity: BrowserIdentity): FingerprintContext {
  const ts = Math.floor(Date.now() / 1000)
  return {
    identity,
    canvasHash: identity.canvasHash,
    histogramBins: [...identity.histogramBase],
    lsUbidSignin: `${identity.lsubidPrefixSignin}-${String(randInt(10000000)).padStart(7, '0')}-${String(randInt(10000000)).padStart(7, '0')}:${ts}`,
    lsUbidProfile: '',
    perfTiming: null,
    startTime: null
  }
}

export function resetPerfTiming(ctx: FingerprintContext): void {
  ctx.perfTiming = null
}

function genPerfTiming(nowMs: number): Record<string, number> {
  const loadEventEnd = nowMs - (500 + randInt(1001))
  const loadDuration = 2000 + randInt(2001)
  const base = loadEventEnd - loadDuration

  const dnsOffset = 2 + randInt(8)
  const connectEndOffset = 300 + randInt(300)
  const responseOffset = connectEndOffset + 200 + randInt(400)
  const domInteractiveOffset = loadDuration - (5 + randInt(11))
  const domContentLoadedStart = domInteractiveOffset + randInt(3)

  return {
    connectStart: base + dnsOffset + 1 + randInt(3),
    secureConnectionStart: base + dnsOffset + 3 + randInt(5),
    unloadEventEnd: 0,
    domainLookupStart: base + dnsOffset,
    domainLookupEnd: base + dnsOffset + randInt(2),
    responseStart: base + responseOffset,
    connectEnd: base + connectEndOffset,
    responseEnd: base + responseOffset + randInt(5),
    requestStart: base + connectEndOffset,
    domLoading: base + responseOffset + 2 + randInt(5),
    redirectStart: 0,
    loadEventEnd,
    domComplete: loadEventEnd,
    navigationStart: base,
    loadEventStart: loadEventEnd,
    domContentLoadedEventEnd: loadEventEnd,
    unloadEventStart: 0,
    redirectEnd: 0,
    domInteractive: base + domInteractiveOffset,
    fetchStart: base + dnsOffset,
    domContentLoadedEventStart: base + domContentLoadedStart
  }
}

function getPerfTiming(ctx: FingerprintContext, nowMs: number): Record<string, number> {
  if (!ctx.perfTiming) ctx.perfTiming = genPerfTiming(nowMs)
  return ctx.perfTiming
}

function getLsUbid(ctx: FingerprintContext, pageType: string): string {
  if (pageType === 'profile') {
    if (!ctx.lsUbidProfile) {
      const ts = ctx.perfTiming
        ? Math.floor(ctx.perfTiming.loadEventEnd / 1000)
        : Math.floor(Date.now() / 1000)
      ctx.lsUbidProfile = `${ctx.identity.lsubidPrefixProfile}-${String(randInt(10000000)).padStart(7, '0')}-${String(randInt(10000000)).padStart(7, '0')}:${ts}`
    }
    return ctx.lsUbidProfile
  }
  return ctx.lsUbidSignin
}

function getStartTime(ctx: FingerprintContext, nowMs: number): number {
  if (ctx.startTime === null) ctx.startTime = nowMs
  return ctx.startTime
}

// ============ Metrics & Interaction ============

function genMetricsFirstLoad(pageType: string): Record<string, number> {
  const m: Record<string, number> = {
    el: 0, script: 0, h: 0, batt: 0, perf: 0, auto: 0,
    tz: 0, fp2: 0, lsubid: 0, browser: 0, capabilities: 0,
    gpu: 0, dnt: 0, math: 0, tts: 0, input: 0, canvas: 0,
    captchainput: 0, pow: 0
  }
  switch (pageType) {
    case 'profile':
      m.batt = 5 + randInt(21); m.fp2 = 1 + randInt(8)
      m.browser = randInt(4); m.capabilities = 1 + randInt(8)
      m.dnt = randInt(4); m.input = 8 + randInt(23); m.canvas = 5 + randInt(16)
      break
    case 'signup':
      m.script = randInt(3); m.batt = randInt(6)
      m.fp2 = randInt(4); m.gpu = 3 + randInt(6)
      break
    default:
      m.script = randInt(3); m.auto = randInt(3)
      m.browser = randInt(3); m.gpu = 3 + randInt(6)
  }
  return m
}

function genMetricsPageSubmit(): Record<string, number> {
  return {
    el: 0, script: 0, h: 0, batt: 0, perf: randInt(3),
    auto: 0, tz: 0, fp2: 0, lsubid: 0, browser: 0,
    capabilities: 0, gpu: 0, dnt: 0, math: 0, tts: 0,
    input: 0, canvas: 0, captchainput: 0, pow: 0
  }
}

function genInteraction(eventType: string): Record<string, unknown> {
  if (eventType === 'PageLoad' || eventType === 'first_load') {
    return {
      clicks: 0, touches: 0, keyPresses: 0,
      cuts: 0, copies: 0, pastes: 0,
      keyPressTimeIntervals: [], mouseClickPositions: [],
      keyCycles: [], mouseCycles: [], touchCycles: []
    }
  }
  const nClicks = 1 + randInt(3)
  const nKeys = 3 + randInt(8)
  const nIntervals = Math.max(1, Math.floor(nKeys / 3)) + randInt(Math.max(1, Math.floor(nKeys / 2) - Math.floor(nKeys / 3) + 1))
  const nCycles = Math.max(2, Math.floor(nKeys / 2)) + randInt(Math.max(1, Math.floor(nKeys * 2 / 3) - Math.floor(nKeys / 2) + 1))

  return {
    clicks: nClicks, touches: 0, keyPresses: nKeys,
    cuts: 0, copies: 0, pastes: 0,
    keyPressTimeIntervals: Array.from({ length: nIntervals }, () => 80 + randInt(621)),
    mouseClickPositions: Array.from({ length: nClicks }, () => `${400 + randInt(401)},${300 + randInt(201)}`),
    keyCycles: Array.from({ length: nCycles }, () => 20 + randInt(281)),
    mouseCycles: Array.from({ length: nClicks }, () => 50 + randInt(101)),
    touchCycles: []
  }
}

function genFormField(
  startMs: number, emailLen: number, email: string,
  interaction: Record<string, unknown>
): Record<string, unknown> {
  const fieldTs = startMs - (10 + randInt(41))
  const fieldRand = 1000 + randInt(9000)
  const fieldName = `formField29-${fieldTs}-${fieldRand}`

  let nKeys = Math.max(3, Math.floor(emailLen / 3) + randInt(5) - 2)
  const intervals = Array.from({ length: Math.min(nKeys - 1, 5) }, () => 80 + randInt(621))
  const keyCycles = Array.from({ length: Math.min(nKeys, 6) }, () => 20 + randInt(231))

  if (typeof interaction.keyPresses === 'number' && interaction.keyPresses > 0) {
    nKeys = interaction.keyPresses
  }

  const checksumStr = email || `user${1000 + randInt(9000)}@example.com`
  const cksum = crc32Str(checksumStr).toString(16).toUpperCase().padStart(8, '0')

  return {
    [fieldName]: {
      clicks: 1, touches: 0, keyPresses: nKeys,
      cuts: 0, copies: 0, pastes: 0,
      keyPressTimeIntervals: intervals,
      mouseClickPositions: [`${100 + randInt(151)}.5,${10 + randInt(11)}.5`],
      keyCycles, mouseCycles: [80 + randInt(71)], touchCycles: [],
      width: 180, height: 32, totalFocusTime: 0,
      checksum: cksum, autocomplete: false, prefilled: false
    }
  }
}

// ============ Build Fingerprint ============

function formatScreen(s: BrowserIdentity['screen']): string {
  return `${s.width}-${s.height}-${s.availHeight}-${s.colorDepth}-*-*-*`
}

function formatPlugins(plugins: BrowserIdentity['plugins']): string {
  return plugins.map((p) => p.name).join(' ')
}

export function buildFingerprintData(
  identity: BrowserIdentity,
  locationURL: string,
  referrer: string,
  nowMs: number,
  ctx: FingerprintContext | null,
  pageType: string,
  eventType: string,
  timeOnPage: number,
  emailLen: number,
  email: string
): OrderedMap {
  const canvasHash = ctx ? ctx.canvasHash : identity.canvasHash
  const histogram = ctx ? ctx.histogramBins : identity.histogramBase

  const perfTiming = ctx ? getPerfTiming(ctx, nowMs) : genPerfTiming(nowMs)

  let lsUbid: string
  if (ctx) {
    lsUbid = getLsUbid(ctx, pageType)
  } else {
    lsUbid = `${identity.lsubidPrefixSignin}-${String(randInt(10000000)).padStart(7, '0')}-${String(randInt(10000000)).padStart(7, '0')}:${Math.floor(perfTiming.loadEventEnd / 1000)}`
  }

  let dynamicURLs: string[]
  let scriptsElapsed: number
  let historyLength: number
  let isCompatible: boolean

  switch (pageType) {
    case 'profile':
      dynamicURLs = [`/dist/main/app_${identity.webpackHash}.min.js`]
      scriptsElapsed = 0
      historyLength = (eventType === 'PageLoad' || eventType === 'first_load') ? 2 : 3
      isCompatible = true
      break
    case 'signup':
      dynamicURLs = ['/assets/js/app.js']
      scriptsElapsed = 1
      historyLength = 5
      isCompatible = true
      break
    default:
      dynamicURLs = ['/assets/js/app.js']
      scriptsElapsed = 1
      historyLength = 1
      isCompatible = false
  }

  let metrics: Record<string, number>
  if (eventType === 'first_load' || (eventType === 'PageLoad' && pageType === 'profile')) {
    metrics = genMetricsFirstLoad(pageType)
  } else {
    metrics = genMetricsPageSubmit()
  }

  const interaction = genInteraction(eventType)

  const endMs = nowMs + randInt(51)
  let startTime: number
  if (eventType !== 'PageLoad' && eventType !== 'first_load' && timeOnPage > 0) {
    startTime = endMs - timeOnPage
  } else if (ctx) {
    if (eventType === 'first_load') {
      startTime = getStartTime(ctx, nowMs - (500 + randInt(501)))
    } else if (eventType === 'PageLoad' && pageType === 'profile') {
      startTime = getStartTime(ctx, nowMs - (30 + randInt(51)))
    } else {
      startTime = getStartTime(ctx, nowMs)
    }
  } else {
    startTime = nowMs
  }

  const pluginsStr = formatPlugins(identity.plugins)
  const screenStr = formatScreen(identity.screen)

  const result = new OrderedMap()
  result.set('metrics', metrics)
  result.set('start', startTime)
  result.set('interaction', interaction)
  result.set('scripts', {
    dynamicUrls: dynamicURLs, inlineHashes: [],
    elapsed: scriptsElapsed, dynamicUrlCount: dynamicURLs.length, inlineHashesCount: 0
  })
  result.set('history', { length: historyLength })
  result.set('battery', {})
  result.set('performance', { timing: perfTiming })
  result.set('automation', {
    wd: { properties: { document: [], window: [], navigator: [] } },
    phantom: { properties: { window: [] } }
  })
  result.set('end', endMs)
  result.set('timeZone', 8)
  result.set('flashVersion', null)
  result.set('plugins', pluginsStr + ' ||' + screenStr)
  result.set('dupedPlugins', pluginsStr + ' ||' + screenStr)
  result.set('screenInfo', screenStr)
  result.set('lsUbid', lsUbid)
  result.set('referrer', referrer)
  result.set('userAgent', identity.ua)
  result.set('location', locationURL)
  result.set('webDriver', false)
  result.set('capabilities', {
    css: {
      textShadow: 1, WebkitTextStroke: 1, boxShadow: 1,
      borderRadius: 1, borderImage: 1, opacity: 1,
      transform: 1, transition: 1
    },
    js: {
      audio: true, geolocation: true, localStorage: 'supported',
      touch: false, video: true, webWorker: true
    },
    elapsed: 0
  })
  result.set('gpu', {
    vendor: identity.gpuVendor, model: identity.gpuModel,
    extensions: identity.webGLExts
  })
  result.set('dnt', null)
  result.set('math', { tan: identity.mathTan, sin: identity.mathSin, cos: identity.mathCos })

  if (pageType === 'profile') {
    if (eventType === 'PageLoad' || eventType === 'first_load') {
      result.set('timeToSubmit', 1 + randInt(5))
    } else if (timeOnPage > 0) {
      result.set('timeToSubmit', timeOnPage)
    } else {
      result.set('timeToSubmit', 2000 + randInt(4001))
    }
  }

  if (pageType === 'profile' && eventType !== 'PageLoad' && eventType !== 'first_load' && emailLen > 0) {
    result.set('form', genFormField(nowMs, emailLen, email, interaction))
  } else {
    result.set('form', {})
  }

  result.set('canvas', { hash: canvasHash, emailHash: null, histogramBins: [...histogram] })
  result.set('token', { isCompatible, pageHasCaptcha: 0 })
  result.set('auth', { form: { method: 'get' } })
  result.set('errors', [])
  result.set('version', getTESVersion())

  return result
}

/** 生成加密后的浏览器指纹字符串 */
export function generateFingerprint(
  identity: BrowserIdentity,
  locationURL: string,
  referrer: string,
  ctx: FingerprintContext | null,
  pageType: string,
  eventType: string,
  timeOnPage: number,
  emailLen: number,
  email: string
): string {
  const nowMs = Date.now()
  const fpData = buildFingerprintData(
    identity, locationURL, referrer, nowMs, ctx,
    pageType, eventType, timeOnPage, emailLen, email
  )
  const jsonStr = fpData.toJSON()
  return encryptFingerprint(jsonStr)
}
