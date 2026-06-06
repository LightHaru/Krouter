import { cn } from '../../lib/utils'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  size?: 'sm' | 'md'
}

export function Toggle({ checked, onChange, disabled = false, size = 'md' }: ToggleProps) {
  const sizes = {
    sm: { track: 'w-8 h-4', thumb: 'w-3 h-3', translate: 'translate-x-4' },
    md: { track: 'w-11 h-6', thumb: 'w-5 h-5', translate: 'translate-x-5' }
  }

  const s = sizes[size]

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-all duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2',
        s.track,
        checked
          ? 'bg-[linear-gradient(135deg,var(--gradient-from),var(--gradient-to))] shadow-[0_2px_8px_rgba(91,140,255,0.35)]'
          : 'bg-foreground/20 dark:bg-foreground/15 shadow-inner',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    >
      <span
        className={cn(
          'pointer-events-none inline-block rounded-full bg-white shadow-md ring-1 ring-black/5 transition-transform duration-200 ease-in-out',
          s.thumb,
          checked ? s.translate : 'translate-x-0'
        )}
      />
    </button>
  )
}
