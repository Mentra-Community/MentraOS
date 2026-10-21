/**
 * The Licenses page's banners and its one-line states, as the design draws them: back from checkout (setting
 * up, ready, or still not in Core after a minute), test mode on dev and staging, the total above the cards,
 * and "unavailable". The words are `strings/licenses.ts`; these only place them.
 */

import { CheckIcon, CreditCardIcon, FlaskConicalIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { BillingTotal, PurchaseStatus, TestMode } from "@mentra/workspace-contract/portal-billing";
import { groupCardNumber, totalSummary } from "../../lib/billing-format";
import { licenseStrings as t, type LicenseScope } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { CopyButton, Spinner } from "../common";

/** How often the page reads billing's status and Core's licenses while a purchase is being set up (decision 18). */
export const PURCHASE_POLL_MS = 2_000;

/** How long a purchase may take to reach Core before the banner says the seats can take a few minutes. */
export const PURCHASE_TIMEOUT_MS = 60_000;

/**
 * Back from checkout: it stands out while the license is set up, then says it is active and what to do next.
 * Where the license hasn't reached Core after a minute it says so, with Reload.
 *
 * It is ready when billing's status says `ready` *and* the license is listed (`listed`: Core lists
 * `purchase.licenseId`; a person's license is billing's alone, so there it is always true). A checkout that
 * collected no payment (`paid: false`, such as a trial) says "Purchase complete" and never "Payment received".
 */
export function PurchaseBanner({
  purchase,
  productName,
  scope = "workspace",
  listed,
  onDismiss,
  onReload,
  onTimeout,
  timeoutMs = PURCHASE_TIMEOUT_MS,
}: {
  /** `status.purchase`. */
  purchase: Pick<PurchaseStatus, "status" | "quantity" | "paid">;
  /** The product, as the catalog names it. */
  productName: string;
  scope?: LicenseScope;
  listed: boolean;
  onDismiss(): void;
  /** Reloads the page; the browser's own reload unless given. */
  onReload?: () => void;
  /** The minute passed without the license arriving: the page can stop reading. */
  onTimeout?: () => void;
  timeoutMs?: number;
}) {
  const ready = purchase.status === "ready" && listed;
  const [timedOut, setTimedOut] = useState(false);
  const timedOutRef = useRef(onTimeout);
  timedOutRef.current = onTimeout;
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => {
      setTimedOut(true);
      timedOutRef.current?.();
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [ready, timeoutMs]);

  const { paid, quantity } = purchase;
  const person = scope === "person";
  const phase = ready ? "ready" : timedOut ? "timeout" : "processing";
  const title =
    phase === "ready"
      ? person
        ? t.purchase.personReadyTitle(productName)
        : t.purchase.readyTitle({ seats: quantity, product: productName })
      : phase === "timeout"
        ? t.purchase.timeout.title(paid)
        : t.purchase.headline(paid);
  const body =
    phase === "ready"
      ? person
        ? t.purchase.personReadyBody({ product: productName, paid })
        : t.purchase.readyBody({ product: productName, paid })
      : phase === "timeout"
        ? t.purchase.timeout.body
        : person
          ? t.purchase.personSettingUp(productName)
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

/** Hazard tape from the notice tokens: an amber and dark-amber frame no real notice uses. */
const HAZARD_TAPE: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(-45deg, var(--mentra-error) 0 10px, color-mix(in srgb, var(--mentra-error) 18%, var(--mentra-error-bg)) 10px 20px)",
};

/**
 * Dev and staging only, where billing is in test mode: which environment, the card to pay with (grouped as it is
 * read, copied as its bare digits), and that only Organization Admins see billing there.
 */
export function TestModeBanner({ testMode }: { testMode: Pick<TestMode, "cardNumber" | "environment"> }) {
  const digits = testMode.cardNumber.replace(/\s+/g, "");
  return (
    <div role="note" aria-label={t.testMode.label(testMode.environment)} className="rounded-[16px] p-1.5" style={HAZARD_TAPE}>
      <div className="bg-error text-error-foreground flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[11px] px-4 py-3.5">
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
          <p className="mt-1 opacity-80">{t.testMode.note}</p>
        </div>
        <CopyButton text={digits} label={t.testMode.copy} />
      </div>
    </div>
  );
}

/**
 * The line above the cards: "2 licenses · $295 a month in total", from billing's own total of the licenses it
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
 * rather than cards without names. `personal` is the personal Billing page's wording.
 */
export function LicensesUnavailable({
  onRetry,
  retrying = false,
  personal = false,
}: {
  onRetry(): void;
  retrying?: boolean;
  personal?: boolean;
}) {
  const words = personal ? t.personal.unavailable : t.page.unavailable;
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
