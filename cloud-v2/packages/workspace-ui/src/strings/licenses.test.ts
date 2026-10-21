import { describe, expect, test } from "bun:test";
import { BILLING_ERROR_CODES, KNOWN_ACTION_KINDS, KNOWN_LICENSE_STATUSES } from "@mentra/workspace-contract/portal-billing";
import { licenseStrings as t, refusalMessage } from "./licenses";

// The spec's copy, word for word, with names and numbers filled in. Amounts and dates arrive formatted.

describe("counts", () => {
  test("pluralise from one", () => {
    expect([t.count.seats(1), t.count.seats(5), t.count.seats(0)]).toEqual(["1 seat", "5 seats", "0 seats"]);
    expect([t.count.people(1), t.count.people(3)]).toEqual(["1 person", "3 people"]);
    expect([t.count.members(1), t.count.members(14)]).toEqual(["1 member", "14 members"]);
    expect([t.count.licenses(1), t.count.licenses(2)]).toEqual(["1 license", "2 licenses"]);
  });
});

describe("the pages", () => {
  test("the Licenses page", () => {
    expect(t.page.title).toBe("Licenses");
    expect(t.page.description("Acme Field Services")).toBe("What Acme Field Services pays for, and who has each seat.");
    expect(t.page.memberDescription("Acme Field Services")).toBe("Your seats in Acme Field Services.");
    expect(t.page.adminsGiveOutSeats("Acme Field Services")).toBe("Acme Field Services's Admins and Owners give out seats.");
    expect(t.page.noSeat.title("Acme Field Services")).toBe("You don't have a seat in Acme Field Services");
    expect(t.page.noSeat.body).toBe(
      "Its Admins and Owners give out seats. Once you have one, it works the next time you open the miniapp it's for.",
    );
    expect(t.page.billingAndInvoices).toBe("Billing & invoices");
    expect(t.page.buyALicense).toBe("Buy a license");
  });

  test("its unavailable state, and the personal page's", () => {
    expect(t.page.unavailable).toEqual({
      title: "Licenses are unavailable",
      body: "They can't be shown right now. Try again in a moment.",
      retry: "Retry",
    });
    expect(t.personal.unavailable.title).toBe("Billing is unavailable");
    expect(t.personal.unavailable.retry).toBe("Retry");
  });

  test("the personal Billing page and the navigation to it", () => {
    expect(t.personal.title).toBe("Billing");
    expect(t.personal.description).toBe("Licenses you buy for yourself, apart from any workspace's.");
    expect(t.nav).toMatchObject({ licenses: "Licenses", billing: "Billing", yourAccount: "Your account" });
    expect(t.nav.backTo("Acme Field Services")).toBe("Back to Acme Field Services");
  });
});

describe("the catalog and buying", () => {
  test("the catalog's headings differ for a workspace and a person", () => {
    expect(t.catalog.workspace).toEqual({
      title: "Buy a license for your members",
      intro: "You'll pay by card on a secure payment page, then come back here to give out the seats.",
    });
    expect(t.catalog.person).toEqual({
      title: "Buy a license for yourself",
      intro: "You'll pay by card on a secure payment page, then come back here.",
    });
    expect(t.catalog.buy).toBe("Buy");
  });

  test("the catalog dialog and its held rows", () => {
    expect(t.catalog.dialog.title).toBe("Buy a license");
    expect(t.catalog.dialog.description).toBe("Products for your workspace. For one you have, add seats instead.");
    expect(t.catalog.youHaveSeats(5)).toBe("You have 5 seats");
    expect(t.catalog.youHaveSeats(1)).toBe("You have 1 seat");
    expect(t.catalog.youHaveIt).toBe("You have it");
  });

  test("the seats step", () => {
    expect(t.buy.title("Fleet")).toBe("Buy Fleet");
    expect(t.buy.terms("$15 per seat a month", "month")).toBe(
      "$15 per seat a month · Renews every month. Change the seats or cancel at any time.",
    );
    expect(t.buy.terms("$15 per seat every 3 months", "3 months")).toBe(
      "$15 per seat every 3 months · Renews every 3 months. Change the seats or cancel at any time.",
    );
    expect(t.buy.seats).toBe("Seats");
    expect([t.buy.fewer, t.buy.more]).toEqual(["One seat fewer", "One seat more"]);
    expect(t.buy.members(14)).toBe("Your workspace has 14 members.");
    expect(t.buy.members(1)).toBe("Your workspace has 1 member.");
    expect(t.buy.summary({ seats: 10, unit: "$15", total: "$150", rate: "a month", note: "before tax" })).toBe(
      "10 seats × $15 · $150 a month · before tax",
    );
    expect(t.buy.summary({ seats: 1, unit: "$15", total: "$15", rate: "a month", note: null })).toBe("1 seat × $15 · $15 a month");
    expect(t.buy.payNote).toBe("You'll pay by card on a secure payment page.");
    expect([t.buy.cancel, t.buy.continue]).toEqual(["Cancel", "Continue to payment"]);
  });
});

describe("a license's card", () => {
  test("badges", () => {
    expect(t.status.active).toBe("Active");
    expect(t.status.ending("Nov 20")).toBe("Ends Nov 20");
    expect(t.status.pastDue).toBe("Payment failed");
    expect(t.status.incomplete).toBe("Payment incomplete");
    expect(t.status.processing).toBe("Setting up");
    expect(t.status.over(2)).toBe("2 over");
    expect(t.status.youHaveASeat).toBe("You have a seat");
  });

  test("a license's status is worded by its named badge, and an unknown one keeps billing's label", () => {
    const s = t.status;
    expect(s.label("active", "x")).toBe(s.active);
    expect(s.label("ending", "x", "Nov 20")).toBe(s.ending("Nov 20"));
    expect(s.label("past_due", "x")).toBe(s.pastDue);
    expect(s.label("incomplete", "x")).toBe(s.incomplete);
    expect(s.label("processing", "x")).toBe(s.processing);
    for (const known of KNOWN_LICENSE_STATUSES) expect(s.label(known, "FALLBACK", "Nov 20")).not.toBe("FALLBACK");
    expect(s.label("paused", "Paused")).toBe("Paused");
    // An ending license billing sent no end for can't say "Ends <date>": billing's own label stands.
    expect(s.label("ending", "Ending soon")).toBe("Ending soon");
  });

  test("the seats fact", () => {
    expect(t.facts.seats.label).toBe("Seats");
    expect(t.facts.seats.inUse(3, 5)).toBe("3 of 5 in use");
    expect(t.facts.seats.free(2)).toBe("2 free");
    expect(t.facts.seats.free(0)).toBe("None free");
    expect(t.facts.seats.assigned(7)).toBe("7 assigned");
    expect(t.facts.seats.moreThanCovered(2, 5)).toBe("2 more than the 5 covered");
  });

  test("the term fact: Renews, Ends or Renewal, and never 'Paid through'", () => {
    expect(t.facts.term.renews).toBe("Renews");
    expect(t.facts.term.ends).toBe("Ends");
    expect(t.facts.term.renewal).toBe("Renewal");
    expect(t.facts.term.every("month")).toBe("Every month");
    expect(t.facts.term.every("3 months")).toBe("Every 3 months");
    expect(t.facts.term.until("Dec 1, 2026")).toBe("Until Dec 1, 2026");
    expect(t.facts.term.doesntRenew).toBe("Doesn't renew");
    expect(t.facts.term.notPaid).toBe("Not paid");
  });

  test("the cost fact", () => {
    expect(t.facts.cost.label).toBe("Cost");
    expect(t.facts.cost.noMoreCharges).toBe("No more charges");
    expect(t.facts.cost.value("$145", "a month")).toBe("$145 a month");
    expect(t.facts.cost.multiple(5, "$29")).toBe("5 × $29");
    expect(t.facts.cost.foot(["5 × $29", "before tax"])).toBe("5 × $29 · before tax");
    expect(t.facts.cost.foot(["5 × $29", null])).toBe("5 × $29");
    expect(t.facts.cost.foot([null, null])).toBeNull();
  });

  test("a member's own seat", () => {
    expect(t.facts.own.seat).toBe("Your seat");
    expect(t.facts.own.since("Oct 20, 2026")).toBe("Since Oct 20, 2026");
    expect(t.facts.own.givenBy("Acme Field Services")).toBe("Given by Acme Field Services");
    expect(t.facts.own.worksIn).toBe("Works in");
    expect(t.facts.own.nextTime).toBe("The next time you open it");
  });

  test("the failed-payment notice names the day the seats stop, then says they stopped", () => {
    expect(t.notice.pastDue({ date: "Nov 23, 2026", stopped: false })).toEqual({
      title: "Seats stop on Nov 23, 2026 unless payment goes through.",
      body: "Update the payment method to keep them.",
    });
    expect(t.notice.pastDue({ date: "Nov 23, 2026", stopped: true })).toEqual({
      title: "Seats stopped on Nov 23, 2026. They come back once payment goes through.",
      body: null,
    });
    // Billing always sends the date; a license without one still gets a notice that claims nothing about it.
    expect(t.notice.pastDue({ date: null, stopped: false })).toEqual({
      title: "The last payment didn't go through.",
      body: "Update the payment method to keep the seats.",
    });
  });

  test("the incomplete-payment notice", () => {
    expect(t.notice.incomplete("Mentra Call Unlimited")).toEqual({
      title: "The first payment for Mentra Call Unlimited isn't finished.",
      body: "Finish it to start the license.",
    });
  });

  test("the over-assigned notice, with and without 'add seats'", () => {
    expect(t.notice.over({ used: 7, quantity: 5, canAddSeats: true })).toEqual({
      title: "7 people have a seat, but the license covers 5.",
      body: "Unassign 2 of them, or add 2 seats. No one else can get a seat until then.",
    });
    expect(t.notice.over({ used: 7, quantity: 5, canAddSeats: false })).toEqual({
      title: "7 people have a seat, but the license covers 5.",
      body: "Unassign 2 of them. No one else can get a seat until then.",
    });
    expect(t.notice.over({ used: 6, quantity: 5, canAddSeats: true }).body).toBe(
      "Unassign 1 of them, or add 1 seat. No one else can get a seat until then.",
    );
  });
});

describe("billing's actions", () => {
  test("every kind Core knows is worded by its named constant, and an unknown kind keeps billing's label", () => {
    const a = t.actions;
    expect(a.label("add_seats", "x")).toBe(a.addSeats);
    expect(a.label("change_seats", "x")).toBe(a.changeSeats);
    expect(a.label("cancel", "x")).toBe(a.cancel);
    expect(a.label("renew", "x")).toBe(a.renew);
    expect(a.label("update_payment", "x")).toBe(a.updatePayment);
    expect(a.label("complete_payment", "x")).toBe(a.completePayment);
    expect(a.label("billing_and_invoices", "x")).toBe(a.billingAndInvoices);
    expect(a.label("pause_collection", "Pause billing")).toBe("Pause billing");
    for (const kind of KNOWN_ACTION_KINDS) expect(a.label(kind, "FALLBACK")).not.toBe("FALLBACK");
    // The words themselves, as the spec has them.
    expect([a.addSeats, a.changeSeats, a.cancel, a.renew, a.updatePayment, a.completePayment, a.billingAndInvoices]).toEqual([
      "Add seats",
      "Change seats",
      "Cancel",
      "Renew",
      "Update payment method",
      "Complete payment",
      "Billing & invoices",
    ]);
  });

  test("a button that leaves the portal says so to a screen reader", () => {
    expect(t.actions.opensSecureBillingPage).toBe("Opens a secure billing page");
    expect(t.actions.opensSecureBillingPageInNewTab).toBe("Opens a secure billing page in a new tab");
  });

  test("adding a number of seats, and the link for a blocked tab", () => {
    expect([t.actions.addSeatsCount(2), t.actions.addSeatsCount(1)]).toEqual(["Add 2 seats", "Add 1 seat"]);
    expect(t.actions.openPaymentPage).toBe("Open the payment page");
  });
});

describe("seats", () => {
  test("the roster", () => {
    expect(t.seats.title).toBe("Seat holders");
    expect(t.seats.searchPlaceholder).toBe("Search seat holders");
    expect(t.seats.since("Oct 20, 2026")).toBe("Since Oct 20, 2026");
    expect(t.seats.unassign).toBe("Unassign");
    expect(t.seats.freeSeat).toBe("Free seat");
    expect(t.seats.assign).toBe("Assign");
    expect(t.seats.assignSeats).toBe("Assign seats");
    expect(t.seats.freeSeats(7)).toBe("7 free seats");
    expect(t.seats.nobodyYet).toBe("Nobody has a seat yet.");
  });

  test("a full roster, with and without 'add seats'", () => {
    expect(t.seats.allInUse(5)).toBe("All 5 seats are in use.");
    expect(t.seats.allInUseHelp(true)).toBe("Add seats to give one to someone else, or unassign someone to free theirs.");
    expect(t.seats.allInUseHelp(false)).toBe("Unassign someone to free their seat.");
  });

  test("who holds the seats, in a strip", () => {
    expect(t.names.holders([])).toBe("Nobody has a seat yet");
    expect(t.names.holders(["Dana Reyes", "Priya Natarajan", "C", "D", "E", "F", "G", "H", "I", "J"])).toBe(
      "Dana Reyes, Priya Natarajan and 8 others",
    );
    expect(t.seats.moreAvatars(3)).toBe("+3");
  });
});

describe("the people picker", () => {
  test("its dialog", () => {
    expect(t.picker.title).toBe("Assign seats");
    expect(t.picker.description("Mentra Call Unlimited", 3)).toBe("Mentra Call Unlimited · 3 free seats");
    expect(t.picker.description("Mentra Call Unlimited", 1)).toBe("Mentra Call Unlimited · 1 free seat");
    expect(t.picker.search).toBe("Search by name or email");
    expect(t.picker.hasASeat).toBe("Has a seat");
    expect(t.picker.afterFirstSignIn).toBe("After first sign-in");
    expect(t.picker.chosen(2, 3)).toBe("2 of 3 free seats chosen");
    expect([t.picker.assign(0), t.picker.assign(1), t.picker.assign(3)]).toEqual(["Assign", "Assign 1 seat", "Assign 3 seats"]);
    expect(t.picker.cancel).toBe("Cancel");
    expect(t.picker.noMatches).toBe("No one matches your search.");
  });

  test("seats that changed while it was open", () => {
    expect(t.conflict.seatsChanged).toBe(
      "Seats changed while you were choosing. Nothing was assigned. Check the counts and try again.",
    );
  });
});

describe("Members and the member panel", () => {
  test("the list", () => {
    expect(t.members.title).toBe("Members");
    expect([t.members.member, t.members.role, t.members.joined, t.members.you]).toEqual(["Member", "Role", "Joined", "You"]);
    expect(t.members.pendingFirstSignIn).toBe("Pending first sign-in");
    expect(t.members.importedMember).toBe("Imported member");
    expect(t.members.licenses).toBe("Licenses");
    expect(t.members.none).toBe("None");
    expect(t.members.afterFirstSignIn).toBe("After first sign-in");
    expect(t.members.moreChips(2)).toBe("+2");
    expect(t.members.selected(2)).toBe("2 selected");
    expect(t.members.assignLicenses).toBe("Assign licenses");
    expect(t.members.clearSelection).toBe("Clear selection");
    expect(t.members.selectMember("Luis Ortega")).toBe("Select Luis Ortega");
    expect(t.members.openMember("Luis Ortega")).toBe("Open Luis Ortega");
  });

  test("the panel's role and joining", () => {
    expect([t.memberPanel.role, t.memberPanel.joined, t.memberPanel.changeRole]).toEqual(["Role", "Joined", "Change role"]);
  });

  test("the panel's Licenses section", () => {
    expect(t.memberPanel.licenses).toBe("Licenses");
    expect(t.memberPanel.intro("Luis Ortega")).toBe("Turn one on to give Luis Ortega a seat. Changes apply right away.");
    expect(t.memberPanel.hasASeat(1, 5)).toBe("Has a seat · 1 of 5 free");
    expect(t.memberPanel.seatsFree(1, 3)).toBe("1 of 3 seats free");
    expect(t.memberPanel.allInUse(10)).toBe("All 10 seats are in use");
    expect(t.memberPanel.overAssigned(2)).toBe("2 more assigned than covered");
    expect(t.memberPanel.afterFirstSignIn("sam@acme.test")).toBe("sam@acme.test can get seats after their first sign-in.");
    expect(t.memberPanel.seatSwitch("Mentra Call Unlimited", "Luis Ortega")).toBe("Mentra Call Unlimited seat for Luis Ortega");
  });

  test("removing a member asks first", () => {
    expect(t.memberPanel.remove).toBe("Remove from workspace");
    expect(t.memberPanel.removePrompt("Luis Ortega")).toBe("Remove Luis Ortega from this workspace?");
    expect(t.memberPanel.removeConfirm).toBe("Confirm remove");
  });

  test("assigning several licenses to several people", () => {
    expect(t.assign.title).toBe("Assign licenses");
    expect(t.assign.enough({ free: 2, quantity: 5, chosen: 2 })).toBe("2 of 5 seats free: enough for both.");
    expect(t.assign.enough({ free: 4, quantity: 5, chosen: 3 })).toBe("4 of 5 seats free: enough for all 3.");
    expect(t.assign.enough({ free: 4, quantity: 5, chosen: 1 })).toBe("4 of 5 seats free.");
    expect(t.assign.someHold({ holders: ["Amara Okafor"], free: 1, quantity: 3, recipients: ["Luis Ortega"] })).toBe(
      "Amara Okafor has one. 1 of 3 seats free, for Luis Ortega.",
    );
    expect(t.assign.someHold({ holders: ["A", "B"], free: 1, quantity: 3, recipients: ["C"] })).toBe(
      "A and B have one. 1 of 3 seats free, for C.",
    );
    expect(t.assign.everyoneHolds).toBe("Everyone you chose has one.");
    expect(t.assign.footer([{ seats: 2, name: "Call Unlimited" }, { seats: 1, name: "Example Add-on" }])).toBe(
      "2 Call Unlimited · 1 Example Add-on",
    );
    expect(t.assign.confirm(3)).toBe("Assign 3 seats");
    expect(t.assign.confirm(1)).toBe("Assign 1 seat");
    expect(t.assign.confirm(0)).toBe("Assign");
  });
});

describe("banners", () => {
  test("after checkout in a workspace", () => {
    const p = t.purchase;
    expect(p.headline(true)).toBe("Payment received");
    expect(p.headline(false)).toBe("Purchase complete");
    expect(p.settingUpSeats({ seats: 5, product: "Call Unlimited" })).toBe(
      "Setting up 5 Call Unlimited seats. This takes a few seconds; you can stay on this page.",
    );
    expect(p.readyTitle({ seats: 5, product: "Call Unlimited" })).toBe("Your 5 Call Unlimited seats are ready");
    expect(p.readyTitle({ seats: 1, product: "Call Unlimited" })).toBe("Your 1 Call Unlimited seat is ready");
    expect(p.readyBody({ product: "Call Unlimited", paid: true })).toBe(
      "Payment received, and Call Unlimited is active. Give the seats to members below, or from Members.",
    );
    expect(p.readyBody({ product: "Call Unlimited", paid: false })).toBe(
      "Call Unlimited is active. Give the seats to members below, or from Members.",
    );
    expect(p.settingUp).toBe("Setting up…");
    expect(p.dismiss).toBe("Dismiss");
  });

  test("after checkout for a person", () => {
    const p = t.purchase;
    expect(p.personSettingUp("Call Unlimited")).toBe("Setting up Call Unlimited. This takes a few seconds; you can stay on this page.");
    expect(p.personReadyTitle("Call Unlimited")).toBe("Call Unlimited is ready");
    expect(p.personReadyBody({ product: "Call Unlimited", paid: true })).toBe("Payment received, and Call Unlimited is active on your account.");
    expect(p.personReadyBody({ product: "Call Unlimited", paid: false })).toBe("Call Unlimited is active on your account.");
  });

  test("a license that hasn't reached Core after a minute", () => {
    expect(t.purchase.timeout.title(true)).toBe("Your payment went through");
    // A checkout that collected nothing (a trial) claims no payment.
    expect(t.purchase.timeout.title(false)).toBe("Your purchase went through");
    expect(t.purchase.timeout.body).toBe("The seats can take a few minutes to appear.");
    expect(t.purchase.timeout.reload).toBe("Reload");
  });

  test("the test-mode banner", () => {
    expect(t.testMode.label("Staging")).toBe("Test mode · Staging");
    expect(t.testMode.lead).toBe("Nothing here is charged.");
    expect(t.testMode.beforeCard).toBe("Pay with the test card");
    expect(t.testMode.afterCard).toBe(", any future date and any CVC.");
    expect(t.testMode.note).toBe("On dev and staging only Organization Admins see billing, and seats bought here work only here.");
    expect(t.testMode.copy).toBe("Copy card number");
  });

  test("the page total", () => {
    expect(t.summary({ count: 2, amount: "$295", rate: "a month" })).toEqual({ lead: "2 licenses", rest: "$295 a month in total" });
    expect(t.summary({ count: 1, amount: "$29", rate: "every 3 months" })).toEqual({ lead: "1 license", rest: "$29 every 3 months in total" });
  });
});

describe("refusals", () => {
  test("the two the screens act on name the product", () => {
    expect(refusalMessage("already_licensed", { product: "Fleet" })).toBe("You already have Fleet. Add seats instead.");
    expect(refusalMessage("already_licensed", { product: "Fleet", scope: "person" })).toBe("You already have Fleet.");
    expect(refusalMessage("checkout_in_progress", { product: "Fleet" })).toBe(
      "A purchase of Fleet is already under way. Finish it, or try again in a minute.",
    );
  });

  test("every code in the contract has words of its own, and any other is the generic line", () => {
    for (const code of BILLING_ERROR_CODES) {
      const message = refusalMessage(code, { product: "Fleet" });
      expect(message.length).toBeGreaterThan(10);
      if (code !== "invalid_request") expect(message).not.toBe(t.refusal.generic);
    }
    expect(refusalMessage("something_new", {})).toBe("Billing couldn't do that. Try again.");
    expect(t.refusal.generic).toBe("Billing couldn't do that. Try again.");
  });

  test("no sentence names the payment processor, and none says \"Paid through\": every string, and every function's output", () => {
    const outputs: string[] = [];
    const functions: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === "string") outputs.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(collect);
    };
    const walk = (value: unknown, path: string) => {
      if (typeof value === "function") {
        functions.push(path);
        const samples = SAMPLES[path];
        if (!samples) throw new Error(`no sample for t.${path}: add one to SAMPLES so its sentences are scanned`);
        for (const args of samples) collect((value as (...a: unknown[]) => unknown)(...args));
      } else if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
      } else collect(value);
    };
    walk(t, "");
    // A sample for a function that no longer exists would only pretend to scan something.
    expect(Object.keys(SAMPLES).filter((path) => !functions.includes(path))).toEqual([]);
    for (const code of BILLING_ERROR_CODES) {
      for (const context of [{ product: "Fleet" }, { product: "Fleet", scope: "person" as const }, {}]) outputs.push(refusalMessage(code, context));
    }
    // A floor, so a walk that reached nothing can't pass.
    expect(outputs.length).toBeGreaterThan(250);
    // The word is assembled so that this file doesn't name it either.
    const processor = new RegExp(["str", "ipe"].join(""), "i");
    expect(outputs.filter((text) => processor.test(text) || /paid through/i.test(text))).toEqual([]);
    // Samples that fit their function leave no hole in a sentence.
    expect(outputs.filter((text) => /undefined|NaN|\[object/.test(text))).toEqual([]);
  });
});

/**
 * Arguments that exercise each function of the strings, one list per branch, keyed by its path. The walk above
 * calls them all, and fails for a function that has none.
 */
const BAG = { name: "Dana Reyes", product: "Mentra Call Unlimited" };
const SAMPLES: Record<string, unknown[][]> = {
  "count.seats": [[0], [1], [5]],
  "count.people": [[1], [3]],
  "count.members": [[1], [14]],
  "count.licenses": [[1], [2]],
  "names.list": [[[]], [["A"]], [["A", "B"]], [["A", "B", "C"]], [["A", "B", "C", "D", "E"]]],
  "names.holders": [[[]], [["A"]], [["A", "B", "C", "D", "E"]]],
  "nav.backTo": [["Acme Field Services"]],
  "page.description": [["Acme Field Services"]],
  "page.memberDescription": [["Acme Field Services"]],
  "page.adminsGiveOutSeats": [["Acme Field Services"]],
  "page.noSeat.title": [["Acme Field Services"]],
  "recurrence.rate": [["month", 1], ["month", 3], ["year", 2, "2"]],
  "recurrence.cadence": [["month", 1], ["month", 3], ["week", 2, "2"]],
  "price.perSeat": [["$15", "a month"]],
  "price.perPerson": [["$29", "every 3 months"]],
  "catalog.youHaveSeats": [[1], [5]],
  "buy.title": [["Fleet"]],
  "buy.terms": [["$15 per seat a month", "month"]],
  "buy.members": [[1], [14]],
  "buy.summary": [
    [{ seats: 10, unit: "$15", total: "$150", rate: "a month", note: "before tax" }],
    [{ seats: 1, unit: "$15", total: "$15", rate: "a month", note: null }],
  ],
  "card.moreFor": [["Fleet"]],
  "card.featureIn": [["Mentra Call"]],
  "status.ending": [["Nov 20"]],
  "status.over": [[2]],
  "status.label": [
    ["active", "x"],
    ["ending", "x", "Nov 20"],
    ["ending", "Ending"],
    ["past_due", "x"],
    ["incomplete", "x"],
    ["processing", "x"],
    ["paused", "Paused"],
  ],
  "facts.seats.inUse": [[3, 5]],
  "facts.seats.free": [[2], [0]],
  "facts.seats.assigned": [[7]],
  "facts.seats.moreThanCovered": [[2, 5]],
  "facts.term.every": [["month"], ["3 months"]],
  "facts.term.until": [["Dec 1, 2026"]],
  "facts.cost.value": [["$145", "a month"]],
  "facts.cost.multiple": [[5, "$29"]],
  "facts.cost.foot": [[["5 × $29", "before tax"]], [["5 × $29", null]], [[null, null]]],
  "facts.own.since": [["Oct 20, 2026"]],
  "facts.own.givenBy": [["Acme Field Services"]],
  "notice.pastDue": [
    [{ date: "Nov 23, 2026", stopped: false }],
    [{ date: "Nov 23, 2026", stopped: true }],
    [{ date: null, stopped: false }],
  ],
  "notice.incomplete": [["Fleet"]],
  "notice.over": [
    [{ used: 7, quantity: 5, canAddSeats: true }],
    [{ used: 7, quantity: 5, canAddSeats: false }],
    [{ used: 6, quantity: 5, canAddSeats: true }],
    [{ used: 1, quantity: 0, canAddSeats: true }],
  ],
  "actions.addSeatsCount": [[1], [2]],
  "actions.label": [
    ["add_seats", "x"],
    ["change_seats", "x"],
    ["cancel", "x"],
    ["renew", "x"],
    ["update_payment", "x"],
    ["complete_payment", "x"],
    ["billing_and_invoices", "x"],
    ["something_new", "Something new"],
  ],
  "seats.since": [["Oct 20, 2026"]],
  "seats.unassignPrompt": [["Dana Reyes"]],
  "seats.freeSeats": [[7]],
  "seats.allInUse": [[5]],
  "seats.allInUseHelp": [[true], [false]],
  "seats.moreAvatars": [[3]],
  "fit.note": [
    [{ fit: 3, needed: 4, canAddSeats: true }],
    [{ fit: 3, needed: 4, canAddSeats: false }],
    [{ fit: 2, needed: 5, canAddSeats: true }],
  ],
  "picker.description": [["Fleet", 1], ["Fleet", 3]],
  "picker.chosen": [[2, 3]],
  "picker.assign": [[0], [1], [3]],
  "members.moreChips": [[2]],
  "members.selectMember": [["Dana Reyes"]],
  "members.openMember": [["Dana Reyes"]],
  "members.selected": [[2]],
  "memberPanel.intro": [["Dana Reyes"]],
  "memberPanel.hasASeat": [[1, 5]],
  "memberPanel.seatsFree": [[1, 3]],
  "memberPanel.allInUse": [[10]],
  "memberPanel.overAssigned": [[2]],
  "memberPanel.afterFirstSignIn": [["sam@acme.test"]],
  "memberPanel.seatSwitch": [[BAG.product, BAG.name]],
  "memberPanel.removePrompt": [["Dana Reyes"]],
  "assign.enough": [
    [{ free: 2, quantity: 5, chosen: 1 }],
    [{ free: 2, quantity: 5, chosen: 2 }],
    [{ free: 4, quantity: 5, chosen: 3 }],
  ],
  "assign.someHold": [
    [{ holders: ["A"], free: 1, quantity: 3, recipients: ["B"] }],
    [{ holders: ["A", "B"], free: 1, quantity: 3, recipients: ["C", "D"] }],
  ],
  "assign.footer": [[[{ seats: 2, name: "Call Unlimited" }, { seats: 1, name: "Example Add-on" }]]],
  "assign.confirm": [[0], [1], [3]],
  "purchase.headline": [[true], [false]],
  "purchase.settingUpSeats": [[{ seats: 1, product: "Call Unlimited" }], [{ seats: 5, product: "Call Unlimited" }]],
  "purchase.readyTitle": [[{ seats: 1, product: "Call Unlimited" }], [{ seats: 5, product: "Call Unlimited" }]],
  "purchase.readyBody": [[{ product: "Call Unlimited", paid: true }], [{ product: "Call Unlimited", paid: false }]],
  "purchase.personSettingUp": [["Call Unlimited"]],
  "purchase.personReadyTitle": [["Call Unlimited"]],
  "purchase.personReadyBody": [[{ product: "Call Unlimited", paid: true }], [{ product: "Call Unlimited", paid: false }]],
  "purchase.timeout.title": [[true], [false]],
  "testMode.label": [["Staging"]],
  summary: [[{ count: 1, amount: "$29", rate: "a month" }], [{ count: 2, amount: "$295", rate: "a month" }]],
};
