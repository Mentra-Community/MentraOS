import * as React from "react";

import { cn } from "../lib/utils";

/**
 * A text field as on the sign-in page: a grey pill with a border, 16px text (so phones do not zoom in on
 * focus) and the shared green focus ring. `h-12` matches the sign-in page exactly, for a page that is
 * only a short form.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-full border border-border bg-surface px-[18px] text-base text-foreground transition-[border-color,background-color] placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive",
        "file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-semibold file:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
