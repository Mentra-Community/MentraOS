"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"
import { cn } from "./button"

function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Match mobile: 46px wide × 28px tall, pill shape
        "peer inline-flex h-7 w-[46px] shrink-0 items-center rounded-full transition-all outline-none",
        // OFF state: gray track (matching mobile sidebar_border)
        "data-[state=unchecked]:bg-border",
        // ON state: Mentra green (primary color from mobile)
        "data-[state=checked]:bg-[#00b869]",
        // Focus styles
        "focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        // Disabled state
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // Match mobile: 24px knob with shadow
          "pointer-events-none block size-6 rounded-full bg-white ring-0 transition-transform",
          // Shadow matching mobile
          "shadow-[0_2px_3px_rgba(0,0,0,0.15)]",
          // Position: 2px margin on each side (46px - 24px - 2px margin each side = 18px travel)
          "data-[state=unchecked]:translate-x-0.5",
          "data-[state=checked]:translate-x-[20px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
