import { useState, useEffect, useMemo } from 'react'
import { useAccountsStore } from '@/store/accounts'
import { useTranslation } from '@/hooks/useTranslation'
import { AccountToolbar, type AccountViewMode } from './AccountToolbar'
import { AccountGrid } from './AccountGrid'
import { AccountList } from './AccountList'
import { AddAccountDialog } from './AddAccountDialog'
import { BedrockAccountsPanel } from './BedrockAccountsPanel'
import { CustomApiAccountsPanel } from './CustomApiAccountsPanel'
import { ChatGPTOAuthPanel } from '../proxy/ChatGPTOAuthPanel'
import { EditAccountDialog } from './EditAccountDialog'
import { GroupManageDialog } from './GroupManageDialog'
import { TagManageDialog } from './TagManageDialog'
import { ExportDialog } from './ExportDialog'
import { Badge, Button } from '../ui'
import { useIsMobile } from '@/hooks/useIsMobile'
import type { Account } from '@/types/account'
import type { AccountProviderRoute } from '@/lib/docsRoute'
import { splitCredentialLine } from '@/lib/utils'
import { ArrowLeft, Loader2, Users, Cloud, Bot, Key, SlidersHorizontal, ChevronUp } from 'lucide-react'

interface AccountManagerProps {
  onBack?: () => void
  provider?: AccountProviderRoute
  onProviderChange?: (provider: AccountProviderRoute) => void
  customApiProviderId?: string | null
  onCustomApiProviderChange?: (providerId: string | null) => void
}

export function AccountManager({
  onBack,
  provider = 'kiro',
  onProviderChange,
  customApiProviderId = null,
  onCustomApiProviderChange
}: AccountManagerProps): React.ReactNode {
  const {
    isLoading,
    accounts,
    importFromExportData,
    importAccounts,
    selectedIds,
    activeGroupTab,
    groups
  } = useAccountsStore()

  const [showAddDialog, setShowAddDialog] = useState(false)
  const [localProvider, setLocalProvider] = useState<AccountProviderRoute>(provider)
  useEffect(() => setLocalProvider(provider), [provider])
  const accountTab = onProviderChange ? provider : localProvider
  const selectAccountTab = (nextProvider: AccountProviderRoute): void => {
    if (onProviderChange) onProviderChange(nextProvider)
    else setLocalProvider(nextProvider)
  }
  const [addDialogMode, setAddDialogMode] = useState<'login' | 'bedrock' | 'customApi' | undefined>(undefined)
  const [bedrockRefreshKey, setBedrockRefreshKey] = useState(0)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  const [showGroupDialog, setShowGroupDialog] = useState(false)
  const [showTagDialog, setShowTagDialog] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [isFilterExpanded, setIsFilterExpanded] = useState(false)
  const isMobile = useIsMobile()
  // Trên mobile header chiếm gần nửa màn hình -> cho phép thu gọn thanh công cụ,
  // mặc định gập lại để nhường chỗ cho danh sách tài khoản.
  const [toolbarOpen, setToolbarOpen] = useState(false)
  // 视图模式：grid（卡片，默认）/ list（紧凑列表），持久化到 localStorage
  const [viewMode, setViewMode] = useState<AccountViewMode>(() => {
    const saved = localStorage.getItem('accounts_viewMode')
    return saved === 'list' ? 'list' : 'grid'
  })
  useEffect(() => {
    localStorage.setItem('accounts_viewMode', viewMode)
  }, [viewMode])
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  const kiroSummary = useMemo(() => {
    const list = Array.from(accounts.values())
    return {
      total: list.length,
      active: list.filter((account) => account.status === 'active').length,
      attention: list.filter((account) => account.status !== 'active').length,
      groups: groups.size
    }
  }, [accounts, groups])

  // 获取要导出的账号列表
  const getExportAccounts = () => {
    const accountList = Array.from(accounts.values())
    if (selectedIds.size > 0) {
      return accountList.filter(acc => selectedIds.has(acc.id))
    }
    return accountList
  }

  // 导出
  const handleExport = (): void => {
    setShowExportDialog(true)
  }

  // 解析 CSV 行（处理引号和逗号）
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i]
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim())
        current = ''
      } else {
        current += char
      }
    }
    result.push(current.trim())
    return result
  }

  // 导入
  const handleImport = async (): Promise<void> => {
    // 文件导入归入"当前打开的分组"（activeGroupTab 为真实分组时），否则未分组
    const currentGroupId = (activeGroupTab !== 'all' && activeGroupTab !== 'ungrouped' && groups.has(activeGroupTab)) ? activeGroupTab : undefined
    const groupName = currentGroupId ? (groups.get(currentGroupId)?.name ?? '未分组') : '未分组'
    const fileData = await window.api.importFromFile()

    if (!fileData) return

    const { content, format } = fileData

    try {
      if (format === 'json') {
        // JSON 格式：完整导出数据
        const data = JSON.parse(content)
        if (data.version && data.accounts) {
          const result = importFromExportData(data)
          const skippedInfo = result.errors.find(e => e.id === 'skipped')
          const skippedMsg = skippedInfo ? `，${skippedInfo.error}` : ''
          alert(`导入完成：成功 ${result.success} 个${skippedMsg}`)
        } else {
          alert('无效的 JSON 文件格式')
        }
      } else if (format === 'csv') {
        // CSV 格式：邮箱,昵称,登录方式,RefreshToken,ClientId,ClientSecret,Region
        const lines = content.split('\n').filter(line => line.trim())
        if (lines.length < 2) {
          alert('CSV 文件为空或只有标题行')
          return
        }

        // 跳过标题行，解析数据行
        const items = lines.slice(1).map(line => {
          const cols = parseCSVLine(line)
          return {
            email: cols[0] || '',
            nickname: cols[1] || undefined,
            idp: cols[2] || 'Google',
            refreshToken: cols[3] || '',
            clientId: cols[4] || '',
            clientSecret: cols[5] || '',
            region: cols[6] || 'us-east-1',
            groupId: currentGroupId
          }
        }).filter(item => item.email && item.refreshToken)

        if (items.length === 0) {
          alert('未找到有效的账号数据（需要邮箱和 RefreshToken）')
          return
        }

        const result = importAccounts(items)
        alert(`导入完成：成功 ${result.success} 个，失败 ${result.failed} 个（分组：${groupName}）`)
      } else if (format === 'txt') {
        // TXT 格式：自动识别卡密格式或普通格式
        const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('#'))

        // 检测是否为卡密格式（包含 ---- 分隔符）
        const isKamiFormat = lines.some(line => line.includes('----'))

        if (isKamiFormat) {
          // 卡密格式：邮箱----密码----RefreshToken----ClientId----ClientSecret
          // 自动识别分隔符：----、\t、连续空格
          const items = lines.map(line => {
            const parts = splitCredentialLine(line)
            const rawPwd = parts[1]?.trim()
            const clientId = parts[3]?.trim() || undefined
            const clientSecret = parts[4]?.trim() || undefined
            // 第6字段为登录方式(idp)：新卡密直接带；旧卡密无此字段时按 ClientId/Secret 推断
            // social(Github/Google) 只有 refreshToken，IdC(BuilderId) 才有 ClientId/Secret
            const rawIdp = parts[5]?.trim()
            const idp = rawIdp || ((!clientId && !clientSecret) ? 'Google' : 'BuilderId')
            return {
              email: parts[0]?.trim() || '',
              password: (rawPwd && rawPwd !== 'no_password') ? rawPwd : undefined,
              refreshToken: parts[2]?.trim() || '',
              clientId,
              clientSecret,
              idp,
              groupId: currentGroupId
            }
          }).filter(item => item.email && item.refreshToken)

          if (items.length === 0) {
            alert('未找到有效的卡密数据（格式：邮箱----密码----RefreshToken----ClientId----ClientSecret）')
            return
          }

          const result = importAccounts(items)
          alert(`卡密导入完成：成功 ${result.success} 个，失败 ${result.failed} 个（分组：${groupName}）`)
        } else {
          // 普通 TXT 格式：邮箱,RefreshToken 或 邮箱|RefreshToken
          const items = lines.map(line => {
            const parts = line.includes('|') ? line.split('|') : line.split(',')
            return {
              email: parts[0]?.trim() || '',
              refreshToken: parts[1]?.trim() || '',
              nickname: parts[2]?.trim() || undefined,
              idp: parts[3]?.trim() || 'Google',
              groupId: currentGroupId
            }
          }).filter(item => item.email && item.refreshToken)

          if (items.length === 0) {
            alert('未找到有效的账号数据（格式：邮箱,RefreshToken 或 卡密格式：邮箱----密码----Token----ID----Secret）')
            return
          }

          const result = importAccounts(items)
          alert(`导入完成：成功 ${result.success} 个，失败 ${result.failed} 个（分组：${groupName}）`)
        }
      } else {
        alert(`不支持的文件格式：${format}`)
      }
    } catch (e) {
      console.error('Import error:', e)
      alert('解析导入文件失败')
    }
  }

  // 管理分组
  const handleManageGroups = (): void => {
    setShowGroupDialog(true)
  }

  // 管理标签
  const handleManageTags = (): void => {
    setShowTagDialog(true)
  }

  // 编辑账号
  const handleEditAccount = (account: Account): void => {
    setEditingAccount(account)
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">加载账号数据...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 顶部工具栏 - 玻璃态（relative z-20 抬升 stacking context，确保下拉菜单浮在卡片之上） */}
      <header className="accounts-workspace-head relative z-20 flex flex-wrap items-center justify-between gap-3 px-3 py-3">
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          {onBack && (
            <Button variant="ghost" size="icon" onClick={onBack}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Users className="h-5 w-5 text-primary" />
            </div>
            <h1 className="text-lg font-semibold text-primary">{isEn ? 'Accounts' : '账户管理'}</h1>
          </div>
          {/* Nút gập/mở thanh công cụ — chỉ hiện trên mobile để lấy lại tầm nhìn */}
          {isMobile && (
            <Button
              variant={toolbarOpen ? 'default' : 'outline'}
              size="sm"
              className="rounded-xl ml-auto"
              onClick={() => setToolbarOpen((v) => !v)}
              title={toolbarOpen ? (isEn ? 'Collapse toolbar' : 'Thu gọn công cụ') : (isEn ? 'Show toolbar' : 'Hiện công cụ')}
            >
              {toolbarOpen ? <ChevronUp className="h-4 w-4" /> : <SlidersHorizontal className="h-4 w-4" />}
            </Button>
          )}
          <div className="provider-switcher flex max-w-full items-center gap-1 overflow-x-auto p-1 rounded-xl bg-muted/50 border">
            <button
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all font-medium ${accountTab === 'kiro' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => selectAccountTab('kiro')}
              aria-current={accountTab === 'kiro' ? 'page' : undefined}
            >
              <Users className="h-4 w-4" />
              {isEn ? 'Kiro' : 'Kiro'}
            </button>
            <button
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all font-medium ${accountTab === 'bedrock' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => selectAccountTab('bedrock')}
              aria-current={accountTab === 'bedrock' ? 'page' : undefined}
            >
              <Cloud className="h-4 w-4" />
              Bedrock
            </button>
            <button
              className={`flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all font-medium ${accountTab === 'chatgpt' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => selectAccountTab('chatgpt')}
              aria-current={accountTab === 'chatgpt' ? 'page' : undefined}
            >
              <Bot className="h-4 w-4" />
              ChatGPT
            </button>
            <button
              className={`flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-all font-medium ${accountTab === 'customApi' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => selectAccountTab('customApi')}
              aria-current={accountTab === 'customApi' ? 'page' : undefined}
            >
              <Key className="h-4 w-4" />
              Custom API
            </button>
          </div>
        </div>
        
        {/* 工具栏 — mobile 折叠时隐藏，桌面端始终显示 */}
        {(!isMobile || toolbarOpen) && (
          <div className="w-full sm:w-auto">
            {accountTab === 'kiro' && (
              <AccountToolbar
                onAddAccount={() => { setAddDialogMode(undefined); setShowAddDialog(true) }}
                onImport={handleImport}
                onExport={handleExport}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                onManageGroups={handleManageGroups}
                onManageTags={handleManageTags}
                isFilterExpanded={isFilterExpanded}
                onToggleFilter={() => setIsFilterExpanded(!isFilterExpanded)}
              />
            )}
            {accountTab === 'bedrock' && (
              <Button onClick={() => { setAddDialogMode('bedrock'); setShowAddDialog(true) }} className="rounded-xl">
                {isEn ? 'Add Bedrock' : 'Thêm Bedrock'}
              </Button>
            )}
            {accountTab === 'customApi' && (
              <Button onClick={() => { setAddDialogMode('customApi'); setShowAddDialog(true) }} className="rounded-xl">
                {isEn ? 'Add Custom API' : 'Thêm Custom API'}
              </Button>
            )}
          </div>
        )}
      </header>

      {/* 主内容区域 */}
      <div className="flex-1 overflow-hidden flex flex-col px-3 py-3 gap-3">
        {accountTab === 'kiro' && (
          <div className="kiro-provider-summary">
            <div className="provider-identity"><div className="provider-brand"><Users /></div><div><div className="provider-title-line"><h2>Kiro</h2><Badge variant="success">{kiroSummary.active} {isEn ? 'active' : 'dang hoat dong'}</Badge></div><p>{isEn ? 'Managed account pool with quota-aware rotation and failover.' : 'Pool tai khoan co xoay vong theo quota va failover.'}</p></div></div>
            <div className="kiro-summary-signals"><div><small>{isEn ? 'TOTAL' : 'TONG'}</small><strong>{kiroSummary.total}</strong></div><div><small>{isEn ? 'HEALTHY' : 'ON DINH'}</small><strong>{kiroSummary.active}</strong></div><div><small>{isEn ? 'ATTENTION' : 'CAN CHU Y'}</small><strong>{kiroSummary.attention}</strong></div><div><small>{isEn ? 'GROUPS' : 'NHOM'}</small><strong>{kiroSummary.groups}</strong></div></div>
          </div>
        )}
        <div className="flex-1 overflow-hidden">
          {accountTab === 'chatgpt' ? (
            <div className="h-full overflow-auto pr-1">
              <ChatGPTOAuthPanel isEn={isEn} variant="accounts" />
            </div>
          ) : accountTab === 'bedrock' ? (
            <BedrockAccountsPanel key={bedrockRefreshKey} isEn={isEn} onAddBedrock={() => { setAddDialogMode('bedrock'); setShowAddDialog(true) }} />
          ) : accountTab === 'customApi' ? (
            <CustomApiAccountsPanel
              key={bedrockRefreshKey}
              isEn={isEn}
              selectedProviderId={customApiProviderId}
              onOpenProvider={(providerId) => onCustomApiProviderChange?.(providerId)}
              onBackToProviders={() => onCustomApiProviderChange?.(null)}
              onAddProvider={() => { setAddDialogMode('customApi'); setShowAddDialog(true) }}
            />
          ) : viewMode === 'grid' ? (
            <AccountGrid
              onAddAccount={() => { setAddDialogMode(undefined); setShowAddDialog(true) }}
              onEditAccount={handleEditAccount}
            />
          ) : (
            <AccountList
              onAddAccount={() => { setAddDialogMode(undefined); setShowAddDialog(true) }}
              onEditAccount={handleEditAccount}
            />
          )}
        </div>
      </div>

      {/* 添加账号对话框 */}
      <AddAccountDialog
        isOpen={showAddDialog}
        onClose={() => { setShowAddDialog(false); setBedrockRefreshKey(k => k + 1) }}
        defaultMode={addDialogMode}
      />

      {/* 编辑账号对话框 */}
      <EditAccountDialog
        open={!!editingAccount}
        onOpenChange={(open) => !open && setEditingAccount(null)}
        account={editingAccount}
      />

      {/* 分组管理对话框 */}
      <GroupManageDialog
        isOpen={showGroupDialog}
        onClose={() => setShowGroupDialog(false)}
      />

      {/* 标签管理对话框 */}
      <TagManageDialog
        isOpen={showTagDialog}
        onClose={() => setShowTagDialog(false)}
      />

      {/* 导出对话框 */}
      <ExportDialog
        open={showExportDialog}
        onClose={() => setShowExportDialog(false)}
        accounts={getExportAccounts()}
        selectedCount={selectedIds.size}
      />
    </div>
  )
}
