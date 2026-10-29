/**
 * The Licenses page's banner and its one-line states, as the design draws them: test mode on dev and staging, and
 * "unavailable". (Back from checkout is a dialog, `PurchaseDialog`.) The words are `strings/licenses.ts`; these only
 * place them.
 */

import { CreditCardIcon, FlaskConicalIcon, XIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";
import type { TestMode } from "@mentra/workspace-contract/portal-billing";
import { groupCardNumber } from "../../lib/billing-format";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { CopyButton } from "../common";

/** Hazard tape from the notice tokens: an amber and dark-amber frame no real notice uses. */
const HAZARD_TAPE: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(-45deg, var(--mentra-error) 0 10px, color-mix(in srgb, var(--mentra-error) 18%, var(--mentra-error-bg)) 10px 20px)",
};

/** The session's storage key for a test-mode notice the viewer hid: one key, so it holds on every page of the session. */
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
