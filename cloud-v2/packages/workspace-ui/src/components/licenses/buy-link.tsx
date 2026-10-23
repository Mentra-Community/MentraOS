/**
 * What a `?buy=<product>` link answers on the Licenses page: one dialog, chosen by what the person needs.
 *
 * `decideLink` is the pure half. Once the page's reads are in, the first row of the table that matches decides, and the
 * page shows no note (the dialog is the answer):
 *
 * 1. the viewer holds the product (a seat of a license of it that hasn't ended): **held**;
 * 2. they have a membership and may assign licenses, and a license of it is free (in its term, with a license left):
 *    **free**, which assigns it to them with no payment, since taking a free license needs no billing;
 * 3. they may not manage billing: **ask**, an Admin or Owner;
 * 4. billing isn't offered to them: **not here**;
 * 5. the workspace has a card for the product and they have a membership: **add** one for them, when one of its
 *    licenses lists `add_seats` for it and isn't over-assigned, else **full**;
 * 6. the workspace has a card and they have no membership (an Organization Admin visiting): **already has**;
 * 7. billing sells it now: **buy**, the existing Buy dialog (drawn by the page, not here);
 * 8. anything else: **not for sale**.
 *
 * `LinkDialog` is the drawing half. It owns the two requests a dialog can make: assigning the free license to the
 * viewer (Core's ordinary assignment) and asking billing for the hosted page that adds one license for them
 * (`forMe`). Nothing is requested until the person presses a button. Every dialog is titled with the product's name,
 * `licenseStrings.page.title` where the catalog doesn't know it, and shows the product's icon; its words are
 * `licenseStrings.page.buyLink`.
 */

import type { LicenseView, MemberView, WorkspaceDetail } from "@mentra/workspace-contract";
import { isPerSeat, type BillingAction, type BillingStatus, type CatalogEntry, type LicenseBilling } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../../api";
import type { BillingApi } from "../../billing-api";
import type { BillingScope } from "../../billing-scope";
import { formatMoney, formatRecurrence, taxNote } from "../../lib/billing-format";
import { holdsSeat, joinLicenses, listedAction } from "../../lib/license-join";
import { useSeatMutation } from "../../queries";
import { can } from "../../roles";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { canBuy } from "./catalog";
import { HostedFeedback, useHostedAction, type NavigateOut } from "./hosted-action";
import { HostedPageButton, SeatErrorNotice } from "./parts";
import { ProductIcon } from "./product";
import { seatHolders } from "./seats";

/** What a link was answered with, and the license it acts on and the counts and names its words need. */
export type LinkOutcome = { product: string; entry: CatalogEntry | null } & (
  | { kind: "held" }
  | { kind: "free"; licenseId: string; free: number }
  | { kind: "ask" }
  | { kind: "not_here" }
  | { kind: "add"; licenseId: string; count: number; people: string[]; action: BillingAction; billing: LicenseBilling }
  | { kind: "full"; count: number; people: string[] }
  | { kind: "already_has" }
  | { kind: "buy" }
  | { kind: "not_for_sale" }
);

/** Whether a license is inside its term at `now`: it has begun and is paid through a later time. */
function inTerm(license: Pick<LicenseView, "validFrom" | "paidThrough">, now: number): boolean {
  return Date.parse(license.validFrom) <= now && now < Date.parse(license.paidThrough);
}

/**
 * Which dialog a link for `product` gets, from the table above. `licenses` is Core's whole list for the viewer,
 * `status` billing's (null where the viewer isn't offered billing), `manage` whether billing is offered to them, and
 * `now` the time in ms. The license an outcome acts on, and the counts and names it states, are decision 2's: the
 * first free license in Core's order (free), the first license billing lists `add_seats` for that isn't
 * over-assigned (add), and every not-ended license of the product for counts and names, named in seat order.
 */
export function decideLink({
  product,
  workspace,
  licenses,
  members,
  products,
  status,
  manage,
  now,
}: {
  product: string;
  workspace: Pick<WorkspaceDetail, "membership" | "capabilities">;
  licenses: readonly LicenseView[];
  members: readonly MemberView[];
  products: readonly CatalogEntry[];
  status: Pick<BillingStatus, "licenses"> | null;
  manage: boolean;
  now: number;
}): LinkOutcome {
  const entry = products.find((candidate) => candidate.product === product) ?? null;
  const base = { product, entry };
  const live = licenses.filter((license) => license.product === product && !license.endedAt);
  const membershipId = workspace.membership?.membershipId ?? null;

  if (membershipId !== null && live.some((license) => holdsSeat(license, membershipId))) return { ...base, kind: "held" };

  if (membershipId !== null && can(workspace, "workspace.licenses.assign")) {
    const free = live.filter((license) => inTerm(license, now) && license.seatsUsed < license.quantity);
    if (free.length > 0) {
      const total = free.reduce((sum, license) => sum + (license.quantity - license.seatsUsed), 0);
      return { ...base, kind: "free", licenseId: free[0]!.licenseId, free: total };
    }
  }

  if (!can(workspace, "workspace.billing.manage")) return { ...base, kind: "ask" };
  if (!manage) return { ...base, kind: "not_here" };

  const card = joinLicenses({ licenses, billing: status?.licenses ?? null, catalog: products }).some((joined) => joined.product === product);
  if (card) {
    // A card billing has but Core has no license for yet (being set up) has nothing to add to: the workspace has it.
    if (membershipId === null || live.length === 0) return { ...base, kind: "already_has" };
    const count = live.reduce((sum, license) => sum + license.quantity, 0);
    const seen = new Set<string>();
    const people: string[] = [];
    for (const license of live) {
      for (const holder of seatHolders(license, members)) {
        if (seen.has(holder.membershipId)) continue;
        seen.add(holder.membershipId);
        people.push(holder.label);
      }
    }
    for (const license of live) {
      const billing = status?.licenses.find((candidate) => candidate.licenseId === license.licenseId) ?? null;
      const action = listedAction(billing, "add_seats");
      if (billing !== null && action !== null && license.seatsUsed <= license.quantity) {
        return { ...base, kind: "add", licenseId: license.licenseId, count, people, action, billing };
      }
    }
    return { ...base, kind: "full", count, people };
  }

  if (entry !== null && canBuy(entry)) return { ...base, kind: "buy" };
  return { ...base, kind: "not_for_sale" };
}

/** The one line under the rule in the Add dialog: "1 more license · $29 a month · before tax". */
function addTerms(billing: LicenseBilling, locale: string): string {
  const price = isPerSeat(billing.price)
    ? `${formatMoney(billing.price.unit, locale)} ${formatRecurrence(billing.price.recurrence, locale)}`
    : billing.price.fallbackLabel;
  return t.page.buyLink.addTerms({ price, note: taxNote(billing.tax) });
}

export interface LinkDialogProps {
  /** What the link was answered with: any outcome but `buy`, which is the Buy dialog's. */
  outcome: Exclude<LinkOutcome, { kind: "buy" }>;
  workspace: Pick<WorkspaceDetail, "workspaceId" | "name" | "membership">;
  api: WorkspaceApi;
  billing: BillingApi;
  scope: BillingScope;
  navigateOut: NavigateOut;
  /** Cancel, Done, Escape, the × and the backdrop. */
  onClose(): void;
}

/**
 * The dialog for a link's outcome, open for as long as it is mounted. It makes no request until a button is pressed:
 * "Assign it to me" assigns the free license to the viewer's membership (Core's assignment, no payment), after which
 * the dialog reads "<product> is assigned to you."; "Continue to payment ↗" asks billing for the hosted page that adds
 * one license for the viewer (`forMe`), and goes there. A refusal of either is drawn in the dialog.
 */
export function LinkDialog({ outcome, workspace, api, billing, scope, navigateOut, onClose }: LinkDialogProps) {
  const words = t.page.buyLink;
  const { entry, product } = outcome;
  const name = entry?.name ?? product;
  const hosted = useHostedAction({ billing, scope, navigateOut, api, product: name });
  const membershipId = workspace.membership?.membershipId ?? null;
  const assign = useSeatMutation(api, workspace.workspaceId, (variables: { licenseId: string; membershipId: string }) =>
    api.assignSeat(workspace.workspaceId, variables.licenseId, variables.membershipId),
  );
  const assigned = assign.isSuccess;

  let lines: string[];
  let sum: string | null = null;
  let feedback: "assignment" | "hosted" | null = null;
  let buttons: "done" | "free" | "add";
  switch (outcome.kind) {
    case "held":
      lines = [words.held(name)];
      buttons = "done";
      break;
    case "free":
      lines = assigned ? [words.assigned(name)] : [words.free(workspace.name, outcome.free, name)];
      feedback = "assignment";
      buttons = assigned ? "done" : "free";
      break;
    case "add":
      lines = [words.add(workspace.name, outcome.count, name, t.names.short(outcome.people))];
      sum = addTerms(outcome.billing, billing.locale);
      feedback = "hosted";
      buttons = "add";
      break;
    case "full": {
      const full = words.full(workspace.name, outcome.count, name, t.names.short(outcome.people));
      lines = [full.body, full.hint];
      buttons = "done";
      break;
    }
    case "already_has":
      lines = [words.alreadyHas(workspace.name, name)];
      buttons = "done";
      break;
    case "ask":
      lines = [words.askAnAdmin(workspace.name, entry?.name ?? words.anyProduct)];
      buttons = "done";
      break;
    case "not_here":
      lines = [words.notHere];
      buttons = "done";
      break;
    case "not_for_sale":
      lines = [words.notForSale];
      buttons = "done";
      break;
  }

  const working = assign.isPending || hosted.pending !== null;
  return (
    <Dialog open onClose={onClose} locked={working} title={entry?.name ?? t.page.title} className="max-w-[480px]">
      <div data-link={outcome.kind} className="space-y-5">
        <div className="flex items-start gap-3">
          {entry ? <ProductIcon product={entry} size={40} /> : null}
          <div className="min-w-0 flex-1 space-y-2 text-[15px] leading-6">
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </div>
        {sum !== null ? <p className="border-t pt-4 text-sm font-semibold tabular-nums">{sum}</p> : null}
        {feedback === "assignment" ? <SeatErrorNotice error={assign.error} /> : null}
        {feedback === "hosted" ? <HostedFeedback action={hosted} /> : null}
      </div>
      <div className="-mx-6 -mb-6 flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4 sm:-mx-7 sm:-mb-7 sm:px-7">
        {buttons === "done" ? (
          <Button type="button" onClick={onClose}>
            {words.done}
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" disabled={working} onClick={onClose}>
              {t.buy.cancel}
            </Button>
            {outcome.kind === "free" && membershipId !== null ? (
              <Button
                type="button"
                disabled={working}
                aria-busy={assign.isPending || undefined}
                onClick={() => assign.mutate({ licenseId: outcome.licenseId, membershipId })}
              >
                {words.assignToMe}
              </Button>
            ) : null}
            {outcome.kind === "add" ? (
              <HostedPageButton
                variant="default"
                size="default"
                pending={hosted.pending !== null}
                disabled={working}
                onClick={() => hosted.run({ action: outcome.action, licenseId: outcome.licenseId, seats: 1, forMe: true, name })}
              >
                {t.buy.continue}
              </HostedPageButton>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}
