import { CheckIcon } from "lucide-react";
import * as React from "react";

import { cn } from "../lib/utils";

/**
 * A native `<input type="checkbox">` drawn in Mentra's tokens: a 20px rounded box that fills with the primary
 * colour and a tick when checked. It is the real control, in the tab order, toggled by Space, and it carries every
 * input prop (`checked`, `onChange`, `disabled`, `aria-label`).
 *
 * The box alone is smaller than a thumb. Give it a `label` and the whole label (the box and its text, at least
 * 24px high) is the click and tap target, and the checkbox's name. Without one, put it in a `<label>` of your
 * own that spans the row (as the people picker does), or name it with `aria-label`. `className` sizes or places
 * the outermost element: the label when there is one, else the box's wrapper.
 */
function Checkbox({
  label,
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  /** What the checkbox is for. The label wraps the box, so a click or a tap on it toggles the box. */
  label?: React.ReactNode;
}) {
  const box = (
    <span
      data-slot="checkbox"
      className={cn(
        "relative inline-flex size-5 shrink-0",
        // A label dims with its box, so the box alone doesn't dim twice.
        label === undefined && "has-[input:disabled]:opacity-45",
        label === undefined && className,
      )}
    >
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
  if (label === undefined) return box;
  return (
    <label
      data-slot="checkbox-label"
      className={cn(
        "inline-flex min-h-6 cursor-pointer items-center gap-3 has-[input:disabled]:cursor-not-allowed has-[input:disabled]:opacity-45",
        className,
      )}
    >
      {box}
      <span>{label}</span>
    </label>
  );
}

export { Checkbox };
