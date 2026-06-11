#!/usr/bin/env node

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline/promises')
const { execFile, spawn } = require('child_process')
const { stdin: input, stdout: output } = require('process')

const PACKAGE_ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.resolve(process.env.KROUTER_DATA_DIR || process.env.KIRO_WEB_DATA_DIR || path.join(os.homedir(), '.krouter'))
const ENV_FILE = path.join(DATA_DIR, '.env')
const PID_FILE = path.join(DATA_DIR, 'server.pid')
const SERVER_OUT = path.join(DATA_DIR, 'server.out.log')
const SERVER_ERR = path.join(DATA_DIR, 'server.err.log')
const SERVER_ENTRY = path.join(PACKAGE_ROOT, 'out-server', 'server', 'index.js')
const STATIC_ENTRY = path.join(PACKAGE_ROOT, 'dist-web', 'index.html')
const KROUTER_NPM_PACKAGE = '@lightharu/krouter'
const KROUTER_NPM_LATEST_URL = 'https://registry.npmjs.org/@lightharu%2Fkrouter/latest'
const DEFAULT_PORT = process.env.PORT || '4010'
const API_BASE = (process.env.KROUTER_API_BASE || process.env.KAM_API_BASE || `http://127.0.0.1:${DEFAULT_PORT}`).replace(/\/$/, '')
const DASHBOARD_URL = (
  process.env.KROUTER_DASHBOARD_URL ||
  process.env.KAM_DASHBOARD_URL ||
  process.env.PUBLIC_DASHBOARD_URL ||
  process.env.DASHBOARD_URL ||
  API_BASE
).replace(/\/$/, '')
const invokedName = path.basename(process.argv[1] || 'krouter')
const COMMAND_NAME = /^(krouter-cli|kiro-manager-cli)\.cjs$/i.test(invokedName) ? 'krouter' : invokedName
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const COLORS = {
  reset: USE_COLOR ? '\x1b[0m' : '',
  green: USE_COLOR ? '\x1b[32m' : '',
  red: USE_COLOR ? '\x1b[31m' : '',
  yellow: USE_COLOR ? '\x1b[33m' : '',
  cyan: USE_COLOR ? '\x1b[36m' : '',
  bold: USE_COLOR ? '\x1b[1m' : '',
  dim: USE_COLOR ? '\x1b[2m' : ''
}

let cookie = ''

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url')
}

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const env = {}
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
    const index = trimmed.indexOf('=')
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return env
}

function writeEnvFile(file, env) {
  const body = Object.entries(env)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, '')}`)
    .join('\n')
  fs.writeFileSync(file, `${body}\n`, 'utf8')
}

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function compareVersions(a, b) {
  const normalize = (value) => String(value || '0')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => {
      const match = part.match(/\d+/)
      return match ? Number(match[0]) : 0
    })
  const left = normalize(a)
  const right = normalize(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

function npmCommand() {
  return process.env.KROUTER_NPM_COMMAND || process.env.NPM_COMMAND || (process.platform === 'win32' ? 'npm.cmd' : 'npm')
}

async function fetchLatestPackageVersion() {
  const response = await fetch(KROUTER_NPM_LATEST_URL, {
    headers: { Accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`npm registry returned ${response.status}`)
  const latest = await response.json()
  return {
    version: String(latest.version || '').replace(/^v/i, ''),
    tarball: latest.dist?.tarball
  }
}

function runGlobalPackageUpdate() {
  return new Promise((resolve) => {
    execFile(
      npmCommand(),
      ['install', '-g', `${KROUTER_NPM_PACKAGE}@latest`, '--registry', 'https://registry.npmjs.org/', '--no-audit', '--no-fund'],
      { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : 1
          resolve({ code, stdout, stderr: stderr || error.message })
          return
        }
        resolve({ code: 0, stdout, stderr })
      }
    )
  })
}

async function updateKrouterPackage(options = {}) {
  const currentVersion = packageVersion()
  console.log(line('Package', KROUTER_NPM_PACKAGE))
  console.log(line('Current', currentVersion))

  const latest = await fetchLatestPackageVersion()
  console.log(line('Latest', latest.version || '-'))

  const hasUpdate = latest.version && compareVersions(latest.version, currentVersion) > 0
  if (!hasUpdate && !options.force) {
    console.log(`${COLORS.green}Krouter dang o ban moi nhat.${COLORS.reset}`)
    return
  }

  if (options.checkOnly) {
    console.log(hasUpdate ? `${COLORS.yellow}Co ban moi. Chay: ${COMMAND_NAME} update${COLORS.reset}` : `${COLORS.green}Khong co ban moi.${COLORS.reset}`)
    return
  }

  console.log(`${COLORS.cyan}Dang cap nhat qua npm...${COLORS.reset}`)
  const result = await runGlobalPackageUpdate()
  const outputText = `${result.stdout || ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim()
  if (result.code !== 0) {
    throw new Error(`Cap nhat that bai (exit ${result.code}).${outputText ? `\n${outputText}` : ''}`)
  }
  if (outputText) console.log(outputText)
  console.log(`${COLORS.green}Cap nhat xong.${COLORS.reset} Chay lai: ${COMMAND_NAME}`)
}

function ensureRuntimeEnv() {
  ensureDir(DATA_DIR)
  const env = parseEnvFile(ENV_FILE)
  if (!env.SESSION_SECRET) env.SESSION_SECRET = randomSecret()
  if (!env.APP_ENCRYPTION_KEY) env.APP_ENCRYPTION_KEY = randomSecret()
  if (!env.KROUTER_CLI_TOKEN) env.KROUTER_CLI_TOKEN = randomSecret()
  if (!env.KIRO_WEB_DATA_DIR) env.KIRO_WEB_DATA_DIR = DATA_DIR
  if (!env.KIRO_RUNTIME_DATA_DIR) env.KIRO_RUNTIME_DATA_DIR = DATA_DIR
  writeEnvFile(ENV_FILE, env)
  return env
}

function readCliToken() {
  const fileEnv = readEnvFile()
  return process.env.KROUTER_CLI_TOKEN ||
    process.env.KAM_CLI_TOKEN ||
    fileEnv.KROUTER_CLI_TOKEN ||
    fileEnv.KAM_CLI_TOKEN ||
    ''
}

function readEnvFile() {
  const candidates = [
    process.env.KROUTER_ENV_FILE,
    process.env.KAM_ENV_FILE,
    ENV_FILE,
    path.join(process.cwd(), 'shared', '.env.web'),
    path.join(process.cwd(), '..', 'shared', '.env.web'),
    path.join(process.cwd(), '..', '..', 'shared', '.env.web'),
    path.join(process.cwd(), '.env.web'),
    path.join(process.cwd(), '.env')
  ].filter(Boolean)

  for (const file of candidates) {
    const env = parseEnvFile(file)
    if (Object.keys(env).length > 0) return env
  }
  return {}
}

async function request(pathname, options = {}) {
  const cliToken = readCliToken()
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(cliToken ? { 'X-Krouter-Cli-Token': cliToken } : {}),
    ...(options.headers || {})
  }
  const response = await fetch(`${API_BASE}${pathname}`, { ...options, headers })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { message: text }
    }
  }
  if (!response.ok) {
    throw new Error(data?.error || data?.message || response.statusText)
  }
  return data
}

async function getHealth() {
  try {
    return await request('/healthz')
  } catch {
    return null
  }
}

function isRemoteApiBase() {
  return Boolean(process.env.KROUTER_API_BASE || process.env.KAM_API_BASE)
}

function isPidRunning(pid) {
  if (!pid || Number.isNaN(Number(pid))) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

function readPid() {
  try {
    return Number(fs.readFileSync(PID_FILE, 'utf8').trim())
  } catch {
    return 0
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHealth(timeoutMs = 15000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const health = await getHealth()
    if (health?.ok) return health
    await sleep(500)
  }
  return null
}

async function ensureServer() {
  const runtimeEnv = ensureRuntimeEnv()
  const existing = await getHealth()
  if (existing?.ok) {
    const currentVersion = packageVersion()
    if (!isRemoteApiBase() && existing.version && existing.version !== currentVersion) {
      const pid = readPid()
      if (isPidRunning(pid)) {
        try {
          process.kill(pid)
          await sleep(1200)
        } catch {
          return existing
        }
      } else {
        return existing
      }
    } else {
      return existing
    }
  }

  if (isRemoteApiBase()) {
    throw new Error(`Khong ket noi duoc Krouter backend tai ${API_BASE}`)
  }
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`Thieu backend build: ${SERVER_ENTRY}. Cai lai package hoac chay npm run build:fullstack.`)
  }
  if (!fs.existsSync(STATIC_ENTRY)) {
    throw new Error(`Thieu web build: ${STATIC_ENTRY}. Cai lai package hoac chay npm run build:fullstack.`)
  }

  const pid = readPid()
  if (isPidRunning(pid)) {
    const health = await waitForHealth(5000)
    if (health?.ok) return health
  }

  const out = fs.openSync(SERVER_OUT, 'a')
  const err = fs.openSync(SERVER_ERR, 'a')
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PACKAGE_ROOT,
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      ...runtimeEnv,
      PORT: DEFAULT_PORT,
      HOST: process.env.HOST || '127.0.0.1',
      SERVE_STATIC: process.env.SERVE_STATIC || 'true',
      KROUTER_SERVER_MODE: process.env.KROUTER_SERVER_MODE || 'fullstack',
      KROUTER_DASHBOARD_URL: DASHBOARD_URL
    }
  })
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8')
  child.unref()

  const health = await waitForHealth()
  if (!health?.ok) {
    throw new Error(`Krouter backend khoi dong chua thanh cong. Xem log: ${SERVER_ERR}`)
  }
  return health
}

function openBrowser(url) {
  if (process.env.KROUTER_NO_OPEN || process.env.NO_OPEN) return
  const platform = process.platform
  const command = platform === 'win32' ? 'cmd'
    : platform === 'darwin' ? 'open'
    : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  } catch {
    // Opening the browser is best effort only.
  }
}

async function login() {
  const fileEnv = readEnvFile()
  const session = await request('/api/auth/session').catch(() => null)
  if (session?.authenticated) return
  if (session?.setupRequired) {
    throw new Error(`Krouter chua duoc setup. Chay: ${COMMAND_NAME} setup`)
  }
  const email = process.env.KROUTER_ADMIN_EMAIL || process.env.KAM_ADMIN_EMAIL || process.env.ADMIN_EMAIL || fileEnv.KROUTER_ADMIN_EMAIL || fileEnv.KAM_ADMIN_EMAIL || fileEnv.ADMIN_EMAIL || 'admin@krouter.local'
  const password = process.env.KROUTER_ADMIN_PASSWORD || process.env.KAM_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || fileEnv.KROUTER_ADMIN_PASSWORD || fileEnv.KAM_ADMIN_PASSWORD || fileEnv.ADMIN_PASSWORD
  if (!password) {
    throw new Error(`Thieu mat khau admin. Mo dashboard ${DASHBOARD_URL} hoac dat KROUTER_ADMIN_PASSWORD.`)
  }
  await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  })
}

async function getSetupStatus() {
  return request('/api/auth/setup/status')
}

async function setupKrouter() {
  const status = await getSetupStatus()
  if (!status.setupRequired) {
    console.log(`${COLORS.green}Krouter da duoc setup.${COLORS.reset}`)
    return
  }

  const rl = readline.createInterface({ input, output })
  try {
    boxedTitle('Krouter setup', 'Tao mat khau admin lan dau')
    console.log(`${COLORS.bold}1.${COLORS.reset} Krouter tao mat khau random`)
    console.log(`${COLORS.bold}2.${COLORS.reset} Tu dat mat khau`)
    const choice = await ask(rl, '\nChon: ', '1')
    let body
    if (choice === '2') {
      const password = await ask(rl, 'Mat khau moi (toi thieu 8 ky tu): ')
      const confirm = await ask(rl, 'Nhap lai mat khau: ')
      if (password !== confirm) throw new Error('Hai mat khau khong khop')
      body = { mode: 'custom', password }
    } else {
      body = { mode: 'random' }
    }

    const result = await request('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    console.log(`${COLORS.green}Setup thanh cong.${COLORS.reset}`)
    if (result.generatedPassword) {
      console.log(line('Mat khau', `${COLORS.yellow}${result.generatedPassword}${COLORS.reset}`))
      console.log(`${COLORS.yellow}Luu mat khau nay ngay bay gio, Krouter chi hien thi mot lan.${COLORS.reset}`)
    }
  } finally {
    rl.close()
  }
}

async function ipc(method, args = []) {
  return request('/api/ipc', {
    method: 'POST',
    body: JSON.stringify({ method, args })
  })
}

function activeDashboardUrl(tunnel) {
  return tunnel?.running && tunnel.publicUrl ? tunnel.publicUrl.replace(/\/$/, '') : DASHBOARD_URL
}

function statusLabel(value) {
  return value ? `${COLORS.green}ON${COLORS.reset}` : `${COLORS.red}OFF${COLORS.reset}`
}

const BOX_WIDTH = 66

// Visible length ignoring ANSI color codes, so bordered boxes stay aligned
// whether or not colors are enabled.
function visibleLength(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\x1b\[[0-9;]*m/g, '').length
}

function line(label, value) {
  const padded = `${label}:`.padEnd(16, ' ')
  return `  ${COLORS.dim}${padded}${COLORS.reset}${value || '-'}`
}

function horizontal(width = BOX_WIDTH) {
  return `${COLORS.dim}+${'-'.repeat(Math.max(0, width - 2))}+${COLORS.reset}`
}

// A single bordered row whose content keeps its alignment even with color codes.
function boxedRow(content, width = BOX_WIDTH) {
  const inner = width - 4
  const pad = Math.max(0, inner - visibleLength(content))
  return `${COLORS.dim}|${COLORS.reset} ${content}${' '.repeat(pad)} ${COLORS.dim}|${COLORS.reset}`
}

function boxedTitle(title, subtitle) {
  console.log(horizontal())
  console.log(boxedRow(`${COLORS.bold}${COLORS.cyan}${title}${COLORS.reset}`))
  if (subtitle) console.log(boxedRow(`${COLORS.dim}${subtitle}${COLORS.reset}`))
  console.log(horizontal())
}

async function getTunnelStatus() {
  try {
    return await ipc('dashboardTunnelGetStatus')
  } catch (error) {
    const message = error?.message || String(error)
    const session = await request('/api/auth/session').catch(() => null)
    return {
      running: false,
      localUrl: DASHBOARD_URL,
      error: /unauthorized/i.test(message)
        ? (session?.setupRequired ? `Krouter chua setup. Chay: ${COMMAND_NAME} setup` : 'Backend hien tai chua nhan quyen CLI local. Chay krouter stop roi krouter de khoi dong lai ban moi.')
        : message
    }
  }
}

async function printLinks() {
  const tunnel = await getTunnelStatus()
  console.log(line('Web local', `${COLORS.cyan}${DASHBOARD_URL}${COLORS.reset}`))
  console.log(line('Tunnel', `${statusLabel(Boolean(tunnel.running))}${tunnel.publicUrl ? `  ${COLORS.green}${tunnel.publicUrl}${COLORS.reset}` : ''}`))
  console.log(line('Dung link nay', `${COLORS.green}${activeDashboardUrl(tunnel)}${COLORS.reset}`))
  if (tunnel.error) console.log(line('Loi tunnel', `${COLORS.red}${tunnel.error}${COLORS.reset}`))
  return tunnel
}

async function printBasicStart() {
  const session = await request('/api/auth/session').catch(() => null)
  boxedTitle('Krouter', 'Dashboard web va API proxy')
  console.log(line('Backend', API_BASE))
  console.log(line('Dashboard', `${COLORS.green}${DASHBOARD_URL}${COLORS.reset}`))
  console.log(line('Data', DATA_DIR))
  if (session?.setupRequired) {
    console.log(line('Setup', `${COLORS.yellow}${COMMAND_NAME} setup${COLORS.reset}`))
  }
  console.log(horizontal())
}

async function printStatus() {
  const [health, tunnel] = await Promise.all([getHealth(), getTunnelStatus()])
  boxedTitle('Krouter', 'Dashboard web va tunnel')
  console.log(line('Backend', `${API_BASE}${health ? ` (${health.mode || 'ok'})` : ''}`))
  console.log(line('Web local', `${COLORS.cyan}${DASHBOARD_URL}${COLORS.reset}`))
  console.log(line('Data', DATA_DIR))
  console.log(line('Tunnel', `${statusLabel(Boolean(tunnel.running))}${tunnel.publicUrl ? `  ${COLORS.green}${tunnel.publicUrl}${COLORS.reset}` : ''}`))
  console.log(line('Tro ve', tunnel.localUrl))
  if (tunnel.publicUrl) console.log(line('Web public', `${COLORS.green}${tunnel.publicUrl}${COLORS.reset}`))
  if (tunnel.error) console.log(line('Loi', `${COLORS.red}${tunnel.error}${COLORS.reset}`))
  console.log(horizontal())
}

async function startTunnel(localUrl) {
  const result = await ipc('dashboardTunnelStart', [{ localUrl: localUrl || DASHBOARD_URL }])
  const status = result.status
  if (!result.success && result.error) {
    console.log(`${COLORS.red}Loi tunnel:${COLORS.reset} ${result.error}`)
  } else if (status.publicUrl) {
    console.log(`${COLORS.green}Link tunnel:${COLORS.reset} ${status.publicUrl}`)
  } else {
    console.log(`${COLORS.yellow}Dang bat tunnel.${COLORS.reset} Kiem tra: ${COMMAND_NAME} status`)
  }
  return status
}

async function stopTunnel() {
  const result = await ipc('dashboardTunnelStop')
  console.log(result.success ? `${COLORS.green}Da tat tunnel.${COLORS.reset}` : `${COLORS.red}Tat tunnel loi:${COLORS.reset} ${result.error || result.status?.error || 'unknown error'}`)
}

async function restartTunnel(localUrl) {
  await stopTunnel()
  await startTunnel(localUrl)
}

function formatDateTime(value) {
  if (!value) return '-'
  try {
    return new Date(Number(value)).toLocaleString()
  } catch {
    return '-'
  }
}

async function printSyncPasswordStatus() {
  const status = await ipc('accountSyncGetStatus')
  console.log(line('Sync password', status.enabled ? `${COLORS.green}DA TAO${COLORS.reset}` : `${COLORS.yellow}CHUA TAO${COLORS.reset}`))
  if (status.createdAt) console.log(line('Tao luc', formatDateTime(status.createdAt)))
  if (status.updatedAt) console.log(line('Cap nhat', formatDateTime(status.updatedAt)))
  if (!status.enabled) console.log(`${COLORS.yellow}Chay: ${COMMAND_NAME} sync-password${COLORS.reset}`)
  return status
}

async function generateSyncPassword() {
  const result = await ipc('accountSyncGeneratePassword')
  if (!result?.success || !result.password) {
    throw new Error(result?.error || 'Tao mat khau dong bo that bai')
  }
  const tunnel = await getTunnelStatus().catch(() => null)
  boxedTitle('Account sync password', 'Dung tren may local de dong bo account len VPS')
  console.log(line('Tunnel URL', `${COLORS.green}${activeDashboardUrl(tunnel)}${COLORS.reset}`))
  console.log(line('Sync password', `${COLORS.yellow}${result.password}${COLORS.reset}`))
  console.log(line('Trang thai', `${COLORS.green}DA BAT${COLORS.reset}`))
  console.log(`${COLORS.yellow}Mat khau chi hien thi lan nay. Neu mat, chay lai lenh nay de tao mat khau moi.${COLORS.reset}`)
  console.log(horizontal())
  return result
}

async function stopServer() {
  const pid = readPid()
  if (!pid || !isPidRunning(pid)) {
    console.log(`${COLORS.yellow}Krouter backend khong chay theo pid file.${COLORS.reset}`)
    return
  }
  process.kill(pid)
  console.log(`${COLORS.green}Da gui lenh tat backend.${COLORS.reset}`)
}

async function waitForEnter(rl) {
  await ask(rl, `\n${COLORS.dim}Nhan Enter de tiep tuc...${COLORS.reset}`, '')
}

async function ask(rl, prompt, fallback = '') {
  try {
    return String(await rl.question(prompt)).trim()
  } catch (error) {
    const message = error?.message || ''
    const code = error?.code || ''
    if (code === 'ERR_USE_AFTER_CLOSE' || /readline was closed/i.test(message)) return fallback
    throw error
  }
}

async function menu() {
  const rl = readline.createInterface({ input, output })
  try {
    while (true) {
      if (process.stdout.isTTY) console.clear()
      await printStatus()
      console.log('')
      console.log(`${COLORS.bold}1.${COLORS.reset} Lay link truy cap`)
      console.log(`${COLORS.bold}2.${COLORS.reset} Bat tunnel public`)
      console.log(`${COLORS.bold}3.${COLORS.reset} Tao lai tunnel public`)
      console.log(`${COLORS.bold}4.${COLORS.reset} Tat tunnel`)
      console.log(`${COLORS.bold}5.${COLORS.reset} Mo dashboard`)
      console.log(`${COLORS.bold}6.${COLORS.reset} Tao mat khau dong bo account`)
      console.log(`${COLORS.bold}0.${COLORS.reset} Thoat`)
      const choice = await ask(rl, '\nChon: ', '0')
      try {
        if (choice === '1') {
          console.log('')
          await printLinks()
          await waitForEnter(rl)
        } else if (choice === '2') {
          await startTunnel()
          await waitForEnter(rl)
        } else if (choice === '3') {
          await restartTunnel()
          await waitForEnter(rl)
        } else if (choice === '4') {
          await stopTunnel()
          await waitForEnter(rl)
        } else if (choice === '5') {
          openBrowser(DASHBOARD_URL)
          await waitForEnter(rl)
        } else if (choice === '6') {
          await generateSyncPassword()
          await waitForEnter(rl)
        } else if (choice === '0' || /^q/i.test(choice)) {
          return
        }
      } catch (error) {
        console.error(error.message || error)
        await waitForEnter(rl)
      }
    }
  } finally {
    rl.close()
  }
}

function usage() {
  console.log('Huong dan:')
  console.log(`  npm install -g @lightharu/krouter`)
  console.log(`  ${COMMAND_NAME}`)
  console.log(`  ${COMMAND_NAME} update`)
  console.log(`  ${COMMAND_NAME} update check`)
  console.log(`  ${COMMAND_NAME} start`)
  console.log(`  ${COMMAND_NAME} setup`)
  console.log(`  ${COMMAND_NAME} status`)
  console.log(`  ${COMMAND_NAME} links`)
  console.log(`  ${COMMAND_NAME} sync-password`)
  console.log(`  ${COMMAND_NAME} sync-password status`)
  console.log(`  ${COMMAND_NAME} tunnel start [local-url]`)
  console.log(`  ${COMMAND_NAME} tunnel restart [local-url]`)
  console.log(`  ${COMMAND_NAME} tunnel stop`)
  console.log(`  ${COMMAND_NAME} stop`)
}

async function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2)
  if (command === 'help' || command === '--help' || command === '-h') {
    usage()
    return
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(packageVersion())
    return
  }
  if (command === 'update' || command === 'upgrade') {
    const flags = new Set([subcommand, ...rest].filter(Boolean))
    return updateKrouterPackage({
      checkOnly: flags.has('check') || flags.has('--check'),
      force: flags.has('--force') || flags.has('force')
    })
  }

  await ensureServer()

  if (command === 'start') {
    await printBasicStart()
    openBrowser(DASHBOARD_URL)
    return
  }
  if (command === 'stop') return stopServer()
  if (command === 'setup') return setupKrouter()

  if (!command || command === 'menu') {
    const session = await request('/api/auth/session').catch(() => null)
    if (session?.setupRequired) await setupKrouter()
    openBrowser(DASHBOARD_URL)
    return menu()
  }

  if (command === 'status') return printStatus()
  if (command === 'links' || command === 'url' || command === 'link') return printLinks()
  if (command === 'sync-password') {
    if (subcommand === 'status') return printSyncPasswordStatus()
    return generateSyncPassword()
  }
  if (command === 'tunnel' && subcommand === 'start') return startTunnel(rest[0])
  if (command === 'tunnel' && subcommand === 'restart') return restartTunnel(rest[0])
  if (command === 'tunnel' && subcommand === 'stop') return stopTunnel()
  if (command === 'tunnel' && (!subcommand || subcommand === 'status')) return printStatus()
  usage()
}

main().catch(error => {
  console.error(error.message || error)
  process.exit(1)
})
