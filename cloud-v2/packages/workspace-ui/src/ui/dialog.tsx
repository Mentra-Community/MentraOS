import { XIcon } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { Button } from "./button";

/**
 * A modal dialog on the platform's `<dialog>`: `showModal()` makes the rest of the page inert, keeps focus
 * inside, closes on Escape and returns focus to the opener, all natively. The content renders only while
 * the dialog is open, so a form inside starts fresh each time. A click on the backdrop closes it too.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  className,
  children,
}: {
  open: boolean;
  /** The dialog was closed (Escape, the close button, the backdrop): set `open` to false. */
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // Escape closes the dialog natively; `close` also fires when `open` turns false, which is harmless.
      onClose={() => onClose()}
      onClick={(event) => {
        // The content fills the dialog, so only a click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "bg-card text-card-foreground m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border p-0 shadow-[0_24px_60px_-12px_rgba(20,21,27,0.35)] backdrop:bg-[#111217]/40 backdrop:backdrop-blur-[2px]",
        className,
      )}
    >
      {open ? (
        <div className="space-y-5 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <h2 id={titleId} className="text-lg leading-tight font-semibold">
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="text-muted-foreground text-sm">
                  {description}
                </p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground -mt-1 -mr-2 rounded-full"
              aria-label="Close"
              onClick={onClose}
            >
              <XIcon />
            </Button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
