import * as React from "react"
import { cn } from "../../lib/utils"

export interface SwitchProps {
  id?: string
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ id, checked = false, onCheckedChange, disabled, className }, ref) => {
    return (
      <button
        ref={ref}
        id={id}
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
        className={cn(
          "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
          checked
            ? "bg-[linear-gradient(135deg,var(--gradient-from),var(--gradient-to))] shadow-[0_2px_8px_rgba(91,140,255,0.35)]"
            : "bg-foreground/20 dark:bg-foreground/15 shadow-inner",
          className
        )}
      >
        <span
          className={cn(
            "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-md ring-1 ring-black/5 transition-transform duration-200",
            checked ? "translate-x-4" : "translate-x-0"
          )}
        />
      </button>
    )
  }
)
Switch.displayName = "Switch"

export { Switch }
