/**
 * Kho link đăng ký ở mức module: giữ nguyên dữ liệu sau khi SubscriptionPage unmount
 * (trong cùng một phiên) và cho phép RegisterPage ghi vào từ luồng đăng ký hàng loạt.
 *
 * Tách khỏi SubscriptionPage.tsx vì file component chỉ nên export component — export lẫn
 * hàm tiện ích làm hỏng Fast Refresh (react-refresh/only-export-components).
 */

export interface SubscriptionLink {
  accountId: string
  email: string
  status: 'pending' | 'loading' | 'success' | 'error' | 'expired'
  url?: string
  error?: string
  /** 链接生成时间（用于估算有效期） */
  generatedAt?: number
  /** 链接是否经过本地有效性探测且通过 */
  validated?: boolean
}

let links: SubscriptionLink[] = []
let notify: ((links: SubscriptionLink[]) => void) | null = null

export function getSubscriptionLinks(): SubscriptionLink[] {
  return links
}

export function setSubscriptionLinks(next: SubscriptionLink[]): void {
  links = next
}

/** Đăng ký callback để hai hàm ghi bên dưới đồng bộ được vào React state đang hiển thị. */
export function setSubscriptionLinksNotifier(fn: ((links: SubscriptionLink[]) => void) | null): void {
  notify = fn
}

export function appendSubscriptionLink(link: SubscriptionLink): void {
  links = [...links, link]
  notify?.(links)
}

export function updateSubscriptionLink(accountId: string, update: Partial<SubscriptionLink>): void {
  links = links.map((l) => (l.accountId === accountId ? { ...l, ...update } : l))
  notify?.(links)
}
