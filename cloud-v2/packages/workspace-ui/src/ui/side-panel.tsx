import { XIcon } from "lucide-react";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../lib/utils";
import { licenseStrings as t } from "../strings/licenses";
import { Button } from "./button";

/** What can take focus inside the panel; `isReachable` keeps the ones a person can get to with Tab. */
const FOCUSABLE = 'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]';

/**
 * Whether Tab can land on `element`: not taken out of the tab order (`tabindex` below zero, as a menu's items
 * are), not disabled (itself, or by a disabled `fieldset`, except in its legend), and not inside anything
 * `hidden`, `inert` or `aria-hidden`.
 */
function isReachable(element: HTMLElement): boolean {
  const tabindex = element.getAttribute("tabindex");
  if (tabindex !== null && Number(tabindex) < 0) return false;
  if (element.hasAttribute("disabled")) return false;
  if (element.closest("fieldset[disabled]") && !element.closest("legend")) return false;
  return element.closest('[hidden], [inert], [aria-hidden="true"]') === null;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(isReachable);
}

/**
 * A modal sheet on the right-hand side, full-screen on a phone. It is built like `Dialog`, on
 * the platform's `<dialog>` (`showModal()` makes the rest of the page inert, dims it and puts the sheet in the
 * top layer), and the open state is the host's (`open`, `onClose`), so the host can tie it to an address:
 *
 * - Focus goes inside when it opens, Tab and Shift+Tab wrap at its ends, and focus returns to whatever opened
 *   it when it closes. A browser does most of that for a modal `<dialog>` already; it is done here too so the
 *   sheet behaves the same wherever it runs.
 * - Escape, the ×, a click on the dimmed page and the browser's own close request all call `onClose`. The panel
 *   stays open until the host sets `open` to false, so a host can ask first. One press of Escape calls it once,
 *   even in a browser that sends its own close request for the same press.
 * - Escape in a menu or a dialog opened from inside the panel closes that, not the panel.
 *
 * The content renders only while open, so a form inside starts fresh each time.
 */
export function SidePanel({
  open,
  onClose,
  title,
  description,
  className,
  children,
}: {
  open: boolean;
  /** The person asked to close it: set `open` to false. */
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  // Set while one press of Escape is being handled: its keydown and a browser's own cancel are one request.
  const escapePending = useRef(false);

  useEffect(() => {
    escapePending.current = false;
  }, [open]);

  function requestEscapeClose() {
    if (escapePending.current) return;
    escapePending.current = true;
    // Both events of a press arrive in one task. A later press, for a host that stayed open to ask first, is a new request.
    setTimeout(() => {
      escapePending.current = false;
    }, 0);
    onClose();
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      if (!dialog.contains(document.activeElement)) focusables(dialog)[0]?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) back.focus();
    }
  }, [open]);

  /** Whether `event` came from this panel itself and not from a dialog nested in it, which handles its own keys. */
  const isOwn = (event: KeyboardEvent<HTMLDialogElement>) =>
    event.target instanceof Element && event.target.closest("dialog") === event.currentTarget;

  function onKeyDown(event: KeyboardEvent<HTMLDialogElement>) {
    if (!isOwn(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      requestEscapeClose();
    } else if (event.key === "Tab") {
      const dialog = event.currentTarget;
      const controls = focusables(dialog);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      const outside = !dialog.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <dialog
      ref={ref}
      data-slot="side-panel"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onKeyDown={onKeyDown}
      // The browser's close request (Escape, an Android back gesture): the host decides, so it isn't closed here.
      onCancel={(event) => {
        event.preventDefault();
        requestEscapeClose();
      }}
      // A close the host didn't ask for (the dialog closed itself). Closing it from `open` fires this too: not a request.
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(event) => {
        // The content fills the dialog, so only a click on the dimmed page lands on the dialog itself.
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        // A sheet: the full height at the right edge, the full width on a phone and 30rem from `sm`. Cleared of the
        // dialog defaults (centred, inset by 1em) so it sits flush.
        "bg-background text-foreground shadow-dialog m-0 ml-auto h-dvh max-h-dvh w-full max-w-full overflow-hidden rounded-none border-0 p-0 backdrop:bg-black/45 backdrop:backdrop-blur-[4px] sm:max-w-[30rem] sm:rounded-l-card",
        className,
      )}
    >
      {open ? (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-start justify-between gap-4 border-b p-6 max-sm:p-5">
            <div className="min-w-0 flex-1 space-y-1.5">
              <h2 id={titleId} className="text-xl leading-tight font-semibold">
                {title}
              </h2>
              {description ? (
                <div id={descriptionId} className="text-muted-foreground text-sm">
                  {description}
                </div>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground -mt-1.5 -mr-2"
              aria-label={t.dialog.close}
              onClick={onClose}
            >
              <XIcon />
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6 max-sm:p-5">{children}</div>
        </div>
      ) : null}
    </dialog>
  );
}
