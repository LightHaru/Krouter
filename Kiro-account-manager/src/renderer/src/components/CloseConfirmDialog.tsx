import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Minimize2, LogOut, XCircle, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '../hooks/useTranslation'

export function CloseConfirmDialog() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const [open, setOpen] = useState(false)
  const [rememberChoice, setRememberChoice] = useState(false)

  useEffect(() => {
    const unsubscribe = window.api.onShowCloseConfirmDialog(() => {
      setOpen(true)
      setRememberChoice(false)
    })
    return () => unsubscribe()
  }, [])

  const handleAction = (action: 'minimize' | 'quit' | 'cancel') => {
    window.api.sendCloseConfirmResponse(action, rememberChoice)
    setOpen(false)
  }

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => handleAction('cancel')} />
      
      <div className="relative glass-card-strong rounded-2xl shadow-2xl w-full max-w-md m-4 animate-in zoom-in-95 duration-200 overflow-hidden">
        {/* 头部 */}
        <div className="bg-gradient-to-r from-primary/10 to-[var(--gradient-to)]/10 p-6 border-b">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center">
                <XCircle className="h-6 w-6 text-primary" />
              </div>
              <div>
                <h2 className="text-lg font-bold">{isEn ? 'Close Window' : 'Đóng cửa sổ'}</h2>
                <p className="text-sm text-muted-foreground">{isEn ? 'Choose an action' : 'Chọn thao tác'}</p>
              </div>
            </div>
            <button
              onClick={() => handleAction('cancel')}
              className="p-2 hover:bg-muted rounded-lg transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            {isEn ? 'Would you like to minimize to system tray or exit the application?' : 'Anh muốn thu nhỏ xuống khay hệ thống hay thoát hẳn ứng dụng?'}
          </p>
          
          <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">
            {isEn ? 'When minimized to tray, the app will continue running in the background and the proxy service will remain available. You can reopen the window by clicking the tray icon.' : 'Khi thu nhỏ xuống khay, ứng dụng vẫn chạy nền và dịch vụ proxy vẫn hoạt động. Có thể mở lại bằng cách bấm biểu tượng ở khay hệ thống.'}
          </p>

          {/* 操作按钮 */}
          <div className="space-y-2">
            <Button 
              variant="outline" 
              className="w-full justify-start gap-3 h-12"
              onClick={() => handleAction('minimize')}
            >
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <Minimize2 className="h-4 w-4 text-blue-500" />
              </div>
              <div className="text-left">
                <div className="font-medium">{isEn ? 'Minimize to Tray' : 'Thu nhỏ xuống khay'}</div>
                <div className="text-xs text-muted-foreground">{isEn ? 'Continue running in background' : 'Tiếp tục chạy nền'}</div>
              </div>
            </Button>
            
            <Button 
              variant="outline" 
              className="w-full justify-start gap-3 h-12"
              onClick={() => handleAction('quit')}
            >
              <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
                <LogOut className="h-4 w-4 text-red-500" />
              </div>
              <div className="text-left">
                <div className="font-medium">{isEn ? 'Exit Application' : 'Thoát ứng dụng'}</div>
                <div className="text-xs text-muted-foreground">{isEn ? 'Close the app completely' : 'Đóng hoàn toàn ứng dụng'}</div>
              </div>
            </Button>
          </div>

          {/* 记住选择 */}
          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={() => setRememberChoice(!rememberChoice)}
              className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                rememberChoice 
                  ? 'bg-primary border-primary' 
                  : 'border-muted-foreground/50 hover:border-primary'
              }`}
            >
              {rememberChoice && <Check className="h-3 w-3 text-primary-foreground" />}
            </button>
            <button
              type="button"
              onClick={() => setRememberChoice(!rememberChoice)}
              className="text-sm text-muted-foreground cursor-pointer select-none"
            >
              {isEn ? 'Remember my choice' : 'Ghi nhớ lựa chọn'}
            </button>
          </div>

          {/* 取消按钮 */}
          <Button 
            variant="ghost" 
            className="w-full"
            onClick={() => handleAction('cancel')}
          >
            {isEn ? 'Cancel' : 'Hủy'}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}


