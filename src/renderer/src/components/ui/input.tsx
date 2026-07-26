import * as React from "react"
import { cn } from "../../lib/utils"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-[9px] border border-border bg-input px-3 py-1 text-sm shadow-[inset_0_1px_0_rgba(20,35,31,.02)] transition-all file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground hover:border-primary/30 focus-visible:outline-none focus-visible:border-primary/55 focus-visible:ring-2 focus-visible:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
