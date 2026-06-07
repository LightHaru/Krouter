import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync } from 'fs'
import { access } from 'fs/promises'
import net from 'net'
import os from 'os'
import path from 'path'
import { getRuntimeUserDataPath } from '../../main/runtimePaths'

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
const PROTON_INBOX_URL = 'https://mail.proton.me/u/0/inbox'
const DEFAULT_VIEWPORT = { width: 1280, height: 900 }

type ProtonLogger = (msg: string) => void

interface WaitProtonOtpOptions {
  timeoutSec: number
  intervalSec: number
  signal?: AbortSignal
  log?: ProtonLogger
  proxy?: string
}

interface ScanResult {
  code: string
  from: 'body' | 'body-nocode' | 'wrong-recipient' | 'none' | 'error'
  matched: boolean
  snippet?: string
  err?: string
}

interface CdpResponse {
  id?: number
  method?: string
  params?: unknown
  result?: any
  error?: { message?: string }
}

interface PendingCommand {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

class CdpClient {
  private nextId = 1
  private pending = new Map<number, PendingCommand>()
  private eventWaiters = new Map<string, Array<(params: unknown) => void>>()
  private closed = false

  constructor(private readonly ws: any) {
    addWsListener(ws, 'message', (event: any) => void this.handleMessage(event))
    addWsListener(ws, 'close', () => this.handleClose())
    addWsListener(ws, 'error', (event: any) => this.handleError(event))
  }

  static async connect(url: string): Promise<CdpClient> {
    const WsCtor = (globalThis as any).WebSocket || require('undici').WebSocket
    const ws = new WsCtor(url)
    await waitForWsOpen(ws)
    return new CdpClient(ws)
  }

  isClosed(): boolean {
    return this.closed
  }

  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      // Ignore close races.
    }
  }

  send(method: string, params?: Record<string, unknown>, timeoutMs = 15000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'))
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params: params || {} })
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP command timed out: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.ws.send(payload)
    })
  }

  waitForEvent(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.eventWaiters.get(method) || []
        this.eventWaiters.set(method, waiters.filter((waiter) => waiter !== done))
        reject(new Error(`Timed out waiting for ${method}`))
      }, timeoutMs)
      const done = (params: unknown): void => {
        clearTimeout(timeout)
        resolve(params)
      }
      const waiters = this.eventWaiters.get(method) || []
      waiters.push(done)
      this.eventWaiters.set(method, waiters)
    })
  }

  private async handleMessage(event: any): Promise<void> {
    const raw = await messageText(event)
    if (!raw) return
    let message: CdpResponse
    try {
      message = JSON.parse(raw) as CdpResponse
    } catch {
      return
    }

    if (message.id) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'))
      else pending.resolve(message.result)
      return
    }

    if (message.method) {
      const waiters = this.eventWaiters.get(message.method) || []
      this.eventWaiters.delete(message.method)
      for (const waiter of waiters) waiter(message.params)
    }
  }

  private handleClose(): void {
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('CDP connection closed'))
    }
    this.pending.clear()
    this.eventWaiters.clear()
  }

  private handleError(event: any): void {
    const message = event?.message || event?.error?.message || 'CDP websocket error'
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(message))
    }
    this.pending.clear()
  }
}

let browserProcess: ChildProcess | null = null
let client: CdpClient | null = null
let debugPort = 0
let activeProxy = ''
let viewport = { ...DEFAULT_VIEWPORT }
let otpQueue: Promise<unknown> = Promise.resolve()

function addWsListener(ws: any, event: string, listener: (payload?: unknown) => void): void {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, listener)
  } else if (typeof ws.on === 'function') {
    ws.on(event, listener)
  }
}

async function messageText(event: any): Promise<string> {
  const data = event?.data ?? event
  if (typeof data === 'string') return data
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  if (data && typeof data.text === 'function') return await data.text()
  if (data === undefined || data === null) return ''
  return Buffer.from(data).toString('utf8')
}

function waitForWsOpen(ws: any): Promise<void> {
  if (ws.readyState === 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out connecting to Chromium DevTools')), 15000)
    addWsListener(ws, 'open', () => {
      clearTimeout(timeout)
      resolve()
    })
    addWsListener(ws, 'error', (event: any) => {
      clearTimeout(timeout)
      reject(new Error(event?.message || 'Failed to connect to Chromium DevTools'))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveSettingsProxy(explicit?: string): string {
  const value = (explicit || '').trim()
  if (value) return value
  return (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    ''
  ).trim()
}

function profileDir(): string {
  const dir = path.join(getRuntimeUserDataPath(), 'proton-browser')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function canAccess(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function findBrowserExecutable(): Promise<string> {
  const explicit = (process.env.PROTON_BROWSER_PATH || '').trim()
  if (explicit) {
    if (await canAccess(explicit)) return explicit
    throw new Error(`PROTON_BROWSER_PATH does not exist: ${explicit}`)
  }

  const candidates: string[] = []
  if (process.platform === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA
    ].filter((value): value is string => Boolean(value))
    for (const root of roots) {
      candidates.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium')
  } else {
    candidates.push('/usr/bin/chromium')
    candidates.push('/usr/bin/chromium-browser')
    candidates.push('/usr/bin/google-chrome')
    candidates.push('/usr/bin/google-chrome-stable')
    candidates.push('/usr/bin/microsoft-edge')
  }

  const pathNames = process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
    : ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of pathNames) candidates.push(path.join(dir, name))
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }

  throw new Error('No Chrome/Chromium executable found. Set PROTON_BROWSER_PATH or install chromium on the server.')
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${url} failed with ${response.status}`)
  return await response.json() as T
}

async function waitForDevtools(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`)
      return
    } catch {
      await sleep(250)
    }
  }
  throw new Error('Chromium DevTools endpoint did not become ready')
}

async function getPageWebSocketUrl(port: number): Promise<string> {
  type Target = { type?: string; url?: string; webSocketDebuggerUrl?: string }
  let targets = await fetchJson<Target[]>(`http://127.0.0.1:${port}/json/list`)
  let target = targets.find((item) => item.type === 'page' && /proton\.me/i.test(item.url || ''))
    || targets.find((item) => item.type === 'page')

  if (!target?.webSocketDebuggerUrl) {
    const createUrl = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(PROTON_INBOX_URL)}`
    try {
      await fetchJson(createUrl, { method: 'PUT' })
    } catch {
      await fetchJson(createUrl)
    }
    targets = await fetchJson<Target[]>(`http://127.0.0.1:${port}/json/list`)
    target = targets.find((item) => item.type === 'page' && /proton\.me/i.test(item.url || ''))
      || targets.find((item) => item.type === 'page')
  }

  if (!target?.webSocketDebuggerUrl) throw new Error('Could not find a Chromium page target')
  return target.webSocketDebuggerUrl
}

function browserIsRunning(): boolean {
  return Boolean(browserProcess && browserProcess.exitCode === null && !browserProcess.killed)
}

async function launchBrowser(proxy?: string): Promise<void> {
  const resolvedProxy = resolveSettingsProxy(proxy)
  if (browserIsRunning() && activeProxy === resolvedProxy) return
  await closeProtonWindow()

  debugPort = Number(process.env.PROTON_BROWSER_DEBUG_PORT || 0) || await getFreePort()
  activeProxy = resolvedProxy

  const executable = await findBrowserExecutable()
  const headless = process.env.PROTON_BROWSER_HEADLESS !== 'false'
  const noSandbox = process.env.PROTON_BROWSER_NO_SANDBOX === 'true'
    || (
      process.env.PROTON_BROWSER_NO_SANDBOX !== 'false'
      && process.platform !== 'win32'
      && (typeof process.getuid !== 'function' || process.getuid() === 0)
    )
  const args = [
    `--remote-debugging-port=${debugPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir()}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--window-size=${viewport.width},${viewport.height}`,
    `--user-agent=${CHROME_UA}`
  ]
  if (headless) args.push('--headless=new')
  if (noSandbox) args.push('--no-sandbox')
  if (resolvedProxy) args.push(`--proxy-server=${resolvedProxy}`)
  args.push(PROTON_INBOX_URL)

  const proc = spawn(executable, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  browserProcess = proc
  proc.stderr?.on('data', (chunk) => {
    const line = chunk.toString('utf8').trim()
    if (line) console.warn(`[ProtonBrowser] ${line}`)
  })
  proc.on('exit', () => {
    browserProcess = null
    client?.close()
    client = null
  })

  await waitForDevtools(debugPort)
}

async function ensureClient(proxy?: string): Promise<CdpClient> {
  await launchBrowser(proxy)
  if (!client || client.isClosed()) {
    const wsUrl = await getPageWebSocketUrl(debugPort)
    client = await CdpClient.connect(wsUrl)
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await setViewport(viewport.width, viewport.height)
  }
  return client
}

async function setViewport(width: number, height: number): Promise<void> {
  viewport = {
    width: Math.max(640, Math.min(Math.floor(width || DEFAULT_VIEWPORT.width), 1920)),
    height: Math.max(480, Math.min(Math.floor(height || DEFAULT_VIEWPORT.height), 1400))
  }
  if (!client || client.isClosed()) return
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false
  })
}

async function evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
  const cdp = await ensureClient()
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  })
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Chromium evaluation failed')
  }
  const remote = result?.result
  return remote?.value as T
}

async function currentUrl(): Promise<string> {
  try {
    return await evaluate<string>('location.href')
  } catch {
    return ''
  }
}

async function loadAndWait(url = PROTON_INBOX_URL, timeoutMs = 30000): Promise<void> {
  const cdp = await ensureClient()
  const load = cdp.waitForEvent('Page.loadEventFired', timeoutMs).catch(() => undefined)
  await cdp.send('Page.navigate', { url })
  await load
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const ready = await evaluate<string>('document.readyState')
      if (ready === 'interactive' || ready === 'complete') return
    } catch {
      // Keep polling until the page is usable.
    }
    await sleep(250)
  }
}

async function checkLoggedIn(): Promise<boolean> {
  const url = await currentUrl()
  if (/account\.proton\.me/i.test(url) || /\/(login|authorize|switch)/i.test(url)) return false
  if (!/mail\.proton\.me\/u\//i.test(url)) return false
  try {
    return Boolean(await evaluate<boolean>(
      `(() => {
        if (document.querySelector('input[type="password"], #password')) return false
        const sels = ['[data-testid="message-list"]','.items-column-list','[data-shortcut-target="item-container"]','main [role="main"]']
        return sels.some(s => document.querySelector(s)) || /\\/u\\//.test(location.pathname)
      })()`
    ))
  } catch {
    return /mail\.proton\.me\/u\//i.test(url)
  }
}

export async function openProtonLogin(proxy?: string): Promise<{
  success: boolean
  loggedIn: boolean
  loginUrl?: string
  url?: string
  error?: string
}> {
  try {
    await ensureClient(proxy)
    if (!/proton\.me/i.test(await currentUrl())) await loadAndWait(PROTON_INBOX_URL)
    await sleep(1200)
    const loggedIn = await checkLoggedIn()
    return { success: true, loggedIn, loginUrl: '/proton-login', url: await currentUrl() }
  } catch (error) {
    return {
      success: false,
      loggedIn: false,
      loginUrl: '/proton-login',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function getProtonLoginStatus(proxy?: string): Promise<{ loggedIn: boolean; loginUrl?: string; url?: string; error?: string }> {
  try {
    await ensureClient(proxy)
    await sleep(600)
    return { loggedIn: await checkLoggedIn(), loginUrl: '/proton-login', url: await currentUrl() }
  } catch (error) {
    return { loggedIn: false, loginUrl: '/proton-login', error: error instanceof Error ? error.message : String(error) }
  }
}

export async function closeProtonWindow(): Promise<void> {
  client?.close()
  client = null
  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    browserProcess.kill()
  }
  browserProcess = null
  activeProxy = ''
}

export async function captureProtonScreenshot(width?: number, height?: number): Promise<{
  success: boolean
  dataUrl?: string
  width?: number
  height?: number
  loggedIn?: boolean
  url?: string
  error?: string
}> {
  try {
    const cdp = await ensureClient()
    await setViewport(width || viewport.width, height || viewport.height)
    await cdp.send('Page.bringToFront')
    let result: { data: string }
    try {
      result = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 82,
        fromSurface: true,
        captureBeyondViewport: false
      }, 12000)
    } catch {
      result = await cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 82,
        fromSurface: false,
        captureBeyondViewport: false
      }, 12000)
    }
    return {
      success: true,
      dataUrl: `data:image/jpeg;base64,${result.data}`,
      width: viewport.width,
      height: viewport.height,
      loggedIn: await checkLoggedIn(),
      url: await currentUrl()
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function clickProtonPage(x: number, y: number): Promise<{ success: boolean; error?: string }> {
  try {
    const cdp = await ensureClient()
    const safeX = Math.max(0, Math.min(Number(x) || 0, viewport.width))
    const safeY = Math.max(0, Math.min(Number(y) || 0, viewport.height))
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: safeX, y: safeY, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: safeX, y: safeY, button: 'left', clickCount: 1 })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function typeProtonText(text: string): Promise<{ success: boolean; error?: string }> {
  try {
    const cdp = await ensureClient()
    await cdp.send('Input.insertText', { text })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function keyParams(key: string): Record<string, unknown> {
  const normalized = key.trim()
  const aliases: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }
  }
  return aliases[normalized] || { key: normalized, code: normalized, windowsVirtualKeyCode: 0 }
}

export async function pressProtonKey(key: string): Promise<{ success: boolean; error?: string }> {
  try {
    const cdp = await ensureClient()
    const params = keyParams(key)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function scrollProtonPage(deltaY: number, x?: number, y?: number): Promise<{ success: boolean; error?: string }> {
  try {
    const cdp = await ensureClient()
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.max(0, Math.min(Number(x) || viewport.width / 2, viewport.width)),
      y: Math.max(0, Math.min(Number(y) || viewport.height / 2, viewport.height)),
      deltaX: 0,
      deltaY: Number(deltaY) || 0
    })
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function navigateProton(url?: string): Promise<{ success: boolean; loggedIn?: boolean; url?: string; error?: string }> {
  try {
    const target = url && /^https:\/\/(?:mail|account)\.proton\.me\//i.test(url) ? url : PROTON_INBOX_URL
    await loadAndWait(target)
    return { success: true, loggedIn: await checkLoggedIn(), url: await currentUrl() }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function buildScanScript(address: string): string {
  const addrFull = JSON.stringify(address.trim().toLowerCase())
  return `(async () => {
    const addrFull = ${addrFull};
    const extractCode = (t) => { const m = (t||'').match(/\\b\\d{6}\\b/g); return m ? m[m.length-1] : ''; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const fire = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    const readRecipients = () => {
      const set = new Set();
      document.querySelectorAll('a[href^="mailto:"]').forEach((a) => {
        const m = (a.getAttribute('href') || '').replace(/^mailto:/i, '').trim().toLowerCase();
        if (m.indexOf('@') > 0) set.add(m);
      });
      document.querySelectorAll('[data-testid="recipient-label"], bdi.message-recipient-item-label').forEach((el) => {
        const t = (el.innerText || '').trim().toLowerCase();
        if (t.indexOf('@') > 0) set.add(t);
      });
      document.querySelectorAll('[data-testid^="recipients:item-"]').forEach((el) => {
        const t = (el.getAttribute('data-testid') || '').replace('recipients:item-', '').trim().toLowerCase();
        if (t.indexOf('@') > 0) set.add(t);
      });
      return set;
    };
    const SENDER = 'no-reply@signin.aws';
    const senderOf = (it) => {
      const el = it.querySelector('[data-testid="message-column:sender-address"]');
      return el ? (el.getAttribute('title') || el.innerText || '').trim().toLowerCase() : '';
    };
    const openItem = (it) => {
      let target = it.querySelector('[data-testid="message-column:subject"]')
        || it.querySelector('[data-testid^="message-row"]')
        || it.querySelector('.item-subject-wrapper, .subject, span[role="heading"]');
      if (!target) {
        const cand = Array.from(it.querySelectorAll('span, div'))
          .filter((el) => !el.closest('button') && !el.querySelector('button, input') && (el.innerText || '').trim().length > 8);
        target = cand[0] || it;
      }
      fire(target, 'mousedown'); fire(target, 'mouseup'); fire(target, 'click');
    };
    const readBody = () => {
      let body = '';
      const ifr = document.querySelector('iframe[data-testid="content-iframe"], iframe[title], iframe');
      if (ifr) { try { body = (ifr.contentDocument && ifr.contentDocument.body) ? (ifr.contentDocument.body.innerText || '') : ''; } catch (e) {} }
      if (!body) {
        const readSels = ['[data-testid="message-content"]','.message-content','[data-testid="message-view"]','main [role="article"]','main'];
        for (const rs of readSels) { const el = document.querySelector(rs); if (el && el.innerText) { body = el.innerText; break; } }
      }
      if (!body) body = document.body.innerText || '';
      return body;
    };
    const listSels = ['[data-testid="message-item"]','[data-shortcut-target="item-container"]','.items-column-list [role="row"]','.item-container-wrapper','.item-container'];
    let items = [];
    for (const s of listSels) { const e = [...document.querySelectorAll(s)]; if (e.length) { items = e; break; } }
    if (!items[0]) return { code: '', from: 'none', matched: false };
    const awsItems = items.filter((it) => senderOf(it) === SENDER);
    const candidates = (awsItems.length ? awsItems : items).slice(0, 2);
    const results = [];
    for (let i = 0; i < candidates.length; i++) {
      try {
        openItem(candidates[i]);
        let body = '';
        let recipients = new Set();
        for (let t = 0; t < 11; t++) {
          await sleep(t === 0 ? 350 : 170);
          body = readBody();
          recipients = readRecipients();
          if (extractCode(body) || (recipients.size > 0 && body.length > 30)) break;
        }
        const r = {
          i,
          hasRecip: recipients.size > 0,
          match: recipients.has(addrFull),
          code: extractCode(body),
          recipText: Array.from(recipients).join(',').slice(0, 100),
          bodySnip: body.slice(0, 100)
        };
        results.push(r);
        if (r.match && r.code) return { code: r.code, from: 'body', matched: true, snippet: 'aws#' + i + ' ' + r.bodySnip };
      } catch (e) {
        results.push({ i, hasRecip: false, match: false, code: '', recipText: '', bodySnip: 'err=' + String(e) });
      }
    }
    const noRecipCode = results.find((r) => !r.hasRecip && r.code);
    if (noRecipCode) return { code: noRecipCode.code, from: 'body', matched: false, snippet: 'aws#' + noRecipCode.i + ' no-recipients; ' + noRecipCode.bodySnip };
    const matchNoCode = results.find((r) => r.match && !r.code);
    if (matchNoCode) return { code: '', from: 'body-nocode', matched: true, snippet: 'aws#' + matchNoCode.i + ' ' + matchNoCode.bodySnip };
    const wrongRecip = results.find((r) => r.code && r.hasRecip && !r.match);
    if (wrongRecip) return { code: '', from: 'wrong-recipient', matched: false, snippet: 'aws#' + wrongRecip.i + ' recipients=' + wrongRecip.recipText };
    return { code: '', from: 'body-nocode', matched: false, snippet: 'awsItems=' + awsItems.length + '; ' + results.map((r) => '#' + r.i + (r.code ? '+code' : '-nocode') + ' r=' + (r.recipText || 'none')).join(' | ').slice(0, 170) };
  })()`
}

export function waitProtonOtp(address: string, opts: WaitProtonOtpOptions): Promise<string> {
  const run = otpQueue.then(
    () => runWaitProtonOtp(address, opts),
    () => runWaitProtonOtp(address, opts)
  )
  otpQueue = run.catch(() => undefined)
  return run
}

async function runWaitProtonOtp(address: string, opts: WaitProtonOtpOptions): Promise<string> {
  const log = opts.log ?? ((): void => {})
  await ensureClient(opts.proxy)

  if (!(await checkLoggedIn())) {
    throw new Error('Proton is not logged in. Open the Proton login page and complete the mailbox login first.')
  }

  await loadAndWait(PROTON_INBOX_URL)
  await sleep(1500)

  const pollMs = Math.min(Math.max(opts.intervalSec * 1000, 250), 1000)
  const maxRetries = Math.max(1, Math.floor((opts.timeoutSec * 1000) / pollMs))
  const script = buildScanScript(address)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (opts.signal?.aborted) throw new Error('Registration was cancelled')

    if (attempt > 1 && attempt % 20 === 0) {
      await loadAndWait(PROTON_INBOX_URL)
      await sleep(1200)
    }

    try {
      const res = await evaluate<ScanResult>(script, true)
      if (res && res.code && res.from === 'body') {
        log(`[Proton] Verification code: ${res.code} (${res.matched ? 'recipient matched' : 'body fallback'})`)
        return res.code
      }
      if (res && res.from === 'wrong-recipient' && attempt % 8 === 0) {
        log(`[Proton] Latest AWS mail is for another recipient, waiting... ${res.snippet || ''}`)
      } else if (res && res.from === 'body-nocode' && attempt % 8 === 0) {
        log(`[Proton] ${res.matched ? 'Matched mail but no code yet' : 'No matching mail yet'}: ${res.snippet || ''}`)
      } else if (res && res.from === 'error' && attempt % 10 === 0) {
        log(`[Proton] Scan script failed: ${res.err}`)
      }
    } catch (error) {
      if (attempt % 10 === 0) log(`[Proton] [${attempt}/${maxRetries}] Read failed: ${error}`)
    }

    if (attempt % 10 === 0) log(`[Proton] [${attempt}/${maxRetries}] No verification code yet...`)
    await sleep(pollMs)
  }

  throw new Error(`Timed out waiting for verification code (${opts.timeoutSec}s) on ${os.hostname()}`)
}
