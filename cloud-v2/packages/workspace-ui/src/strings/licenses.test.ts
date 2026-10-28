import { describe, expect, test } from "bun:test";
import { BILLING_ERROR_CODES, KNOWN_ACTION_KINDS, KNOWN_LICENSE_STATUSES } from "@mentra/workspace-contract/portal-billing";
import { licenseStrings as t, refusalMessage } from "./licenses";

// The spec's copy, word for word, with names and numbers filled in. Amounts and dates arrive formatted.

describe("dialogs and side panels", () => {
  test("the label of the × that closes a dialog or a side panel", () => {
    expect(t.dialog.close).toBe("Close");
  });
});

describe("the pages", () => {
  test("the Licenses page", () => {
    expect(t.page.title).toBe("Subscriptions");
    // The title stands alone: no subtitle for a manager or for a member.
    expect("description" in t.page).toBe(false);
    expect("memberDescription" in t.page).toBe(false);
    expect(t.page.adminsGiveOutSeats("Acme Field Services")).toBe("Acme Field Services's Admins and Owners assign subscriptions.");
    expect(t.page.noSeat.title("Acme Field Services")).toBe("You don't have a subscription in Acme Field Services");
    expect(t.page.noSeat.body).toBe(
      "Its Admins and Owners assign subscriptions. Once you have one, it works the next time you open the miniapp it's for.",
    );
    // The header has one button, Billing; buying more is on each card.
    expect(t.actions.label("billing_and_invoices", "Billing & invoices")).toBe("Billing");
    expect("buyLicenses" in t.page).toBe(false);
  });

  test("the sentence the spec leaves unwritten: no products where nothing is offered", () => {
    expect(t.page.noLicenses).toBe("This workspace has no products yet.");
  });

  test("its unavailable state", () => {
    expect(t.page.unavailable).toEqual({
      title: "Subscriptions are unavailable",
      body: "They can't be shown right now. Try again in a moment.",
      retry: "Retry",
    });
  });

  test("the navigation has the Licenses page and nothing personal", () => {
    expect(t.nav).toEqual({ licenses: "Subscriptions" });
    expect("personal" in t).toBe(false);
  });

  test("the people a link's dialog names: one, two, or the first and a count", () => {
    expect(t.names.short(["Ana Ruiz"])).toBe("Ana Ruiz");
    expect(t.names.short(["Ana Ruiz", "Ben Cho"])).toBe("Ana Ruiz and Ben Cho");
    expect(t.names.short(["Ana Ruiz", "Ben Cho", "Cy Dunn"])).toBe("Ana Ruiz and 2 others");
    expect(t.names.short(["Ana Ruiz", "Ben Cho", "Cy Dunn", "Di Eng", "Ed Fox"])).toBe("Ana Ruiz and 4 others");
  });

  test("what each answer of the ?buy= link says, word for word", () => {
    const words = t.page.buyLink;
    const ws = "Acme Field Services";
    const call = "Mentra Call Unlimited";
    expect(words.held(call)).toBe("You already have Mentra Call Unlimited.");
    expect(words.youNowHave(call)).toEqual({
      title: "You now have Mentra Call Unlimited!",
      body: "Open the Mentra App now to use it on your smart glasses.",
    });
    expect(words.assignTaken).toBe("That subscription was just taken. Nothing was assigned.");
    expect(words.openingCheckout).toBe("Opening checkout…");
    expect(words.full(ws, 3, call, t.names.short(["Ana Ruiz", "Ben Cho", "Cy Dunn"]))).toEqual({
      body: "Acme Field Services has 3 Mentra Call Unlimited subscriptions, assigned to Ana Ruiz and 2 others.",
      hint: "Unassign someone on the Mentra Call Unlimited card to free a subscription.",
    });
    expect(words.full(ws, 1, call, "Ana Ruiz").body).toBe("Acme Field Services has 1 Mentra Call Unlimited subscription, assigned to Ana Ruiz.");
    expect(words.full(ws, 1, call, t.names.short([])).body).toBe("Acme Field Services has 1 Mentra Call Unlimited subscription.");
    expect(t.names.short([])).toBe("");
    expect(words.alreadyHas(ws, call)).toBe("Acme Field Services already has Mentra Call Unlimited.");
    expect(words.notForSale).toBe("That product isn't for sale.");
    expect(words.askAnAdmin(ws, call)).toBe("Only Admins and Owners of Acme Field Services can buy Mentra Call Unlimited. Ask one of them.");
    expect(words.askAnAdmin(ws, words.anyProduct)).toBe("Only Admins and Owners of Acme Field Services can buy subscriptions. Ask one of them.");
    expect(words.notHere).toBe("Subscriptions can't be bought here.");
    expect(words.done).toBe("Done");
    // The dialogs that asked first (Assign it to me, Add one for you?) are gone: the page does it.
    expect(Object.keys(words).sort()).toEqual(
      ["alreadyHas", "anyProduct", "askAnAdmin", "assignTaken", "done", "full", "held", "notForSale", "notHere", "openingCheckout", "youNowHave"].sort(),
    );
  });
});

describe("the catalog and buying", () => {
  test("the catalog's heading", () => {
    expect(t.catalog.title).toBe("Buy subscriptions for your members");
    expect("intro" in t.catalog).toBe(false);
    expect(t.catalog.buy).toBe("Buy");
  });

  test("the catalog dialog and its held rows", () => {
    expect(t.catalog.dialog.title).toBe("Buy subscriptions");
    expect(t.catalog.dialog.description).toBe("Products for your workspace. For one you have, buy more subscriptions instead.");
    expect(t.catalog.youHaveSeats(5)).toBe("You have 5 subscriptions");
    expect(t.catalog.youHaveSeats(1)).toBe("You have 1 subscription");
  });

  test("the licenses step", () => {
    expect(t.buy.title("Fleet")).toBe("Buy Fleet");
    expect(t.buy.terms("$15 per user a month", "month")).toBe(
      "$15 per user a month · Renews every month. Change the number of subscriptions or cancel at any time.",
    );
    expect(t.buy.terms("$15 per user every 3 months", "3 months")).toBe(
      "$15 per user every 3 months · Renews every 3 months. Change the number of subscriptions or cancel at any time.",
    );
    expect(t.buy.seats).toBe("Subscriptions");
    expect([t.buy.fewer, t.buy.more]).toEqual(["One subscription fewer", "One subscription more"]);
    expect(t.buy.members(14)).toBe("Your workspace has 14 members.");
    expect(t.buy.members(1)).toBe("Your workspace has 1 member.");
    expect(t.buy.summary({ seats: 10, unit: "$15", total: "$150", rate: "a month", note: "before tax" })).toBe(
      "10 subscriptions × $15 · $150 a month · before tax",
    );
    expect(t.buy.summary({ seats: 1, unit: "$15", total: "$15", rate: "a month", note: null })).toBe("1 subscription × $15 · $15 a month");
    // A workspace of one member buys one license with no number to choose.
    expect(t.buy.solo({ total: "$29", rate: "a month", note: "before tax" })).toBe("1 subscription · $29 a month · before tax");
    expect(t.buy.solo({ total: "$29", rate: "a month", note: null })).toBe("1 subscription · $29 a month");
    expect("yoursOnPayment" in t.buy).toBe(false);
    expect("payNote" in t.buy).toBe(false);
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
    expect(t.facts.seats.label).toBe("Subscriptions");
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
    expect(t.facts.cost.value("$145", "a month")).toBe("$145 a month");
    // No sub-line: no tax note, no "No more charges", no quantity × unit.
    expect("beforeTax" in t.facts.cost).toBe(false);
    expect("noMoreCharges" in t.facts.cost).toBe(false);
    expect("multiple" in t.facts.cost).toBe(false);
    expect("foot" in t.facts.cost).toBe(false);
  });

  test("a member's own license", () => {
    expect(t.facts.own.seat).toBe("Your subscription");
    expect(t.facts.own.since("Oct 20, 2026")).toBe("Since Oct 20, 2026");
    expect(t.facts.own.givenBy("Acme Field Services")).toBe("Given by Acme Field Services");
    expect(t.facts.own.worksIn).toBe("Works in");
    expect(t.facts.own.nextTime).toBe("The next time you open it");
  });

  test("the failed-payment notice names the day the licenses stop working, then says they stopped", () => {
    expect(t.notice.pastDue({ date: "Nov 23, 2026", stopped: false })).toEqual({
      title: "Subscriptions stop working on Nov 23, 2026 unless payment goes through.",
      body: "Update the payment method to keep them.",
    });
    expect(t.notice.pastDue({ date: "Nov 23, 2026", stopped: true })).toEqual({
      title: "Subscriptions stopped working on Nov 23, 2026. They come back once payment goes through.",
      body: null,
    });
    // Billing always sends the date; a subscription without one still gets a notice that claims nothing about it.
    expect(t.notice.pastDue({ date: null, stopped: false })).toEqual({
      title: "The last payment didn't go through.",
      body: "Update the payment method to keep the subscriptions.",
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
      title: "7 people are assigned but only 5 subscriptions are paid for.",
      body: "Unassign 2 of them, or buy 2 subscriptions. No one else can get a subscription until then.",
    });
    expect(t.notice.over({ used: 7, quantity: 5, canAddSeats: false })).toEqual({
      title: "7 people are assigned but only 5 subscriptions are paid for.",
      body: "Unassign 2 of them. No one else can get a subscription until then.",
    });
    expect(t.notice.over({ used: 6, quantity: 5, canAddSeats: true }).body).toBe(
      "Unassign 1 of them, or buy 1 subscription. No one else can get a subscription until then.",
    );
    // One person and one license: the verbs agree.
    expect(t.notice.over({ used: 1, quantity: 0, canAddSeats: true }).title).toBe("1 person is assigned but only 0 subscriptions are paid for.");
    expect(t.notice.over({ used: 2, quantity: 1, canAddSeats: true }).title).toBe("2 people are assigned but only 1 subscription is paid for.");
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
      "Buy subscriptions",
      "Change subscription count",
      "Cancel",
      "Renew",
      "Update payment method",
      "Complete payment",
      "Billing",
    ]);
  });

  test("a button that leaves the portal says so to a screen reader", () => {
    expect(t.actions.opensSecureBillingPage).toBe("Opens a secure billing page");
    expect(t.actions.opensSecureBillingPageInNewTab).toBe("Opens a secure billing page in a new tab");
  });

  test("adding a number of licenses, and the link for a blocked tab", () => {
    expect([t.actions.addSeatsCount(2), t.actions.addSeatsCount(1)]).toEqual(["Buy 2 subscriptions", "Buy 1 subscription"]);
    expect(t.actions.openPaymentPage).toBe("Open the payment page");
  });
});

describe("licenses held", () => {
  test("the roster", () => {
    expect(t.seats.title).toBe("Assigned to");
    expect(t.seats.searchPlaceholder).toBe("Search people with a subscription");
    expect(t.seats.since("Oct 20, 2026")).toBe("Since Oct 20, 2026");
    expect(t.seats.unassign).toBe("Unassign");
    expect(t.seats.cancel).toBe("Cancel");
    // Unassign asks in a dialog: its title, and one plain line under it.
    expect(t.seats.unassignPrompt("Hannah Kim")).toBe("Unassign Hannah Kim?");
    expect(t.seats.unassignBody("Hannah Kim", "Mentra Call Unlimited")).toBe("Hannah Kim loses Mentra Call Unlimited the next time they open it.");
    expect(t.seats.assignSeats).toBe("Assign subscriptions");
    // Seats nobody holds have no rows, so nothing names them.
    expect("freeSeat" in t.seats).toBe(false);
    expect("freeSeats" in t.seats).toBe(false);
  });

  test("every subscription assigned, as the people picker says it", () => {
    expect(t.seats.allInUse(5)).toBe("All 5 subscriptions are assigned.");
    expect(t.seats.allInUse(1)).toBe("The subscription is assigned.");
    // The roster has no row for it: Buy subscriptions and Assign subscriptions head it whatever is assigned.
    expect("allInUseHelp" in t.seats).toBe(false);
  });

  test("who holds the licenses, in a strip", () => {
    expect(t.names.holders([])).toBe("No one has a subscription yet");
    expect(t.names.holders(["Dana Reyes", "Priya Natarajan", "C", "D", "E", "F", "G", "H", "I", "J"])).toBe(
      "Dana Reyes, Priya Natarajan and 8 others",
    );
    expect(t.seats.moreAvatars(3)).toBe("+3");
  });
});

describe("the people picker", () => {
  test("its dialog", () => {
    expect(t.picker.title).toBe("Assign subscriptions");
    expect(t.picker.description("Mentra Call Unlimited", 3)).toBe("Mentra Call Unlimited · 3 available subscriptions");
    expect(t.picker.description("Mentra Call Unlimited", 1)).toBe("Mentra Call Unlimited · 1 available subscription");
    expect(t.picker.search).toBe("Search by name or email");
    expect(t.picker.hasASeat).toBe("Has a subscription");
    expect(t.picker.afterFirstSignIn).toBe("After first sign-in");
    expect(t.picker.chosen(2, 3)).toBe("2 of 3 available subscriptions chosen");
    expect(t.picker.chosen(1, 1)).toBe("1 of 1 available subscription chosen");
    expect([t.picker.assign(0), t.picker.assign(1), t.picker.assign(3)]).toEqual(["Assign", "Assign 1 subscription", "Assign 3 subscriptions"]);
    expect(t.picker.cancel).toBe("Cancel");
    expect(t.picker.noMatches).toBe("No one matches your search.");
  });

  test("licenses that changed while it was open", () => {
    expect(t.conflict.seatsChanged).toBe(
      "Subscriptions changed while you were choosing. Nothing was assigned. Check the counts and try again.",
    );
  });
});

describe("Members", () => {
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
    expect(t.members.licenses).toBe("Subscriptions");
    expect(t.members.none).toBe("None");
    expect(t.members.afterFirstSignIn).toBe("After first sign-in");
    expect(t.members.moreChips(2)).toBe("+2");
  });

  test("the list has no selection, no bulk Assign licenses and no member panel", () => {
    expect("selected" in t.members).toBe(false);
    expect("assignLicenses" in t.members).toBe(false);
    expect("clearSelection" in t.members).toBe(false);
    expect("selectMember" in t.members).toBe(false);
    expect("openMember" in t.members).toBe(false);
    expect("memberPanel" in t).toBe(false);
    expect("title" in t.assign).toBe(false);
  });

  test("the row's menu: a role to change to, and Remove from workspace", () => {
    expect(t.members.moreFor("Luis Ortega")).toBe("More for Luis Ortega");
    expect(t.members.changeRoleTo("Admin")).toBe("Change role to Admin");
    expect(t.members.remove).toBe("Remove from workspace");
  });

  test("Remove asks first in a dialog: its title, one plain line, Cancel and a destructive Remove", () => {
    expect(t.members.removePrompt("Luis Ortega")).toBe("Remove Luis Ortega from this workspace?");
    expect(t.members.removeBody).toBe("They lose access to this workspace, and any subscriptions assigned to them are freed.");
    expect(t.members.removeConfirm).toBe("Remove");
    expect(t.members.cancel).toBe("Cancel");
  });

  test("Leave, Delete and Revoke ask in a dialog too: the question, one plain line, and the action's name", () => {
    expect(t.confirm.cancel).toBe("Cancel");
    expect(t.confirm.leave.title("Acme Robotics")).toBe("Leave Acme Robotics?");
    expect(t.confirm.leave.body).toBe("You lose access to this workspace.");
    expect(t.confirm.leave.action).toBe("Leave");
    expect(t.confirm.delete.title("Acme Robotics")).toBe("Delete Acme Robotics?");
    expect(t.confirm.delete.body).toBe("Deleting a workspace ends every membership and invitation and revokes every key. It cannot be undone.");
    expect(t.confirm.delete.typeName("Acme Robotics")).toEqual({ lead: "Type ", name: "Acme Robotics", rest: " to confirm" });
    expect(t.confirm.delete.action).toBe("Delete");
    expect(t.confirm.revokeInvitation.title("jamie@acme.test")).toBe("Revoke the invitation for jamie@acme.test?");
    expect(t.confirm.revokeInvitation.body).toBe("The link they were sent stops working.");
    expect(t.confirm.revokeInvitation.action).toBe("Revoke");
    expect(t.confirm.revokeKey.title("CI publisher")).toBe("Revoke CI publisher?");
    expect(t.confirm.revokeKey.body).toBe("Anything using it stops working.");
    expect(t.confirm.revokeKey.action).toBe("Revoke");
  });

  test("what fits, when licenses are given to several people at once (the people picker's lines)", () => {
    expect(t.assign.enough({ free: 2, quantity: 5, chosen: 2 })).toBe("2 of 5 subscriptions available: enough for both.");
    expect(t.assign.enough({ free: 4, quantity: 5, chosen: 3 })).toBe("4 of 5 subscriptions available: enough for all 3.");
    expect(t.assign.enough({ free: 4, quantity: 5, chosen: 1 })).toBe("4 of 5 subscriptions available.");
    expect(t.assign.someHold({ holders: ["Amara Okafor"], free: 1, quantity: 3, recipients: ["Luis Ortega"] })).toBe(
      "Amara Okafor has one. 1 of 3 subscriptions available, for Luis Ortega.",
    );
    expect(t.assign.someHold({ holders: ["A", "B"], free: 1, quantity: 3, recipients: ["C"] })).toBe(
      "A and B have one. 1 of 3 subscriptions available, for C.",
    );
    expect(t.assign.everyoneHolds).toBe("Everyone you chose has one.");
    expect(t.assign.tooMany(500)).toBe("You can assign up to 500 subscriptions at a time.");
  });

  test("one license is one license wherever a count sits beside it: 1 of 1 license, never 1 of 1 licenses", () => {
    expect(t.assign.enough({ free: 1, quantity: 1, chosen: 1 })).toBe("1 of 1 subscription available.");
    expect(t.assign.enough({ free: 1, quantity: 1, chosen: 2 })).toBe("1 of 1 subscription available: enough for both.");
    expect(t.assign.enough({ free: 2, quantity: 2, chosen: 1 })).toBe("2 of 2 subscriptions available.");
    expect(t.assign.someHold({ holders: ["Amara Okafor"], free: 1, quantity: 1, recipients: ["Luis Ortega"] })).toBe(
      "Amara Okafor has one. 1 of 1 subscription available, for Luis Ortega.",
    );
    expect(t.assign.someHold({ holders: ["A"], free: 0, quantity: 1, recipients: ["B"] })).toBe("A has one. 0 of 1 subscription available, for B.");
    expect(t.assign.tooMany(1)).toBe("You can assign up to 1 subscription at a time.");
  });
});

describe("banners and the dialog back from checkout", () => {
  test("after checkout in a workspace", () => {
    const p = t.purchase;
    expect(p.headline(true)).toBe("Payment received");
    expect(p.headline(false)).toBe("Purchase complete");
    expect(p.settingUpSeats({ seats: 5, product: "Call Unlimited" })).toBe(
      "Setting up 5 Call Unlimited subscriptions. This takes a few seconds; you can stay on this page.",
    );
    expect(p.readyTitle({ seats: 5, product: "Call Unlimited" })).toBe("Your 5 Call Unlimited subscriptions are ready");
    expect(p.readyTitle({ seats: 1, product: "Call Unlimited" })).toBe("Your 1 Call Unlimited subscription is ready");
    expect(p.readyBody({ product: "Call Unlimited", paid: true })).toBe(
      "Payment received, and Call Unlimited is active. Assign the subscriptions to members below.",
    );
    expect(p.readyBody({ product: "Call Unlimited", paid: false })).toBe(
      "Call Unlimited is active. Assign the subscriptions to members below.",
    );
    expect(p.settingUp).toBe("Setting up…");
    // One button closes the dialog, whatever it says.
    expect(p.ok).toBe("OK");
    expect("dismiss" in p).toBe(false);
  });

  test("after checkout, when the buyer was given one of the new licenses", () => {
    const p = t.purchase;
    expect(p.youNowHave("Call Unlimited")).toEqual({
      title: "You now have Call Unlimited!",
      body: "Open the Mentra App now to use it on your smart glasses.",
    });
    expect(p.youNowHave("Call Unlimited", 1)).toEqual(p.youNowHave("Call Unlimited"));
    // More than one bought: the rest are the buyer's to assign.
    expect(p.youNowHave("Call Unlimited", 5)).toEqual({
      title: "You now have Call Unlimited!",
      body: "Open the Mentra App now to use it on your smart glasses. Assign the rest to members below.",
    });
    // The ?buy= link that assigns a free one says the same.
    expect(t.page.buyLink.youNowHave).toBe(p.youNowHave);
  });

  test("a purchase that hasn't reached Core after a minute", () => {
    expect(t.purchase.timeout.title(true)).toBe("Your payment went through");
    // A checkout that collected nothing (a trial) claims no payment.
    expect(t.purchase.timeout.title(false)).toBe("Your purchase went through");
    expect(t.purchase.timeout.body).toBe("The subscriptions can take a few minutes to appear.");
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

  test("there is no page total: the cards are not added up", () => {
    expect("summary" in t).toBe(false);
  });
});

describe("refusals", () => {
  test("the two the screens act on name the product", () => {
    expect(refusalMessage("already_licensed", { product: "Fleet" })).toBe("You already have Fleet. Buy more subscriptions instead.");
    expect(refusalMessage("checkout_in_progress", { product: "Fleet" })).toBe(
      "A purchase of Fleet is already under way. Finish it, or try again in a minute.",
    );
  });

  test("a request someone else has open names the product when it is known", () => {
    expect(refusalMessage("seat_request_pending", { product: "Fleet" })).toBe("Someone else is adding a Fleet subscription right now. Try again in a few minutes.");
    expect(refusalMessage("seat_request_pending")).toBe("Someone else is adding a subscription right now. Try again in a few minutes.");
  });

  test("the refusals about a number of licenses, or about a subscription that has gone", () => {
    expect(refusalMessage("invalid_seats")).toBe("That number of subscriptions isn't available. Choose a different number.");
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
      for (const context of [{ product: "Fleet" }, {}]) outputs.push(refusalMessage(code, context));
    }
    // A floor, so a walk that reached nothing can't pass.
    expect(outputs.length).toBeGreaterThan(250);
    // The word is assembled so that this file doesn't name it either.
    const processor = new RegExp(["str", "ipe"].join(""), "i");
    expect(outputs.filter((text) => processor.test(text) || /paid through/i.test(text))).toEqual([]);
    // A subscription is one person's right to a product, and "seat" and "license" are not words a person reads. API and
    // code names keep them (`licenses`, `seats`, `add_seats`), so only the sentences are scanned.
    expect(outputs.filter((text) => /\b(seats?|licenses?)\b/i.test(text))).toEqual([]);
    // A count of one never sits beside a plural noun ("1 of 1 subscriptions"): every sentence that counts goes through `plural`.
    expect(outputs.filter((text) => /\b1 (subscriptions|products|members|users|people|persons|others)\b/.test(text))).toEqual([]);
    // Samples that fit their function leave no hole in a sentence.
    expect(outputs.filter((text) => /undefined|NaN|\[object/.test(text))).toEqual([]);
  });
});

/**
 * Arguments that exercise each function of the strings, one list per branch, keyed by its path. The walk above
 * calls them all, and fails for a function that has none.
 */
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
  "names.list": [[[]], [["A"]], [["A", "B"]], [["A", "B", "C"]], [["A", "B", "C", "D", "E"]]],
  "names.holders": [[[]], [["A"]], [["A", "B", "C", "D", "E"]]],
  "names.short": [[[]], [["A"]], [["A", "B"]], [["A", "B", "C"]], [["A", "B", "C", "D", "E"]]],
  "page.buyLink.held": [["Mentra Call Unlimited"]],
  "page.buyLink.youNowHave": [["Mentra Call Unlimited"]],
  "page.buyLink.full": [["Acme Field Services", 1, "Mentra Call Unlimited", ""], ["Acme Field Services", 3, "Mentra Call Unlimited", "Ana Ruiz and 2 others"], ["Acme Field Services", 1, "Mentra Call Unlimited", "Ana Ruiz"]],
  "page.buyLink.alreadyHas": [["Acme Field Services", "Mentra Call Unlimited"]],
  "page.buyLink.askAnAdmin": [["Acme Field Services", "Mentra Call Unlimited"], ["Acme Field Services", "subscriptions"]],
  "page.adminsGiveOutSeats": [["Acme Field Services"]],
  "page.noSeat.title": [["Acme Field Services"]],
  "recurrence.rate": [["month", 1], ["month", 3], ["year", 2, "2"]],
  "recurrence.cadence": [["month", 1], ["month", 3], ["week", 2, "2"]],
  "price.perSeat": [["$15", "a month"]],
  "catalog.youHaveSeats": [[1], [5]],
  "buy.title": [["Fleet"]],
  "buy.terms": [["$15 per user a month", "month"]],
  "buy.members": [[1], [14]],
  "buy.solo": [[{ total: "$29", rate: "a month", note: "before tax" }], [{ total: "$29", rate: "a month", note: null }]],
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
  "seats.unassignBody": [["Dana Reyes", "Mentra Call Unlimited"]],
  "seats.unassignAria": [["Dana Reyes"]],
  "seats.allInUse": [[5], [1]],
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
  "members.copyIdFor": [["Dana Reyes"]],
  "members.moreFor": [["Dana Reyes"]],
  "members.changeRoleTo": [["Admin"]],
  "members.removePrompt": [["Dana Reyes"]],
  "confirm.leave.title": [["Acme Field Services"]],
  "confirm.delete.title": [["Acme Field Services"]],
  "confirm.delete.typeName": [["Acme Field Services"]],
  "confirm.revokeInvitation.title": [["jamie@acme.test"]],
  "confirm.revokeKey.title": [["CI publisher"]],
  "assign.enough": [
    [{ free: 2, quantity: 5, chosen: 1 }],
    [{ free: 2, quantity: 5, chosen: 2 }],
    [{ free: 4, quantity: 5, chosen: 3 }],
    [{ free: 1, quantity: 1, chosen: 1 }],
    [{ free: 1, quantity: 1, chosen: 2 }],
  ],
  "assign.someHold": [
    [{ holders: ["A"], free: 1, quantity: 3, recipients: ["B"] }],
    [{ holders: ["A", "B"], free: 1, quantity: 3, recipients: ["C", "D"] }],
    [{ holders: ["A"], free: 1, quantity: 1, recipients: ["B"] }],
  ],
  "assign.tooMany": [[500], [1]],
  "purchase.headline": [[true], [false]],
  "purchase.settingUpSeats": [[{ seats: 1, product: "Call Unlimited" }], [{ seats: 5, product: "Call Unlimited" }]],
  "purchase.readyTitle": [[{ seats: 1, product: "Call Unlimited" }], [{ seats: 5, product: "Call Unlimited" }]],
  "purchase.readyBody": [[{ product: "Call Unlimited", paid: true }], [{ product: "Call Unlimited", paid: false }]],
  "purchase.youNowHave": [["Call Unlimited"], ["Call Unlimited", 5]],
  "purchase.timeout.title": [[true], [false]],
  "testMode.label": [["Staging"]],
};
