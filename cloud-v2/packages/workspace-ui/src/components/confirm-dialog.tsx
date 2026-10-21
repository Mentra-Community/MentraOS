/**
 * A question in a modal, for an action that can't be taken back (Unassign, Remove from workspace): its title, one plain
 * line under it, Cancel, and a destructive button that asks.
 *
 * The caller mounts it only while it asks, so a page holds no dialog of its own until then. Pressing the button runs
 * `onConfirm`, which answers with the refusal in words or null once it is done: a refusal is shown inside the dialog,
 * which stays open for another try; done closes it. While the request is out the dialog is busy and can't be
 * dismissed. Cancel, Escape, the × and the backdrop close it with no request (`onClose(false)`), and the caller gives
 * focus back to the button that asked.
 */

import { useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { AlertText } from "./common";

export function ConfirmDialog({
  title,
  description,
  cancelLabel,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: ReactNode;
  /** The one line under the title. */
  description: ReactNode;
  cancelLabel: string;
  /** The destructive button's words. */
  confirmLabel: string;
  /** Does it: the refusal in words, or null once it is done. */
  onConfirm(): Promise<string | null>;
  /** The dialog is over: `done` when the request went through, false when the person backed out. */
  onClose(done: boolean): void;
}) {
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setRefusal(null);
    const refused = await onConfirm();
    setPending(false);
    if (refused === null) onClose(true);
    else setRefusal(refused);
  }

  return (
    <Dialog open onClose={() => onClose(false)} locked={pending} title={title} description={description}>
      {refusal !== null ? <AlertText tone="neutral">{refusal}</AlertText> : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button type="button" variant="secondary" disabled={pending} onClick={() => onClose(false)}>
          {cancelLabel}
        </Button>
        <Button type="button" variant="destructive" disabled={pending} aria-busy={pending || undefined} onClick={() => void confirm()}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
