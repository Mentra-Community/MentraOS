import type {ComponentProps} from "react";
import {Button} from "./ui/button";
import {Loader2} from "lucide-react";

/** Shared testing surfaces follow the surrounding Admin cards and controls. */
export const TESTING_PANEL = "rounded-[24px] border border-[#e0e4de] bg-white p-5 shadow-[0_1px_2px_rgba(20,21,27,0.06)]";
export const TESTING_LINK = "rounded-sm text-sm font-medium text-[#0969da] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0969da]";
export const TESTING_FIELD = "h-9 w-full min-w-0 rounded-md border border-[#e0e4de] bg-white px-3 text-sm shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0969da] disabled:opacity-50";

export function TestingButton({variant = "outline", size = "sm", className, busy = false, children, disabled, ...props}: ComponentProps<typeof Button> & {busy?: boolean}) {
  return <Button type="button" variant={variant} size={size} className={`rounded-lg ${variant === "outline" ? "border-[#e0e4de] bg-white text-[#14151b] hover:bg-[#f3f4f2]" : ""} ${className ?? ""}`} {...props} disabled={disabled || busy} aria-busy={busy || undefined}>
    {busy && <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />}{children}
  </Button>;
}
