import { describe, expect, test } from "bun:test";
import { BILLING_ERROR_CODES, KNOWN_ACTION_KINDS, KNOWN_LICENSE_STATUSES } from "@mentra/workspace-contract/portal-billing";
import { licenseStrings as t, refusalMessage } from "./licenses";

// The spec's copy, word for word, with names and numbers filled in. Amounts and dates arrive formatted.

describe("dialogs and side panels", () => {
  test("the label of the × that closes a dialog or a side panel", () => {
    expect(t.dialog.close).toBe("Close");
  });
});

describe("counts", () => {
  test("pluralise from one", () => {
    expect([t.count.people(1), t.count.people(3)]).toEqual(["1 person", "3 people"]);
    expect([t.count.members(1), t.count.members(14)]).toEqual(["1 member", "14 members"]);
    expect([t.count.licenses(1), t.count.licenses(2)]).toEqual(["1 license", "2 licenses"]);
    expect([t.count.products(1), t.count.products(2)]).toEqual(["1 product", "2 products"]);
  });
});

describe("the pages", () => {
  test("the Licenses page", () => {
    expect(t.page.title).toBe("Licenses");
    expect(t.page.description("Acme Field Services")).toBe("What Acme Field Services pays for, and who has each license.");
    expect(t.page.memberDescription("Acme Field Services")).toBe("Your licenses in Acme Field Services.");
    expect(t.page.adminsGiveOutSeats("Acme Field Services")).toBe("Acme Field Services's Admins and Owners assign licenses.");
    expect(t.page.noSeat.title("Acme Field Services")).toBe("You don't have a license in Acme Field Services");
    expect(t.page.noSeat.body).toBe(
      "Its Admins and Owners assign licenses. Once you have one, it works the next time you open the miniapp it's for.",
    );
    expect(t.page.billingAndInvoices).toBe("Billing & invoices");
    // A workspace buys several licenses; a person buys their own.
    expect(t.page.buyLicenses).toBe("Buy licenses");
    expect(t.page.buyALicense).toBe("Buy a license");
  });

  test("the two sentences the spec leaves unwritten: no products where nothing is offered, and nothing to buy for a person", () => {
    expect(t.page.noLicenses).toBe("This workspace has no products yet.");
    expect(t.personal.nothingToBuy).toBe("There is nothing to buy for yourself right now.");
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
      title: "Buy licenses for your members",
      intro: "You'll pay by card on a secure payment page, then come back here to assign the licenses.",
    });
    expect(t.catalog.person).toEqual({
      title: "Buy a license for yourself",
      intro: "You'll pay by card on a secure payment page, then come back here.",
    });
    expect(t.catalog.buy).toBe("Buy");
  });

  test("the catalog dialog and its held rows", () => {
    expect(t.catalog.dialog.title).toBe("Buy licenses");
    expect(t.catalog.dialog.personTitle).toBe("Buy a license");
    expect(t.catalog.dialog.description).toBe("Products for your workspace. For one you have, add licenses instead.");
    expect(t.catalog.youHaveSeats(5)).toBe("You have 5 licenses");
    expect(t.catalog.youHaveSeats(1)).toBe("You have 1 license");
    expect(t.catalog.youHaveIt).toBe("You have it");
  });

  test("the licenses step", () => {
    expect(t.buy.title("Fleet")).toBe("Buy Fleet");
    expect(t.buy.terms("$15 per user a month", "month")).toBe(
      "$15 per user a month · Renews every month. Change the number of licenses or cancel at any time.",
    );
    expect(t.buy.terms("$15 per user every 3 months", "3 months")).toBe(
      "$15 per user every 3 months · Renews every 3 months. Change the number of licenses or cancel at any time.",
    );
    expect(t.buy.seats).toBe("Licenses");
    expect([t.buy.fewer, t.buy.more]).toEqual(["One license fewer", "One license more"]);
    expect(t.buy.members(14)).toBe("Your workspace has 14 members.");
    expect(t.buy.members(1)).toBe("Your workspace has 1 member.");
    expect(t.buy.summary({ seats: 10, unit: "$15", total: "$150", rate: "a month", note: "before tax" })).toBe(
      "10 licenses × $15 · $150 a month · before tax",
    );
    expect(t.buy.summary({ seats: 1, unit: "$15", total: "$15", rate: "a month", note: null })).toBe("1 license × $15 · $15 a month");
    expect(t.buy.payNote).toBe("You'll pay by card on a secure payment page.");
    expect([t.buy.cancel, t.buy.continue]).toEqual(["Cancel", "Continue to payment"]);
  });
});

describe("a product's card", () => {
  test("badges", () => {
    expect(t.status.active).toBe("Active");
    expect(t.status.ending("Nov 20")).toBe("Ends Nov 20");
    expect(t.status.pastDue).toBe("Payment failed");
    expect(t.status.incomplete).toBe("Payment incomplete");
    expect(t.status.processing).toBe("Setting up");
    expect(t.status.over(2)).toBe("2 over");
    expect(t.status.youHaveASeat).toBe("Assigned to you");
  });

  test("a product's status is worded by its named badge, and an unknown one keeps billing's label", () => {
    const s = t.status;
    expect(s.label("active", "x")).toBe(s.active);
    expect(s.label("ending", "x", "Nov 20")).toBe(s.ending("Nov 20"));
    expect(s.label("past_due", "x")).toBe(s.pastDue);
    expect(s.label("incomplete", "x")).toBe(s.incomplete);
    expect(s.label("processing", "x")).toBe(s.processing);
    for (const known of KNOWN_LICENSE_STATUSES) expect(s.label(known, "FALLBACK", "Nov 20")).not.toBe("FALLBACK");
    expect(s.label("paused", "Paused")).toBe("Paused");
    // An ending product billing sent no end for can't say "Ends <date>": billing's own label stands.
    expect(s.label("ending", "Ending soon")).toBe("Ending soon");
  });

  test("the licenses fact", () => {
    expect(t.facts.seats.label).toBe("Licenses");
    expect(t.facts.seats.inUse(3, 5)).toBe("3 of 5 assigned");
    // "2 available" is not said: the count and the meter already say it.
    expect("free" in t.facts.seats).toBe(false);
    expect(t.facts.seats.assigned(7)).toBe("7 assigned");
    expect(t.facts.seats.moreThanCovered(2, 5)).toBe("2 more than the 5 covered");
  });

  test("the term fact: Renews, Ends or Renewal, and never 'Paid through'", () => {
    expect(t.facts.term.renews).toBe("Renews");
    expect(t.facts.term.ends).toBe("Ends");
    expect(t.facts.term.renewal).toBe("Renewal");
    // The recurrence is in the cost's value ("$145 a month"), not under the date.
    expect("every" in t.facts.term).toBe(false);
    expect(t.facts.term.until("Dec 1, 2026")).toBe("Until Dec 1, 2026");
    expect(t.facts.term.doesntRenew).toBe("Doesn't renew");
    expect(t.facts.term.notPaid).toBe("Not paid");
  });

  test("the cost fact", () => {
    expect(t.facts.cost.label).toBe("Cost");
    expect(t.facts.cost.noMoreCharges).toBe("No more charges");
    expect(t.facts.cost.value("$145", "a month")).toBe("$145 a month");
    // The one sub-line, for a cost with tax excluded; no quantity × unit.
    expect(t.facts.cost.beforeTax).toBe("Before tax");
    expect("multiple" in t.facts.cost).toBe(false);
    expect("foot" in t.facts.cost).toBe(false);
  });

  test("a member's own license", () => {
    expect(t.facts.own.seat).toBe("Your license");
    expect(t.facts.own.since("Oct 20, 2026")).toBe("Since Oct 20, 2026");
    expect(t.facts.own.givenBy("Acme Field Services")).toBe("Given by Acme Field Services");
    expect(t.facts.own.worksIn).toBe("Works in");
    expect(t.facts.own.nextTime).toBe("The next time you open it");
  });

  test("the failed-payment notice names the day the licenses stop working, then says they stopped", () => {
    expect(t.notice.pastDue({ date: "Nov 23, 2026", stopped: false })).toEqual({
      title: "Licenses stop working on Nov 23, 2026 unless payment goes through.",
      body: "Update the payment method to keep them.",
    });
    expect(t.notice.pastDue({ date: "Nov 23, 2026", stopped: true })).toEqual({
      title: "Licenses stopped working on Nov 23, 2026. They come back once payment goes through.",
      body: null,
    });
    // Billing always sends the date; a subscription without one still gets a notice that claims nothing about it.
    expect(t.notice.pastDue({ date: null, stopped: false })).toEqual({
      title: "The last payment didn't go through.",
      body: "Update the payment method to keep the licenses.",
    });
  });

  test("the incomplete-payment notice", () => {
    expect(t.notice.incomplete("Mentra Call Unlimited")).toEqual({
      title: "The first payment for Mentra Call Unlimited isn't finished.",
      body: "Finish it to start the subscription.",
    });
  });

  test("the over-assigned notice, with and without 'add licenses'", () => {
    expect(t.notice.over({ used: 7, quantity: 5, canAddSeats: true })).toEqual({
      title: "7 people are assigned but only 5 licenses are paid for.",
      body: "Unassign 2 of them, or add 2 licenses. No one else can get a license until then.",
    });
    expect(t.notice.over({ used: 7, quantity: 5, canAddSeats: false })).toEqual({
      title: "7 people are assigned but only 5 licenses are paid for.",
      body: "Unassign 2 of them. No one else can get a license until then.",
    });
    expect(t.notice.over({ used: 6, quantity: 5, canAddSeats: true }).body).toBe(
      "Unassign 1 of them, or add 1 license. No one else can get a license until then.",
    );
    // One person and one license: the verbs agree.
    expect(t.notice.over({ used: 1, quantity: 0, canAddSeats: true }).title).toBe("1 person is assigned but only 0 licenses are paid for.");
    expect(t.notice.over({ used: 2, quantity: 1, canAddSeats: true }).title).toBe("2 people are assigned but only 1 license is paid for.");
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
      "Add licenses",
      "Change license count",
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

  test("adding a number of licenses, and the link for a blocked tab", () => {
    expect([t.actions.addSeatsCount(2), t.actions.addSeatsCount(1)]).toEqual(["Add 2 licenses", "Add 1 license"]);
    expect(t.actions.openPaymentPage).toBe("Open the payment page");
  });
});

describe("licenses held", () => {
  test("the roster", () => {
    expect(t.seats.title).toBe("Assigned to");
    expect(t.seats.searchPlaceholder).toBe("Search people with a license");
    expect(t.seats.since("Oct 20, 2026")).toBe("Since Oct 20, 2026");
    expect(t.seats.unassign).toBe("Unassign");
    expect(t.seats.freeSeat).toBe("Available license");
    expect(t.seats.assign).toBe("Assign");
    expect(t.seats.assignSeats).toBe("Assign licenses");
    expect(t.seats.freeSeats(7)).toBe("7 available licenses");
    expect(t.seats.nobodyYet).toBe("No one has a license yet.");
  });

  test("a full roster, with and without 'add licenses'", () => {
    expect(t.seats.allInUse(5)).toBe("All 5 licenses are assigned.");
    expect(t.seats.allInUse(1)).toBe("The license is assigned.");
    expect(t.seats.allInUseHelp(true)).toBe("Add licenses to give one to someone else, or unassign someone to free theirs.");
    expect(t.seats.allInUseHelp(false)).toBe("Unassign someone to free their license.");
  });

  test("who holds the licenses, in a strip", () => {
    expect(t.names.holders([])).toBe("No one has a license yet");
    expect(t.names.holders(["Dana Reyes", "Priya Natarajan", "C", "D", "E", "F", "G", "H", "I", "J"])).toBe(
      "Dana Reyes, Priya Natarajan and 8 others",
    );
    expect(t.seats.moreAvatars(3)).toBe("+3");
  });
});

describe("the people picker", () => {
  test("its dialog", () => {
    expect(t.picker.title).toBe("Assign licenses");
    expect(t.picker.description("Mentra Call Unlimited", 3)).toBe("Mentra Call Unlimited · 3 available licenses");
    expect(t.picker.description("Mentra Call Unlimited", 1)).toBe("Mentra Call Unlimited · 1 available license");
    expect(t.picker.search).toBe("Search by name or email");
    expect(t.picker.hasASeat).toBe("Has a license");
    expect(t.picker.afterFirstSignIn).toBe("After first sign-in");
    expect(t.picker.chosen(2, 3)).toBe("2 of 3 available licenses chosen");
    expect(t.picker.chosen(1, 1)).toBe("1 of 1 available license chosen");
    expect([t.picker.assign(0), t.picker.assign(1), t.picker.assign(3)]).toEqual(["Assign", "Assign 1 license", "Assign 3 licenses"]);
    expect(t.picker.cancel).toBe("Cancel");
    expect(t.picker.noMatches).toBe("No one matches your search.");
  });

  test("licenses that changed while it was open", () => {
    expect(t.conflict.seatsChanged).toBe(
      "Licenses changed while you were choosing. Nothing was assigned. Check the counts and try again.",
    );
  });
});

describe("Members and the member panel", () => {
  test("the list", () => {
    expect(t.members.title).toBe("Members");
    expect(t.members.description).toBe("People in this workspace and the role each of them holds.");
    expect(t.members.adminsOnly).toBe("Only workspace admins can see the member list.");
    expect(t.members.noMembers).toBe("No members yet.");
    expect(t.members.copyId).toBe("Copy id");
    expect(t.members.copyIdFor("Dana Reyes")).toBe("Copy the Mentra user id of Dana Reyes");
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
    expect(t.memberPanel.intro("Luis Ortega")).toBe("Turn one on to give Luis Ortega a license. Changes apply right away.");
    expect(t.memberPanel.hasASeat(1, 5)).toBe("Has a license · 1 of 5 available");
    expect(t.memberPanel.seatsFree(1, 3)).toBe("1 of 3 licenses available");
    expect(t.memberPanel.allInUse(10)).toBe("All 10 licenses are assigned");
    expect(t.memberPanel.allInUse(1)).toBe("The license is assigned");
    expect(t.memberPanel.overAssigned(2)).toBe("2 more assigned than covered");
    expect(t.memberPanel.afterFirstSignIn("sam@acme.test")).toBe("sam@acme.test can get licenses after their first sign-in.");
    expect(t.memberPanel.seatSwitch("Mentra Call Unlimited", "Luis Ortega")).toBe("Mentra Call Unlimited license for Luis Ortega");
  });

  test("removing a member asks first", () => {
    expect(t.memberPanel.remove).toBe("Remove from workspace");
    expect(t.memberPanel.removePrompt("Luis Ortega")).toBe("Remove Luis Ortega from this workspace?");
    expect(t.memberPanel.removeConfirm).toBe("Confirm remove");
  });

  test("assigning several licenses to several people", () => {
    expect(t.assign.title).toBe("Assign licenses");
    expect(t.assign.enough({ free: 2, quantity: 5, chosen: 2 })).toBe("2 of 5 licenses available: enough for both.");
    expect(t.assign.enough({ free: 4, quantity: 5, chosen: 3 })).toBe("4 of 5 licenses available: enough for all 3.");
    expect(t.assign.enough({ free: 4, quantity: 5, chosen: 1 })).toBe("4 of 5 licenses available.");
    expect(t.assign.someHold({ holders: ["Amara Okafor"], free: 1, quantity: 3, recipients: ["Luis Ortega"] })).toBe(
      "Amara Okafor has one. 1 of 3 licenses available, for Luis Ortega.",
    );
    expect(t.assign.someHold({ holders: ["A", "B"], free: 1, quantity: 3, recipients: ["C"] })).toBe(
      "A and B have one. 1 of 3 licenses available, for C.",
    );
    expect(t.assign.everyoneHolds).toBe("Everyone you chose has one.");
    expect(t.assign.footer([{ seats: 2, name: "Call Unlimited" }, { seats: 1, name: "Example Add-on" }])).toBe(
      "2 Call Unlimited · 1 Example Add-on",
    );
    expect(t.assign.confirm(3)).toBe("Assign 3 licenses");
    expect(t.assign.confirm(1)).toBe("Assign 1 license");
    expect(t.assign.confirm(0)).toBe("Assign");
    expect(t.assign.tooMany(500)).toBe("You can assign up to 500 licenses at a time.");
  });
});

describe("banners", () => {
  test("after checkout in a workspace", () => {
    const p = t.purchase;
    expect(p.headline(true)).toBe("Payment received");
    expect(p.headline(false)).toBe("Purchase complete");
    expect(p.settingUpSeats({ seats: 5, product: "Call Unlimited" })).toBe(
      "Setting up 5 Call Unlimited licenses. This takes a few seconds; you can stay on this page.",
    );
    expect(p.readyTitle({ seats: 5, product: "Call Unlimited" })).toBe("Your 5 Call Unlimited licenses are ready");
    expect(p.readyTitle({ seats: 1, product: "Call Unlimited" })).toBe("Your 1 Call Unlimited license is ready");
    expect(p.readyBody({ product: "Call Unlimited", paid: true })).toBe(
      "Payment received, and Call Unlimited is active. Assign the licenses to members below, or from Members.",
    );
    expect(p.readyBody({ product: "Call Unlimited", paid: false })).toBe(
      "Call Unlimited is active. Assign the licenses to members below, or from Members.",
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

  test("a purchase that hasn't reached Core after a minute", () => {
    expect(t.purchase.timeout.title(true)).toBe("Your payment went through");
    // A checkout that collected nothing (a trial) claims no payment.
    expect(t.purchase.timeout.title(false)).toBe("Your purchase went through");
    expect(t.purchase.timeout.body).toBe("The licenses can take a few minutes to appear.");
    // A person has one license: their line is about it.
    expect(t.purchase.timeout.personBody).toBe("Your license can take a few minutes to appear.");
    expect(t.purchase.timeout.reload).toBe("Reload");
  });

  test("the test-mode banner", () => {
    expect(t.testMode.label("Staging")).toBe("Test mode · Staging");
    expect(t.testMode.lead).toBe("Nothing here is charged.");
    expect(t.testMode.beforeCard).toBe("Pay with the test card");
    expect(t.testMode.afterCard).toBe(", any future date and any CVC.");
    expect(t.testMode.copy).toBe("Copy card number");
    // The banner is one line of words: the note about who sees billing is gone, and a × hides the banner.
    expect(t.testMode.hide).toBe("Hide the test mode notice");
    expect("note" in t.testMode).toBe(false);
  });

  test("the page total counts products", () => {
    expect(t.summary({ count: 2, amount: "$295", rate: "a month" })).toEqual({ lead: "2 products", rest: "$295 a month in total" });
    expect(t.summary({ count: 1, amount: "$29", rate: "every 3 months" })).toEqual({ lead: "1 product", rest: "$29 every 3 months in total" });
  });
});

describe("refusals", () => {
  test("the two the screens act on name the product", () => {
    expect(refusalMessage("already_licensed", { product: "Fleet" })).toBe("You already have Fleet. Add licenses instead.");
    expect(refusalMessage("already_licensed", { product: "Fleet", scope: "person" })).toBe("You already have Fleet.");
    expect(refusalMessage("checkout_in_progress", { product: "Fleet" })).toBe(
      "A purchase of Fleet is already under way. Finish it, or try again in a minute.",
    );
  });

  test("the refusals about a number of licenses, or about a subscription that has gone", () => {
    expect(refusalMessage("invalid_seats")).toBe("That number of licenses isn't available. Choose a different number.");
    expect(refusalMessage("unknown_action")).toBe("That isn't available for this subscription any more. Reload the page and try again.");
    expect(refusalMessage("license_not_found")).toBe("That subscription no longer exists. Reload the page.");
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

  test("no sentence names the payment processor, says \"Paid through\" or says \"seat\": every string, and every function's output", () => {
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
    // A license is one person's right to a product, and "seat" is not a word a person reads. API and code names keep it
    // (`seats`, `add_seats`), so only the sentences are scanned.
    expect(outputs.filter((text) => /\bseats?\b/i.test(text))).toEqual([]);
    // Samples that fit their function leave no hole in a sentence.
    expect(outputs.filter((text) => /undefined|NaN|\[object/.test(text))).toEqual([]);
  });
});

/**
 * Arguments that exercise each function of the strings, one list per branch, keyed by its path. The walk above
 * calls them all, and fails for a function that has none.
 */
const BAG = { name: "Dana Reyes", product: "Mentra Call Unlimited" };
/** A `fitFor` result for each of its kinds, worded with and without the option to add seats. */
const PERSON = (name: string) => ({ name });
const NAME_OF = (person: { name: string }) => person.name;
const FIT_BASE = { holders: [], recipients: [], quantity: 5, free: 2, over: 0, fit: 0, needed: 0, ok: false };
const FIT_LINES: unknown[][] = (["enough", "some_hold", "all_hold", "short", "full", "nobody"] as const).flatMap((kind) =>
  [true, false].map((canAddSeats) => [
    {
      ...FIT_BASE,
      kind,
      holders: kind === "some_hold" || kind === "all_hold" ? [PERSON("Amara Okafor")] : [],
      recipients: kind === "all_hold" || kind === "nobody" ? [] : [PERSON("Luis Ortega"), PERSON("Sofia Alvarez")],
      needed: kind === "all_hold" || kind === "nobody" ? 0 : 2,
    },
    { nameOf: NAME_OF, canAddSeats },
  ]),
);
const SAMPLES: Record<string, unknown[][]> = {
  "count.people": [[1], [3]],
  "count.members": [[1], [14]],
  "count.licenses": [[1], [2]],
  "count.products": [[1], [2]],
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
  "buy.terms": [["$15 per user a month", "month"]],
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
  "facts.seats.assigned": [[7]],
  "facts.seats.moreThanCovered": [[2, 5]],
  "facts.term.until": [["Dec 1, 2026"]],
  "facts.cost.value": [["$145", "a month"]],
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
    [{ used: 2, quantity: 1, canAddSeats: false }],
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
  "seats.unassignAria": [["Dana Reyes"]],
  "seats.freeSeats": [[7]],
  "seats.allInUse": [[5], [1]],
  "seats.allInUseHelp": [[true], [false]],
  "seats.moreAvatars": [[3]],
  "fit.note": [
    [{ fit: 3, needed: 4, canAddSeats: true }],
    [{ fit: 3, needed: 4, canAddSeats: false }],
    [{ fit: 2, needed: 5, canAddSeats: true }],
  ],
  "fit.line": FIT_LINES,
  "picker.description": [["Fleet", 1], ["Fleet", 3]],
  "picker.chosen": [[2, 3], [1, 1]],
  "picker.assign": [[0], [1], [3]],
  "members.moreChips": [[2]],
  "members.selectMember": [["Dana Reyes"]],
  "members.openMember": [["Dana Reyes"]],
  "members.copyIdFor": [["Dana Reyes"]],
  "members.selected": [[2]],
  "memberPanel.intro": [["Dana Reyes"]],
  "memberPanel.hasASeat": [[1, 5]],
  "memberPanel.seatsFree": [[1, 3]],
  "memberPanel.allInUse": [[10], [1]],
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
  "assign.tooMany": [[500]],
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
