import { CheckIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils";

/**
 * A native `<input type="checkbox">` drawn in Mentra's tokens: a 20px rounded box that fills with the primary
 * colour and a tick when checked. It is the real control, in the tab order, toggled by Space and by a click on
 * the `<label>` around it, and it carries every input prop (`checked`, `onChange`, `disabled`, `aria-label`).
 * `className` sizes or places the box's wrapper.
 */
function Checkbox({ className, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <span data-slot="checkbox" className={cn("relative inline-flex size-5 shrink-0 has-[input:disabled]:opacity-45", className)}>
      <input
        type="checkbox"
        className="peer border-border bg-background checked:border-primary checked:bg-primary size-full cursor-pointer appearance-none rounded-[6px] border-2 disabled:cursor-not-allowed"
        {...props}
      />
      <CheckIcon
        aria-hidden="true"
        strokeWidth={3}
        className="text-primary-foreground pointer-events-none absolute inset-0 m-auto size-3.5 opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
}

export { Checkbox };
