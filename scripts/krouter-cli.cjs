#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const readline = require('readline/promises')
const { stdin: input, stdout: output } = require('process')

const API_BASE = (process.env.KROUTER_API_BASE || process.env.KAM_API_BASE || `http://127.0.0.1:${process.env.PORT || '4010'}`).replace(/\/$/, '')
const DASHBOARD_URL = (
  process.env.KROUTER_DASHBOARD_URL ||
  process.env.KAM_DASHBOARD_URL ||
  process.env.PUBLIC_DASHBOARD_URL ||
  process.env.DASHBOARD_URL ||
  API_BASE
).replace(/\/$/, '')
const COMMAND_NAME = path.basename(process.argv[1] || 'krouter')
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

function readEnvFile() {
  const candidates = [
    process.env.KROUTER_ENV_FILE,
    process.env.KAM_ENV_FILE,
    path.join(process.cwd(), 'shared', '.env.web'),
    path.join(process.cwd(), '..', 'shared', '.env.web'),
    path.join(process.cwd(), '..', '..', 'shared', '.env.web'),
    path.join(process.cwd(), '.env.web'),
    path.join(process.cwd(), '.env')
  ].filter(Boolean)

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const env = {}
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const index = trimmed.indexOf('=')
      env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
    }
    return env
  }
  return {}
}

async function request(pathname, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(cookie ? { Cookie: cookie } : {}),
    ...(options.headers || {})
  }
  const response = await fetch(`${API_BASE}${pathname}`, { ...options, headers })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  const text = await response.text()
  const data = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(data?.error || data?.message || response.statusText)
  }
  return data
}

async function login() {
  const fileEnv = readEnvFile()
  const session = await request('/api/auth/session').catch(() => null)
  if (session?.setupRequired) {
    throw new Error(`Krouter chua duoc setup. Chay: ${COMMAND_NAME} setup`)
  }
  const email = process.env.KROUTER_ADMIN_EMAIL || process.env.KAM_ADMIN_EMAIL || process.env.ADMIN_EMAIL || fileEnv.KROUTER_ADMIN_EMAIL || fileEnv.KAM_ADMIN_EMAIL || fileEnv.ADMIN_EMAIL || 'admin@krouter.local'
  const password = process.env.KROUTER_ADMIN_PASSWORD || process.env.KAM_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || fileEnv.KROUTER_ADMIN_PASSWORD || fileEnv.KAM_ADMIN_PASSWORD || fileEnv.ADMIN_PASSWORD
  if (!password) {
    throw new Error('Thieu mat khau admin. Dat KROUTER_ADMIN_PASSWORD hoac dang nhap bang dashboard web.')
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

function line(label, value) {
  const padded = `${label}:`.padEnd(16, ' ')
  return `  ${COLORS.dim}${padded}${COLORS.reset}${value || '-'}`
}

function horizontal(width = 62) {
  return '+'.padEnd(width - 1, '-') + '+'
}

function boxedTitle(title, subtitle) {
  const width = 62
  console.log(horizontal(width))
  console.log(`| ${COLORS.bold}${title}${COLORS.reset}`.padEnd(width - 1, ' ') + '|')
  console.log(`| ${COLORS.dim}${subtitle}${COLORS.reset}`.padEnd(width - 1, ' ') + '|')
  console.log(horizontal(width))
}

async function getTunnelStatus() {
  return ipc('dashboardTunnelGetStatus')
}

async function getHealth() {
  try {
    return await request('/healthz')
  } catch {
    return null
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

async function printStatus() {
  const [health, tunnel] = await Promise.all([getHealth(), getTunnelStatus()])
  boxedTitle('Krouter', 'Dashboard web va tunnel')
  console.log(line('Backend', `${API_BASE}${health ? ` (${health.mode || 'ok'})` : ''}`))
  console.log(line('Web local', `${COLORS.cyan}${DASHBOARD_URL}${COLORS.reset}`))
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
  console.log(`  ${COMMAND_NAME}`)
  console.log(`  ${COMMAND_NAME} setup`)
  console.log(`  ${COMMAND_NAME} status`)
  console.log(`  ${COMMAND_NAME} links`)
  console.log(`  ${COMMAND_NAME} tunnel start [local-url]`)
  console.log(`  ${COMMAND_NAME} tunnel restart [local-url]`)
  console.log(`  ${COMMAND_NAME} tunnel stop`)
}

async function main() {
  const [command, subcommand, ...rest] = process.argv.slice(2)
  if (command === 'setup') return setupKrouter()
  await login()
  if (!command || command === 'menu') return menu()
  if (command === 'status') return printStatus()
  if (command === 'links' || command === 'url' || command === 'link') return printLinks()
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
