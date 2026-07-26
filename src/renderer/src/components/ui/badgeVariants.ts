import { cva } from 'class-variance-authority'

/**
 * Tách khỏi badge.tsx: file component chỉ nên export component, nếu không Fast Refresh
 * phải nạp lại cả module thay vì thay nóng riêng component
 * (react-refresh/only-export-components).
 */
export const badgeVariants = cva(
  'inline-flex items-center rounded-[6px] border px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-[0.04em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-primary/15 bg-primary/10 text-primary',
        secondary: 'border-border bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground shadow',
        outline: 'text-foreground',
        success: 'border-transparent bg-success text-white shadow'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)
