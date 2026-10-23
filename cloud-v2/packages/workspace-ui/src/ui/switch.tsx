import * as React from "react";

import { cn } from "../lib/utils";

/**
 * A native `<input type="checkbox" role="switch">` drawn as a 40 × 24px track and thumb: grey when off, Mentra
 * green when on. It is the real control, in the tab order and toggled by Space, and it carries every input
 * prop (`checked`, `onChange`, `disabled`, `aria-label`). `className` sizes or places the switch's wrapper.
 */
function Switch({ className, ...props }: Omit<React.ComponentProps<"input">, "type" | "role">) {
  return (
    <span data-slot="switch" className={cn("relative inline-flex h-6 w-10 shrink-0 has-[input:disabled]:opacity-40", className)}>
      <input
        type="checkbox"
        role="switch"
        className="peer bg-muted-foreground/35 checked:bg-brand size-full cursor-pointer appearance-none rounded-full transition-colors disabled:cursor-not-allowed motion-reduce:transition-none"
        {...props}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform peer-checked:translate-x-4 motion-reduce:transition-none"
      />
    </span>
  );
}

export { Switch };
