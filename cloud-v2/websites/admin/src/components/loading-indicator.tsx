import {Loader2} from "lucide-react";

/** One compact, accessible loading treatment across Admin pages and controls. */
export function LoadingIndicator({label = "Loading", inline = false, className = ""}: {
  label?: string;
  inline?: boolean;
  className?: string;
}) {
  return <span role="status" aria-label={label}
    className={`${inline ? "inline-flex" : "flex min-h-24 justify-center rounded-xl border border-[#e0e4de] bg-white"} items-center gap-2 text-sm text-[#68746d] ${className}`}>
    <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
    <span>Loading</span>
  </span>;
}
