import * as React from "react";

import { cn } from "../lib/utils";

/**
 * A multi-line text field drawn like `Input`: the grey surface, a 1px border, 16px text (so phones do not
 * zoom in on focus) and the shared green focus ring, with the menu's 16px corners in place of a pill.
 * It is at least three lines high, and the person can make it taller (not wider).
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "rounded-menu border-border bg-surface text-foreground placeholder:text-muted-foreground aria-invalid:border-destructive block min-h-24 w-full min-w-0 resize-y border px-[18px] py-3 text-base leading-6 transition-[border-color,background-color] disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
