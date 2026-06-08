// Deep-link helper for the Docs page.
//
// The dashboard navigates by in-memory state (PageType) rather than a router.
// To support a shareable /docs URL, the app reads window.location.pathname on
// load and on popstate, mapping it to a page via this pure helper.
//
// Pure + idempotent: returns 'docs' iff the path (trailing slash ignored) is
// exactly '/docs', otherwise null. No side effects.

export const DOCS_PATH = '/docs'

export function pageFromPath(pathname: string): 'docs' | null {
  if (typeof pathname !== 'string') return null
  const normalized = pathname.replace(/\/+$/, '') || '/'
  return normalized === DOCS_PATH ? 'docs' : null
}
