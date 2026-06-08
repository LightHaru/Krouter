import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Check, KeyRound, Loader2, Lock, Shuffle } from 'lucide-react'
import { getSession, login, setupAdmin, type AuthUser } from '@/api/authClient'
import krouterMark from '@/assets/krouter-mark.svg'
import { APP_NAME } from '@/brand'
import { cn } from '@/lib/utils'

interface AuthGateProps {
  children: React.ReactNode
}

type SetupMode = 'random' | 'custom'

export function AuthGate({ children }: AuthGateProps): React.ReactNode {
  const [loading, setLoading] = useState(true)
  const [setupRequired, setSetupRequired] = useState(false)
  const [user, setUser] = useState<AuthUser | null>(null)
  const [password, setPassword] = useState('')
  const [setupPassword, setSetupPassword] = useState('')
  const [setupPasswordConfirm, setSetupPasswordConfirm] = useState('')
  const [setupMode, setSetupMode] = useState<SetupMode>('random')
  const [generatedPassword, setGeneratedPassword] = useState('')
  const [pendingUser, setPendingUser] = useState<AuthUser | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const refreshSession = useCallback(async (): Promise<void> => {
    const session = await getSession()
    setSetupRequired(Boolean(session.setupRequired))
    setUser(session.user || null)
  }, [])

  useEffect(() => {
    refreshSession()
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [refreshSession])

  useEffect(() => {
    if (!setupRequired || user) return
    const timer = window.setInterval(() => {
      refreshSession()
        .then(() => setError(''))
        .catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [refreshSession, setupRequired, user])

  const recheckSetup = async (): Promise<boolean> => {
    try {
      const session = await getSession()
      setSetupRequired(Boolean(session.setupRequired))
      setUser(session.user || null)
      return !session.setupRequired
    } catch {
      return false
    }
  }

  const onLogin = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const session = await login(password)
      setSetupRequired(Boolean(session.setupRequired))
      setUser(session.user || null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đăng nhập thất bại')
    } finally {
      setSubmitting(false)
    }
  }

  const onSetup = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    if (setupMode === 'custom') {
      if (setupPassword.length < 8) {
        setError('Mật khẩu cần ít nhất 8 ký tự')
        return
      }
      if (setupPassword !== setupPasswordConfirm) {
        setError('Hai mật khẩu không khớp')
        return
      }
    }
    if (await recheckSetup()) {
      setError('Krouter đã có mật khẩu admin, vui lòng đăng nhập.')
      return
    }

    setSubmitting(true)
    try {
      const session = await setupAdmin({
        mode: setupMode,
        password: setupMode === 'custom' ? setupPassword : undefined
      })
      setSetupRequired(false)
      if (session.generatedPassword) {
        setGeneratedPassword(session.generatedPassword)
        setPendingUser(session.user || null)
      } else {
        setUser(session.user || null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Thiết lập Krouter thất bại')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="h-screen ambient-bg flex items-center justify-center text-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  if (user) return children

  if (generatedPassword && pendingUser) {
    return (
      <AuthShell>
        <div className="mb-5 flex items-center gap-3">
          <BrandIcon />
          <div>
            <h1 className="text-base font-semibold text-foreground">Krouter đã sẵn sàng</h1>
            <p className="text-xs text-muted-foreground">Mật khẩu admin chỉ hiển thị một lần.</p>
          </div>
        </div>
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
          <div className="mb-1 text-xs font-medium text-muted-foreground">Mật khẩu admin</div>
          <div className="select-all break-all rounded-lg bg-background/80 px-3 py-2 font-mono text-sm text-foreground">
            {generatedPassword}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setUser(pendingUser)}
          className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90"
        >
          <Check className="h-4 w-4" />
          Vào dashboard
        </button>
      </AuthShell>
    )
  }

  if (setupRequired) {
    return (
      <AuthShell onSubmit={onSetup}>
        <div className="mb-5 flex items-center gap-3">
          <BrandIcon />
          <div>
            <h1 className="text-base font-semibold text-foreground">Thiết lập {APP_NAME}</h1>
            <p className="text-xs text-muted-foreground">Tạo mật khẩu admin cho lần cài đặt đầu tiên.</p>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-2">
          <ModeButton
            active={setupMode === 'random'}
            icon={<Shuffle className="h-4 w-4" />}
            title="Krouter tạo"
            description="Random an toàn"
            onClick={() => setSetupMode('random')}
          />
          <ModeButton
            active={setupMode === 'custom'}
            icon={<KeyRound className="h-4 w-4" />}
            title="Tự đặt"
            description="Nhập mật khẩu riêng"
            onClick={() => setSetupMode('custom')}
          />
        </div>

        {setupMode === 'custom' && (
          <div className="space-y-3">
            <PasswordField
              id="setup-password"
              label="Mật khẩu mới"
              value={setupPassword}
              onChange={setSetupPassword}
              autoComplete="new-password"
            />
            <PasswordField
              id="setup-password-confirm"
              label="Nhập lại mật khẩu"
              value={setupPasswordConfirm}
              onChange={setSetupPasswordConfirm}
              autoComplete="new-password"
            />
          </div>
        )}

        {setupMode === 'random' && (
          <div className="rounded-xl border border-border/80 bg-background/60 p-3 text-xs leading-relaxed text-muted-foreground">
            Krouter sẽ tạo mật khẩu mạnh và hiển thị một lần để anh lưu lại.
          </div>
        )}

        <ErrorText error={error} />

        <button
          type="submit"
          disabled={submitting}
          className="mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          {setupMode === 'random' ? 'Tạo mật khẩu random' : 'Lưu mật khẩu'}
        </button>
      </AuthShell>
    )
  }

  return (
    <AuthShell onSubmit={onLogin}>
      <div className="mb-5 flex items-center gap-3">
        <BrandIcon />
        <div>
          <h1 className="text-base font-semibold text-foreground">{APP_NAME}</h1>
          <p className="text-xs text-muted-foreground">Đăng nhập vào máy chủ quản trị.</p>
        </div>
      </div>

      <PasswordField
        id="password"
        label="Mật khẩu"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
      />

      <ErrorText error={error} />

      <button
        type="submit"
        disabled={submitting}
        className="mt-4 flex h-10 w-full items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Đăng nhập'}
      </button>
    </AuthShell>
  )
}

function AuthShell({ children, onSubmit }: { children: React.ReactNode; onSubmit?: (event: FormEvent) => void }): React.ReactNode {
  const content = (
    <div className="w-full max-w-sm glass-card-strong rounded-2xl border border-foreground/10 p-5 shadow-xl">
      {children}
    </div>
  )

  return (
    <div className="h-screen ambient-bg flex items-center justify-center p-4">
      {onSubmit ? (
        <form onSubmit={onSubmit} className="w-full max-w-sm">
          {content}
        </form>
      ) : content}
    </div>
  )
}

function BrandIcon(): React.ReactNode {
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
      <img src={krouterMark} alt="" className="h-8 w-8" />
    </div>
  )
}

function ModeButton(props: {
  active: boolean
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'rounded-xl border p-3 text-left transition',
        props.active ? 'border-primary/50 bg-primary/10' : 'border-border bg-background/60 hover:bg-muted/60'
      )}
    >
      <div className="mb-2 text-primary">{props.icon}</div>
      <div className="text-sm font-semibold text-foreground">{props.title}</div>
      <div className="text-[11px] text-muted-foreground">{props.description}</div>
    </button>
  )
}

function PasswordField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
}): React.ReactNode {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor={props.id}>
        {props.label}
      </label>
      <input
        id={props.id}
        type="password"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-10 w-full rounded-lg border border-border bg-background/70 px-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
        autoComplete={props.autoComplete}
        required
      />
    </div>
  )
}

function ErrorText({ error }: { error: string }): React.ReactNode {
  if (!error) return null
  return <div className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
}
