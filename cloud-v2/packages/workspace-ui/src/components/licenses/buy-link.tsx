/**
 * What a `?buy=<product>` link answers on the Licenses page, by what the person needs. Once the page's reads are in,
 * the first row of the table that matches decides, and the page shows no note:
 *
 * 1. the viewer holds the product (a seat of a license of it that hasn't ended): a dialog, **held**;
 * 2. they have a membership and may assign licenses, and a license of it is free (in its term, with a license left):
 *    **assign**, with no click, to them (Core's ordinary assignment, no payment), then a dialog says so;
 * 3. they may not manage billing: **ask**, a dialog that names who to ask;
 * 4. billing isn't offered to them: **not here**;
 * 5. the workspace has a card for the product and they have a membership: **add**, straight to billing's hosted page
 *    for one more license assigned to them (`add_seats`, `seats: 1`, `forMe`), when one of its licenses lists
 *    `add_seats` and isn't over-assigned, else **full**;
 * 6. the workspace has a card and they have no membership (an Organization Admin visiting): **already has**;
 * 7. billing sells it now: **buy**, straight to billing's checkout for one license (Core assigns the buyer), or, where
 *    billing's smallest purchase is more than one, **choose**, the seats dialog;
 * 8. anything else: **not for sale**.
 *
 * `decideLink` is the pure half. `LinkDialog` is the drawing half, and does what the outcome asks of it with no
 * click: the two requests are assigning the free license and asking billing for a hosted page, in this tab (the page
 * returns to the portal) through the same `useHostedAction` as every other ↗ button. A refusal of either is drawn in a
 * dialog. Every dialog is titled with the product's name, `licenseStrings.page.title` where the catalog doesn't know
 * it, and shows the product's icon; its words are `licenseStrings.page.buyLink`.
 */

import { useEffect, useRef } from "react";
import type { LicenseView, MemberView, WorkspaceDetail } from "@mentra/workspace-contract";
import type { BillingAction, BillingStatus, CatalogEntry } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../../api";
import type { BillingApi } from "../../billing-api";
import type { BillingScope } from "../../billing-scope";
import { isLicenseChangedError } from "../../errors";
import { holdsSeat, joinLicenses, listedAction } from "../../lib/license-join";
import { useSeatMutation } from "../../queries";
import { can } from "../../roles";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Dialog } from "../../ui/dialog";
import { AlertText, Spinner } from "../common";
import { canBuy } from "./catalog";
import { HostedFeedback, useHostedAction, type NavigateOut } from "./hosted-action";
import { SeatErrorNotice } from "./parts";
import { ProductIcon } from "./product";
import { IconTitle } from "./purchase-dialog";
import { seatHolders } from "./seats";

/** What a link was answered with, and the license it acts on and the counts and names its words need. */
export type LinkOutcome = { product: string; entry: CatalogEntry | null } & (
  | { kind: "held" }
  | { kind: "assign"; licenseId: string }
  | { kind: "ask" }
  | { kind: "not_here" }
  | { kind: "add"; licenseId: string; action: BillingAction }
  | { kind: "full"; count: number; people: string[] }
  | { kind: "already_has" }
  | { kind: "buy" }
  | { kind: "choose" }
  | { kind: "not_for_sale" }
);

/** Whether a license is inside its term at `now`: it has begun and is paid through a later time. */
function inTerm(license: Pick<LicenseView, "validFrom" | "paidThrough">, now: number): boolean {
  return Date.parse(license.validFrom) <= now && now < Date.parse(license.paidThrough);
}

/**
 * Which answer a link for `product` gets, from the table above. `licenses` is Core's whole list for the viewer,
 * `status` billing's (null where the viewer isn't offered billing), `manage` whether billing is offered to them, and
 * `now` the time in ms. The license an outcome acts on is the first free license in Core's order (assign) or the first
 * license billing lists `add_seats` for that isn't over-assigned (add); the counts and names of a full answer cover
 * every not-ended license of the product, named in seat order.
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
    const free = live.find((license) => inTerm(license, now) && license.seatsUsed < license.quantity);
    if (free) return { ...base, kind: "assign", licenseId: free.licenseId };
  }

  if (!can(workspace, "workspace.billing.manage")) return { ...base, kind: "ask" };
  if (!manage) return { ...base, kind: "not_here" };

  const card = joinLicenses({ licenses, billing: status?.licenses ?? null, catalog: products }).some((joined) => joined.product === product);
  if (card) {
    // A card billing has but Core has no license for yet (being set up) has nothing to add to: the workspace has it.
    if (membershipId === null || live.length === 0) return { ...base, kind: "already_has" };
    for (const license of live) {
      const billing = status?.licenses.find((candidate) => candidate.licenseId === license.licenseId) ?? null;
      const action = listedAction(billing, "add_seats");
      if (action !== null && license.seatsUsed <= license.quantity) return { ...base, kind: "add", licenseId: license.licenseId, action };
    }
    const seen = new Set<string>();
    const people: string[] = [];
    for (const license of live) {
      for (const holder of seatHolders(license, members)) {
        if (seen.has(holder.membershipId)) continue;
        seen.add(holder.membershipId);
        people.push(holder.label);
      }
    }
    return { ...base, kind: "full", count: live.reduce((sum, license) => sum + license.quantity, 0), people };
  }

  if (entry !== null && canBuy(entry)) return { ...base, kind: entry.offer.buy.minSeats > 1 ? "choose" : "buy" };
  return { ...base, kind: "not_for_sale" };
}

export interface LinkDialogProps {
  /** What the link was answered with: any outcome but `choose`, which is the Buy dialog's. */
  outcome: Exclude<LinkOutcome, { kind: "choose" }>;
  workspace: Pick<WorkspaceDetail, "workspaceId" | "name" | "membership">;
  api: WorkspaceApi;
  billing: BillingApi;
  scope: BillingScope;
  navigateOut: NavigateOut;
  /** Done, Escape, the × and the backdrop. */
  onClose(): void;
}

/**
 * The answer to a link, started once when it is mounted (give it a `key` per link). `assign` assigns the free license to
 * the viewer's membership and then says "You now have <product>!" and to open the Mentra App; `add` and `buy` ask billing for the hosted page and
 * send this tab there, saying "Opening checkout…" meanwhile; a refusal of any is a dialog with its words and Done. The
 * other outcomes are a dialog that says why.
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
  // Back from the hosted page can bring this page out of the browser's back/forward cache as it was when it left: the
  // dialog locked on "Opening checkout…", with a request that is long over. Closing it ends the outcome, and its state.
  const leaving = outcome.kind === "add" || outcome.kind === "buy";
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!leaving) return;
    const restored = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) close.current();
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, [leaving]);
  // React's strict mode runs an effect twice from the same render: the request is made once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    if (outcome.kind === "assign" && membershipId !== null) {
      started.current = true;
      assign.mutate({ licenseId: outcome.licenseId, membershipId });
    } else if (outcome.kind === "add") {
      started.current = true;
      // Back to the portal in this tab, whatever billing says of the action: nothing here is a click that could open another.
      hosted.run({ action: { kind: outcome.action.kind, fallbackLabel: outcome.action.fallbackLabel }, licenseId: outcome.licenseId, seats: 1, forMe: true, name });
    } else if (outcome.kind === "buy") {
      started.current = true;
      hosted.run({ product: outcome.product, seats: 1, name });
    }
    // Once, for the outcome this was mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let lines: string[] = [];
  // Assigned: the dialog is titled "You now have <product>!" beside the product's icon, and says only what to do next.
  let title: string | null = null;
  let body: "lines" | "opening" | "assignment" | "hosted" = "lines";
  switch (outcome.kind) {
    case "held":
      lines = [words.held(name)];
      break;
    case "assign":
      // While it is being assigned the page shows nothing; once it is, the person is told.
      if (assign.isSuccess) {
        const now = words.youNowHave(name);
        title = now.title;
        lines = [now.body];
      } else if (assign.isError) body = "assignment";
      else return null;
      break;
    case "add":
    case "buy":
      body = hosted.error !== null ? "hosted" : "opening";
      break;
    case "full": {
      const full = words.full(workspace.name, outcome.count, name, t.names.short(outcome.people));
      // With nobody holding a seat (a license out of its term) there is no one to unassign.
      lines = outcome.people.length === 0 ? [full.body] : [full.body, full.hint];
      break;
    }
    case "already_has":
      lines = [words.alreadyHas(workspace.name, name)];
      break;
    case "ask":
      lines = [words.askAnAdmin(workspace.name, entry?.name ?? words.anyProduct)];
      break;
    case "not_here":
      lines = [words.notHere];
      break;
    case "not_for_sale":
      lines = [words.notForSale];
      break;
  }

  const opening = body === "opening";
  return (
    <Dialog
      open
      onClose={onClose}
      locked={opening}
      title={title !== null ? <IconTitle entry={entry} title={title} /> : (entry?.name ?? t.page.title)}
      className="max-w-[480px]"
    >
      <div data-link={outcome.kind} className="space-y-5">
        <div className="flex items-start gap-3">
          {entry && title === null ? <ProductIcon product={entry} size={40} /> : null}
          <div className="min-w-0 flex-1 space-y-2 text-[15px] leading-6">
            {opening ? (
              <p role="status" className="flex items-center gap-2.5">
                <Spinner className="size-4" />
                {words.openingCheckout}
              </p>
            ) : null}
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {body === "assignment" ? (
              // The person chose nothing: a license that changed under the link is not "while you were choosing".
              isLicenseChangedError(assign.error) ? <AlertText tone="neutral">{words.assignTaken}</AlertText> : <SeatErrorNotice error={assign.error} />
            ) : null}
            {body === "hosted" ? <HostedFeedback action={hosted} /> : null}
          </div>
        </div>
      </div>
      {opening ? null : (
        <div className="-mx-6 -mb-6 flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4 sm:-mx-7 sm:-mb-7 sm:px-7">
          <Button type="button" onClick={onClose}>
            {words.done}
          </Button>
        </div>
      )}
    </Dialog>
  );
}
