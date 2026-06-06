import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // 默认主 CTA：实色 + hover 浮起 + 主色辉光
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:-translate-y-px hover:shadow-[var(--glass-shadow-glow)]',
        // 危险操作：红色 + hover 红色辉光
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:-translate-y-px hover:shadow-[0_0_0_1px_rgba(239,68,68,0.25),0_8px_24px_rgba(239,68,68,0.25)]',
        // 玻璃 outline：默认无填充，hover 显示淡色 + 浮起
        outline: 'border border-[var(--glass-border-strong)] bg-[var(--glass-bg-subtle)] backdrop-blur-md shadow-sm hover:bg-[var(--glass-bg)] hover:text-foreground hover:-translate-y-px',
        // secondary：玻璃感
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 hover:-translate-y-px',
        // ghost：透明，hover 显示淡色背景
        ghost: 'hover:bg-white/40 dark:hover:bg-white/5 hover:text-foreground',
        // link：下划线
        link: 'text-primary underline-offset-4 hover:underline',
        // gradient：主 CTA 强调款，主题渐变 + 持续呼吸辉光
        gradient: 'gradient-bg-primary shadow-md hover:-translate-y-px breathe-glow text-white border-0'
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-lg px-3 text-xs',
        lg: 'h-11 rounded-xl px-6 text-base',
        cta: 'h-12 rounded-2xl px-8 text-base font-semibold', // 主要 Call-to-Action 按钮
        icon: 'h-9 w-9 rounded-lg'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
