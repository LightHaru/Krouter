import { useEffect, useState } from 'react'

/**
 * True khi viewport hẹp hơn hoặc bằng breakpoint (mặc định 768px = Tailwind `md`).
 * Bọc matchMedia + dọn listener khi unmount. Dùng để chuyển shell sang chế độ mobile
 * (sidebar drawer + hamburger) và các quyết định layout theo bề rộng.
 */
export function useIsMobile(maxWidthPx = 768): boolean {
  const query = `(max-width: ${maxWidthPx}px)`
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const update = (): void => setIsMobile(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [query])

  return isMobile
}
