import { MinusIcon, PlusIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { cn } from "../lib/utils";
import { Button } from "./button";
import { Input } from "./input";

/**
 * A whole number you step with − and +, or type: − n +. It is bounded: `min` (1 unless given) and `max` (none
 * unless given). The buttons turn off at a bound, the arrow keys stop there, and a typed number is held to the
 * bounds when they leave the field or press Enter; something that isn't a number goes back to the last value.
 * `onChange` is only ever called with a whole number within the bounds.
 *
 * The field is a spinbutton (`role="spinbutton"` with its bounds), named by `label`. The words for the two
 * buttons come from the caller, so the control carries none of its own.
 */
function Stepper({
  value,
  onChange,
  min = 1,
  max,
  label,
  decrementLabel,
  incrementLabel,
  id,
  disabled = false,
  className,
}: {
  value: number;
  onChange(value: number): void;
  min?: number;
  max?: number;
  /** The field's accessible name ("Seats"). */
  label: string;
  decrementLabel: string;
  incrementLabel: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}) {
  // What is being typed, until it is taken. Null: show `value`.
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, n));
  const canDecrease = !disabled && value > min;
  const canIncrease = !disabled && (max === undefined || value < max);

  function set(next: number) {
    const bounded = clamp(next);
    setDraft(null);
    if (bounded !== value) onChange(bounded);
  }

  function commit() {
    if (draft === null) return;
    const typed = draft === "" ? Number.NaN : Number(draft);
    if (Number.isSafeInteger(typed)) set(typed);
    else setDraft(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      set(value + (event.key === "ArrowUp" ? 1 : -1));
    } else if (event.key === "Enter") {
      // A stepper in a dialog's form must not submit it just by taking its number.
      event.preventDefault();
      commit();
    }
  }

  return (
    <div data-slot="stepper" className={cn("flex items-center gap-2", className)}>
      <Button type="button" variant="secondary" size="icon-sm" aria-label={decrementLabel} disabled={!canDecrease} onClick={() => set(value - 1)}>
        <MinusIcon />
      </Button>
      <Input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        role="spinbutton"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
        onBlur={commit}
        onKeyDown={onKeyDown}
        className="bg-background h-9 w-20 px-2 text-center tabular-nums"
      />
      <Button type="button" variant="secondary" size="icon-sm" aria-label={incrementLabel} disabled={!canIncrease} onClick={() => set(value + 1)}>
        <PlusIcon />
      </Button>
    </div>
  );
}

export { Stepper };
