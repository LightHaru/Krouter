// Lightweight hash routing keeps navigation durable in both the web dashboard
// and Electron's file-based renderer without adding a router dependency.

export const PAGE_ROUTES = {
  home: '/',
  accounts: '/accounts/kiro',
  machineId: '/machine-id',
  kiroSettings: '/kiro-settings',
  proxy: '/proxy-api',
  usage: '/usage',
  kproxy: '/k-proxy',
  mitm: '/mitm-proxy',
  proxyPool: '/proxy-pool',
  register: '/register',
  subscription: '/subscription',
  webhooks: '/webhooks',
  diagnose: '/diagnostics',
  configSync: '/config-sync',
  skills: '/skills',
  logs: '/logs',
  docs: '/docs',
  settings: '/settings',
  about: '/about'
} as const

export type RoutablePage = keyof typeof PAGE_ROUTES
export type AccountProviderRoute = 'kiro' | 'bedrock' | 'chatgpt' | 'customApi'

export const ACCOUNT_PROVIDER_ROUTES: Record<AccountProviderRoute, string> = {
  kiro: '/accounts/kiro',
  bedrock: '/accounts/bedrock',
  chatgpt: '/accounts/chatgpt',
  customApi: '/accounts/custom-api'
}

const ROUTE_PAGES = Object.entries(PAGE_ROUTES) as Array<[RoutablePage, string]>
const ROUTE_ACCOUNT_PROVIDERS = Object.entries(ACCOUNT_PROVIDER_ROUTES) as Array<[AccountProviderRoute, string]>

function normalizePath(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0]
  const withLeadingSlash = withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`
  return withLeadingSlash.replace(/\/+$/, '') || '/'
}

export function pageFromLocation(pathname: string, hash = ''): RoutablePage | null {
  const hashPath = hash.replace(/^#/, '')
  if (hashPath) {
    const normalizedHash = normalizePath(hashPath)
    if (normalizedHash === '/accounts' || normalizedHash.startsWith('/accounts/')) return 'accounts'
    const hashMatch = ROUTE_PAGES.find(([, route]) => route === normalizedHash)
    if (hashMatch) return hashMatch[0]
  }

  const normalizedPath = normalizePath(pathname)
  if (normalizedPath === '/accounts' || normalizedPath.startsWith('/accounts/')) return 'accounts'
  const pathMatch = ROUTE_PAGES.find(([, route]) => route === normalizedPath)
  return pathMatch?.[0] || null
}

export function pageToHash(page: RoutablePage): string {
  return `#${PAGE_ROUTES[page]}`
}

export function accountProviderFromLocation(pathname: string, hash = ''): AccountProviderRoute {
  const hashPath = hash.replace(/^#/, '')
  const normalized = hashPath ? normalizePath(hashPath) : normalizePath(pathname)
  if (normalized.startsWith(`${ACCOUNT_PROVIDER_ROUTES.customApi}/`)) return 'customApi'
  return ROUTE_ACCOUNT_PROVIDERS.find(([, route]) => route === normalized)?.[0] || 'kiro'
}

export function accountProviderToHash(provider: AccountProviderRoute): string {
  return `#${ACCOUNT_PROVIDER_ROUTES[provider]}`
}

export function customApiProviderIdFromLocation(pathname: string, hash = ''): string | null {
  const hashPath = hash.replace(/^#/, '')
  const normalized = hashPath ? normalizePath(hashPath) : normalizePath(pathname)
  const prefix = `${ACCOUNT_PROVIDER_ROUTES.customApi}/`
  if (!normalized.startsWith(prefix)) return null
  try {
    return decodeURIComponent(normalized.slice(prefix.length)) || null
  } catch {
    return null
  }
}

export function customApiProviderToHash(providerId: string): string {
  return `#${ACCOUNT_PROVIDER_ROUTES.customApi}/${encodeURIComponent(providerId)}`
}

// Backward-compatible helper retained for existing docs deep links.
export const DOCS_PATH = PAGE_ROUTES.docs
export function pageFromPath(pathname: string): 'docs' | null {
  return pageFromLocation(pathname) === 'docs' ? 'docs' : null
}
