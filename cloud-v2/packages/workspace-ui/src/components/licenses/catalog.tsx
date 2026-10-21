/**
 * Buying from billing's catalog, as the approved design draws it (its `parts2.tsx`): the grid of products an owner
 * with nothing yet is offered, the "Buy a license" dialog an owner with licenses opens, and the seats step.
 *
 * Everything is drawn from what billing sent for each product: its name, description, icon and features, and, for
 * a viewer who may manage the owner's billing, its `offer` (the price, the tax treatment and what buying allows).
 * An entry with no `offer` is display content only: it shows no price and no Buy. An offer whose `buy` is null
 * (the owner holds the product, or a purchase of it is under way) has no Buy either.
 *
 * Prices follow one rule. A `per_seat` price is the only one Core computes with, and the one sum it shows is the
 * seats step's seats × unit. Any other price shows its `fallbackLabel` exactly, with no arithmetic, no renewal
 * claim and no tax note. "before tax" appears only where billing says tax is `excluded`.
 *
 * Every button that leaves the portal for a hosted page is a `HostedPageButton` (marked ↗): Add seats, Continue to
 * payment, and a person's Buy, which asks for their one seat and goes straight to payment (a person never sees the
 * seats step). A workspace's Buy only opens the seats step, so it is a plain button. Where the browser goes is the
 * host's `navigateOut`; the client has already refused any address the contract doesn't accept.
 *
 * Words are in `strings/licenses.ts`. This file imports the client's type only, never its schemas.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isPerSeat, type Buy, type CatalogEntry, type LicenseBilling, type Offer, type Price } from "@mentra/workspace-contract/portal-billing";
import { CircleCheckIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import type { BillingApi } from "../../billing-api";
import { BillingRefusedError, billingErrorMessage } from "../../billing-errors";
import { ownerTypeOf, type BillingScope } from "../../billing-scope";
import { formatMoney, formatRecurrence, priceLine, renewalCadence, taxNote } from "../../lib/billing-format";
import { catalogForOwner, listedAction } from "../../lib/license-join";
import { cn } from "../../lib/utils";
import { billingKeys } from "../../queries";
import { licenseStrings as t, type LicenseScope } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Dialog } from "../../ui/dialog";
import { Label } from "../../ui/label";
import { Stepper } from "../../ui/stepper";
import { HostedPageButton } from "./parts";
import { ProductIcon } from "./product";

/** What the buying components ask of billing's client: the portal's locale, a purchase and a session. */
export type CatalogBilling = Pick<BillingApi, "locale" | "purchase" | "session">;

/** What every buying component needs to reach billing and to leave for a hosted page. */
export interface BuyingHost {
  billing: CatalogBilling;
  scope: BillingScope;
  /** Sends the browser to a hosted page. Billing's client only ever answers an address the contract accepts. */
  navigateOut(url: string): void;
}

export interface CatalogProps extends BuyingHost {
  /** `catalog.products`. An entry whose `ownerTypes` lack the scope's type is dropped here as well. */
  products: readonly CatalogEntry[];
  /** `status.licenses`: which products the owner holds, with their seats and the actions billing lists. */
  licenses?: readonly LicenseBilling[];
  /** How many members the workspace has, for the seats step ("Your workspace has 14 members."). */
  memberCount?: number;
}

/** An entry billing offers to this viewer for sale now: it has an offer, and the offer's `buy` isn't null. */
export type BuyableEntry = CatalogEntry & { offer: Offer & { buy: Buy } };

/** Whether billing offers `entry` for sale to this viewer now (a price and `buy` limits). */
export function canBuy(entry: CatalogEntry): entry is BuyableEntry {
  return entry.offer !== undefined && entry.offer.buy !== null;
}

// ---- seats ------------------------------------------------------------------------------------------------------

interface SeatBounds {
  min: number;
  max: number;
  /** `defaultSeats`, held to the bounds. */
  initial: number;
}

/**
 * The seats a purchase may name: billing's `minSeats` to its `maxSeats`, held so that seats × unit never leaves the
 * safe integers (a price in the minor unit is a safe integer, and so must be its sum). Without a `maxSeats` that
 * ceiling is the only bound.
 */
function seatBounds(buy: Buy, price: Price): SeatBounds {
  const min = buy.minSeats;
  const ceiling =
    isPerSeat(price) && price.unit.amountMinor > 0 ? Math.floor(Number.MAX_SAFE_INTEGER / price.unit.amountMinor) : Number.MAX_SAFE_INTEGER;
  const max = Math.max(min, Math.min(buy.maxSeats ?? ceiling, ceiling));
  return { min, max, initial: Math.min(max, Math.max(min, buy.defaultSeats)) };
}

// ---- asking billing ---------------------------------------------------------------------------------------------

type Request =
  | { kind: "buy"; entry: CatalogEntry; seats: number }
  | { kind: "seats"; entry: CatalogEntry; license: LicenseBilling };

interface Hosted {
  /** What billing is being asked now, if anything: nothing else is started meanwhile. */
  busy: { kind: Request["kind"]; product: string } | null;
  /** The last refusal in words, with billing's code when it sent one. A new request clears it. */
  failure: { message: string; code: string | null } | null;
  buy(entry: CatalogEntry, seats: number): void;
  addSeats(license: LicenseBilling, entry: CatalogEntry): void;
}

/**
 * One request at a time to billing for the hosted page of a purchase or of Add seats, and on to it. A request the
 * component has let go of (its dialog closed) doesn't send the browser anywhere when it answers. `already_licensed`
 * means the catalog the screen shows is stale, so billing's answers for the owner are read again.
 */
function useHosted({ billing, scope, navigateOut }: BuyingHost): Hosted {
  const client = useQueryClient();
  // Set the moment a request starts: the mutation's own `isPending` reaches the screen a tick later, and a second
  // press in that tick must not start a second checkout.
  const inFlight = useRef(false);
  const mutation = useMutation({
    mutationFn: (request: Request) =>
      request.kind === "buy"
        ? billing.purchase(scope, { product: request.entry.product, seats: request.seats })
        : billing.session(scope, { action: "add_seats", licenseId: request.license.licenseId }),
    onError: (error, request) => {
      if (request.kind === "buy" && error instanceof BillingRefusedError && error.code === "already_licensed") {
        void client.invalidateQueries({ queryKey: billingKeys.owner(scope) });
      }
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const go = (request: Request) => {
    if (inFlight.current) return;
    inFlight.current = true;
    mutation.mutate(request, { onSuccess: (answer) => navigateOut(answer.url) });
  };
  return {
    busy: mutation.isPending ? { kind: mutation.variables.kind, product: mutation.variables.entry.product } : null,
    failure: mutation.isError
      ? {
          message: billingErrorMessage(mutation.error, { product: mutation.variables.entry.name, scope: ownerTypeOf(scope) }),
          code: mutation.error instanceof BillingRefusedError ? mutation.error.code : null,
        }
      : null,
    buy: (entry, seats) => go({ kind: "buy", entry, seats }),
    addSeats: (license, entry) => go({ kind: "seats", entry, license }),
  };
}

// ---- small pieces -----------------------------------------------------------------------------------------------

/** A refusal in words. It is an alert: the person asked for something and it didn't happen. */
function RefusalNotice({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-notice bg-error text-error-foreground px-4 py-3 text-sm">
      {message}
    </p>
  );
}

/** The license the owner holds of a product, preferring one billing lists `add_seats` for. */
function heldOf(licenses: readonly LicenseBilling[] | undefined, product: string): LicenseBilling | null {
  const mine = (licenses ?? []).filter((license) => license.product === product);
  return mine.find((license) => listedAction(license, "add_seats") !== null) ?? mine[0] ?? null;
}

/** "You have 5 seats" for a workspace, "You have it" for a person. */
function heldText(owner: LicenseScope, license: LicenseBilling): string {
  return owner === "workspace" ? t.catalog.youHaveSeats(license.quantity) : t.catalog.youHaveIt;
}

/** `sentence` as its lead (when it starts with it) and the rest, so a screen can style the lead without rewording the sentence. */
function splitLead(sentence: string, lead: string): [string, string] {
  return sentence.startsWith(lead) ? [lead, sentence.slice(lead.length)] : ["", sentence];
}

/** Buy. A workspace's opens the seats step; a person's goes straight to payment, so it leaves the portal (↗). */
function BuyButton({
  entry,
  owner,
  busy,
  pending,
  onBuy,
  describedBy,
  size,
  className,
}: {
  entry: CatalogEntry;
  owner: LicenseScope;
  busy: boolean;
  pending: boolean;
  onBuy(entry: CatalogEntry): void;
  /** The id of the product's name, which a screen reader hears after "Buy". */
  describedBy: string;
  size: "default" | "sm";
  className?: string;
}) {
  if (owner === "person") {
    return (
      <HostedPageButton
        variant="default"
        size={size}
        className={className}
        pending={pending}
        disabled={busy}
        aria-describedby={describedBy}
        onClick={() => onBuy(entry)}
      >
        {t.catalog.buy}
      </HostedPageButton>
    );
  }
  return (
    <Button type="button" size={size} className={className} disabled={busy} aria-describedby={describedBy} onClick={() => onBuy(entry)}>
      {t.catalog.buy}
    </Button>
  );
}

/** Add seats, for a held product whose license billing lists `add_seats` for, in a workspace. Null otherwise. */
function AddSeatsButton({
  entry,
  owner,
  license,
  busy,
  pending,
  onAddSeats,
  describedBy,
  size,
  className,
}: {
  entry: CatalogEntry;
  owner: LicenseScope;
  license: LicenseBilling;
  busy: boolean;
  pending: boolean;
  onAddSeats(license: LicenseBilling, entry: CatalogEntry): void;
  describedBy: string;
  size: "default" | "sm";
  className?: string;
}) {
  // A person's licenses have no seat count to change, whatever is listed.
  const action = owner === "workspace" ? listedAction(license, "add_seats") : null;
  if (action === null) return null;
  return (
    <HostedPageButton
      variant="secondary"
      size={size}
      className={className}
      pending={pending}
      disabled={busy}
      aria-describedby={describedBy}
      onClick={() => onAddSeats(license, entry)}
    >
      {t.actions.label(action.kind, action.fallbackLabel)}
    </HostedPageButton>
  );
}

/** A card's price: the amount large and what it is for beside it, or billing's own label for a scheme Core doesn't compute with. */
function CardPrice({ price, owner, locale }: { price: Price; owner: LicenseScope; locale: string }) {
  if (!isPerSeat(price)) return <p className="text-lg leading-snug font-semibold">{price.fallbackLabel}</p>;
  const [amount, rest] = splitLead(priceLine(price, owner, locale), formatMoney(price.unit, locale));
  if (amount === "") return <p className="text-sm">{rest}</p>;
  return (
    <p className="flex items-baseline gap-1.5">
      <span className="text-2xl leading-none font-semibold tabular-nums">{amount}</span>{" "}
      <span className="text-muted-foreground text-sm">{rest.trimStart()}</span>
    </p>
  );
}

// ---- the grid ---------------------------------------------------------------------------------------------------

export interface CatalogCardProps {
  entry: CatalogEntry;
  scope: LicenseScope;
  locale: string;
  /** The owner's license of this product, if it holds one. */
  held: LicenseBilling | null;
  /** Billing is being asked something already: no second request starts. */
  busy: boolean;
  /** It is this card's own request that is out. */
  pending: boolean;
  onBuy(entry: CatalogEntry): void;
  onAddSeats(license: LicenseBilling, entry: CatalogEntry): void;
}

/**
 * One product: icon, name, description, its features as a list when it has more than one, and then its price and
 * Buy, or, for a product the owner holds, "You have 5 seats" and Add seats ("You have it" for a person).
 */
export function CatalogCard({ entry, scope, locale, held, busy, pending, onBuy, onAddSeats }: CatalogCardProps) {
  const nameId = useId();
  return (
    <Card data-product={entry.product} className="gap-0 py-0">
      <div className="flex flex-1 flex-col p-6">
        <ProductIcon product={entry} />
        <h3 id={nameId} className="mt-4 text-lg leading-tight font-semibold">
          {entry.name}
        </h3>
        {entry.description ? <p className="text-muted-foreground mt-1.5 text-sm leading-5">{entry.description}</p> : null}
        {entry.features.length > 1 ? (
          <ul className="mt-4 space-y-2 text-sm">
            {entry.features.map((feature) => (
              <li key={feature.key} className="flex gap-2.5">
                <CircleCheckIcon aria-hidden="true" className="text-brand mt-px size-4 shrink-0" />
                <span>
                  {feature.name}
                  {feature.appName ? (
                    <>
                      {" "}
                      <span className="text-muted-foreground">{t.card.featureIn(feature.appName)}</span>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex-1" />
        {/* A flex column with a gap, not `space-y`: a hosted-page button brings a hidden hint span after it, which would take the last child's place. */}
        {held ? (
          <div className="mt-6 flex flex-col gap-4">
            <p className="text-[15px] font-semibold">{heldText(scope, held)}</p>
            <AddSeatsButton
              entry={entry}
              owner={scope}
              license={held}
              busy={busy}
              pending={pending}
              onAddSeats={onAddSeats}
              describedBy={nameId}
              size="default"
              className="w-full"
            />
          </div>
        ) : entry.offer ? (
          <div className="mt-6 flex flex-col gap-4">
            <CardPrice price={entry.offer.price} owner={scope} locale={locale} />
            {canBuy(entry) ? (
              <BuyButton entry={entry} owner={scope} busy={busy} pending={pending} onBuy={onBuy} describedBy={nameId} size="default" className="w-full" />
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * What this owner can buy: "Buy a license for your members" or "Buy a license for yourself", with one card per
 * product the scope's owner type is offered. It draws nothing when there is no such product. A workspace's Buy opens
 * the seats step; a person's goes straight to payment.
 */
export function CatalogGrid({ products, licenses, scope, billing, navigateOut, memberCount }: CatalogProps) {
  const owner = ownerTypeOf(scope);
  const entries = catalogForOwner(products, owner);
  const hosted = useHosted({ billing, scope, navigateOut });
  const [buying, setBuying] = useState<CatalogEntry | null>(null);
  const headingId = useId();
  if (entries.length === 0) return null;
  const copy = t.catalog[owner];

  const onBuy = (entry: CatalogEntry) => {
    if (!canBuy(entry)) return;
    if (owner === "workspace") setBuying(entry);
    else hosted.buy(entry, seatBounds(entry.offer.buy, entry.offer.price).initial);
  };

  return (
    <section aria-labelledby={headingId} className="space-y-4">
      <div>
        <h2 id={headingId} className="text-lg font-semibold">
          {copy.title}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{copy.intro}</p>
      </div>
      {hosted.failure ? <RefusalNotice message={hosted.failure.message} /> : null}
      <div className={cn("grid gap-4", entries.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
        {entries.map((entry) => (
          <CatalogCard
            key={entry.product}
            entry={entry}
            scope={owner}
            locale={billing.locale}
            held={heldOf(licenses, entry.product)}
            busy={hosted.busy !== null}
            pending={hosted.busy?.product === entry.product}
            onBuy={onBuy}
            onAddSeats={hosted.addSeats}
          />
        ))}
      </div>
      {owner === "workspace" ? (
        <BuyDialog
          open={buying !== null}
          product={buying}
          billing={billing}
          scope={scope}
          navigateOut={navigateOut}
          memberCount={memberCount}
          onClose={() => setBuying(null)}
        />
      ) : null}
    </section>
  );
}

// ---- Buy a license, as a dialog ---------------------------------------------------------------------------------

/** One product as a row: icon and name, then what you have or what it costs, and Buy or Add seats. */
function CatalogRow({
  entry,
  owner,
  locale,
  held,
  busy,
  pending,
  onBuy,
  onAddSeats,
}: Omit<CatalogCardProps, "scope"> & { owner: LicenseScope }) {
  const nameId = useId();
  const second = held ? heldText(owner, held) : entry.offer ? priceLine(entry.offer.price, owner, locale) : null;
  return (
    <li data-product={entry.product} className="flex items-center gap-3 rounded-[16px] border p-3">
      <ProductIcon product={entry} size={40} />
      <div className="min-w-0 flex-1">
        <div id={nameId} className="text-[15px] font-semibold">
          {entry.name}
        </div>
        {second ? <div className="text-muted-foreground truncate text-[13px]">{second}</div> : null}
      </div>
      {held ? (
        <AddSeatsButton entry={entry} owner={owner} license={held} busy={busy} pending={pending} onAddSeats={onAddSeats} describedBy={nameId} size="sm" />
      ) : canBuy(entry) ? (
        <BuyButton entry={entry} owner={owner} busy={busy} pending={pending} onBuy={onBuy} describedBy={nameId} size="sm" />
      ) : null}
    </li>
  );
}

/** The rows, and the last refusal above them. Drawn inside the dialog, so each opening starts without the last one's. */
function CatalogRows({ products, licenses, scope, billing, navigateOut, onChoose }: CatalogProps & { onChoose(entry: CatalogEntry): void }) {
  const owner = ownerTypeOf(scope);
  const hosted = useHosted({ billing, scope, navigateOut });
  const onBuy = (entry: CatalogEntry) => {
    if (!canBuy(entry)) return;
    if (owner === "workspace") onChoose(entry);
    else hosted.buy(entry, seatBounds(entry.offer.buy, entry.offer.price).initial);
  };
  return (
    <div className="space-y-3">
      {hosted.failure ? <RefusalNotice message={hosted.failure.message} /> : null}
      <ul className="space-y-2">
        {catalogForOwner(products, owner).map((entry) => (
          <CatalogRow
            key={entry.product}
            entry={entry}
            owner={owner}
            locale={billing.locale}
            held={heldOf(licenses, entry.product)}
            busy={hosted.busy !== null}
            pending={hosted.busy?.product === entry.product}
            onBuy={onBuy}
            onAddSeats={hosted.addSeats}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * "Buy a license": the same catalog as rows, for an owner that already holds licenses. A product it holds offers
 * Add seats instead of Buy (and says "You have it" for a person); any other shows its price and Buy. A workspace's
 * Buy opens the seats step over the list.
 */
export function CatalogDialog({ open, onClose, ...props }: CatalogProps & { open: boolean; onClose(): void }) {
  const owner = ownerTypeOf(props.scope);
  const [buying, setBuying] = useState<CatalogEntry | null>(null);
  useEffect(() => {
    if (!open) setBuying(null);
  }, [open]);
  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={t.catalog.dialog.title}
        description={owner === "workspace" ? t.catalog.dialog.description : t.catalog.dialog.personDescription}
        className="max-w-[560px]"
      >
        <CatalogRows {...props} onChoose={setBuying} />
      </Dialog>
      {owner === "workspace" ? (
        <BuyDialog
          open={open && buying !== null}
          product={buying}
          billing={props.billing}
          scope={props.scope}
          navigateOut={props.navigateOut}
          memberCount={props.memberCount}
          onClose={() => setBuying(null)}
        />
      ) : null}
    </>
  );
}

// ---- the seats step ---------------------------------------------------------------------------------------------

export interface BuyDialogProps extends BuyingHost {
  open: boolean;
  /** The product being bought: it needs an offer with `buy` limits, or nothing is drawn. */
  product: CatalogEntry | null;
  /** How many members the workspace has. */
  memberCount?: number;
  onClose(): void;
}

/** What is inside the dialog, drawn only while it is open: the seats start again each time. */
function BuyForm({
  product,
  offer,
  buy,
  host,
  memberCount,
  onClose,
}: {
  product: BuyableEntry;
  offer: Offer;
  buy: Buy;
  host: BuyingHost;
  memberCount?: number;
  onClose(): void;
}) {
  const { price } = offer;
  const locale = host.billing.locale;
  const bounds = seatBounds(buy, price);
  const [seats, setSeats] = useState(bounds.initial);
  const hosted = useHosted(host);
  const stepperId = useId();
  const pending = hosted.busy !== null;
  // Held now, as billing has just said: asking again would only be refused again.
  const held = hosted.failure?.code === "already_licensed";

  let terms: ReactNode;
  let sum: string | null = null;
  if (isPerSeat(price)) {
    const line = priceLine(price, "workspace", locale);
    const [lead, rest] = splitLead(t.buy.terms(line, renewalCadence(price, locale) ?? ""), line);
    terms = (
      <p className="text-sm">
        <span className="font-semibold">{lead}</span>
        <span className="text-muted-foreground">{rest}</span>
      </p>
    );
    // The one sum Core shows: seats × the unit price, in billing's currency and recurrence.
    sum = t.buy.summary({
      seats,
      unit: formatMoney(price.unit, locale),
      total: formatMoney({ amountMinor: seats * price.unit.amountMinor, currency: price.unit.currency }, locale),
      rate: formatRecurrence(price.recurrence, locale),
      note: taxNote(offer.tax),
    });
  } else {
    // A scheme Core doesn't know: billing's words, and nothing computed from them.
    terms = <p className="text-sm font-semibold">{price.fallbackLabel}</p>;
  }

  return (
    <>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <ProductIcon product={product} size={40} />
          {terms}
        </div>
        <div>
          <Label htmlFor={stepperId}>{t.buy.seats}</Label>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Stepper
              id={stepperId}
              value={seats}
              onChange={setSeats}
              min={bounds.min}
              max={bounds.max}
              label={t.buy.seats}
              decrementLabel={t.buy.fewer}
              incrementLabel={t.buy.more}
              disabled={pending}
            />
            {memberCount !== undefined ? <span className="text-muted-foreground text-sm">{t.buy.members(memberCount)}</span> : null}
          </div>
        </div>
        {sum !== null ? <p className="border-t pt-4 text-sm font-semibold tabular-nums">{sum}</p> : null}
        {hosted.failure ? <RefusalNotice message={hosted.failure.message} /> : null}
      </div>
      <div className="-mx-6 -mb-6 flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4 sm:-mx-7 sm:-mb-7 sm:px-7">
        <span className="text-muted-foreground max-w-[220px] text-xs leading-4">{t.buy.payNote}</span>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t.buy.cancel}
          </Button>
          <HostedPageButton variant="default" size="default" pending={pending} disabled={held} onClick={() => hosted.buy(product, seats)}>
            {t.buy.continue}
          </HostedPageButton>
        </div>
      </div>
    </>
  );
}

/**
 * The seats step of a workspace's purchase: "Buy <product>" with its description and terms, a stepper bounded by
 * billing's limits, the sum, and "Continue to payment ↗", which asks billing for the checkout of `{product, seats}` and
 * goes to the page it answers. A person never has this step (they are sent straight to payment), so it draws nothing
 * for one.
 */
export function BuyDialog({ open, product, memberCount, onClose, ...host }: BuyDialogProps) {
  const entry = product !== null && canBuy(product) && ownerTypeOf(host.scope) === "workspace" ? product : null;
  return (
    <Dialog
      open={open && entry !== null}
      onClose={onClose}
      title={entry ? t.buy.title(entry.name) : ""}
      description={entry?.description || undefined}
      className="max-w-[480px]"
    >
      {entry ? <BuyForm product={entry} offer={entry.offer} buy={entry.offer.buy} host={host} memberCount={memberCount} onClose={onClose} /> : null}
    </Dialog>
  );
}
