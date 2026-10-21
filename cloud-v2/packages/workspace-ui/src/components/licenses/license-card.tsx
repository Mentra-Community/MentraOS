/**
 * One license on the Licenses page (and, for a person, on the personal Billing page), drawn from a card the
 * join made (`joinLicenses`): the product's icon, name, description and features; one status badge; a strip of
 * facts; a notice when something needs doing; the seats; and a "…" menu of what billing can do about the license.
 *
 * It has three views of the same license:
 * - `workspace`: a manager's. Core's seats and, where the viewer is offered billing, billing's dates and cost.
 *   Without billing's entry the card shows only its Seats: no money, no actions.
 * - `member`: a person who holds a seat. "You have a seat", since when, and where it works: no totals, no money,
 *   nothing about anyone else.
 * - `person`: a personal license. Billing's facts and actions, and no seats.
 *
 * Every action is billing's: a button or menu item exists only where billing lists that action for the license,
 * and each leaves the portal through `useHostedAction`. Billing's actions are placed by kind. The payment ones
 * sit in their notices, `add_seats` with the seats, and everything else, including a kind this code doesn't
 * know, in the "…" menu under billing's own label. An unknown status is a grey badge with billing's label and no
 * notice. Nothing here throws on a value it doesn't know.
 *
 * Dates: the one a failed payment's seats stop on appears in that notice and nowhere else, and no state says
 * "Paid through".
 */

import { ArrowUpRightIcon, MoreHorizontalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { LicenseView, MemberView } from "@mentra/workspace-contract";
import type { BillingAction } from "@mentra/workspace-contract/portal-billing";
import type { WorkspaceApi } from "../../api";
import type { BillingApi } from "../../billing-api";
import type { BillingScope } from "../../billing-scope";
import { errorMessage } from "../../errors";
import { costFact, formatDay, formatDayShort, renewalCadence } from "../../lib/billing-format";
import { listedAction, type JoinedLicense, type SeatCounts } from "../../lib/license-join";
import { cn } from "../../lib/utils";
import { useSeatMutation } from "../../queries";
import { licenseStrings as t } from "../../strings/licenses";
import { Menu, type MenuItem } from "../../ui/menu";
import { Meter } from "../../ui/meter";
import { Card } from "../../ui/card";
import { Spinner } from "../common";
import { HostedFeedback, useHostedAction, type NavigateOut } from "./hosted-action";
import { Fact, HostedPageButton, Notice, Skeleton, StatusBadge, type StatusBadgeStatus } from "./parts";
import { PeoplePickerDialog } from "./people-picker";
import { FeatureChips, ProductIcon } from "./product";
import { SeatRoster, SeatStrip, seatHolders, type AddSeatsControl, type SeatHolder } from "./seats";

/** Whose eyes the card is drawn for. */
export type LicenseCardView = "workspace" | "member" | "person";

export interface LicenseCardProps {
  /** From `joinLicenses`. */
  card: JoinedLicense;
  view: LicenseCardView;
  /** Whose billing the actions are for: `workspaceScope(id)`, or `ACCOUNT_SCOPE` on the personal page. */
  scope: BillingScope;
  billing: Pick<BillingApi, "session">;
  navigateOut: NavigateOut;
  /** The portal's locale, for dates and amounts. */
  locale: string;
  /** For a member's "Given by <workspace>". */
  workspaceName?: string;
  /** Core's workspace API, for assigning and unassigning seats. Without it (or in another view) the seats can't be changed. */
  api?: WorkspaceApi;
  /** The workspace's members, to name who holds each seat. */
  members?: readonly MemberView[];
  /** The viewer holds `workspace.licenses.assign`. */
  canAssign?: boolean;
  /** Several licenses are on the page: the seats fold into a strip until it is opened. A single license shows its roster. */
  folded?: boolean;
  /** The license just bought: ringed in green. */
  highlight?: boolean;
  /** The time a failed payment's date is compared with (ms since the epoch); now unless given. */
  now?: number;
}

/** The surface name of a press inside the people picker, whose refusals the picker draws itself. */
const PICKER = "picker";

const WARN_RING = "border-error-foreground/35 ring-error ring-4";
const GREEN_RING = "border-brand/45 ring-info ring-4";

/** What the badge says, or null when there is nothing to say (a manager who isn't offered billing, and whose license isn't over). */
function badgeFor(card: JoinedLicense, view: LicenseCardView, locale: string): StatusBadgeStatus | null {
  if (view === "member") return { label: t.status.youHaveASeat, tone: "success" };
  if (card.problem === "over") return { label: t.status.over(card.seats?.over ?? 0), tone: "warn" };
  const billing = card.billing;
  if (billing === null) return null;
  const label = t.status.label(billing.status, billing.fallbackStatusLabel, billing.endsAt ? formatDayShort(billing.endsAt, locale) : undefined);
  switch (billing.status) {
    case "active":
      return { label, tone: "success" };
    case "past_due":
    case "incomplete":
      return { label, tone: "warn" };
    case "processing":
      return { label, tone: "neutral", spin: true };
    default:
      return { label, tone: "neutral" };
  }
}

/** A fact whose value isn't known yet. */
function Pending({ label }: { label: string }) {
  return <Fact label={label} value={<Skeleton className="w-28" />} foot={<Skeleton className="h-3 w-14" />} />;
}

function SeatsFact({ seats }: { seats: SeatCounts }) {
  const over = seats.over > 0;
  return (
    <Fact
      label={t.facts.seats.label}
      value={over ? t.facts.seats.assigned(seats.used) : t.facts.seats.inUse(seats.used, seats.quantity)}
      foot={
        over ? (
          <span className="text-error-foreground font-semibold">{t.facts.seats.moreThanCovered(seats.over, seats.quantity)}</span>
        ) : (
          t.facts.seats.free(seats.free)
        )
      }
    >
      <Meter used={seats.used} total={seats.quantity} />
    </Fact>
  );
}

/** Where the license's term stands: its renewal, its end, or the renewal a failed payment left unpaid. */
function TermFact({ card, locale }: { card: JoinedLicense; locale: string }) {
  const billing = card.billing;
  if (billing === null || billing.status === "processing") return <Pending label={t.facts.term.renews} />;
  const day = (iso: string) => formatDay(iso, locale);
  if (billing.status === "past_due" && billing.renewsAt) {
    return (
      <Fact
        label={t.facts.term.renewal}
        value={day(billing.renewsAt)}
        foot={<span className="text-error-foreground font-semibold">{t.facts.term.notPaid}</span>}
      />
    );
  }
  if (billing.status === "ending") {
    return billing.endsAt ? (
      <Fact label={t.facts.term.ends} value={day(billing.endsAt)} foot={t.facts.term.doesntRenew} />
    ) : (
      <Pending label={t.facts.term.ends} />
    );
  }
  if (billing.renewsAt) {
    const cadence = renewalCadence(billing.price, locale);
    return (
      <Fact
        label={t.facts.term.renews}
        value={day(billing.renewsAt)}
        foot={billing.endsAt ? t.facts.term.until(day(billing.endsAt)) : cadence ? t.facts.term.every(cadence) : undefined}
      />
    );
  }
  if (billing.endsAt) return <Fact label={t.facts.term.ends} value={day(billing.endsAt)} foot={t.facts.term.doesntRenew} />;
  return <Pending label={t.facts.term.renews} />;
}

/** What the license costs, from billing's own total; an ending license says it has no more charges. */
function CostFactView({ card, view, locale }: { card: JoinedLicense; view: LicenseCardView; locale: string }) {
  const billing = card.billing;
  if (billing === null || billing.status === "processing") return <Pending label={t.facts.cost.label} />;
  const cost = costFact(billing, locale, view === "person" ? "person" : "workspace");
  return <Fact label={t.facts.cost.label} value={cost.value} foot={billing.status === "ending" ? t.facts.cost.noMoreCharges : cost.foot} />;
}

/** The miniapps a license's features are for, once each, in the order billing lists them. */
function miniappsOf(card: JoinedLicense): string[] {
  return [...new Set(card.features.flatMap((feature) => (feature.appName ? [feature.appName] : [])))];
}

/** The strip of facts for the view, and how many columns it has. */
function factsFor(card: JoinedLicense, view: LicenseCardView, locale: string, workspaceName: string | undefined) {
  if (view === "member") {
    const seat = card.license?.seats?.[0];
    const apps = miniappsOf(card);
    return {
      columns: apps.length > 0 ? 2 : 1,
      facts: (
        <>
          <Fact
            label={t.facts.own.seat}
            value={seat ? t.facts.own.since(formatDay(seat.assignedAt, locale)) : t.status.youHaveASeat}
            foot={workspaceName ? t.facts.own.givenBy(workspaceName) : undefined}
          />
          {apps.length > 0 ? <Fact label={t.facts.own.worksIn} value={t.names.list(apps)} foot={t.facts.own.nextTime} /> : null}
        </>
      ),
    };
  }
  if (view === "person") {
    if (card.billing === null) return { columns: 0, facts: null };
    return {
      columns: 2,
      facts: (
        <>
          <TermFact card={card} locale={locale} />
          <CostFactView card={card} view={view} locale={locale} />
        </>
      ),
    };
  }
  const seats = card.seats ? <SeatsFact seats={card.seats} /> : <Pending label={t.facts.seats.label} />;
  if (card.billing === null) return { columns: 1, facts: seats };
  return {
    columns: 3,
    facts: (
      <>
        {seats}
        <TermFact card={card} locale={locale} />
        <CostFactView card={card} view={view} locale={locale} />
      </>
    ),
  };
}

const COLUMNS: Record<number, string> = { 1: "", 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" };

export function LicenseCard({
  card,
  view,
  scope,
  billing,
  navigateOut,
  locale,
  workspaceName,
  api,
  members = [],
  canAssign = false,
  folded = false,
  highlight = false,
  now,
}: LicenseCardProps) {
  const hosted = useHostedAction({ billing, scope, navigateOut, api, product: card.name });
  const [picking, setPicking] = useState(false);
  const clock = now ?? Date.now();

  // Billing's entry is for those offered billing; a member's card has none.
  const entry = view === "member" ? null : card.billing;
  const listed: readonly BillingAction[] = entry?.actions ?? [];
  const has = (kind: string) => listedAction(entry, kind);
  const withSeats = view === "workspace" && card.license !== null && card.seats !== null;
  const addSeatsAction = withSeats ? has("add_seats") : null;
  const busy = hosted.pending !== null;

  const press = (action: BillingAction, variant: "default" | "secondary", options: { seats?: number; label?: string } = {}) => (
    <HostedPageButton
      key={`${action.kind}${options.seats ?? ""}`}
      variant={variant}
      newTab={action.returns === false}
      pending={hosted.pending === action.kind}
      disabled={busy}
      onClick={() => hosted.run({ action, licenseId: card.licenseId, seats: options.seats })}
    >
      {options.label ?? t.actions.label(action.kind, action.fallbackLabel)}
    </HostedPageButton>
  );

  // The notices, and the kinds of action they carry.
  const placed = new Set<string>();
  const notices: ReactNode[] = [];
  const updatePayment = has("update_payment");
  const completePayment = has("complete_payment");
  if (entry?.status === "past_due") {
    const stopsAt = entry.seatsStopAt;
    const words = t.notice.pastDue({
      date: stopsAt ? formatDay(stopsAt, locale) : null,
      stopped: stopsAt ? Date.parse(stopsAt) <= clock : false,
    });
    const first = updatePayment ?? completePayment;
    const buttons = [updatePayment, completePayment].filter((action): action is BillingAction => action !== null);
    for (const action of buttons) placed.add(action.kind);
    notices.push(
      <Notice
        key="past_due"
        tone="warn"
        title={words.title}
        action={buttons.length > 0 ? <>{buttons.map((action) => press(action, action === first ? "default" : "secondary"))}</> : undefined}
      >
        {words.body}
      </Notice>,
    );
  }
  if (entry?.status === "incomplete") {
    const words = t.notice.incomplete(card.name);
    if (completePayment) placed.add(completePayment.kind);
    notices.push(
      <Notice key="incomplete" tone="warn" title={words.title} action={completePayment ? press(completePayment, "default") : undefined}>
        {words.body}
      </Notice>,
    );
  }
  if (view === "workspace" && card.seats !== null && card.seats.over > 0) {
    const { used, quantity, over } = card.seats;
    const words = t.notice.over({ used, quantity, canAddSeats: addSeatsAction !== null });
    notices.push(
      <Notice
        key="over"
        tone="warn"
        title={words.title}
        action={addSeatsAction ? press(addSeatsAction, "secondary", { seats: over, label: t.actions.addSeatsCount(over) }) : undefined}
      >
        {words.body}
      </Notice>,
    );
  }
  if (addSeatsAction) placed.add(addSeatsAction.kind);

  // The "…" menu: every listed action that isn't already on the card, billing's own label for any kind unknown here.
  const menuActions = listed.filter((action) => !placed.has(action.kind));
  const menuPending = hosted.pending !== null && menuActions.some((action) => action.kind === hosted.pending);
  const items: MenuItem[] = menuActions.map((action, index) => ({
      key: `${action.kind}-${index}`,
      onSelect: () => hosted.run({ action, licenseId: card.licenseId }),
      label: (
        <>
          {t.actions.label(action.kind, action.fallbackLabel)}
          <ArrowUpRightIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
          <span className="sr-only">{action.returns === false ? t.actions.opensSecureBillingPageInNewTab : t.actions.opensSecureBillingPage}</span>
        </>
      ),
    }));

  const badge = badgeFor(card, view, locale);
  const { columns, facts } = factsFor(card, view, locale, workspaceName);
  const ring = card.problem === "past_due" ? "warn" : highlight ? "highlight" : null;
  // Add seats from the card draws its refusal on the card; from the picker, in the picker (the card is behind it).
  const fromPicker = hosted.surface === PICKER;
  const addSeatsFrom = (surface?: string): AddSeatsControl | null =>
    addSeatsAction
      ? {
          onClick: () => hosted.run({ action: addSeatsAction, licenseId: card.licenseId }, surface),
          pending: hosted.pending === addSeatsAction.kind,
          newTab: addSeatsAction.returns === false,
          disabled: busy && hosted.pending !== addSeatsAction.kind,
          ...(surface === PICKER ? { error: fromPicker ? hosted.error : null, link: fromPicker ? hosted.link : null } : {}),
        }
      : null;
  // While the picker is open it shows what its own press left; once it is closed the card does, so nothing is lost.
  const onCard = fromPicker && picking ? { error: null, link: null } : hosted;

  return (
    <Card
      role="group"
      aria-label={card.name}
      data-ring={ring ?? undefined}
      // No `overflow-hidden`: the "…" menu opens over the card's edge.
      className={cn("gap-0 py-0", ring === "warn" && WARN_RING, ring === "highlight" && GREEN_RING)}
    >
      <div className="flex items-start gap-4 p-6 max-sm:p-5">
        <ProductIcon product={card} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h2 className="text-lg leading-tight font-semibold">{card.name}</h2>
            {badge ? <StatusBadge status={badge} /> : null}
          </div>
          {card.description ? <p className="text-muted-foreground mt-1 text-sm">{card.description}</p> : null}
          <div className="mt-3 empty:hidden">
            <FeatureChips product={card} />
          </div>
        </div>
        {items.length > 0 ? (
          <Menu
            label={t.card.moreFor(card.name)}
            trigger={menuPending ? <Spinner className="size-4" /> : <MoreHorizontalIcon aria-hidden="true" />}
            items={items}
            disabled={busy}
            className="text-muted-foreground -mt-1 -mr-2"
          />
        ) : null}
      </div>
      {notices.length > 0 || onCard.error !== null || onCard.link !== null ? (
        <div className="space-y-3 px-6 pb-5 max-sm:px-5">
          {notices}
          <HostedFeedback action={onCard} />
        </div>
      ) : null}
      {facts ? (
        <dl className={cn("grid border-t max-sm:divide-y sm:divide-x", COLUMNS[columns], withSeats && "border-b")}>{facts}</dl>
      ) : null}
      {withSeats && card.license && card.seats ? (
        <CardSeats
          license={card.license}
          counts={card.seats}
          productName={card.name}
          scope={scope}
          locale={locale}
          api={api}
          members={members}
          canAssign={canAssign}
          folded={folded}
          addSeats={addSeatsFrom()}
          pickerAddSeats={addSeatsFrom(PICKER)}
          picking={picking}
          onPicking={setPicking}
        />
      ) : null}
    </Card>
  );
}

interface CardSeatsProps {
  license: LicenseView;
  counts: SeatCounts;
  productName: string;
  scope: BillingScope;
  locale: string;
  api: WorkspaceApi | undefined;
  members: readonly MemberView[];
  canAssign: boolean;
  folded: boolean;
  addSeats: AddSeatsControl | null;
  /** The same action, started from the people picker. */
  pickerAddSeats: AddSeatsControl | null;
  /** Whether the people picker is open. The card owns it, so it knows where a refusal should be drawn. */
  picking: boolean;
  onPicking(open: boolean): void;
}

/** The card's seats: read-only where the card has no way to change them, else with assigning and unassigning. */
function CardSeats(props: CardSeatsProps) {
  const { api, scope } = props;
  if (api && scope.kind === "workspace") return <ManagedSeats {...props} api={api} workspaceId={scope.workspaceId} />;
  return <SeatsLayout {...props} canAssign={false} onAssign={() => {}} onUnassign={() => {}} releasing={null} error={null} />;
}

/** The seats with their requests: unassigning, and the people picker that assigns. Both are seat mutations, so billing's status refreshes too. */
function ManagedSeats(props: CardSeatsProps & { api: WorkspaceApi; workspaceId: string }) {
  const { api, workspaceId, license, members, productName, pickerAddSeats, picking, onPicking } = props;
  const release = useSeatMutation(api, workspaceId, (holder: SeatHolder) => api.releaseSeat(workspaceId, license.licenseId, holder.membershipId));
  return (
    <>
      <SeatsLayout
        {...props}
        onAssign={() => onPicking(true)}
        onUnassign={(holder) => {
          release.reset();
          release.mutate(holder);
        }}
        releasing={release.isPending ? release.variables.membershipId : null}
        error={release.error ? errorMessage(release.error) : null}
      />
      {props.canAssign ? (
        <PeoplePickerDialog
          open={picking}
          onClose={() => onPicking(false)}
          api={api}
          workspaceId={workspaceId}
          license={license}
          productName={productName}
          members={members}
          addSeats={pickerAddSeats}
        />
      ) : null}
    </>
  );
}

function SeatsLayout({
  license,
  counts,
  locale,
  members,
  canAssign,
  folded,
  addSeats,
  onAssign,
  onUnassign,
  releasing,
  error,
}: CardSeatsProps & {
  onAssign(): void;
  onUnassign(holder: SeatHolder): void;
  releasing: string | null;
  error: string | null;
}) {
  const [open, setOpen] = useState(false);
  const holders = seatHolders(license, members);
  const controls = { holders, counts, canAssign, blocked: counts.over > 0, addSeats, onAssign };
  const alert =
    error !== null ? (
      <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
        {error}
      </p>
    ) : null;
  if (folded && !open) {
    return (
      <>
        {alert ? <div className="px-6 pt-4 max-sm:px-5">{alert}</div> : null}
        <SeatStrip {...controls} onOpen={() => setOpen(true)} />
      </>
    );
  }
  return (
    <div className="space-y-3 p-6 max-sm:p-5">
      {alert}
      <SeatRoster {...controls} locale={locale} onUnassign={onUnassign} releasing={releasing} onCollapse={folded ? () => setOpen(false) : undefined} />
    </div>
  );
}
