/**
 * Every sentence the Licenses page, the Members list's licenses, the member panel, the personal Billing page and
 * their refusals show. Billing sends typed values and Core words them, here and nowhere else: this is the one
 * module a translation touches, and no component writes a sentence of its own.
 *
 * Each entry is a string, or a function of the values it names. Amounts and dates come in already formatted (in
 * the portal's locale and the viewer's time zone, by `lib/billing-format.ts`), counts as numbers, and names as
 * they are. Where a sentence has parts a screen styles (a bold lead, a monospaced card number) it comes back in
 * those parts, so no screen has to take a sentence apart.
 *
 * Billing's own content (product, feature and miniapp names, descriptions, `fallback*` labels) is never worded
 * here: it arrives localized and is shown as sent. Nothing here names the payment processor.
 */

import type { LicenseFit } from "../lib/license-join";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const and = (names: readonly string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** Whether a sentence is for a workspace's licenses or a person's own. */
export type LicenseScope = "workspace" | "person";

/** What a refusal's words may name. */
export interface RefusalContext {
  /** The product's name, as billing sent it. */
  product?: string;
  scope?: LicenseScope;
}

const GENERIC_REFUSAL = "Billing couldn't do that. Try again.";

/**
 * The words for a refusal from billing (`{error}`), by its code. Codes Core doesn't know, and `invalid_request`,
 * get the generic line.
 */
export function refusalMessage(code: string, context: RefusalContext = {}): string {
  const { product, scope = "workspace" } = context;
  switch (code) {
    case "not_for_sale":
      return product ? `${product} isn't for sale right now.` : "That isn't for sale right now.";
    case "invalid_seats":
      return "That number of seats isn't available. Choose a different number.";
    case "unknown_action":
      return "That isn't available for this license any more. Reload the page and try again.";
    case "forbidden":
      return "You don't have permission to manage billing here.";
    case "billing_staff_only":
      return "Only Organization Admins can use billing on this environment.";
    case "license_not_found":
      return "That license no longer exists. Reload the page.";
    case "no_billing_account":
      return "There's no billing account yet. It's created with the first purchase.";
    case "already_licensed": {
      const held = product ? `You already have ${product}.` : "You already have that.";
      return scope === "person" ? held : `${held} Add seats instead.`;
    }
    case "checkout_in_progress":
      return `A purchase of ${product ?? "that"} is already under way. Finish it, or try again in a minute.`;
    case "owner_ended":
      return scope === "person"
        ? "This account has been deleted, so billing can't change it."
        : "This workspace has been deleted, so billing can't change it.";
    case "billing_unavailable":
    case "core_unavailable":
      return "Billing is unavailable right now. Try again in a moment.";
    default:
      return GENERIC_REFUSAL;
  }
}

/** The names of up to three people in a sentence; past three, the first two and a count. */
function nameList(names: readonly string[]): string {
  if (names.length <= 3) return names.length === 0 ? "" : and(names);
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/** What billing's actions say. `label` returns these, so a wording changes in one place. */
const actions = {
  addSeats: "Add seats",
  /** "Add 2 seats": the over-assigned notice's button. */
  addSeatsCount: (n: number) => `Add ${plural(n, "seat")}`,
  changeSeats: "Change seats",
  cancel: "Cancel",
  renew: "Renew",
  updatePayment: "Update payment method",
  completePayment: "Complete payment",
  billingAndInvoices: "Billing & invoices",
  /** The link for a hosted page the browser wouldn't open in a new tab. */
  openPaymentPage: "Open the payment page",
  /** What a screen reader hears after a button that leaves the portal for a hosted page (its ↗). */
  opensSecureBillingPage: "Opens a secure billing page",
  /** The same, for a page that opens in a new tab (an action listed with `returns: false`). */
  opensSecureBillingPageInNewTab: "Opens a secure billing page in a new tab",
  /** The words for an action: Core's for a kind it knows, billing's own label for any other. */
  label: (kind: string, fallbackLabel: string): string => {
    switch (kind) {
      case "add_seats":
        return actions.addSeats;
      case "change_seats":
        return actions.changeSeats;
      case "cancel":
        return actions.cancel;
      case "renew":
        return actions.renew;
      case "update_payment":
        return actions.updatePayment;
      case "complete_payment":
        return actions.completePayment;
      case "billing_and_invoices":
        return actions.billingAndInvoices;
      default:
        return fallbackLabel;
    }
  },
};

/** A license's badges. `label` returns these, so a wording changes in one place. */
const status = {
  active: "Active",
  ending: (date: string) => `Ends ${date}`,
  pastDue: "Payment failed",
  incomplete: "Payment incomplete",
  processing: "Setting up",
  over: (n: number) => `${n} over`,
  youHaveASeat: "You have a seat",
  /**
   * The badge's words for a license's billing status: Core's for a status it knows, and billing's own
   * `fallbackStatusLabel` for any other. `shortEndDate` (the day an `ending` license ends, without the year)
   * is what "Ends <date>" needs; an `ending` status without one shows billing's label.
   */
  label: (value: string, fallbackLabel: string, shortEndDate?: string): string => {
    switch (value) {
      case "active":
        return status.active;
      case "ending":
        return shortEndDate ? status.ending(shortEndDate) : fallbackLabel;
      case "past_due":
        return status.pastDue;
      case "incomplete":
        return status.incomplete;
      case "processing":
        return status.processing;
      default:
        return fallbackLabel;
    }
  },
};

export const licenseStrings = {
  count: {
    seats: (n: number) => plural(n, "seat"),
    people: (n: number) => plural(n, "person", "people"),
    members: (n: number) => plural(n, "member"),
    licenses: (n: number) => plural(n, "license"),
  },

  /** People, in a sentence: "Dana Reyes, Priya Natarajan and 8 others". */
  names: {
    list: nameList,
    holders: (names: readonly string[]) => (names.length === 0 ? "Nobody has a seat yet" : nameList(names)),
  },

  nav: {
    licenses: "Licenses",
    billing: "Billing",
    yourAccount: "Your account",
    backTo: (workspace: string) => `Back to ${workspace}`,
  },

  page: {
    title: "Licenses",
    description: (workspace: string) => `What ${workspace} pays for, and who has each seat.`,
    /** A Member's or Developer's page: only the licenses they hold a seat in. */
    memberDescription: (workspace: string) => `Your seats in ${workspace}.`,
    adminsGiveOutSeats: (workspace: string) => `${workspace}'s Admins and Owners give out seats.`,
    noSeat: {
      title: (workspace: string) => `You don't have a seat in ${workspace}`,
      body: "Its Admins and Owners give out seats. Once you have one, it works the next time you open the miniapp it's for.",
    },
    billingAndInvoices: "Billing & invoices",
    buyALicense: "Buy a license",
    loading: "Loading licenses…",
    unavailable: {
      title: "Licenses are unavailable",
      body: "They can't be shown right now. Try again in a moment.",
      retry: "Retry",
    },
  },

  personal: {
    title: "Billing",
    description: "Licenses you buy for yourself, apart from any workspace's.",
    loading: "Loading billing…",
    unavailable: {
      title: "Billing is unavailable",
      body: "It can't be shown right now. Try again in a moment.",
      retry: "Retry",
    },
  },

  /** How often something is charged. `interval` is `day`, `week`, `month` or `year`. */
  recurrence: {
    /** "a month", "every 3 months": after an amount. */
    rate: (interval: string, count: number, countText = String(count)) =>
      count === 1 ? `a ${interval}` : `every ${countText} ${interval}s`,
    /** "month", "3 months": after "every". */
    cadence: (interval: string, count: number, countText = String(count)) =>
      count === 1 ? interval : `${countText} ${interval}s`,
  },

  tax: {
    excluded: "before tax",
    included: "including tax",
  },

  price: {
    /** "$15 per seat a month". */
    perSeat: (unit: string, rate: string) => `${unit} per seat ${rate}`,
    /** "$29 a month": a person's one seat. */
    perPerson: (unit: string, rate: string) => `${unit} ${rate}`,
  },

  catalog: {
    workspace: {
      title: "Buy a license for your members",
      intro: "You'll pay by card on a secure payment page, then come back here to give out the seats.",
    },
    person: {
      title: "Buy a license for yourself",
      intro: "You'll pay by card on a secure payment page, then come back here.",
    },
    buy: "Buy",
    youHaveIt: "You have it",
    youHaveSeats: (n: number) => `You have ${plural(n, "seat")}`,
    dialog: {
      title: "Buy a license",
      description: "Products for your workspace. For one you have, add seats instead.",
      /** A person's own catalog: there are no seats to add. */
      personDescription: "Products you can buy for yourself.",
    },
  },

  buy: {
    title: (product: string) => `Buy ${product}`,
    /** "$15 per seat a month · Renews every month. Change the seats or cancel at any time." */
    terms: (price: string, cadence: string) => `${price} · Renews every ${cadence}. Change the seats or cancel at any time.`,
    seats: "Seats",
    fewer: "One seat fewer",
    more: "One seat more",
    members: (n: number) => `Your workspace has ${plural(n, "member")}.`,
    /** "10 seats × $15 · $150 a month · before tax": the one sum Core shows. */
    summary: (parts: { seats: number; unit: string; total: string; rate: string; note: string | null }) =>
      `${plural(parts.seats, "seat")} × ${parts.unit} · ${parts.total} ${parts.rate}${parts.note ? ` · ${parts.note}` : ""}`,
    payNote: "You'll pay by card on a secure payment page.",
    cancel: "Cancel",
    continue: "Continue to payment",
  },

  card: {
    moreFor: (product: string) => `More for ${product}`,
    /** The label of a card's feature chips. */
    includes: "Includes",
    featureIn: (app: string) => `in ${app}`,
  },

  status,

  facts: {
    seats: {
      label: "Seats",
      inUse: (used: number, quantity: number) => `${used} of ${quantity} in use`,
      free: (n: number) => (n > 0 ? `${n} free` : "None free"),
      assigned: (used: number) => `${used} assigned`,
      moreThanCovered: (over: number, quantity: number) => `${over} more than the ${quantity} covered`,
    },
    term: {
      renews: "Renews",
      ends: "Ends",
      renewal: "Renewal",
      every: (cadence: string) => `Every ${cadence}`,
      until: (date: string) => `Until ${date}`,
      doesntRenew: "Doesn't renew",
      notPaid: "Not paid",
    },
    cost: {
      label: "Cost",
      noMoreCharges: "No more charges",
      value: (total: string, rate: string) => `${total} ${rate}`,
      /** "5 × $29". */
      multiple: (quantity: number, unit: string) => `${quantity} × ${unit}`,
      /** The facts under a cost, in one line: "5 × $29 · before tax"; null when there are none. */
      foot: (parts: ReadonlyArray<string | null>) => {
        const present = parts.filter((part): part is string => part !== null && part !== "");
        return present.length > 0 ? present.join(" · ") : null;
      },
    },
    /** A member's own card. */
    own: {
      seat: "Your seat",
      since: (date: string) => `Since ${date}`,
      givenBy: (workspace: string) => `Given by ${workspace}`,
      worksIn: "Works in",
      nextTime: "The next time you open it",
    },
  },

  notice: {
    /** A failed payment: the day the seats stop (or stopped), and what to do. `date` is null when billing sent none. */
    pastDue: ({ date, stopped }: { date: string | null; stopped: boolean }): { title: string; body: string | null } => {
      if (date === null) {
        return { title: "The last payment didn't go through.", body: "Update the payment method to keep the seats." };
      }
      if (stopped) {
        return { title: `Seats stopped on ${date}. They come back once payment goes through.`, body: null };
      }
      return { title: `Seats stop on ${date} unless payment goes through.`, body: "Update the payment method to keep them." };
    },
    incomplete: (product: string) => ({
      title: `The first payment for ${product} isn't finished.`,
      body: "Finish it to start the license.",
    }),
    /** More seats are assigned than the license covers. */
    over: ({ used, quantity, canAddSeats }: { used: number; quantity: number; canAddSeats: boolean }) => {
      const extra = used - quantity;
      const unassign = `Unassign ${extra} of them`;
      return {
        title: `${used === 1 ? "1 person has" : `${used} people have`} a seat, but the license covers ${quantity}.`,
        body: canAddSeats
          ? `${unassign}, or add ${plural(extra, "seat")}. No one else can get a seat until then.`
          : `${unassign}. No one else can get a seat until then.`,
      };
    },
  },

  actions,

  seats: {
    title: "Seat holders",
    searchPlaceholder: "Search seat holders",
    since: (date: string) => `Since ${date}`,
    unassign: "Unassign",
    /** The confirm step of Unassign. */
    unassignPrompt: (name: string) => `Unassign ${name}?`,
    /** Unassign's accessible name: whose seat. */
    unassignAria: (name: string) => `Unassign ${name}`,
    freeSeat: "Free seat",
    assign: "Assign",
    assignSeats: "Assign seats",
    freeSeats: (n: number) => `${n} free seats`,
    nobodyYet: "Nobody has a seat yet.",
    allInUse: (quantity: number) => `All ${quantity} seats are in use.`,
    allInUseHelp: (canAddSeats: boolean) =>
      canAddSeats ? "Add seats to give one to someone else, or unassign someone to free theirs." : "Unassign someone to free their seat.",
    moreAvatars: (n: number) => `+${n}`,
  },

  /** How many of the people chosen fit in the seats that are free. */
  fit: {
    note: ({ fit, needed, canAddSeats }: { fit: number; needed: number; canAddSeats: boolean }) => {
      const remove = needed - fit === 1 ? "one" : String(needed - fit);
      return `${fit} of ${needed} fit: remove ${remove}${canAddSeats ? " or add seats" : ""}.`;
    },
    /**
     * The line a seat dialog shows for the people chosen (`fitFor`'s result for one license): which of the
     * spec's sentences the result calls for, with the people by `nameOf`. `canAddSeats` is whether billing lists
     * `add_seats` for the license. Null when nobody is chosen.
     */
    line: <P>(fit: LicenseFit<P>, options: { nameOf: (person: P) => string; canAddSeats: boolean }): string | null => {
      const names = (people: readonly P[]) => people.map(options.nameOf);
      switch (fit.kind) {
        case "nobody":
          return null;
        case "all_hold":
          return licenseStrings.assign.everyoneHolds;
        case "full":
          return licenseStrings.seats.allInUse(fit.quantity);
        case "short":
          return licenseStrings.fit.note({ fit: fit.fit, needed: fit.needed, canAddSeats: options.canAddSeats });
        case "some_hold":
          return licenseStrings.assign.someHold({
            holders: names(fit.holders),
            free: fit.free,
            quantity: fit.quantity,
            recipients: names(fit.recipients),
          });
        case "enough":
          return licenseStrings.assign.enough({ free: fit.free, quantity: fit.quantity, chosen: fit.needed });
      }
    },
  },

  picker: {
    title: "Assign seats",
    description: (product: string, free: number) => `${product} · ${free} free ${free === 1 ? "seat" : "seats"}`,
    search: "Search by name or email",
    noMatches: "No one matches your search.",
    hasASeat: "Has a seat",
    afterFirstSignIn: "After first sign-in",
    chosen: (chosen: number, free: number) => `${chosen} of ${free} free seats chosen`,
    assign: (n: number) => (n === 0 ? "Assign" : `Assign ${plural(n, "seat")}`),
    cancel: "Cancel",
  },

  /** What a bulk assignment says when the counts it was built on changed. */
  conflict: {
    seatsChanged: "Seats changed while you were choosing. Nothing was assigned. Check the counts and try again.",
  },

  /** The Members list. */
  members: {
    title: "Members",
    description: "People in this workspace and the role each of them holds.",
    /** Shown in place of the list to a viewer who may not read it. */
    adminsOnly: "Only workspace admins can see the member list.",
    noMembers: "No members yet.",
    member: "Member",
    role: "Role",
    joined: "Joined",
    /** The badge on the viewer's own row. */
    you: "You",
    pendingFirstSignIn: "Pending first sign-in",
    importedMember: "Imported member",
    /** The Licenses column. */
    licenses: "Licenses",
    none: "None",
    afterFirstSignIn: "After first sign-in",
    moreChips: (n: number) => `+${n}`,
    /** The row's checkbox, and the control that opens the member panel from a row. */
    selectMember: (name: string) => `Select ${name}`,
    openMember: (name: string) => `Open ${name}`,
    /** An Organization Admin's copy button for a member's Mentra user id, in the row (`showUserIds`). */
    copyId: "Copy id",
    copyIdFor: (name: string) => `Copy the Mentra user id of ${name}`,
    selected: (n: number) => `${n} selected`,
    assignLicenses: "Assign licenses",
    clearSelection: "Clear selection",
  },

  /** The member panel: the member's role and joining, their licenses, and removing them. */
  memberPanel: {
    role: "Role",
    joined: "Joined",
    changeRole: "Change role",
    licenses: "Licenses",
    intro: (name: string) => `Turn one on to give ${name} a seat. Changes apply right away.`,
    /** On, with the seats left after theirs. */
    hasASeat: (free: number, quantity: number) => `Has a seat · ${free} of ${quantity} free`,
    seatsFree: (free: number, quantity: number) => `${free} of ${quantity} seats free`,
    allInUse: (quantity: number) => `All ${quantity} seats are in use`,
    overAssigned: (n: number) => `${n} more assigned than covered`,
    afterFirstSignIn: (email: string) => `${email} can get seats after their first sign-in.`,
    /** A switch's accessible name: which license, for whom. */
    seatSwitch: (product: string, name: string) => `${product} seat for ${name}`,
    remove: "Remove from workspace",
    removePrompt: (name: string) => `Remove ${name} from this workspace?`,
    removeConfirm: "Confirm remove",
  },

  /** Assign licenses: several people, several licenses, one request. */
  assign: {
    title: "Assign licenses",
    enough: ({ free, quantity, chosen }: { free: number; quantity: number; chosen: number }) => {
      const seats = `${free} of ${quantity} seats free`;
      if (chosen === 1) return `${seats}.`;
      return `${seats}: enough for ${chosen === 2 ? "both" : `all ${chosen}`}.`;
    },
    /** Some of the people already hold one: who, and who the free seats are for. */
    someHold: ({ holders, free, quantity, recipients }: { holders: readonly string[]; free: number; quantity: number; recipients: readonly string[] }) =>
      `${nameList(holders)} ${holders.length === 1 ? "has" : "have"} one. ${free} of ${quantity} seats free, for ${nameList(recipients)}.`,
    everyoneHolds: "Everyone you chose has one.",
    /** The seats per product: "2 Call Unlimited · 1 Example Add-on". */
    footer: (parts: ReadonlyArray<{ seats: number; name: string }>) => parts.map((part) => `${part.seats} ${part.name}`).join(" · "),
    confirm: (n: number) => (n === 0 ? "Assign" : `Assign ${plural(n, "seat")}`),
    /** Under Assign when more seats are chosen than one request takes (`MAX_SEAT_ASSIGNMENTS`). */
    tooMany: (max: number) => `You can assign up to ${max} seats at a time.`,
  },

  purchase: {
    headline: (paid: boolean) => (paid ? "Payment received" : "Purchase complete"),
    settingUp: "Setting up…",
    dismiss: "Dismiss",
    /** A workspace, while billing writes the license into Core. */
    settingUpSeats: ({ seats, product }: { seats: number; product: string }) =>
      `Setting up ${seats} ${product} ${seats === 1 ? "seat" : "seats"}. This takes a few seconds; you can stay on this page.`,
    readyTitle: ({ seats, product }: { seats: number; product: string }) =>
      `Your ${seats} ${product} ${seats === 1 ? "seat is" : "seats are"} ready`,
    readyBody: ({ product, paid }: { product: string; paid: boolean }) =>
      `${paid ? `Payment received, and ${product} is active.` : `${product} is active.`} Give the seats to members below, or from Members.`,
    /** A person. */
    personSettingUp: (product: string) => `Setting up ${product}. This takes a few seconds; you can stay on this page.`,
    personReadyTitle: (product: string) => `${product} is ready`,
    personReadyBody: ({ product, paid }: { product: string; paid: boolean }) =>
      paid ? `Payment received, and ${product} is active on your account.` : `${product} is active on your account.`,
    /** The license hasn't reached Core after a minute. */
    timeout: {
      title: (paid: boolean) => (paid ? "Your payment went through" : "Your purchase went through"),
      body: "The seats can take a few minutes to appear.",
      reload: "Reload",
    },
  },

  testMode: {
    label: (environment: string) => `Test mode · ${environment}`,
    lead: "Nothing here is charged.",
    beforeCard: "Pay with the test card",
    afterCard: ", any future date and any CVC.",
    note: "On dev and staging only Organization Admins see billing, and seats bought here work only here.",
    copy: "Copy card number",
  },

  /** The total above the cards: "2 licenses" in bold, then "$295 a month in total". */
  summary: ({ count, amount, rate }: { count: number; amount: string; rate: string }) => ({
    lead: plural(count, "license"),
    rest: `${amount} ${rate} in total`,
  }),

  refusal: {
    generic: GENERIC_REFUSAL,
  },
};

/** The strings, for a screen that takes them as a prop (a test, or a later locale). */
export type LicenseStrings = typeof licenseStrings;
