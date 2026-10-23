/**
 * Every sentence the Licenses page, the Members list's licenses and
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
 *
 * The words are Microsoft 365's. A license is one person's right to use a product; a workspace buys some number
 * of licenses for a product, and each license is assigned to one member. What the workspace buys is a product (or a
 * subscription), never "a license", and the count above the cards counts products. A price per license is "per
 * user". "Seat" is not a word anyone reads: the API and the code keep their names
 * (`seats`, `seatsUsed`, `add_seats`, the keys of this object), and the strings test scans every sentence for it.
 */

import type { LicenseFit } from "../lib/license-join";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const and = (names: readonly string[]) => (names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** What a refusal's words may name. */
export interface RefusalContext {
  /** The product's name, as billing sent it. */
  product?: string;
}

const GENERIC_REFUSAL = "Billing couldn't do that. Try again.";

/**
 * The words for a refusal from billing (`{error}`), by its code. Codes Core doesn't know, and `invalid_request`,
 * get the generic line.
 */
export function refusalMessage(code: string, context: RefusalContext = {}): string {
  const { product } = context;
  switch (code) {
    case "not_for_sale":
      return product ? `${product} isn't for sale right now.` : "That isn't for sale right now.";
    case "invalid_seats":
      return "That number of licenses isn't available. Choose a different number.";
    case "unknown_action":
      return "That isn't available for this subscription any more. Reload the page and try again.";
    case "forbidden":
      return "You don't have permission to manage billing here.";
    case "billing_staff_only":
      return "Only Organization Admins can use billing on this environment.";
    case "license_not_found":
      return "That subscription no longer exists. Reload the page.";
    case "no_billing_account":
      return "There's no billing account yet. It's created with the first purchase.";
    case "already_licensed":
      return `${product ? `You already have ${product}.` : "You already have that."} Add licenses instead.`;
    case "checkout_in_progress":
      return `A purchase of ${product ?? "that"} is already under way. Finish it, or try again in a minute.`;
    case "seat_request_pending":
      return `Someone else is adding a${product ? ` ${product}` : ""} license right now. Try again in a few minutes.`;
    case "owner_ended":
      return "This workspace has been deleted, so billing can't change it.";
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

/** One name; two joined by "and"; three or more, the first and a count: "Ana Ruiz and 2 others". */
function shortNames(names: readonly string[]): string {
  if (names.length <= 2) return and(names);
  return `${names[0]} and ${names.length - 1} others`;
}

/** What billing's actions say. `label` returns these, so a wording changes in one place. */
const actions = {
  addSeats: "Add licenses",
  /** "Add 2 licenses": the over-assigned notice's button. */
  addSeatsCount: (n: number) => `Add ${plural(n, "license")}`,
  changeSeats: "Change license count",
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
  youHaveASeat: "Assigned to you",
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
  /** The × that closes a dialog or a side panel, as a screen reader names it. */
  dialog: {
    close: "Close",
  },

  /** People, in a sentence: "Dana Reyes, Priya Natarajan and 8 others". */
  names: {
    list: nameList,
    /** The people a link's dialog names: "Ana Ruiz", "Ana Ruiz and Ben Cho", "Ana Ruiz and 2 others". */
    short: shortNames,
    holders: (names: readonly string[]) => (names.length === 0 ? "No one has a license yet" : nameList(names)),
  },

  nav: {
    licenses: "Licenses",
  },

  page: {
    title: "Licenses",
    adminsGiveOutSeats: (workspace: string) => `${workspace}'s Admins and Owners assign licenses.`,
    noSeat: {
      title: (workspace: string) => `You don't have a license in ${workspace}`,
      body: "Its Admins and Owners assign licenses. Once you have one, it works the next time you open the miniapp it's for.",
    },
    billingAndInvoices: "Billing & invoices",
    /** The workspace's header button: it buys several licenses for a product. */
    buyLicenses: "Buy licenses",
    /** A manager's page for a workspace with no product, where billing offers nothing to buy. */
    noLicenses: "This workspace has no products yet.",
    loading: "Loading licenses…",
    /**
     * What a `?buy=` link answers, each in a dialog of its own, titled with the product's name (`page.title` where the
     * catalog doesn't know it). `product` is the product's name; `people` is {@link licenseStrings.names.short}.
     */
    buyLink: {
      /** The viewer holds the product already. */
      held: (product: string) => `You already have ${product}.`,
      /** A license of it is unassigned: the dialog offers to assign it to the viewer. */
      free: (workspace: string, count: number, product: string) =>
        `${workspace} has ${count === 1 ? "1 unassigned" : `${count} unassigned`} ${product} ${count === 1 ? "license" : "licenses"}.`,
      assignToMe: "Assign it to me",
      assigned: (product: string) => `${product} is assigned to you.`,
      /** Every license is assigned to someone else: the dialog offers to add one for the viewer. */
      add: (workspace: string, count: number, product: string, people: string) =>
        `${workspace} has ${count} ${product} ${count === 1 ? "license" : "licenses"}, assigned to ${people}. Add one for you?`,
      /** The one sum under it: `price` is "$29 a month", or billing's own label for a price that isn't per user. */
      addTerms: ({ price, note }: { price: string; note: string | null }) => `1 more license · ${price}${note ? ` · ${note}` : ""}`,
      /** Nothing can be added: the licenses are all assigned (or over-assigned) and billing lists no way to add one. */
      full: (workspace: string, count: number, product: string, people: string) => ({
        body: `${workspace} has ${count} ${product} ${count === 1 ? "license" : "licenses"}, assigned to ${people}.`,
        hint: `Unassign someone on the ${product} card to free a license.`,
      }),
      alreadyHas: (workspace: string, product: string) => `${workspace} already has ${product}.`,
      notForSale: "That product isn't for sale.",
      /** `product` is the product's name, or {@link licenseStrings.page.buyLink.anyProduct} where the page doesn't know it. */
      askAnAdmin: (workspace: string, product: string) => `Only Admins and Owners of ${workspace} can buy ${product}. Ask one of them.`,
      anyProduct: "licenses",
      notHere: "Licenses can't be bought here.",
      done: "Done",
    },
    unavailable: {
      title: "Licenses are unavailable",
      body: "They can't be shown right now. Try again in a moment.",
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
    /** "$15 per user a month". */
    perSeat: (unit: string, rate: string) => `${unit} per user ${rate}`,
  },

  catalog: {
    title: "Buy licenses for your members",
    buy: "Buy",
    youHaveSeats: (n: number) => `You have ${plural(n, "license")}`,
    dialog: {
      title: "Buy licenses",
      description: "Products for your workspace. For one you have, add licenses instead.",
    },
  },

  buy: {
    title: (product: string) => `Buy ${product}`,
    /** "$15 per user a month · Renews every month. Change the number of licenses or cancel at any time." */
    terms: (price: string, cadence: string) => `${price} · Renews every ${cadence}. Change the number of licenses or cancel at any time.`,
    seats: "Licenses",
    fewer: "One license fewer",
    more: "One license more",
    members: (n: number) => `Your workspace has ${plural(n, "member")}.`,
    /** A workspace of one member buys one license, with no number to choose: "1 license · $29 a month · before tax". */
    solo: (parts: { total: string; rate: string; note: string | null }) => `1 license · ${parts.total} ${parts.rate}${parts.note ? ` · ${parts.note}` : ""}`,
    /** "10 licenses × $15 · $150 a month · before tax": the one sum Core shows. */
    summary: (parts: { seats: number; unit: string; total: string; rate: string; note: string | null }) =>
      `${plural(parts.seats, "license")} × ${parts.unit} · ${parts.total} ${parts.rate}${parts.note ? ` · ${parts.note}` : ""}`,
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
      label: "Licenses",
      inUse: (used: number, quantity: number) => `${used} of ${quantity} assigned`,
      assigned: (used: number) => `${used} assigned`,
      moreThanCovered: (over: number, quantity: number) => `${over} more than the ${quantity} covered`,
    },
    term: {
      renews: "Renews",
      ends: "Ends",
      renewal: "Renewal",
      until: (date: string) => `Until ${date}`,
      doesntRenew: "Doesn't renew",
      notPaid: "Not paid",
    },
    cost: {
      label: "Cost",
      noMoreCharges: "No more charges",
      value: (total: string, rate: string) => `${total} ${rate}`,
      /** The cost's one sub-line, for a price with tax excluded. The value above it carries the recurrence ("$145 a month"). */
      beforeTax: "Before tax",
    },
    /** A member's own card. */
    own: {
      seat: "Your license",
      since: (date: string) => `Since ${date}`,
      givenBy: (workspace: string) => `Given by ${workspace}`,
      worksIn: "Works in",
      nextTime: "The next time you open it",
    },
  },

  notice: {
    /** A failed payment: the day the licenses stop working (or stopped), and what to do. `date` is null when billing sent none. */
    pastDue: ({ date, stopped }: { date: string | null; stopped: boolean }): { title: string; body: string | null } => {
      if (date === null) {
        return { title: "The last payment didn't go through.", body: "Update the payment method to keep the licenses." };
      }
      if (stopped) {
        return { title: `Licenses stopped working on ${date}. They come back once payment goes through.`, body: null };
      }
      return { title: `Licenses stop working on ${date} unless payment goes through.`, body: "Update the payment method to keep them." };
    },
    incomplete: (product: string) => ({
      title: `The first payment for ${product} isn't finished.`,
      body: "Finish it to start the subscription.",
    }),
    /** More licenses are assigned than the product has paid for. */
    over: ({ used, quantity, canAddSeats }: { used: number; quantity: number; canAddSeats: boolean }) => {
      const extra = used - quantity;
      const unassign = `Unassign ${extra} of them`;
      return {
        title: `${used === 1 ? "1 person is" : `${used} people are`} assigned but only ${plural(quantity, "license")} ${quantity === 1 ? "is" : "are"} paid for.`,
        body: canAddSeats
          ? `${unassign}, or add ${plural(extra, "license")}. No one else can get a license until then.`
          : `${unassign}. No one else can get a license until then.`,
      };
    },
  },

  actions,

  seats: {
    title: "Assigned to",
    searchPlaceholder: "Search people with a license",
    since: (date: string) => `Since ${date}`,
    unassign: "Unassign",
    cancel: "Cancel",
    /** Unassign's dialog: its title, and the one line under it. */
    unassignPrompt: (name: string) => `Unassign ${name}?`,
    unassignBody: (name: string, product: string) => `${name} loses ${product} the next time they open it.`,
    /** Unassign's accessible name: whose license. */
    unassignAria: (name: string) => `Unassign ${name}`,
    freeSeat: "Available license",
    assign: "Assign",
    assignSeats: "Assign licenses",
    freeSeats: (n: number) => plural(n, "available license"),
    nobodyYet: "No one has a license yet.",
    allInUse: (quantity: number) => (quantity === 1 ? "The license is assigned." : `All ${quantity} licenses are assigned.`),
    allInUseHelp: (canAddSeats: boolean) =>
      canAddSeats ? "Add licenses to give one to someone else, or unassign someone to free theirs." : "Unassign someone to free their license.",
    moreAvatars: (n: number) => `+${n}`,
  },

  /** How many of the people chosen fit in the licenses that are available. */
  fit: {
    note: ({ fit, needed, canAddSeats }: { fit: number; needed: number; canAddSeats: boolean }) => {
      const remove = needed - fit === 1 ? "one" : String(needed - fit);
      return `${fit} of ${needed} fit: remove ${remove}${canAddSeats ? " or add licenses" : ""}.`;
    },
    /**
     * The line a license dialog shows for the people chosen (`fitFor`'s result for one license): which of the
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
    title: "Assign licenses",
    description: (product: string, free: number) => `${product} · ${plural(free, "available license")}`,
    search: "Search by name or email",
    noMatches: "No one matches your search.",
    hasASeat: "Has a license",
    afterFirstSignIn: "After first sign-in",
    chosen: (chosen: number, free: number) => `${chosen} of ${plural(free, "available license")} chosen`,
    assign: (n: number) => (n === 0 ? "Assign" : `Assign ${plural(n, "license")}`),
    cancel: "Cancel",
  },

  /** What a bulk assignment says when the counts it was built on changed. */
  conflict: {
    seatsChanged: "Licenses changed while you were choosing. Nothing was assigned. Check the counts and try again.",
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
    /** An Organization Admin's copy button for a member's Mentra user id, in the row (`showUserIds`). */
    copyId: "Copy id",
    copyIdFor: (name: string) => `Copy the Mentra user id of ${name}`,
    /** The row's "…" menu, named for the member: Change role to a role, and Remove from workspace. */
    moreFor: (name: string) => `More for ${name}`,
    changeRoleTo: (role: string) => `Change role to ${role}`,
    remove: "Remove from workspace",
    /** Remove's dialog: its title, one plain line under it, and its buttons. */
    removePrompt: (name: string) => `Remove ${name} from this workspace?`,
    removeBody: "They lose access to this workspace, and any licenses assigned to them are freed.",
    removeConfirm: "Remove",
    cancel: "Cancel",
  },

  /**
   * The questions asked in a dialog before something that can't be taken back and isn't about a license: leaving a
   * workspace, deleting it, and revoking an invitation or a key. Each has its title (the question), one plain line
   * under it, and the action's name on the destructive button, beside a Cancel.
   */
  confirm: {
    cancel: "Cancel",
    leave: {
      title: (workspace: string) => `Leave ${workspace}?`,
      body: "You lose access to this workspace.",
      action: "Leave",
    },
    delete: {
      title: (workspace: string) => `Delete ${workspace}?`,
      body: "Deleting a workspace ends every membership and invitation and revokes every key. It cannot be undone.",
      /** The field that asks for the workspace's name back, in the parts a screen styles (the name is bold). */
      typeName: (workspace: string) => ({ lead: "Type ", name: workspace, rest: " to confirm" }),
      action: "Delete",
    },
    revokeInvitation: {
      title: (email: string) => `Revoke the invitation for ${email}?`,
      body: "The link they were sent stops working.",
      action: "Revoke",
    },
    revokeKey: {
      title: (name: string) => `Revoke ${name}?`,
      body: "Anything using it stops working.",
      action: "Revoke",
    },
  },

  /** What fits when licenses are given to several people at once: the people picker's lines. */
  assign: {
    enough: ({ free, quantity, chosen }: { free: number; quantity: number; chosen: number }) => {
      const available = `${free} of ${plural(quantity, "license")} available`;
      if (chosen === 1) return `${available}.`;
      return `${available}: enough for ${chosen === 2 ? "both" : `all ${chosen}`}.`;
    },
    /** Some of the people already hold one: who, and who the available licenses are for. */
    someHold: ({ holders, free, quantity, recipients }: { holders: readonly string[]; free: number; quantity: number; recipients: readonly string[] }) =>
      `${nameList(holders)} ${holders.length === 1 ? "has" : "have"} one. ${free} of ${plural(quantity, "license")} available, for ${nameList(recipients)}.`,
    everyoneHolds: "Everyone you chose has one.",
    /** Under Assign when more licenses are chosen than one request takes (`MAX_SEAT_ASSIGNMENTS`). */
    tooMany: (max: number) => `You can assign up to ${plural(max, "license")} at a time.`,
  },

  purchase: {
    headline: (paid: boolean) => (paid ? "Payment received" : "Purchase complete"),
    settingUp: "Setting up…",
    dismiss: "Dismiss",
    /** A workspace, while billing writes the license into Core. */
    settingUpSeats: ({ seats, product }: { seats: number; product: string }) =>
      `Setting up ${seats} ${product} ${seats === 1 ? "license" : "licenses"}. This takes a few seconds; you can stay on this page.`,
    readyTitle: ({ seats, product }: { seats: number; product: string }) =>
      `Your ${seats} ${product} ${seats === 1 ? "license is" : "licenses are"} ready`,
    readyBody: ({ product, paid }: { product: string; paid: boolean }) =>
      `${paid ? `Payment received, and ${product} is active.` : `${product} is active.`} Assign the licenses to members below.`,
    /** The new licenses include one assigned to the viewer, who bought them. */
    givenTitle: ({ seats, product, paid }: { seats: number; product: string; paid: boolean }) =>
      seats === 1 ? (paid ? `Your ${product} license is ready` : "Purchase complete") : `Your ${seats} ${product} licenses are ready`,
    givenBody: ({ seats, product, paid }: { seats: number; product: string; paid: boolean }) => {
      const lead = paid ? "Payment received" : `${product} is active`;
      return seats === 1 ? `${lead}, and it's assigned to you.` : `${lead}, and one is assigned to you. Assign the rest to members below.`;
    },
    /** The purchase hasn't reached Core after a minute. */
    timeout: {
      title: (paid: boolean) => (paid ? "Your payment went through" : "Your purchase went through"),
      body: "The licenses can take a few minutes to appear.",
      reload: "Reload",
    },
  },

  testMode: {
    label: (environment: string) => `Test mode · ${environment}`,
    lead: "Nothing here is charged.",
    beforeCard: "Pay with the test card",
    afterCard: ", any future date and any CVC.",
    copy: "Copy card number",
    /** The × in the banner's corner: hides the notice for the rest of the browser session. */
    hide: "Hide the test mode notice",
  },

  /** The total above the cards: "2 products" in bold, then "$295 a month in total". What is counted is what the workspace buys. */
  summary: ({ count, amount, rate }: { count: number; amount: string; rate: string }) => ({
    lead: plural(count, "product"),
    rest: `${amount} ${rate} in total`,
  }),

  refusal: {
    generic: GENERIC_REFUSAL,
  },
};

/** The strings, for a screen that takes them as a prop (a test, or a later locale). */
export type LicenseStrings = typeof licenseStrings;
