import { useState, useEffect } from 'react'
import { AlertTriangle, CheckCircle, Cloud, Loader2, RefreshCw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, Button, Badge } from '../ui'

interface BedrockStatus {
  configured: boolean
  error?: string
  lastChecked?: number
}

interface TestResult {
  success: boolean
  region?: string
  models?: { modelId: string; providerName?: string }[]
  error?: string
}

export function BedrockPanel({ isEn }: { isEn: boolean }) {
  const [status, setStatus] = useState<BedrockStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  useEffect(() => {
    loadStatus()
  }, [])

  async function loadStatus() {
    try {
      const res = await (window as any).api?.proxyGetBedrockStatus?.()
      if (res) setStatus(res)
    } catch { /* ignore */ }
  }

  async function testCredentials() {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await (window as any).api?.proxyTestBedrock?.({})
      setTestResult(res)
      if (res?.success) {
        setStatus({ configured: true })
      }
      await loadStatus()
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  if (!status?.configured) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Cloud className="h-4 w-4" />
          {isEn ? 'AWS Bedrock Integration' : 'AWS Bedrock'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-destructive">
                {isEn ? 'Bedrock Error' : 'Lỗi Bedrock'}
              </p>
              <p className="text-xs text-destructive/80 mt-1 break-words">{status.error}</p>
              {status.lastChecked && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  {isEn ? 'Last checked: ' : 'Kiểm tra lần cuối: '}
                  {new Date(status.lastChecked).toLocaleString()}
                </p>
              )}
            </div>
          </div>
        )}

        {!status.error && (
          <div className="flex items-center gap-2 text-xs text-green-600">
            <CheckCircle className="h-3.5 w-3.5" />
            <span>{isEn ? 'Bedrock connected' : 'Bedrock đã kết nối'}</span>
          </div>
        )}

        {testResult && (
          <div className={`p-3 rounded-lg border text-xs ${testResult.success ? 'bg-green-50 border-green-200 dark:bg-green-950/20 dark:border-green-800' : 'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800'}`}>
            {testResult.success ? (
              <div>
                <p className="font-medium text-green-700 dark:text-green-400">
                  {isEn ? 'Connection successful' : 'Kết nối thành công'}
                </p>
                <p className="text-green-600 dark:text-green-500 mt-1">
                  {isEn ? `Region: ${testResult.region} | ${testResult.models?.length || 0} models available` : `Region: ${testResult.region} | ${testResult.models?.length || 0} models`}
                </p>
                {testResult.models && testResult.models.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {testResult.models.slice(0, 8).map(m => (
                      <Badge key={m.modelId} variant="secondary" className="text-[9px]">
                        {m.modelId.split('/').pop() || m.modelId}
                      </Badge>
                    ))}
                    {testResult.models.length > 8 && (
                      <Badge variant="outline" className="text-[9px]">
                        +{testResult.models.length - 8}
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div>
                <p className="font-medium text-red-700 dark:text-red-400">
                  {isEn ? 'Connection failed' : 'Kết nối thất bại'}
                </p>
                <p className="text-red-600 dark:text-red-500 mt-1">{testResult.error}</p>
              </div>
            )}
          </div>
        )}

        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={testCredentials}
          disabled={testing}
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5 mr-2" />
          )}
          {isEn ? 'Test Credentials' : 'Kiểm tra Credentials'}
        </Button>
      </CardContent>
    </Card>
  )
}
