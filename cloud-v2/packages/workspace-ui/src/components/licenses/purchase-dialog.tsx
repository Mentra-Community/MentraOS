/**
 * The dialog the Licenses page opens when it comes back from checkout (`?purchase=`) or from the hosted page that added a
 * license for the viewer (`?added=`): setting up, ready, or still not in Core after a minute. It is the `?buy=` link's
 * dialog (`LinkDialog`) in look: titled with the product's name, its icon beside the words, and one primary OK. The
 * words are `strings/licenses.ts`; this only places them.
 */

import { useEffect, useRef } from "react";
import type { CatalogEntry, PurchaseStatus } from "@mentra/workspace-contract/portal-billing";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { Spinner } from "../common";
import { ProductIcon } from "./product";

/** How often the page reads billing's status and Core's licenses while a purchase is being set up (decision 18). */
export const PURCHASE_POLL_MS = 2_000;

/** How long the page waits for a purchase to be set up before it stops reading and the dialog says the licenses can take a few minutes (decision 18). */
export const PURCHASE_TIMEOUT_MS = 60_000;

export interface PurchaseDialogProps {
  /** `status.purchase`, or for `?added=` one unpaid license, `ready` once the viewer holds it. */
  purchase: Pick<PurchaseStatus, "status" | "quantity" | "paid">;
  /** The product, as the catalog names it (its key where the catalog lacks it). */
  productName: string;
  /** The catalog's entry: the dialog's title and icon. Without it the title is the page's ("Licenses") and there is no icon. */
  entry: CatalogEntry | null;
  /** Core lists the purchase's license. */
  listed: boolean;
  /** The viewer holds one of the new license's seats. Only a ready dialog says so. */
  assigned?: boolean;
  /** The page has waited a minute for the license and given up reading. */
  timedOut?: boolean;
  /** OK, Escape, the × and the backdrop, in every state. */
  onClose(): void;
  /** Reloads the page; the browser's own reload unless given. */
  onReload?: () => void;
}

/**
 * Back from checkout: a modal that says the license is being set up, then that it is ready and what to do next. Where
 * the license hasn't reached Core after a minute it says so, with Reload. OK closes it in every state, and so do Escape,
 * the × and the backdrop: it stands over the page only until the person has read it.
 *
 * It is ready when billing's status says `ready` *and* the license is listed (`listed`: Core lists
 * `purchase.licenseId`). A checkout that collected no payment (`paid: false`, such as a trial, or a license added to
 * one the workspace has) says "Purchase complete" and never "Payment received".
 *
 * The minute is not counted here. The page counts it (`usePurchaseFlow`, from the purchase, not from the first time the
 * dialog shows) and says so with `timedOut`, which is also what stops its polling. A late license still turns the
 * dialog ready, whatever `timedOut` says.
 *
 * `assigned` is whether the new license's seats include the viewer's own (billing hands the buyer one): the ready
 * dialog is then titled "You now have <product>!" beside the product's icon, with no product header, and says only to open the Mentra App
 * (and, with more than one bought, to assign the rest).
 *
 * Mount it open and unmount it to close it, as the link's dialogs are: its content is drawn only while it is open.
 * It opens with focus on OK, so Enter closes it and the × is not what the eye lands on.
 */
/** A success dialog's title: the product's icon beside what happened ("You now have <product>!"). */
export function IconTitle({ entry, title }: { entry: Pick<CatalogEntry, "name" | "icon"> | null; title: string }) {
  return (
    <span className="flex items-center gap-3">
      {entry ? <ProductIcon product={entry} size={40} /> : null}
      <span className="min-w-0">{title}</span>
    </span>
  );
}

export function PurchaseDialog({ purchase, productName, entry, listed, assigned = false, timedOut = false, onClose, onReload }: PurchaseDialogProps) {
  const ok = useRef<HTMLButtonElement>(null);
  // The dialog's own effect (a child's, so it runs first) has opened it and focused its first control, the ×.
  useEffect(() => ok.current?.focus(), []);
  const ready = purchase.status === "ready" && listed;
  const { paid, quantity } = purchase;
  const phase = ready ? "ready" : timedOut ? "timeout" : "processing";
  // The viewer holds one now: the dialog is just the product's icon, "You now have <product>!" and what to do next, with no
  // product header.
  const given = phase === "ready" && assigned ? t.purchase.youNowHave(productName, quantity) : null;
  const headline =
    phase === "ready"
      ? t.purchase.readyTitle({ seats: quantity, product: productName })
      : phase === "timeout"
        ? t.purchase.timeout.title(paid)
        : t.purchase.headline(paid);
  const body =
    phase === "ready"
      ? t.purchase.readyBody({ product: productName, paid })
      : phase === "timeout"
        ? t.purchase.timeout.body
        : t.purchase.settingUpSeats({ seats: quantity, product: productName });
  return (
    <Dialog open onClose={onClose} title={given ? <IconTitle entry={entry} title={given.title} /> : (entry?.name ?? t.page.title)} className="max-w-[480px]">
      {given ? (
        <p role="status" data-phase={phase} className="text-[15px] leading-6">
          {given.body}
        </p>
      ) : (
        <div className="flex items-start gap-3">
          {entry ? <ProductIcon product={entry} size={40} /> : null}
          {/* A live region: the words change as the purchase is set up, while the dialog stays open. */}
          <div role="status" data-phase={phase} className="min-w-0 flex-1 space-y-2 text-[15px] leading-6">
            <p className="font-semibold">{headline}</p>
            <p>{body}</p>
            {phase === "processing" ? (
              <p className="text-muted-foreground flex items-center gap-2.5 text-sm font-semibold">
                <Spinner className="size-4" />
                {t.purchase.settingUp}
              </p>
            ) : null}
          </div>
        </div>
      )}
      <div className="-mx-6 -mb-6 flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4 sm:-mx-7 sm:-mb-7 sm:px-7">
        {phase === "timeout" ? (
          <Button type="button" variant="secondary" onClick={onReload ?? (() => window.location.reload())}>
            {t.purchase.timeout.reload}
          </Button>
        ) : null}
        <Button ref={ok} type="button" onClick={onClose}>
          {t.purchase.ok}
        </Button>
      </div>
    </Dialog>
  );
}
