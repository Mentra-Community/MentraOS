import { XIcon } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { licenseStrings as t } from "../strings/licenses";
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
  locked = false,
  children,
}: {
  open: boolean;
  /** The dialog was closed (Escape, the close button, the backdrop): set `open` to false. */
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  /** A request is out and the dialog must stay until it answers: Escape, the backdrop and the close button do nothing. */
  locked?: boolean;
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
      // Escape closes the dialog natively (unless it is locked); `close` also fires when `open` turns false, which is harmless.
      onCancel={(event) => {
        if (locked) event.preventDefault();
      }}
      onClose={() => onClose()}
      onClick={(event) => {
        // The content fills the dialog, so only a click on the backdrop lands on the dialog itself.
        if (event.target === event.currentTarget && !locked) onClose();
      }}
      className={cn(
        // The Store's dialog: 24px corners, a soft shadow over a dimmed, blurred page.
        "bg-background text-foreground m-auto w-[calc(100%-2rem)] max-w-md rounded-card border-0 p-0 shadow-dialog backdrop:bg-black/45 backdrop:backdrop-blur-[4px]",
        className,
      )}
    >
      {open ? (
        <div className="space-y-6 p-6 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1.5">
              <h2 id={titleId} className="text-xl leading-tight font-semibold">
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
              className="text-muted-foreground -mt-1.5 -mr-2"
              aria-label={t.dialog.close}
              disabled={locked}
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
