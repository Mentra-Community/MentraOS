import { cn } from "../lib/utils";

/**
 * How full a license is: dark up to the quantity, amber for the seats past it. It repeats what the text beside
 * it says ("3 of 5 in use"), so it is hidden from assistive technology.
 */
function Meter({ used, total, className }: { used: number; total: number; className?: string }) {
  const over = used > total;
  const covered = over ? (total / used) * 100 : (used / Math.max(total, 1)) * 100;
  return (
    <div data-slot="meter" className={cn("bg-surface mt-2.5 flex h-1.5 overflow-hidden rounded-full", className)} aria-hidden="true">
      <span className="bg-foreground h-full" style={{ width: `${covered}%` }} />
      {over ? <span className="bg-error-foreground ml-0.5 h-full flex-1" /> : null}
    </div>
  );
}

export { Meter };
