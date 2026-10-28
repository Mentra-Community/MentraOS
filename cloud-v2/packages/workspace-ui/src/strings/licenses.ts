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
 * A subscription is one person's right to use a product: a workspace buys some number of subscriptions for a product,
 * and each is assigned to one member. A price per subscription is "per user". "Seat" and "license" are not words anyone
 * reads: the API and the code keep their names (`licenses`, `seats`, `seatsUsed`, `add_seats`, the keys of this object),
 * and the strings test scans every sentence for them.
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
      return "That number of subscriptions isn't available. Choose a different number.";
    case "unknown_action":
      return "That isn't available for this subscription any more. Reload the page and try again.";
    case "forbidden":
      return "You don't have permission to manage billing here.";
    case "license_not_found":
      return "That subscription no longer exists. Reload the page.";
    case "no_billing_account":
      return "There's no billing account yet. It's created with the first purchase.";
    case "already_licensed":
      return `${product ? `You already have ${product}.` : "You already have that."} Buy more subscriptions instead.`;
    case "seat_request_pending":
      return `Someone else is adding ${product ? `a ${product} subscription` : "a subscription"} right now. Try again in a few minutes.`;
    case "checkout_in_progress":
      return `A purchase of ${product ?? "that"} is already under way. Finish it, or try again in a minute.`;
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
  if (names.length === 0) return "";
  if (names.length <= 2) return and(names);
  return `${names[0]} and ${names.length - 1} others`;
}

/**
 * What a person who now holds a product is told, back from buying it or from a link that assigned it to them. `seats`
 * is how many were bought: past one, the rest are theirs to assign.
 */
const youNowHave = (product: string, seats = 1) => ({
  title: `You now have ${product}!`,
  body: `Open the Mentra App now to use it on your smart glasses.${seats > 1 ? " Assign the rest to members below." : ""}`,
});

/** What billing's actions say. `label` returns these, so a wording changes in one place. */
const actions = {
  addSeats: "Buy subscriptions",
  /** The same, on a card whose subscriptions are all assigned. */
  addMoreSeats: "Buy more subscriptions",
  /** "Buy 2 subscriptions": the over-assigned notice's button. */
  addSeatsCount: (n: number) => `Buy ${plural(n, "subscription")}`,
  changeSeats: "Change subscription count",
  cancel: "Cancel",
  renew: "Renew",
  updatePayment: "Update payment method",
  completePayment: "Complete payment",
  billingAndInvoices: "Billing",
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
    holders: (names: readonly string[]) => (names.length === 0 ? "No one has a subscription yet" : nameList(names)),
  },

  nav: {
    licenses: "Subscriptions",
  },

  page: {
    title: "Subscriptions",
    adminsGiveOutSeats: (workspace: string) => `${workspace}'s Admins and Owners assign subscriptions.`,
    noSeat: {
      title: (workspace: string) => `You don't have a subscription in ${workspace}`,
      body: "Its Admins and Owners assign subscriptions. Once you have one, it works the next time you open the miniapp it's for.",
    },
    /** A manager's page for a workspace with no product, where billing offers nothing to buy. */
    noLicenses: "This workspace has no products yet.",
    loading: "Loading subscriptions…",
    /**
     * What a `?buy=` link answers. Where the link can get the person a subscription, the page does it with no click (assigns
     * a free one, or opens billing's hosted page for one more) and a dialog says what happened; the others are a
     * dialog that says why not. Every dialog is titled with the product's name (`page.title` where the catalog doesn't
     * know it). `product` is the product's name; `people` is {@link licenseStrings.names.short}.
     */
    buyLink: {
      /** The viewer holds the product already. */
      held: (product: string) => `You already have ${product}.`,
      /** A free subscription was assigned to the viewer, with no click: {@link licenseStrings.purchase.youNowHave}. */
      youNowHave,
      /** The free subscription the link picked was taken before the assignment landed. */
      assignTaken: "That subscription was just taken. Nothing was assigned.",
      /** While billing is asked for the hosted page the link goes to. */
      openingCheckout: "Opening checkout…",
      /** Nothing can be added: the subscriptions are all assigned (or over-assigned) and billing lists no way to add one. */
      full: (workspace: string, count: number, product: string, people: string) => ({
        body: `${workspace} has ${count} ${product} ${count === 1 ? "subscription" : "subscriptions"}${people === "" ? "" : `, assigned to ${people}`}.`,
        hint: `Unassign someone on the ${product} card to free a subscription.`,
      }),
      alreadyHas: (workspace: string, product: string) => `${workspace} already has ${product}.`,
      notForSale: "That product isn't for sale.",
      /** `product` is the product's name, or {@link licenseStrings.page.buyLink.anyProduct} where the page doesn't know it. */
      askAnAdmin: (workspace: string, product: string) => `Only Admins and Owners of ${workspace} can buy ${product}. Ask one of them.`,
      anyProduct: "subscriptions",
      notHere: "Subscriptions can't be bought here.",
      done: "Done",
    },
    unavailable: {
      title: "Subscriptions are unavailable",
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
    title: "Buy subscriptions for your members",
    buy: "Buy",
    youHaveSeats: (n: number) => `You have ${plural(n, "subscription")}`,
    dialog: {
      title: "Buy subscriptions",
      description: "Products for your workspace. For one you have, buy more subscriptions instead.",
    },
  },

  buy: {
    title: (product: string) => `Buy ${product}`,
    /** "$15 per user a month · Renews every month. Change the number of subscriptions or cancel at any time." */
    terms: (price: string, cadence: string) => `${price} · Renews every ${cadence}. Change the number of subscriptions or cancel at any time.`,
    seats: "Subscriptions",
    fewer: "One subscription fewer",
    more: "One subscription more",
    members: (n: number) => `Your workspace has ${plural(n, "member")}.`,
    /** A workspace of one member buys one subscription, with no number to choose: "1 subscription · $29 a month · before tax". */
    solo: (parts: { total: string; rate: string; note: string | null }) => `1 subscription · ${parts.total} ${parts.rate}${parts.note ? ` · ${parts.note}` : ""}`,
    /** "10 subscriptions × $15 · $150 a month · before tax": the one sum Core shows. */
    summary: (parts: { seats: number; unit: string; total: string; rate: string; note: string | null }) =>
      `${plural(parts.seats, "subscription")} × ${parts.unit} · ${parts.total} ${parts.rate}${parts.note ? ` · ${parts.note}` : ""}`,
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
      label: "Subscriptions",
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
      /** The value carries the recurrence ("$145 a month"), with no line under it. */
      value: (total: string, rate: string) => `${total} ${rate}`,
    },
    /** A member's own card. */
    own: {
      seat: "Your subscription",
      since: (date: string) => `Since ${date}`,
      givenBy: (workspace: string) => `Given by ${workspace}`,
      worksIn: "Works in",
      nextTime: "The next time you open it",
    },
  },

  notice: {
    /** A failed payment: the day the subscriptions stop working (or stopped), and what to do. `date` is null when billing sent none. */
    pastDue: ({ date, stopped }: { date: string | null; stopped: boolean }): { title: string; body: string | null } => {
      if (date === null) {
        return { title: "The last payment didn't go through.", body: "Update the payment method to keep the subscriptions." };
      }
      if (stopped) {
        return { title: `Subscriptions stopped working on ${date}. They come back once payment goes through.`, body: null };
      }
      return { title: `Subscriptions stop working on ${date} unless payment goes through.`, body: "Update the payment method to keep them." };
    },
    incomplete: (product: string) => ({
      title: `The first payment for ${product} isn't finished.`,
      body: "Finish it to start the subscription.",
    }),
    /** More subscriptions are assigned than the product has paid for. */
    over: ({ used, quantity, canAddSeats }: { used: number; quantity: number; canAddSeats: boolean }) => {
      const extra = used - quantity;
      const unassign = `Unassign ${extra} of them`;
      return {
        title: `${used === 1 ? "1 person is" : `${used} people are`} assigned but only ${plural(quantity, "subscription")} ${quantity === 1 ? "is" : "are"} paid for.`,
        body: canAddSeats
          ? `${unassign}, or buy ${plural(extra, "subscription")}. No one else can get a subscription until then.`
          : `${unassign}. No one else can get a subscription until then.`,
      };
    },
  },

  actions,

  seats: {
    title: "Assigned to",
    searchPlaceholder: "Search people with a subscription",
    since: (date: string) => `Since ${date}`,
    unassign: "Unassign",
    cancel: "Cancel",
    /** Unassign's dialog: its title, and the one line under it. */
    unassignPrompt: (name: string) => `Unassign ${name}?`,
    unassignBody: (name: string, product: string) => `${name} loses ${product} the next time they open it.`,
    /** Unassign's accessible name: whose subscription. */
    unassignAria: (name: string) => `Unassign ${name}`,
    assignSeats: "Assign subscriptions",
    allInUse: (quantity: number) => (quantity === 1 ? "The subscription is assigned." : `All ${quantity} subscriptions are assigned.`),
    moreAvatars: (n: number) => `+${n}`,
  },

  /** How many of the people chosen fit in the subscriptions that are available. */
  fit: {
    note: ({ fit, needed, canAddSeats }: { fit: number; needed: number; canAddSeats: boolean }) => {
      const remove = needed - fit === 1 ? "one" : String(needed - fit);
      return `${fit} of ${needed} fit: remove ${remove}${canAddSeats ? " or buy subscriptions" : ""}.`;
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
    title: "Assign subscriptions",
    description: (product: string, free: number) => `${product} · ${plural(free, "available subscription")}`,
    search: "Search by name or email",
    noMatches: "No one matches your search.",
    hasASeat: "Has a subscription",
    afterFirstSignIn: "After first sign-in",
    chosen: (chosen: number, free: number) => `${chosen} of ${plural(free, "available subscription")} chosen`,
    assign: (n: number) => (n === 0 ? "Assign" : `Assign ${plural(n, "subscription")}`),
    cancel: "Cancel",
  },

  /** What a bulk assignment says when the counts it was built on changed. */
  conflict: {
    seatsChanged: "Subscriptions changed while you were choosing. Nothing was assigned. Check the counts and try again.",
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
    /** The Subscriptions column. */
    licenses: "Subscriptions",
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
    removeBody: "They lose access to this workspace, and any subscriptions assigned to them are freed.",
    removeConfirm: "Remove",
    cancel: "Cancel",
  },

  /**
   * The questions asked in a dialog before something that can't be taken back and isn't about a subscription: leaving a
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

  /** What fits when subscriptions are given to several people at once: the people picker's lines. */
  assign: {
    enough: ({ free, quantity, chosen }: { free: number; quantity: number; chosen: number }) => {
      const available = `${free} of ${plural(quantity, "subscription")} available`;
      if (chosen === 1) return `${available}.`;
      return `${available}: enough for ${chosen === 2 ? "both" : `all ${chosen}`}.`;
    },
    /** Some of the people already hold one: who, and who the available subscriptions are for. */
    someHold: ({ holders, free, quantity, recipients }: { holders: readonly string[]; free: number; quantity: number; recipients: readonly string[] }) =>
      `${nameList(holders)} ${holders.length === 1 ? "has" : "have"} one. ${free} of ${plural(quantity, "subscription")} available, for ${nameList(recipients)}.`,
    everyoneHolds: "Everyone you chose has one.",
    /** Under Assign when more subscriptions are chosen than one request takes (`MAX_SEAT_ASSIGNMENTS`). */
    tooMany: (max: number) => `You can assign up to ${plural(max, "subscription")} at a time.`,
  },

  /**
   * The dialog back from checkout (`?purchase=`) or from the hosted page that added a subscription (`?added=`). It is titled
   * with the product's name; these are its heading and its sentence in each state, and its buttons.
   */
  purchase: {
    headline: (paid: boolean) => (paid ? "Payment received" : "Purchase complete"),
    settingUp: "Setting up…",
    /** Closes the dialog, in every state. */
    ok: "OK",
    /** A workspace, while billing writes the subscriptions into Core. */
    settingUpSeats: ({ seats, product }: { seats: number; product: string }) =>
      `Setting up ${seats} ${product} ${seats === 1 ? "subscription" : "subscriptions"}. This takes a few seconds; you can stay on this page.`,
    readyTitle: ({ seats, product }: { seats: number; product: string }) =>
      `Your ${seats} ${product} ${seats === 1 ? "subscription is" : "subscriptions are"} ready`,
    readyBody: ({ product, paid }: { product: string; paid: boolean }) =>
      `${paid ? `Payment received, and ${product} is active.` : `${product} is active.`} Assign the subscriptions to members below.`,
    /** The new subscriptions include one assigned to the viewer, who bought them: they can use it now. */
    youNowHave,
    /** The purchase hasn't reached Core after a minute. */
    timeout: {
      title: (paid: boolean) => (paid ? "Your payment went through" : "Your purchase went through"),
      body: "The subscriptions can take a few minutes to appear.",
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

  refusal: {
    generic: GENERIC_REFUSAL,
  },
};

/** The strings, for a screen that takes them as a prop (a test, or a later locale). */
export type LicenseStrings = typeof licenseStrings;
