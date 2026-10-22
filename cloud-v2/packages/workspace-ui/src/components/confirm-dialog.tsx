/**
 * A question in a modal, for an action that can't be taken back (Unassign, Remove from workspace, Leave, Delete,
 * Revoke): its title, one plain line under it, Cancel, and a destructive button that asks.
 *
 * The caller mounts it only while it asks, so a page holds no dialog of its own until then. Pressing the button runs
 * `onConfirm`, which answers with the refusal in words or null once it is done: a refusal is shown inside the dialog,
 * which stays open for another try, with focus back on the button; done closes it. While the request is out the dialog
 * is busy and can't be dismissed. An `onConfirm` that throws is a refusal too (the generic "Something went wrong"), so
 * the dialog is never left busy. Cancel, Escape, the × and the backdrop close it with no request (`onClose(false)`),
 * and the caller gives focus back to the button that asked.
 *
 * For the one question that makes the person type something back first (Delete workspace asks for the workspace's
 * name), `typeToConfirm` adds the field and keeps the button off until it matches.
 */

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { errorMessage } from "../errors";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { AlertText } from "./common";

export function ConfirmDialog({
  title,
  description,
  cancelLabel,
  confirmLabel,
  typeToConfirm,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  /** The one line under the title. */
  description: ReactNode;
  cancelLabel: string;
  /** The destructive button's words. */
  confirmLabel: string;
  /** Asks for `phrase` to be typed back, exactly, before the button works. `label` is the field's question. */
  typeToConfirm?: { phrase: string; label: ReactNode };
  /** Does it: the refusal in words, or null once it is done. */
  onConfirm(): Promise<string | null>;
  /** The dialog is over: `done` when the request went through, false when the person backed out. */
  onClose(done: boolean): void;
}) {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  const wentThrough = useRef(false);
  const ready = typeToConfirm === undefined || typed === typeToConfirm.phrase;

  // A field to type in is where the person starts.
  useEffect(() => {
    field.current?.focus();
  }, []);

  // The button is disabled while the request is out, which drops focus to the page. A refusal leaves the dialog open,
  // so focus goes back to the button for another try.
  useEffect(() => {
    if (pending) wasPending.current = true;
    else if (wasPending.current) {
      wasPending.current = false;
      confirmButton.current?.focus();
    }
  }, [pending]);

  // The one report of how it ended. Once the request went through the caller unmounts the dialog, and the platform may
  // raise a `close` as an open modal leaves the document: that is not the person backing out.
  function end(done: boolean) {
    if (wentThrough.current) return;
    wentThrough.current = done;
    onClose(done);
  }

  async function confirm() {
    setPending(true);
    setRefusal(null);
    let refused: string | null;
    try {
      refused = await onConfirm();
    } catch (error) {
      refused = errorMessage(error);
    } finally {
      setPending(false);
    }
    if (refused === null) end(true);
    else setRefusal(refused);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (ready && !pending) void confirm();
  }

  return (
    <Dialog open onClose={() => end(false)} locked={pending} title={title} description={description}>
      <form onSubmit={submit} className="space-y-6">
        {typeToConfirm ? (
          <div className="grid gap-2">
            <Label htmlFor={fieldId}>
              <span className="font-normal">{typeToConfirm.label}</span>
            </Label>
            <Input
              ref={field}
              id={fieldId}
              autoComplete="off"
              disabled={pending}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
        ) : null}
        {refusal !== null ? <AlertText tone="neutral">{refusal}</AlertText> : null}
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Button type="button" variant="secondary" disabled={pending} onClick={() => end(false)}>
            {cancelLabel}
          </Button>
          <Button ref={confirmButton} type="submit" variant="destructive" disabled={pending || !ready} aria-busy={pending || undefined}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Who a `ConfirmDialog` is asking about, and where focus goes when it closes. A row's button opens the dialog (`ask`),
 * and `close` is the dialog's `onClose`: backed out, focus goes back to the button that asked; done, that row is on its
 * way out, so it goes to the neighbour's button (the next row, else the one before), or stays where it is when there is
 * none. Register each button with `trigger(id)` as its `ref`. `busy` is while a request from the page is out, whose
 * buttons are disabled and can't take focus yet.
 *
 * A button that stays on the page (Leave, Delete) is one row with no neighbours.
 */
export function useAsking<T>(idOf: (item: T) => string, busy = false) {
  const [asking, setAsking] = useState<T | null>(null);
  const triggers = useRef(new Map<string, HTMLElement>());
  const neighbour = useRef<string | null>(null);
  // Whose button gets focus once the dialog is gone; null when nothing is waiting.
  const focusOn = useRef<{ id: string | null } | null>(null);
  useEffect(() => {
    if (asking !== null || busy || focusOn.current === null) return;
    const { id } = focusOn.current;
    focusOn.current = null;
    if (id !== null) triggers.current.get(id)?.focus();
  }, [asking, busy]);
  return {
    asking,
    /** Opens the dialog for `item`, from `among` the rows on the screen, which says who is its neighbour. */
    ask(item: T, among: readonly T[] = []) {
      const at = among.findIndex((other) => idOf(other) === idOf(item));
      const next = among[at + 1] ?? among[at - 1];
      neighbour.current = next === undefined ? null : idOf(next);
      setAsking(item);
    },
    close(done: boolean) {
      if (asking === null) return;
      focusOn.current = { id: done ? neighbour.current : idOf(asking) };
      setAsking(null);
    },
    trigger: (id: string) => (element: HTMLElement | null) => {
      if (element) triggers.current.set(id, element);
      else triggers.current.delete(id);
    },
  };
}
