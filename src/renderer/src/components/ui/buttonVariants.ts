import { cva } from 'class-variance-authority'

/**
 * Tách khỏi button.tsx: file component chỉ nên export component, nếu không Fast Refresh
 * phải nạp lại cả module thay vì thay nóng riêng component
 * (react-refresh/only-export-components).
 */
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[9px] border border-transparent text-sm font-bold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // 默认主 CTA：实色 + hover 浮起 + 主色辉光
        default: 'bg-primary text-primary-foreground shadow-[0_1px_2px_rgba(8,40,31,.18)] hover:bg-primary/90 hover:shadow-[0_5px_14px_-8px_var(--color-primary)]',
        // 危险操作：红色 + hover 红色辉光
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        // 玻璃 outline：默认无填充，hover 显示淡色 + 浮起
        outline: 'border-border bg-card text-foreground shadow-sm hover:border-primary/35 hover:bg-muted',
        // secondary：玻璃感
        secondary: 'border-border/60 bg-secondary text-secondary-foreground hover:bg-secondary/75',
        // ghost：透明，hover 显示淡色背景
        ghost: 'hover:bg-muted hover:text-foreground',
        // link：下划线
        link: 'text-primary underline-offset-4 hover:underline',
        // gradient：主 CTA 强调款，主题渐变 + 持续呼吸辉光
        gradient: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/90'
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-[8px] px-3 text-xs',
        lg: 'h-11 rounded-[10px] px-6 text-base',
        cta: 'h-12 rounded-[11px] px-8 text-base font-bold',
        icon: 'h-9 w-9 rounded-[8px]'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)
