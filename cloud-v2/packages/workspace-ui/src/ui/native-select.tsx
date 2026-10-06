import * as React from "react";

import { cn } from "../lib/utils";

/**
 * A native `<select>` with the look of `SelectTrigger`. Unlike the Radix `Select`, its options are real
 * markup (also on the server) and it uses each platform's own accessible and mobile pickers, which suits
 * the short, fixed lists the workspace screens offer: roles and the caller's workspaces.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "border-input dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive h-9 w-fit rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
