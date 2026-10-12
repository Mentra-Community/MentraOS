import type {ComponentProps, ReactNode} from "react";
import {cn} from "../../lib/utils";

/** The checkbox-based switch used by Admin's routine catalog. */
export function Switch({children, className, ...props}: Omit<ComponentProps<"input">, "type"> & {children: ReactNode}) {
  return <label className={cn("flex min-h-11 shrink-0 items-center gap-2.5 text-sm font-medium text-[#5d6068]", props.disabled ? "cursor-wait opacity-60" : "cursor-pointer", className)}>
    <input {...props} className="peer sr-only" type="checkbox" role="switch" />
    <span aria-hidden="true" className="inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-[#747780] p-0.5 shadow-inner transition-colors duration-200 peer-checked:bg-[#111217] peer-focus-visible:ring-2 peer-focus-visible:ring-[#111217] peer-focus-visible:ring-offset-2 peer-checked:[&>span]:translate-x-5 motion-reduce:transition-none">
      <span className="h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none" />
    </span>
    <span>{children}</span>
  </label>;
}
