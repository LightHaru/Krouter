// Bản đồ ảnh chụp thật cho trang Docs.
//
// Ảnh được chụp bằng scripts/capture-docs-screenshots.mjs (Playwright) từ
// dashboard thật và lưu trong src/renderer/src/assets/docs/. Vite sẽ hash +
// bundle các ảnh này vào dist-web để hiển thị được cả local lẫn tunnel.
//
// Mỗi key tương ứng với trường `image` của một bước trong DocsPage.
// Chạy lại script chụp ảnh để cập nhật khi giao diện thay đổi.

import setupLogin from '@/assets/docs/setup-login.png'
import setupPassword from '@/assets/docs/setup-password.png'
import accountsList from '@/assets/docs/accounts-list.png'
import accountsAdd from '@/assets/docs/accounts-add.png'
import proxyPanel from '@/assets/docs/proxy-panel.png'
import proxyApikey from '@/assets/docs/proxy-apikey.png'
import openclawConfig from '@/assets/docs/openclaw-config.png'
import tunnelCli from '@/assets/docs/tunnel-cli.png'

export const docsImages: Record<string, string> = {
  'setup-login': setupLogin,
  'setup-password': setupPassword,
  'accounts-list': accountsList,
  'accounts-add': accountsAdd,
  'proxy-panel': proxyPanel,
  'proxy-apikey': proxyApikey,
  'openclaw-config': openclawConfig,
  'tunnel-cli': tunnelCli
}
