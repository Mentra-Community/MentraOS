import * as React from "react"
import {cn} from "./button"

function Textarea({className, ...props}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input file:text-foreground placeholder:text-muted-foreground selection:bg-accent selection:text-accent-foreground flex min-h-24 w-full min-w-0 rounded-2xl border bg-background px-4 py-3 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  )
}

export {Textarea}
