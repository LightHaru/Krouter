import * as React from 'react'
import { cn } from '@/lib/utils'

export type CardVariant = 'glass' | 'glass-strong' | 'glass-subtle' | 'solid' | 'elevated'

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * 卡片变体
   * - glass        : 默认玻璃态（半透明 + blur）
   * - glass-strong : 更不透明的玻璃（适合需要更高可读性的内容）
   * - glass-subtle : 轻玻璃（适合二级容器、工具栏）
   * - solid        : 不透明实色 Card（向后兼容老代码）
   * - elevated     : 实色 Card + 更强阴影
   */
  variant?: CardVariant
  /** 是否启用 hover 浮起动画 */
  interactive?: boolean
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant = 'glass', interactive = false, ...props }, ref) => {
    const variantClass: Record<CardVariant, string> = {
      'glass': 'glass-card text-card-foreground',
      'glass-strong': 'glass-card-strong text-card-foreground',
      'glass-subtle': 'glass-card-subtle text-card-foreground',
      'solid': 'bg-card text-card-foreground border shadow',
      'elevated': 'bg-card text-card-foreground border shadow-lg'
    }
    return (
      <div
        ref={ref}
        className={cn(
          'rounded-2xl', // 24px 圆角
          variantClass[variant],
          interactive && 'hover-lift cursor-pointer',
          className
        )}
        {...props}
      />
    )
  }
)
Card.displayName = 'Card'

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col space-y-1.5 p-6', className)} {...props} />
  )
)
CardHeader.displayName = 'CardHeader'

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('font-semibold leading-none tracking-tight', className)} {...props} />
  )
)
CardTitle.displayName = 'CardTitle'

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
  )
)
CardDescription.displayName = 'CardDescription'

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
)
CardContent.displayName = 'CardContent'

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center p-6 pt-0', className)} {...props} />
  )
)
CardFooter.displayName = 'CardFooter'

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
