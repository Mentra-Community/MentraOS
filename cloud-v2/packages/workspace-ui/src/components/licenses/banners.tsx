/**
 * The Licenses page's banners and its one-line states, as the design draws them: back from checkout (setting
 * up, ready, or still not in Core after a minute), test mode on dev and staging, the total above the cards,
 * and "unavailable". The words are `strings/licenses.ts`; these only place them.
 */

import { CheckIcon, CreditCardIcon, FlaskConicalIcon, XIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { BillingTotal, PurchaseStatus, TestMode } from "@mentra/workspace-contract/portal-billing";
import { groupCardNumber, totalSummary } from "../../lib/billing-format";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { CopyButton, Spinner } from "../common";

/** How often the page reads billing's status and Core's licenses while a purchase is being set up (decision 18). */
export const PURCHASE_POLL_MS = 2_000;

/** How long the page waits for a purchase to be set up before it stops reading and the banner says the seats can take a few minutes (decision 18). */
export const PURCHASE_TIMEOUT_MS = 60_000;

/**
 * Back from checkout: it stands out while the license is set up, then says it is active and what to do next.
 * Where the license hasn't reached Core after a minute it says so, with Reload.
 *
 * It is ready when billing's status says `ready` *and* the license is listed (`listed`: Core lists
 * `purchase.licenseId`). A checkout that
 * collected no payment (`paid: false`, such as a trial) says "Purchase complete" and never "Payment received".
 *
 * The minute is not counted here. The page counts it (`usePurchaseFlow`, from the purchase, not from the first time a
 * banner shows) and says so with `timedOut`, which is also what stops its polling. A late license still turns the
 * banner ready, whatever `timedOut` says.
 *
 * `assigned` is whether the new license's seats include the viewer's own (billing hands the buyer one): the ready
 * banner then says so.
 */
export function PurchaseBanner({
  purchase,
  productName,
  listed,
  assigned = false,
  timedOut = false,
  onDismiss,
  onReload,
}: {
  /** `status.purchase`. */
  purchase: Pick<PurchaseStatus, "status" | "quantity" | "paid">;
  /** The product, as the catalog names it. */
  productName: string;
  listed: boolean;
  /** The viewer holds one of the new license's seats. Only a ready banner says so. */
  assigned?: boolean;
  /** The page has waited a minute for the license and given up reading. */
  timedOut?: boolean;
  onDismiss(): void;
  /** Reloads the page; the browser's own reload unless given. */
  onReload?: () => void;
}) {
  const ready = purchase.status === "ready" && listed;
  const { paid, quantity } = purchase;
  const phase = ready ? "ready" : timedOut ? "timeout" : "processing";
  const title =
    phase === "ready"
      ? assigned
        ? t.purchase.givenTitle({ seats: quantity, product: productName, paid })
        : t.purchase.readyTitle({ seats: quantity, product: productName })
      : phase === "timeout"
        ? t.purchase.timeout.title(paid)
        : t.purchase.headline(paid);
  const body =
    phase === "ready"
      ? assigned
        ? t.purchase.givenBody({ seats: quantity, product: productName, paid })
        : t.purchase.readyBody({ product: productName, paid })
      : phase === "timeout"
        ? t.purchase.timeout.body
        : t.purchase.settingUpSeats({ seats: quantity, product: productName });
  return (
    <section role="status" data-phase={phase} className="rounded-card bg-info text-info-foreground flex flex-wrap items-center gap-x-4 gap-y-4 p-6 max-sm:p-5">
      <span className="bg-brand flex size-12 shrink-0 items-center justify-center rounded-full text-white">
        <CheckIcon aria-hidden="true" className="size-6" strokeWidth={3} />
      </span>
      <div className="min-w-0 flex-1 basis-72">
        <h2 className="text-xl leading-tight font-semibold">{title}</h2>
        <p className="mt-1 text-[15px] leading-6">{body}</p>
      </div>
      {phase === "ready" ? (
        <Button variant="ghost" size="icon-sm" aria-label={t.purchase.dismiss} className="text-info-foreground self-start" onClick={onDismiss}>
          <XIcon aria-hidden="true" />
        </Button>
      ) : phase === "timeout" ? (
        <Button variant="secondary" onClick={onReload ?? (() => window.location.reload())}>
          {t.purchase.timeout.reload}
        </Button>
      ) : (
        <span className="flex items-center gap-2.5 text-sm font-semibold">
          <Spinner className="size-5" />
          {t.purchase.settingUp}
        </span>
      )}
    </section>
  );
}

/**
 * Back from the hosted page that added one license for the viewer (`?added=`): the purchase banner's own words for one
 * unpaid license (the add may be charged now or on the next invoice, so it claims no payment). It shows nothing while the
 * license is on its way (`held` and `timedOut` both false): "Purchase complete" and "<product> is active, and it's assigned
 * to you." once the viewer holds the product, and "Your purchase went through" with "The licenses can take a few minutes
 * to appear." and Reload once the page has waited a minute for it. The page counts the minute (`useAddedFlow`).
 */
export function AddedBanner({
  productName,
  held,
  timedOut,
  onDismiss,
  onReload,
}: {
  /** The product, as the catalog names it. */
  productName: string;
  /** The viewer holds the product. */
  held: boolean;
  /** The page has waited a minute for it and given up reading. */
  timedOut: boolean;
  onDismiss(): void;
  onReload?: () => void;
}) {
  if (!held && !timedOut) return null;
  return (
    <PurchaseBanner
      purchase={{ status: held ? "ready" : "processing", quantity: 1, paid: false }}
      productName={productName}
      listed={held}
      assigned={held}
      timedOut={!held}
      onDismiss={onDismiss}
      onReload={onReload}
    />
  );
}

/** Hazard tape from the notice tokens: an amber and dark-amber frame no real notice uses. */
const HAZARD_TAPE: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(-45deg, var(--mentra-error) 0 10px, color-mix(in srgb, var(--mentra-error) 18%, var(--mentra-error-bg)) 10px 20px)",
};

/** The session's storage key for a test-mode notice that staff hid: one key, so it holds on every page of the session. */
export const TEST_MODE_NOTICE_HIDDEN_KEY = "mentra.testModeNotice.hidden";

/** Whether the notice was hidden earlier in this browser session. Storage that throws (a private mode) reads as not hidden. */
function noticeHidden(): boolean {
  try {
    return window.sessionStorage.getItem(TEST_MODE_NOTICE_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers that the notice was hidden, for the rest of the session. Storage that throws keeps nothing: the page hides it itself. */
function rememberNoticeHidden(): void {
  try {
    window.sessionStorage.setItem(TEST_MODE_NOTICE_HIDDEN_KEY, "1");
  } catch {
    // Hidden for this page only.
  }
}

/**
 * Dev and staging only, where billing is in test mode: which environment and the card to pay with (grouped as it is
 * read, copied as its bare digits). A small × in its top-right corner hides it, so a screenshot comes out clean: it
 * stays hidden for the rest of the browser session (`sessionStorage`), and shows again in a new one. Where storage throws, it is hidden for the current page only. Hiding it
 * changes nothing else: test mode itself, the buy dialogs and their words are as they were.
 */
export function TestModeBanner({ testMode }: { testMode: Pick<TestMode, "cardNumber" | "environment"> }) {
  const digits = testMode.cardNumber.replace(/\s+/g, "");
  const [hidden, setHidden] = useState(noticeHidden);
  if (hidden) return null;
  return (
    <div role="note" aria-label={t.testMode.label(testMode.environment)} className="rounded-[16px] p-1.5" style={HAZARD_TAPE}>
      <div className="bg-error text-error-foreground relative flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[11px] py-3.5 pr-12 pl-4">
        <span className="bg-error-foreground inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-semibold tracking-[0.08em] text-white uppercase">
          <FlaskConicalIcon aria-hidden="true" className="size-3.5" />
          {t.testMode.label(testMode.environment)}
        </span>
        <div className="min-w-0 flex-1 basis-80 text-sm leading-5">
          <p>
            <span className="font-semibold">{t.testMode.lead}</span> {t.testMode.beforeCard}{" "}
            <span className="bg-background rounded-md px-1.5 py-0.5 font-semibold tracking-wide whitespace-nowrap tabular-nums">
              {groupCardNumber(digits)}
            </span>
            {t.testMode.afterCard}
          </p>
        </div>
        <CopyButton text={digits} label={t.testMode.copy} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t.testMode.hide}
          className="absolute top-1.5 right-1.5 size-7"
          onClick={() => {
            rememberNoticeHidden();
            setHidden(true);
          }}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/**
 * The line above the cards: "2 products · $295 a month in total", from billing's own total of the licenses it
 * will charge again. Where billing sends none (the licenses don't share a currency, a recurrence and a tax
 * treatment) there is no line: Core adds nothing up.
 */
export function LicensesSummary({ total, locale }: { total: BillingTotal | null; locale: string }) {
  if (total === null) return null;
  const { lead, rest } = totalSummary(total, locale);
  return (
    <p className="text-muted-foreground text-sm">
      <span className="text-foreground font-semibold">{lead}</span>
      {` · ${rest}`}
    </p>
  );
}

/**
 * The page when billing (or the catalog) couldn't be read, or didn't match the contract: say so, with Retry,
 * rather than cards without names.
 */
export function LicensesUnavailable({ onRetry, retrying = false }: { onRetry(): void; retrying?: boolean }) {
  const words = t.page.unavailable;
  return (
    <Card role="status" className="items-center gap-4 px-6 py-14 text-center">
      <span className="bg-surface flex size-14 items-center justify-center rounded-full">
        <CreditCardIcon aria-hidden="true" className="text-muted-foreground size-6" />
      </span>
      <h2 className="text-lg leading-tight font-semibold">{words.title}</h2>
      <p className="text-muted-foreground max-w-md text-sm leading-6">{words.body}</p>
      <Button variant="secondary" disabled={retrying} aria-busy={retrying || undefined} onClick={onRetry}>
        {words.retry}
      </Button>
    </Card>
  );
}
