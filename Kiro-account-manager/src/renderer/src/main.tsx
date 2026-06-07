import './styles/globals.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installBrowserApi } from './api/browserApi'
import { AuthGate } from './components/AuthGate'
import { installVietnameseUi } from './i18n/vietnameseUi'

installBrowserApi()
installVietnameseUi()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>
)
