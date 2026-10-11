import { ChevronDownIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils";

/**
 * A native `<select>` drawn like `Input` (same pill, border, height and focus ring) with one chevron.
 * Unlike a custom listbox, its options are real markup (also on the server) and it uses each platform's
 * own accessible and mobile pickers, which suits the short, fixed lists the workspace screens offer:
 * roles and the caller's workspaces. `className` sizes the control (`w-full`); `compact` makes it 36px
 * high, for a table row.
 */
function NativeSelect({
  className,
  compact = false,
  ...props
}: React.ComponentProps<"select"> & { compact?: boolean }) {
  return (
    <span
      data-slot="native-select"
      className={cn("relative inline-flex w-fit max-w-full has-[select:disabled]:opacity-45", className)}
    >
      <select
        className={cn(
          "w-full min-w-0 cursor-pointer appearance-none rounded-full border border-border bg-surface pr-10 pl-[18px] text-base text-foreground transition-[border-color,background-color] hover:bg-hover disabled:cursor-not-allowed disabled:hover:bg-surface aria-invalid:border-destructive",
          compact ? "h-9 pr-9 pl-4 text-[15px]" : "h-11",
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className={cn(
          "text-muted-foreground pointer-events-none absolute top-1/2 size-4 -translate-y-1/2",
          compact ? "right-3.5" : "right-4",
        )}
      />
    </span>
  );
}

export { NativeSelect };
