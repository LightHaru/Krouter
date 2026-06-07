import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium, request as playwrightRequest } from 'playwright'

const baseURL = (process.env.E2E_BASE_URL || 'http://127.0.0.1:4010').replace(/\/$/, '')
const adminEmail = process.env.E2E_ADMIN_EMAIL || 'admin@example.com'
const adminPassword = process.env.E2E_ADMIN_PASSWORD || 'admin'
const tingamefiApiUrl = process.env.E2E_TINGAMEFI_API_URL || 'https://temp-email-worker.thienp1301.workers.dev'
const tingamefiAdminPassword = process.env.E2E_TINGAMEFI_ADMIN_PASSWORD || ''
const tingamefiDomain = process.env.E2E_TINGAMEFI_DOMAIN || 'mail.tingamefi.com'
const outputDir = path.resolve(process.env.E2E_OUTPUT_DIR || '.web-data-dev/live-registration-two-flows')
const timeoutMs = Number(process.env.E2E_REGISTRATION_TIMEOUT_MS || 600000)
const requestedFlow = process.env.E2E_FLOW || 'both'

assert.ok(tingamefiAdminPassword, 'E2E_TINGAMEFI_ADMIN_PASSWORD is required')
await fs.mkdir(outputDir, { recursive: true })

const api = await playwrightRequest.newContext({ baseURL, timeout: 120000 })
const login = await api.post('/api/auth/login', { data: { email: adminEmail, password: adminPassword } })
assert.equal(login.ok(), true, `API login failed: ${await login.text()}`)

async function ipc(method, args = []) {
  const response = await api.post('/api/ipc', { data: { method, args } })
  assert.equal(response.ok(), true, `${method} returned HTTP ${response.status()}: ${await response.text()}`)
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

async function accountSnapshot() {
  const data = await ipc('loadAccounts')
  const accounts = Object.values(data?.accounts || {})
  return {
    count: accounts.length,
    accounts,
    emails: accounts.map((account) => account.email).filter(Boolean)
  }
}

async function waitFor(predicate, timeout = timeoutMs, interval = 1000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
  throw new Error(`Timed out after ${timeout}ms`)
}

function newEmails(before, after) {
  const known = new Set(before.emails)
  return after.emails.filter((email) => !known.has(email))
}

async function createContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } })
  await context.addInitScript((config) => {
    localStorage.setItem('kiro-register-config', JSON.stringify(config))
    localStorage.setItem('kiro-register-ratelimit-enabled', '0')
    localStorage.setItem('kiro-register-dailyquota-limit', '0')
  }, {
    mode: 'tingamefi',
    batchCount: 1,
    batchInterval: 0,
    batchAutoImport: true,
    batchRetries: 0,
    batchConcurrency: 1,
    autoFetchProLink: false,
    tingamefiMailApiUrl: tingamefiApiUrl,
    tingamefiMailAdminPassword: tingamefiAdminPassword,
    tingamefiMailDomain: tingamefiDomain
  })
  return context
}

async function openRegistrationPage(context) {
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
  await page.locator('#email').fill(adminEmail)
  await page.locator('#password').fill(adminPassword)
  await page.locator('form button[type="submit"]').click()
  await page.locator('nav').waitFor({ timeout: 15000 })
  await page.locator('nav button').nth(7).click()
  await page.getByText('Đăng ký tài khoản', { exact: true }).waitFor({ timeout: 15000 })
  return { page, pageErrors }
}

async function finishFlow(page, pageErrors, before, flowName) {
  const after = await waitFor(async () => {
    const snapshot = await accountSnapshot()
    return snapshot.count > before.count ? snapshot : null
  })
  const addedEmails = newEmails(before, after)
  await page.screenshot({ path: path.join(outputDir, `${flowName}-success.png`), fullPage: true })
  const mainText = await page.locator('main').innerText()
  assert.doesNotMatch(mainText, /profileArn is required/i)
  assert.doesNotMatch(mainText, /验活成功|邮箱=|订阅=/)
  assert.deepEqual(pageErrors, [])
  return {
    status: 'passed',
    beforeCount: before.count,
    afterCount: after.count,
    addedEmails,
    importedMessageVisible: await page.getByText('Đã nhập tài khoản vào trình quản lý', { exact: true }).isVisible().catch(() => false)
  }
}

async function runSingle(browser) {
  const before = await accountSnapshot()
  console.log(`[single] starting with ${before.count} accounts`)
  const context = await createContext(browser)
  const { page, pageErrors } = await openRegistrationPage(context)
  try {
    const start = page.getByRole('button', { name: 'Bắt đầu đăng ký', exact: true })
    await start.waitFor({ timeout: 15000 })
    assert.equal(await start.isDisabled(), false)
    await start.click()
    const result = await finishFlow(page, pageErrors, before, 'single')
    console.log(`[single] passed: ${result.addedEmails.join(', ')}`)
    return result
  } catch (error) {
    await page.screenshot({ path: path.join(outputDir, 'single-failure.png'), fullPage: true }).catch(() => undefined)
    return {
      status: 'failed',
      beforeCount: before.count,
      afterCount: (await accountSnapshot()).count,
      error: error instanceof Error ? error.message : String(error),
      mainText: (await page.locator('main').innerText().catch(() => '')).slice(-8000)
    }
  } finally {
    await context.close()
  }
}

async function runBatch(browser) {
  const before = await accountSnapshot()
  console.log(`[batch] starting with ${before.count} accounts`)
  const context = await createContext(browser)
  const { page, pageErrors } = await openRegistrationPage(context)
  try {
    await page.getByText('Đăng ký hàng loạt', { exact: true }).waitFor({ timeout: 15000 })
    const setNumber = async (label, value) => {
      const input = page.getByText(label, { exact: true }).locator('..').locator('input')
      await input.fill(String(value))
    }
    await setNumber('Số lượng', 1)
    await setNumber('Khoảng cách (giây)', 0)
    await setNumber('Số lần thử lại', 0)
    await setNumber('Số luồng', 1)
    const autoImport = page.getByText('Tự nhập', { exact: true }).locator('..').locator('..').locator('button[role="switch"]')
    if ((await autoImport.getAttribute('data-state')) !== 'checked') await autoImport.click()
    const start = page.getByRole('button', { name: 'Bắt đầu hàng loạt', exact: true })
    assert.equal(await start.isDisabled(), false)
    await start.click()
    await page.getByText('Tiến độ: 1/1', { exact: true }).waitFor({ timeout: timeoutMs })
    const result = await finishFlow(page, pageErrors, before, 'batch')
    console.log(`[batch] passed: ${result.addedEmails.join(', ')}`)
    return result
  } catch (error) {
    await page.screenshot({ path: path.join(outputDir, 'batch-failure.png'), fullPage: true }).catch(() => undefined)
    return {
      status: 'failed',
      beforeCount: before.count,
      afterCount: (await accountSnapshot()).count,
      error: error instanceof Error ? error.message : String(error),
      mainText: (await page.locator('main').innerText().catch(() => '')).slice(-8000)
    }
  } finally {
    await context.close()
  }
}

const browser = await chromium.launch({ headless: true })
const startedAt = new Date().toISOString()
let single
let batch
try {
  single = requestedFlow === 'batch' ? { status: 'not-run' } : await runSingle(browser)
  batch = requestedFlow === 'single' ? { status: 'not-run' } : await runBatch(browser)
} finally {
  await browser.close()
  await api.dispose()
}

const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  baseURL,
  single,
  batch
}
await fs.writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
if (
  (requestedFlow !== 'batch' && single.status !== 'passed') ||
  (requestedFlow !== 'single' && batch.status !== 'passed')
) {
  process.exitCode = 1
}
