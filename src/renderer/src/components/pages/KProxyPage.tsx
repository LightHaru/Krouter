import { KProxyPanel } from '../kproxy'
import { useTranslation } from '@/hooks/useTranslation'
import { Shield } from 'lucide-react'

export function KProxyPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      <div className="page-hero p-6">
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-primary shadow-lg shadow-primary/25">
            <Shield className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-primary">K-Proxy MITM</h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'Local MITM proxy for Kiro request device ID replacement and request auditing.'
                : 'Proxy MITM cuc bo de thay device ID trong request Kiro va theo doi request.'}
            </p>
          </div>
        </div>
      </div>
      <KProxyPanel />
    </div>
  )
}
