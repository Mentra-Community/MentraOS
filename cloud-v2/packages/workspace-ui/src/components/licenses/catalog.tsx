/**
 * Buying from billing's catalog, as the approved design draws it (its `parts2.tsx`): the grid of products a workspace
 * with nothing yet is offered, the "Buy subscriptions" dialog, and the seats step (which only a `?buy=` link for a
 * product whose smallest purchase is more than one still opens).
 *
 * Everything is drawn from what billing sent for each product: its name, icon and features (not its description), and, for
 * a viewer who may manage the owner's billing, its `offer` (the price, the tax treatment and what buying allows).
 * An entry with no `offer` is display content only: it shows no price and no Buy. An offer whose `buy` is null
 * (the owner holds the product, or a purchase of it is under way) has no Buy either.
 *
 * Prices follow one rule. A `per_seat` price is the only one Core computes with, and the one sum it shows is the
 * seats step's seats × unit. Any other price shows its `fallbackLabel` exactly, with no arithmetic, no renewal
 * claim and no tax note. "before tax" appears only where billing says tax is `excluded`.
 *
 * Every button that leaves the portal for a hosted page is a `HostedPageButton`: Buy, which goes straight to checkout
 * for billing's smallest purchase (more seats are bought from the product's card afterwards), Buy more seats (or, on a
 * product whose first payment isn't finished, Complete payment) and Continue to payment. They all leave the way every
 * other billing button does, through `useHostedAction` and the host's `NavigateOut`: the client has already refused
 * any address the contract doesn't accept, and an Buy subscriptions billing lists with `returns: false` opens its tab in the
 * click.
 *
 * Words are in `strings/licenses.ts`. This file imports the client's type only, never its schemas.
 */

import { isPerSeat, type Buy, type BillingAction, type CatalogEntry, type LicenseBilling, type Offer, type Price } from "@mentra/workspace-contract/portal-billing";
import { CircleCheckIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import type { WorkspaceApi } from "../../api";
import type { BillingApi } from "../../billing-api";
import type { BillingScope } from "../../billing-scope";
import { formatMoney, formatRecurrence, priceLine, renewalCadence, taxNote } from "../../lib/billing-format";
import { listedAction } from "../../lib/license-join";
import { cn } from "../../lib/utils";
import { licenseStrings as t } from "../../strings/licenses";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Dialog } from "../../ui/dialog";
import { Label } from "../../ui/label";
import { Stepper } from "../../ui/stepper";
import { HostedFeedback, useHostedAction, type HostedAction, type HostedRequest, type NavigateOut } from "./hosted-action";
import { HostedPageButton } from "./parts";
import { ProductIcon } from "./product";

/** What the buying components ask of billing's client: the portal's locale, a purchase and a session. */
export type CatalogBilling = Pick<BillingApi, "locale" | "purchase" | "session">;

/** What every buying component needs to reach billing and to leave for a hosted page. */
export interface BuyingHost {
  billing: CatalogBilling;
  scope: BillingScope;
  /** How the browser leaves for a hosted page. Billing's client only ever answers an address the contract accepts. */
  navigateOut: NavigateOut;
  /** Core's workspace API, so that coming back from a page that doesn't return reads the workspace's licenses again too. */
  api?: Pick<WorkspaceApi, "basePath">;
}

export interface CatalogProps extends BuyingHost {
  /** `catalog.products`. */
  products: readonly CatalogEntry[];
  /** `status.licenses`: which products the owner holds, with their seats and the actions billing lists. */
  licenses?: readonly LicenseBilling[];
}

/** An entry billing offers to this viewer for sale now: it has an offer, and the offer's `buy` isn't null. */
export type BuyableEntry = CatalogEntry & { offer: Offer & { buy: Buy } };

/** Whether billing offers `entry` for sale to this viewer now (a price and `buy` limits). */
export function canBuy(entry: CatalogEntry): entry is BuyableEntry {
  return entry.offer !== undefined && entry.offer.buy !== null;
}

/**
 * The product being bought, with the terms billing offers it now. The seats step stays open while the catalog is
 * read again, so a price or a limit that changed reaches it. A product that can no longer be bought (billing took
 * its offer away, or the owner now holds it) keeps the terms it was chosen with: the step stays where it is, with
 * the refusal it may be showing, and billing refuses what it won't sell, in words.
 */
export function termsNow(chosen: CatalogEntry | null, products: readonly CatalogEntry[]): CatalogEntry | null {
  if (chosen === null) return null;
  const now = products.find((entry) => entry.product === chosen.product);
  return now !== undefined && canBuy(now) ? now : chosen;
}

// ---- seats ------------------------------------------------------------------------------------------------------

interface SeatBounds {
  min: number;
  max: number;
  /** The workspace's member count, held to the bounds. */
  initial: number;
}

/**
 * The seats a purchase may name: billing's `minSeats` to its `maxSeats`, held so that seats × unit never leaves the
 * safe integers (a price in the minor unit is a safe integer, and so must be its sum). Without a `maxSeats` that
 * ceiling is the only bound. The step starts at `memberCount`, one license for each member, held to those bounds
 * (at the floor where the count isn't known).
 */
function seatBounds(buy: Buy, price: Price, memberCount: number | undefined): SeatBounds {
  const min = buy.minSeats;
  const ceiling =
    isPerSeat(price) && price.unit.amountMinor > 0 ? Math.floor(Number.MAX_SAFE_INTEGER / price.unit.amountMinor) : Number.MAX_SAFE_INTEGER;
  const max = Math.max(min, Math.min(buy.maxSeats ?? ceiling, ceiling));
  return { min, max, initial: Math.min(max, Math.max(min, memberCount ?? min)) };
}

// ---- asking billing ---------------------------------------------------------------------------------------------

// Each container below (the grid, the dialog's rows, the seats step) has its own `useHostedAction(host)`: one request
// at a time to billing, for a purchase or for Buy subscriptions, and on to the page it answers. A refusal is drawn where its
// container is, and goes with it.

/**
 * What pressing Buy on `entry` does: asks billing for the checkout of its smallest purchase (`minSeats`, one) and goes
 * there, with no step between. Only an entry billing offers for sale.
 */
const buyNow = (hosted: HostedAction) => (entry: CatalogEntry) => {
  if (canBuy(entry)) hosted.run({ product: entry.product, seats: entry.offer.buy.minSeats, name: entry.name });
};

/** Buy subscriptions on a held product's license, by the action billing listed for it: its page opens in a tab where billing says it doesn't return. */
const addSeatsOf = (hosted: HostedAction) => (license: LicenseBilling, entry: CatalogEntry, action: BillingAction) =>
  hosted.run({ action, licenseId: license.licenseId, name: entry.name });

/** Whether the request out is the one that `entry`'s button (Buy, or Buy subscriptions on its held `license`) made. */
function isPendingFor(request: HostedRequest | null, entry: CatalogEntry, held: LicenseBilling | null): boolean {
  if (request === null) return false;
  return "action" in request ? held !== null && request.licenseId === held.licenseId : request.product === entry.product;
}

// ---- small pieces -----------------------------------------------------------------------------------------------

/** The license the owner holds of a product, preferring one billing lists `add_seats` for. */
function heldOf(licenses: readonly LicenseBilling[] | undefined, product: string): LicenseBilling | null {
  const mine = (licenses ?? []).filter((license) => license.product === product);
  return mine.find((license) => listedAction(license, "add_seats") !== null) ?? mine[0] ?? null;
}

/**
 * What the workspace's license of a product says on a card or row. A license in force reads "You have 5 licenses". A
 * first payment that isn't finished (`incomplete`) is not held yet: it reads as its state, "Payment incomplete" in
 * amber, as the license's own card does, and never as seats the workspace doesn't have.
 */
function heldState(license: LicenseBilling): { text: string; warn: boolean } {
  if (license.status === "incomplete") return { text: t.status.incomplete, warn: true };
  return { text: t.catalog.youHaveSeats(license.quantity), warn: false };
}

/**
 * The one thing billing lists for a held product that this screen offers: Complete payment for a first payment that
 * isn't finished, else Buy subscriptions. Null where billing lists neither. Nothing is added to a license that isn't paid
 * for, whatever is listed.
 */
function heldAction(license: LicenseBilling): BillingAction | null {
  if (license.status === "incomplete") return listedAction(license, "complete_payment");
  return listedAction(license, "add_seats");
}

/** `sentence` as its lead (when it starts with it) and the rest, so a screen can style the lead without rewording the sentence. */
function splitLead(sentence: string, lead: string): [string, string] {
  return sentence.startsWith(lead) ? [lead, sentence.slice(lead.length)] : ["", sentence];
}

/** Buy: it goes straight to checkout (`buyNow`), and spins while billing answers. */
function BuyButton({
  entry,
  busy,
  pending,
  onBuy,
  describedBy,
  size,
  className,
}: {
  entry: CatalogEntry;
  busy: boolean;
  /** It is this product's purchase that is out. */
  pending: boolean;
  onBuy(entry: CatalogEntry): void;
  /** The id of the product's name, which a screen reader hears after "Buy". */
  describedBy: string;
  size: "default" | "sm";
  className?: string;
}) {
  return (
    <HostedPageButton
      variant="default"
      size={size}
      arrow={false}
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

/**
 * The ↗ button for a held product: Buy subscriptions on its license, or Complete payment for a first payment that isn't
 * finished (see `heldAction`), by the action billing listed. Null where there is none. It opens its page in a tab
 * where billing lists the action with `returns: false`.
 */
function HeldActionButton({
  entry,
  license,
  busy,
  pending,
  onAddSeats,
  describedBy,
  size,
  className,
}: {
  entry: CatalogEntry;
  license: LicenseBilling;
  busy: boolean;
  pending: boolean;
  onAddSeats(license: LicenseBilling, entry: CatalogEntry, action: BillingAction): void;
  describedBy: string;
  size: "default" | "sm";
  className?: string;
}) {
  const action = heldAction(license);
  if (action === null) return null;
  return (
    <HostedPageButton
      variant={license.status === "incomplete" ? "default" : "secondary"}
      // Buy more seats goes without the ↗, as it does on the card.
      arrow={action.kind !== "add_seats"}
      size={size}
      className={className}
      newTab={action.returns === false}
      pending={pending}
      disabled={busy}
      aria-describedby={describedBy}
      onClick={() => onAddSeats(license, entry, action)}
    >
      {t.actions.label(action.kind, action.fallbackLabel)}
    </HostedPageButton>
  );
}

/** A card's price: the amount large and what it is for beside it, or billing's own label for a scheme Core doesn't compute with. */
function CardPrice({ price, locale }: { price: Price; locale: string }) {
  if (!isPerSeat(price)) return <p className="text-lg leading-snug font-semibold">{price.fallbackLabel}</p>;
  const [amount, rest] = splitLead(priceLine(price, locale), formatMoney(price.unit, locale));
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
  locale: string;
  /** The workspace's license of this product, if it holds one. */
  held: LicenseBilling | null;
  /** Billing is being asked something already: no second request starts. */
  busy: boolean;
  /** It is this card's own request that is out. */
  pending: boolean;
  onBuy(entry: CatalogEntry): void;
  /** The held license's button was pressed: Buy subscriptions, or Complete payment on an unfinished first payment, by the action billing listed. */
  onAddSeats(license: LicenseBilling, entry: CatalogEntry, action: BillingAction): void;
}

/**
 * One product: icon, name, its features as a list when it has more than one, and then its price and
 * Buy, or, for a product the workspace holds, "You have 5 licenses" and Buy subscriptions.
 */
export function CatalogCard({ entry, locale, held, busy, pending, onBuy, onAddSeats }: CatalogCardProps) {
  const nameId = useId();
  return (
    <Card data-product={entry.product} className="gap-0 py-0">
      <div className="flex flex-1 flex-col p-6">
        <ProductIcon product={entry} />
        <h3 id={nameId} className="mt-4 text-lg leading-tight font-semibold">
          {entry.name}
        </h3>
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
            <p className={cn("text-[15px] font-semibold", heldState(held).warn && "text-error-foreground")}>{heldState(held).text}</p>
            <HeldActionButton
              entry={entry}
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
            <CardPrice price={entry.offer.price} locale={locale} />
            {canBuy(entry) ? (
              <BuyButton entry={entry} busy={busy} pending={pending} onBuy={onBuy} describedBy={nameId} size="default" className="w-full" />
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * What this workspace can buy: "Buy licenses for your members", with one card per product. It draws nothing when
 * there is no product. The heading and its
 * "You'll pay by card…" line are drawn only when at least one of those products has an `offer` for this viewer; without
 * one the cards are display content and the grid has no buying copy. Buy goes straight to checkout.
 */
export function CatalogGrid({ products, licenses, ...host }: CatalogProps) {
  const entries = products;
  const hosted = useHostedAction(host);
  const headingId = useId();
  if (entries.length === 0) return null;
  const copy = t.catalog;
  const onBuy = buyNow(hosted);
  const onAddSeats = addSeatsOf(hosted);
  // The heading is buying copy: they belong to a viewer billing offers something to
  // (an entry with an `offer`). For anyone else the entries are display content, and say nothing about buying.
  const offered = entries.some((entry) => entry.offer !== undefined);

  return (
    <section aria-labelledby={offered ? headingId : undefined} className="space-y-4">
      {offered ? (
        <h2 id={headingId} className="text-lg font-semibold">
          {copy.title}
        </h2>
      ) : null}
      <HostedFeedback action={hosted} />
      <div className={cn("grid gap-4", entries.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2")}>
        {entries.map((entry) => {
          const held = heldOf(licenses, entry.product);
          return (
            <CatalogCard
              key={entry.product}
              entry={entry}
              locale={host.billing.locale}
              held={held}
              busy={hosted.pending !== null}
              pending={isPendingFor(hosted.request, entry, held)}
              onBuy={onBuy}
              onAddSeats={onAddSeats}
            />
          );
        })}
      </div>
    </section>
  );
}

// ---- Buy licenses, as a dialog ---------------------------------------------------------------------------------

/** One product as a row: icon and name, then what you have or what it costs, and Buy or Buy subscriptions. */
function CatalogRow({
  entry,
  locale,
  held,
  busy,
  pending,
  onBuy,
  onAddSeats,
}: CatalogCardProps) {
  const nameId = useId();
  const state = held ? heldState(held) : null;
  const second = state ? state.text : entry.offer ? priceLine(entry.offer.price, locale) : null;
  return (
    <li data-product={entry.product} className="flex items-center gap-3 rounded-[16px] border p-3">
      <ProductIcon product={entry} size={40} />
      <div className="min-w-0 flex-1">
        <div id={nameId} className="text-[15px] font-semibold">
          {entry.name}
        </div>
        {second ? <div className={cn("truncate text-[13px]", state?.warn ? "text-error-foreground font-semibold" : "text-muted-foreground")}>{second}</div> : null}
      </div>
      {held ? (
        <HeldActionButton entry={entry} license={held} busy={busy} pending={pending} onAddSeats={onAddSeats} describedBy={nameId} size="sm" />
      ) : canBuy(entry) ? (
        <BuyButton entry={entry} busy={busy} pending={pending} onBuy={onBuy} describedBy={nameId} size="sm" />
      ) : null}
    </li>
  );
}

/** The rows, and the last refusal above them. Drawn inside the dialog, so each opening starts without the last one's. */
function CatalogRows({
  products,
  licenses,
  host,
}: Pick<CatalogProps, "products" | "licenses"> & { host: BuyingHost }) {
  const hosted = useHostedAction(host);
  const onBuy = buyNow(hosted);
  const onAddSeats = addSeatsOf(hosted);
  return (
    <div className="space-y-3">
      <HostedFeedback action={hosted} />
      <ul className="space-y-2">
        {products.map((entry) => {
          const held = heldOf(licenses, entry.product);
          return (
            <CatalogRow
              key={entry.product}
              entry={entry}
              locale={host.billing.locale}
              held={held}
              busy={hosted.pending !== null}
              pending={isPendingFor(hosted.request, entry, held)}
              onBuy={onBuy}
              onAddSeats={onAddSeats}
            />
          );
        })}
      </ul>
    </div>
  );
}

/**
 * "Buy licenses": the same catalog as rows, for a workspace that already holds licenses. A product it holds offers
 * Buy more seats instead of Buy; any other shows its price and Buy, which goes straight to checkout.
 */
export function CatalogDialog({ open, onClose, products, licenses, ...host }: CatalogProps & { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} title={t.catalog.dialog.title} description={t.catalog.dialog.description} className="max-w-[560px]">
      <CatalogRows products={products} licenses={licenses} host={host} />
    </Dialog>
  );
}

// ---- the seats step ---------------------------------------------------------------------------------------------

export interface BuyDialogProps extends BuyingHost {
  open: boolean;
  /** The product being bought, with the terms billing offers it now: it needs an offer with `buy` limits, or nothing is drawn. */
  product: CatalogEntry | null;
  /** How many members the workspace has: the number of licenses it starts at, and with one member there is no number to choose. */
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
  const bounds = seatBounds(buy, price, memberCount);
  // A workspace of one member buys its one license with no number to choose (when billing sells one).
  const solo = memberCount === 1 && bounds.initial === 1;
  const [chosen, setChosen] = useState(bounds.initial);
  // Billing can change the limits while the form is open (the catalog is read again): the choice is held to them.
  // With one member there is no choice: the member count can fall to one while the form is open, and the one license
  // shown is the one asked for.
  const seats = solo ? bounds.initial : Math.min(bounds.max, Math.max(bounds.min, chosen));
  if (seats !== chosen) setChosen(seats);
  const hosted = useHostedAction(host);
  const stepperId = useId();
  const pending = hosted.pending !== null;
  // Held now, as billing has just said: asking again would only be refused again.
  const held = hosted.code === "already_licensed";

  let terms: ReactNode;
  let sum: string | null = null;
  if (isPerSeat(price)) {
    const line = priceLine(price, locale);
    const [lead, rest] = splitLead(t.buy.terms(line, renewalCadence(price, locale) ?? ""), line);
    terms = (
      <p className="text-sm">
        <span className="font-semibold">{lead}</span>
        <span className="text-muted-foreground">{rest}</span>
      </p>
    );
    // The one sum Core shows: seats × the unit price, in billing's currency and recurrence.
    sum = solo
      ? t.buy.solo({ total: formatMoney(price.unit, locale), rate: formatRecurrence(price.recurrence, locale), note: taxNote(offer.tax) })
      : t.buy.summary({
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
        {solo ? null : (
          <div>
            <Label htmlFor={stepperId}>{t.buy.seats}</Label>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
              <Stepper
                id={stepperId}
                value={seats}
                onChange={setChosen}
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
        )}
        {sum !== null ? <p className="border-t pt-4 text-sm font-semibold tabular-nums">{sum}</p> : null}
        <HostedFeedback action={hosted} />
      </div>
      <div className="-mx-6 -mb-6 flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4 sm:-mx-7 sm:-mb-7 sm:px-7">
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t.buy.cancel}
          </Button>
          <HostedPageButton variant="default" size="default" pending={pending} disabled={held} onClick={() => hosted.run({ product: product.product, seats, name: product.name })}>
            {t.buy.continue}
          </HostedPageButton>
        </div>
      </div>
    </>
  );
}

/**
 * The seats step of a purchase: "Buy <product>" with its terms, a stepper bounded by
 * billing's limits, the sum, and "Continue to payment ↗", which asks billing for the checkout of `{product, seats}` and
 * goes to the page it answers. The stepper starts at the workspace's member count; a workspace of one has none.
 */
export function BuyDialog({ open, product, memberCount, onClose, ...host }: BuyDialogProps) {
  const entry = product !== null && canBuy(product) ? product : null;
  return (
    <Dialog
      open={open && entry !== null}
      onClose={onClose}
      title={entry ? t.buy.title(entry.name) : ""}
      className="max-w-[480px]"
    >
      {entry ? <BuyForm product={entry} offer={entry.offer} buy={entry.offer.buy} host={host} memberCount={memberCount} onClose={onClose} /> : null}
    </Dialog>
  );
}
