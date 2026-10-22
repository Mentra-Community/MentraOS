# Licenses

Core holds the products that people and workspaces buy, and the licenses people
get from them: who holds each one. Billing (the Store's billing module) sells
the products and writes each license into Core; Core never changes a license's
terms itself. Workspaces, roles and the audit trail are described in
[Workspaces and keys](workspaces.md), and the signed service API in
[Store integration](store-integration.md).

- A **license** is a quantity of one **product** (`mentra.call.unlimited`) for a
  term: valid from `validFrom`, paid through `paidThrough`.
- A product unlocks **features** (`call.unlimited`), each for the packages it
  names (`com.mentra.call`). A feature for no package is a service's.
- A license's **owner** is a workspace, whose Admins and Owners assign its seats
  to members, or a person (by Core user ID), who holds its one seat. The owner
  never changes.
- A **seat** belongs to one membership. A member holds at most one seat per
  license, and the seats in use never exceed the quantity.

**The words.** The screens use the Microsoft 365 meaning. A *license* is one
person's right to use a product; a workspace buys some number of licenses for a
*product*, and each license is assigned to one member. What the workspace buys
is a product (never "a license"), a person's own price has no unit, and a
price per license is "per user". The screens never say "seat". Core's records
and API keep their names for the same things: a `License` is the owner's holding
of one product (its `quantity` is the number of licenses bought), and a license
assigned to a member is a *seat* (`license_seats`, `seatsUsed`, `/seats/`,
`/seat-assignments`, `seat.assigned`). This page uses Core's names where it
describes records and routes, and the screens' words where it describes what a
person sees.

Core keeps them in `licenses` (one document per license, `_id` billing's license
ID, a ULID) and `license_seats` (one document per assigned seat of a workspace
license, unique per license and membership). A personal license has no seat
document. Licenses exist on hosted Core only: a Private Cloud has none.

## Writing licenses

Billing writes a license with `PUT /api/internal/licenses/:licenseId`, signed as
the `store` service ([Signing](store-integration.md#signing)). Any other service
is `403 forbidden`; an unsigned or wrongly signed call is
`401 service_unauthorized`. The body is a `LicenseWrite` from
`@mentra/workspace-contract`:

| Field | Meaning |
| --- | --- |
| `licenseId` | The license the path names: billing's ULID. |
| `revision` | A whole number above zero that grows with every change billing makes. |
| `owner` | `{"type": "workspace", "workspaceId"}` or `{"type": "person", "mentraUserId"}`. |
| `product` | The product, such as `mentra.call.unlimited`. |
| `features` | `[{key, packages}]`; `packages` may be empty. |
| `quantity` | The number of licenses bought, a whole number of 0 or more. Always 1 for a person. |
| `validFrom`, `paidThrough` | RFC 3339 times in UTC (`2026-10-01T00:00:00Z`). |
| `assignTo` | Optional, workspace licenses only: `{"mentraUserId"}`, the purchase's buyer ([The buyer's license](#the-buyers-license)). |

Core applies a write only if its revision is newer than the one it has, so
billing sends the latest version of each license until Core accepts it, and
repeats and late deliveries are harmless:

| Core answers | When | Billing |
| --- | --- | --- |
| `200 {"applied": true, "revision"}` | A new license, or a newer revision. | Delivered. |
| `200 {"applied": false, "revision"}` | The revision Core has. Nothing changes. | Delivered. |
| `409 stale_revision` | An older revision. The body's `revision` is Core's. | Delivered: Core has a newer one. |
| `404 owner_not_found` | The workspace or account is deleted, or never existed, or the license ended with its owner. For a personal license this is checked on every write, a repeat or an older revision included. | Stop sending it. |
| `400 invalid_request` | A malformed write, another license than the path's, a person's quantity other than 1, a `paidThrough` before `validFrom`, an `assignTo` other than `{"mentraUserId"}` with a non-blank ID or one on a personal license, or a change of owner. | A bug to fix. |
| `5xx` | Core could not answer. | Send it again. |

`GET /api/internal/licenses?ownerType=workspace|person&ownerId=` answers
`{"licenses": [...]}`: the owner's licenses, ended ones included, each a
`LicenseView` with `seatsUsed` and `endedAt`. The Store only.

`createCoreWorkspaceClient` from `@mentra/workspace-contract/server` speaks both:
`putLicense(write)` resolves `{applied, revision}`, and throws
`CoreWorkspaceClientError` with `code` `stale_revision` (409), `owner_not_found`
(404), `core_unavailable` (5xx, or no answer) or `bad_request`, and the HTTP
`status`. `listLicenses(owner)` resolves `{licenses}`.

A workspace license is written in a transaction that also writes the workspace,
so it never lands after the workspace is deleted. A personal license is one
document, written without a transaction. Every write of one, a repeat
included, first checks that the person's account still exists; if it does not,
Core ends the license and answers `404 owner_not_found`. So a write that races
the person's account deletion is ended at once, or, should that request fail
first, by billing's next attempt.

### The buyer's license

Billing names a purchase's buyer, by Core user ID, as `assignTo` on every
write of a subscription it checked out, so whichever write reaches Core first
carries it, in any order. Core honors it only on the write that creates the
license, inside that write's transaction: when the buyer has an active
membership in the owner workspace, the license has a seat to give (`quantity`
of 1 or more), and the buyer holds no seat of an in-term, not-ended license of
the same product in that workspace, Core takes one seat through the same
conditional increment as an assignment, inserts it, and records
`seat.assigned` (actor `store`) right after `license.written`. Otherwise it
assigns nothing. A repeat and every later revision assign nothing, even after
the buyer is unassigned, and deliveries of the first write that race create the
license once, so the buyer gets one seat at most. The buyer has their license
whether or not they come back to the page; an Organization Admin who buys for a
workspace they aren't a member of gets none.

## Assigning licenses

People assign licenses (Core calls an assigned license a seat) through the workspace routes, under each portal's route
group ([APIs](workspaces.md#apis)):

| Route | Who | Answers |
| --- | --- | --- |
| `GET /:workspaceId/licenses` | Any member | `{items}`: with `workspace.licenses.read`, every license and every seat; otherwise the licenses the caller holds a seat in, each with only their own seat. |
| `PUT /:workspaceId/licenses/:licenseId/seats/:membershipId` | `workspace.licenses.assign` | The license with its seats. Assigning a seat the member already holds changes nothing. |
| `DELETE /:workspaceId/licenses/:licenseId/seats/:membershipId` | `workspace.licenses.assign` | `204`. Unassigning a seat nobody holds changes nothing. |
| `POST /:workspaceId/seat-assignments` | `workspace.licenses.assign` | `{licenses}`: every license the request names, with its seats. Assigns several seats at once, all of them or none. |

They are for people: a key gets `403`. A seat assignment is refused with
`404 license_not_found` for a license that is not this workspace's,
`409 license_ended` for one that has ended, `404 not_found` for a membership
that is not an active one of this workspace, `400 invalid_request` for an
imported membership still waiting for its person's first sign-in, and
`409 no_seats_available` when every seat is taken.

- **The cap.** Assigning a seat increments the license's `seatsUsed` only while
  it is below `quantity`, in the same transaction as the seat's insert.
  Concurrent assignments conflict on the license, and the database retries them
  against the latest count, so two admins taking the last seat at once never
  both get it, and an assignment is refused only for want of a seat. Rarely, a
  refusal comes from a count read just before another seat was released; trying
  again succeeds.
- **Several at once.** `POST /:workspaceId/seat-assignments` takes
  `{"assignments": [{"licenseId", "membershipId"}]}`, the people picker's
  request. It takes 1 to 500 pairs (`MAX_SEAT_ASSIGNMENTS`);
  any other count, or a pair without both ids, is `400 invalid_request`. Every
  rule of one assignment applies to each pair, and a pair that is refused
  assigns nothing. A repeated pair counts once, and a pair whose member already
  holds that license's seat is skipped and takes no seat. Each license takes all
  of its new seats in one conditional increment, in one transaction for the
  whole request. If any license has fewer seats free than its new pairs need,
  nothing is assigned and Core answers `409 no_seats_available` with
  `licenses`, one `{licenseId, needed, free}` for each license that falls
  short. Requests that race for the same seats, one seat or several, never
  together exceed a license's quantity. Each seat assigned is its own
  `seat.assigned` event.
- **What the people picker checks.** Assign licenses on a card of the Licenses page
  ([In the workspace portal](#in-the-workspace-portal)) gives one product to
  several people in one step: it checks what fits before it sends anything, against the licenses available as Core last listed them ("2 of 3 fit:
  remove one or add licenses."), and sends one
  `POST /:workspaceId/seat-assignments`, so the whole choice is given or none of
  it is. It stays off past `MAX_SEAT_ASSIGNMENTS` licenses, saying "You can assign
  up to 500 licenses at a time.", since one request takes no more. Core checks
  again in its transaction: if the counts changed while the person was choosing,
  it answers `409 no_seats_available`, assigns nothing, and the dialog reads the
  counts again and says "Licenses changed while you were choosing. Nothing was
  assigned. Check the counts and try again." Add licenses ↗ is offered in the
  dialog only for a product whose billing entry lists `add_seats`. The Members list
  assigns nothing: it only shows who holds what.
- **Fewer seats.** A write that lowers the quantity below the seats in use frees
  no seat: the license takes no new assignment until the seats in use fall below
  the quantity again, so a license that is `n` over needs `n + 1` unassigned
  before it takes one.
- **Membership.** Removing a member, the member leaving, or deleting their
  account ends the membership and frees its seats in that same transaction, and
  the freed seat can be assigned again at once. Rejoining is a new membership,
  with no seat.

## In the workspace portal

Mentra Portal draws the Licenses page itself, with `WorkspaceLicensesView` from
`@mentra/workspace-ui`. Billing sends values and the actions it offers: prices,
dates, statuses, product names and what can be done to each product. It sends no
markup and no sentences. The portal words every sentence and formats every
amount, date and count, in its own locale (the first of the browser's languages
it has strings for, with its region, else `en-US`) and the viewer's time zone,
and sends that locale on every request to billing. A status, price or action it
does not know is shown as billing's own label. The page joins three answers into
one card per product the workspace holds: Core's licenses and who holds them (the
routes above), billing's catalog (what each product is) and billing's status
(what each costs and what can be done about it).

Whether the portal offers billing follows `GET /api/portal/me`. `modules.billing`
says the [billing module](portal-modules.md#is-the-module-installed-and-is-it-for-me)
is ready on this Core and visible to the person. `modules.billingCatalog` says
its catalog can be read, which holds wherever billing is ready, whoever asks. The
page asks only for what its viewer's view needs ([Who sees
what](#who-sees-what)).

- **The page.** A workspace has a Licenses item, last in its sidebar, when the
  person is offered billing or the workspace has products to show them (an Admin's
  every product, a member's own licenses). A Private Cloud has neither, so it never
  shows the item. If the licenses cannot be loaded, the sidebar offers the item
  only with billing, but the page's own address still opens. The page says
  "Licenses are unavailable", with Retry, whenever Core's licenses, the catalog it
  needs to name them, or billing's status for someone offered billing cannot be
  read or comes back in a shape the portal does not accept: it never draws cards
  without names. A page that has loaded keeps its cards through every later read,
  a failed one included.
- **Cards.** One per product that has not ended: payment failed first, then
  payment incomplete, then products with more licenses assigned than are paid
  for, then the product just bought, then by name. Above them, one line counts
  them: "2 products · $295 a month in total".
  - The head has the product's icon (a letter tile when billing sends none the
    portal may show), its name and description, one status badge, and, for a
    product with more than one feature, a chip per feature with the miniapp it
    works in.
  - The badge says "Active", "Ends Nov 20" (it will not renew), "Payment failed",
    "Payment incomplete", "Setting up" (paid for, and Core has not received it)
    or "2 over" (more licenses assigned than are paid for).
  - For someone offered billing there are three facts, each with as few lines as
    it needs. Licenses: "3 of 5 assigned" over a meter (past the quantity, "2 more
    than the 5 covered" in amber). The term: Renews with its date alone (or
    "Until" a later end), or Ends with its date and "Doesn't renew". Cost:
    billing's own total with its recurrence, such as "$145 a month" or "$1,740 a
    year", and "Before tax" under it only where billing says tax is excluded; with
    any other tax value there is no line under it. The card never says how many
    licenses are available, "Every month", or "5 × $29": the meter, the date and
    the amount already say it. A price that is not per user shows billing's label,
    with no arithmetic. Without billing the card shows its Licenses alone.
  - A failed payment rings the card in amber and says the day the licenses stop
    working (or stopped), with Update payment method ↗ and Complete payment ↗ where
    billing lists them. That date is the only one of its kind: no card says "paid
    through". A first payment that is not finished says so, with Complete
    payment ↗ where billing lists it. Amber marks failed or unfinished payments
    and over-assignment and nothing else on these pages; a refusal is a neutral
    line.
- **Actions.** Every button that leaves the portal for a hosted billing page is
  marked ↗, and exists only where billing lists that action for the product: Add
  licenses, Change license count, Cancel, Renew, Update payment method, Complete
  payment, and, for the account, Billing & invoices. The payment actions sit in
  their notice, Add licenses with the licenses, and the rest in the card's "…" menu, an
  action Core does not know among them under billing's own label. A press asks
  billing for a session and sends this tab to the address it answers, if it is one
  the portal will follow (`https:`, or `http:` to `localhost` or `127.0.0.1`).
  Billing marks a page that cannot send the person back, such as an invoice's
  payment page, with `returns: false`: it opens in a new tab started in the click
  itself, and if the browser blocks the tab the address comes back as an "Open the
  payment page ↗" link. After such a page, the licenses and billing's status are
  read again when the window regains focus. A refusal is worded next to the
  button.
- **Assigned to.** A card lists who holds each license, name over email, since
  when, and Unassign, which asks in a dialog ("Unassign <name>?", "<name> loses
  <product> the next time they open it.", Cancel and a destructive Unassign;
  Cancel, Escape and × close it with no request and give focus back to the row's
  button, and a refusal is shown inside it). Available licenses follow: up to three as
  a row each ("Available license") with Assign, more as one line ("7 available
  licenses"). A list of more than 8 people has a search ("Search people with a
  license"). With several products on the page the list folds into one line
  (their avatars and "Dana Reyes, Priya Natarajan and 8 others", or "No one has a
  license yet") until "Assigned to" opens it; a single product shows its list
  open. With every license assigned the card says "All 10 licenses are assigned."
  and offers Add licenses ↗ where billing lists it. A product with more licenses
  assigned than are paid for says by how many: "5 people are assigned but only 3
  licenses are paid for." and "Unassign 2 of them, or add 2 licenses. No one else
  can get a license until then." Assigning is off until it is back within the
  quantity, and Unassign still works. Every change of who holds a license makes
  billing's status stale, so the counts and costs on the page are read again.
- **The people picker.** Assign licenses on a card opens a dialog for that
  product: search by name or email, tick several people, and Assign. A member who
  holds a license or has not signed in is listed but cannot be ticked ("Has a
  license", "After first sign-in"). When more are ticked than there are licenses
  available, it says "3 of 4 fit: remove one or add licenses." and Assign stays
  off. Assign sends one `POST /:workspaceId/seat-assignments` ([Assigning licenses](#assigning-licenses)),
  so everyone ticked gets a license or no one does.
- **Buying.** What can be bought comes from the catalog's `offer`, which billing
  sends only to a viewer who manages the owner's billing. Anyone else gets
  display content: no price and no Buy.
  - A workspace with no products shows the catalog as its page, "Buy licenses for
    your members", a card per product with its price ("$15 per user a month") and
    Buy; where billing offers it nothing, the page says "This workspace has no
    products yet." With products, the header's Buy licenses opens the same
    products in a dialog. A product the workspace holds shows "You have 5
    licenses" and Add licenses ↗ where billing lists it, not Buy. A product whose
    first payment is not finished shows "Payment incomplete" and Complete
    payment ↗.
  - Buy opens the licenses step: a counter ("Licenses", with "One license fewer"
    and "One license more") held between billing's smallest and largest number of
    licenses and starting at its default (5 for a workspace), the one sum the
    portal works out ("10 licenses × $15 · $150 a month · before tax"), "Your
    workspace has 14 members.", and Continue to payment ↗. It says "Renews every
    month. Change the number of licenses or cancel at any time." Continue asks
    billing for a purchase, and the browser goes to the hosted payment page it
    answers. For a price that is not per user, the step shows billing's label and
    no sum.
  - Billing's refusals are worded in the dialog, such as "You already have Call
    Unlimited. Add licenses instead." and "A purchase of Call Unlimited is already
    under way. Finish it, or try again in a minute."
- **The header actions.** The page's title bar has Billing & invoices ↗, where
  billing lists that action for the account, and Buy licenses, where billing
  offers the workspace something to buy or to add licenses to. They are drawn only
  for a person offered billing, in a workspace that has products (with none, the
  page is the catalog). A refusal shows under them.
- **Back from checkout.** A completed checkout returns to the Licenses page with
  `?purchase=<purchaseId>`. The page shows a banner, "Setting up 5 Call Unlimited
  licenses. This takes a few seconds; you can stay on this page.", and reads
  billing's status and Core's licenses every 2 seconds for up to a minute. When
  billing says the purchase is ready and Core lists it, the banner says "Your 5
  Call Unlimited licenses are ready", the card for that product is first and
  ringed in green, and Dismiss removes `?purchase=` from the address in place, so
  Back does not return to the banner. After a minute the reads stop and the
  banner says "Your payment went through" with Reload, because the licenses can
  take a few minutes to appear; a product that arrives later still turns it ready. A
  purchase that collected no payment says "Purchase complete" and never "Payment
  received". An unknown purchase, or another owner's, shows no banner.
- **Test mode.** Where billing sells with a test key, a banner above everything
  names the environment and the test card to pay with (with a copy button). A
  small × in its top-right corner ("Hide the test mode notice") hides it for the
  rest of the browser session, on the Licenses page and the personal Billing page
  alike, so a screenshot comes out clean: it is kept in `sessionStorage` under
  `mentra.testModeNotice.hidden`, so a new session shows it again, and where
  storage throws (a private mode) it is hidden for that page only. Test mode
  itself, the buy dialogs and their words are unchanged.
- **Billing.** The person's own page is `/account/billing`, with a Billing entry
  in the account menu. Its sidebar is Your account with Billing under it, and a
  way back to one of the person's workspaces if they have one; a person in no
  workspace gets the page all the same. It is `PersonalBillingView` over
  billing's account scope: a card for each license the person bought for
  themselves, with the status, term, cost, failed-payment notice and "…" menu of
  a workspace's card, and no list of people. With none, the catalog ("Buy a
  license for yourself"), where Buy goes straight to the hosted payment page,
  since a person's one license needs no licenses step. For a person who holds a
  product, the title bar has Billing & invoices ↗ and, while something is left to
  buy, Buy a license. Back from checkout shows the same banner ("Call Unlimited
  is ready").
  Where the person is not offered billing, the menu has no Billing entry and the
  address is "Page not found".

## Ending

- **Deleting a workspace** ends its licenses (`endedReason: "workspace_deleted"`)
  and frees their seats in the deletion's transaction.
- **Deleting an account** ends the person's own licenses
  (`endedReason: "account_deleted"`) before its `user.deleted` tombstone; the
  seats they held in workspaces end with their memberships.

An ended license keeps its document, takes no seat and no write: Core answers
`404 owner_not_found` to every later write for it. Billing learns of the
deletion from the change feed (`workspace.deleted`, `user.deleted`) and stops
charging.

## Listing every license

An Organization Admin lists every license, workspace and personal, in the admin
portal's Licenses page, which reads `GET /api/admin/licenses?query=&cursor=`. It
needs `organization.licenses.read`, which only an Organization Admin holds: an
operator key never does, and neither do a workspace admin, a workspace key or a
phone. The list is read-only: no admin route changes a license or a seat.

- **Items.** Newest first, 50 to a page: `{items, next}`. Each item is an
  `AdminLicenseView` (the license's id, owner, product, quantity, `seatsUsed`,
  `validFrom`, `paidThrough`, `endedAt` and `endedReason`). `next` is the `cursor`
  of the next page, or `null` on the last. A license written while an admin pages
  never moves a row between pages.
- **Owners.** A workspace shows by its name, also once deleted. A person shows by
  the last name a sign-in through Core's sign-in server carried and the email of
  their latest sign-in there, or by Core's copy of their verified email when they
  have not signed in through it; both are null for a deleted account, and the
  portal shows the id. A page's owners are read in one query per collection.
- **Search.** `query` is plain text of up to 100 characters, compared without
  regard to case as a substring of the owner's name, email or id, or of the
  product. A search reads the owners that hold a license, not only a page's, so
  it suits the few thousand licenses a deployment has.
- **The Licenses page** appears in the portal only when the caller may read
  licenses and `GET /api/admin/me` says `licenses.available`: billing is
  configured on this Core (`CLOUD_CORE_BILLING_URL`), or any license exists.

## Features in miniapp tokens

When the Mentra App asks Core for a miniapp's token
(`POST /api/client/auth/miniapp-token`), Core puts the features the person holds
for that miniapp's package in the token's `features` claim: feature keys, sorted
and unique, such as `["call.unlimited"]`. A miniapp backend reads them with
`hasFeature` from `@mentra/auth`. A person who holds none gets a token with no
`features` claim.

A person holds a feature through:

- **a license of their own;**
- **a seat** in a workspace's license (a seat is deleted when its membership
  ends, so every seat Core finds is a current member's);
- **`CLOUD_CORE_ENABLED_FEATURES`**, whose entries are `feature[:package+package]`,
  comma-separated. An entry with packages grants that feature to every signed-in
  person, in those packages' tokens only. An entry without packages (`fleet.managed`)
  reaches no token. Fleet reads only the feature names from the same setting
  ([Fleet integration](fleet-integration.md)).

A license counts only while it is in its term, `validFrom <= now < paidThrough`,
and has not ended (`endedAt` is null). A feature reaches a token only when the
miniapp's package is one of that feature's `packages`: a seat in a license for
another package never reaches this package's token, and a feature for no package
reaches no token.

A change reaches a person with their next token. A token already minted keeps the
features it was minted with until it expires (an hour by default), so a license
that ends or a seat that is released stops showing at the person's next mint.

If Core cannot read the licenses or seats, or the lookup takes longer than 1.5
seconds (the same deadline as the account email lookup), the mint answers
`503 {"error":"features_unavailable"}` and issues no token; the Mentra App asks
again. Core never mints a token that is missing features the person holds.

The lookup uses the collections' existing indexes: personal licenses by
`{"owner.type", "owner.mentraUserId"}`, seats by `{mentraUserId}` and the seated
licenses by `_id`. A person with no seat costs two queries, run together.

## Who sees what

| Capability | Member | Developer | Admin | Owner |
| --- | --- | --- | --- | --- |
| See their own licenses | Yes | Yes | Yes | Yes |
| `workspace.licenses.read`: every product and who holds each license | | | Yes | Yes |
| `workspace.licenses.assign`: assign and unassign licenses | | | Yes | Yes |
| `workspace.billing.manage`: buy, change or cancel, payment methods, invoices | | | Yes | Yes |

Organization Admins act as Owner in every workspace, and hold
`organization.licenses.read`: every license on their Core, personal ones
included, for support. It allows no seat change and no billing. Operator keys
never carry it.

The Licenses page draws what the viewer's capabilities and the portal's offer of
billing allow, and asks for no more than that. Core refuses the rest whatever
the page does.

| Viewer | The page shows | The page reads |
| --- | --- | --- |
| **A plain member** (Member or Developer) | Only the products they hold a license for, each as "Assigned to you" with "Your license" since when, "Given by" the workspace, and the miniapps it works in. No totals, no money, no one else's licenses, no controls. The Licenses item is in their sidebar while they hold a license. | Their licenses from Core, and the catalog for names and icons. Not billing's status, not the members. |
| **A license manager without billing** (an Admin or Owner who is not offered billing) | Every product with its licenses and who holds each. They assign and unassign, from a card (Unassign asks in a dialog) or the people picker. No money, no dates, no total, no billing actions, no buying, no Add licenses. | Core's licenses and the members, and the catalog for names and icons. Not billing's status. |
| **A billing manager** (an Admin or Owner offered billing) | All of that, plus each license's cost and dates, the total, billing's actions and the failed-payment notices, buying, the header actions, and the banner after checkout. | Billing's status as well. |
| **A person**, on their own | `/account/billing`, where billing is offered to them: products they bought for themselves, with no list of people, and the catalog when they hold none. | Billing's catalog and status for their account. |
| **Staff, where billing uses a test key** | Where `CLOUD_CORE_ENVIRONMENT` is not `prod`, billing is offered to Organization Admins only. They act as Owner everywhere, so they are billing managers of every workspace and have their own Billing page, under a test-mode banner. | As for a billing manager or a person. |

- **Who is a license manager without billing.** The roles hold the three
  capabilities together, so the difference is whether billing is offered. It is
  offered when `modules.billing` is true and the person holds
  `workspace.billing.manage`. On a Core with a test key, an Admin or Owner who is
  not an Organization Admin is a license manager without billing: the catalog is an
  open read, so their products are still named and drawn with their icons
  ([Open reads](portal-modules.md#open-reads)), but they see no money and cannot
  buy.
- **The catalog is open, the rest is not.** Billing answers the catalog for every
  member of the workspace, with display content only; it adds each product's
  price and how many licenses may be bought only for someone who manages the owner's
  billing. A plain member's page needs it for names and icons, so it asks for it
  once Core has listed a product for them to name.
- **The Members page.** Its Licenses column is for a viewer with
  `workspace.licenses.read` where the catalog can be read. It only shows: a chip per
  product, "None", or "After first sign-in". Licenses are assigned from the
  Licenses page, never from Members. A row's
  "…" menu (Change role to a role, Remove from workspace, which asks in a dialog)
  needs `workspace.members.manage`. Without the catalog the column is left out and the
  rest of Members works.

## Audit and the change feed

Every license and seat change is in Core's audit trail, with its actor (the
`store` service for a license write and the buyer's seat it gives, the person
for a seat change). A workspace
license's events are the workspace's, so they are on its audit page and on the
[change feed](fleet-integration.md#the-change-feed); a personal license's are the
organization's, and not on the feed.

| `action` | `target` | `before` | `after` |
| --- | --- | --- | --- |
| `license.written` | `{licenseId, product, owner}` | the terms Core had (`{revision, product, features, quantity, validFrom, paidThrough}`), or null | the terms written |
| `license.ended` | `{licenseId, product, owner}` | `{endedAt: null}` | `{endedAt, reason, releasedSeats}` |
| `seat.assigned` | `{licenseId, membershipId, mentraUserId, email}` | null | `{assignedAt, seatsUsed, quantity}` |
| `seat.released` | `{licenseId, membershipId, mentraUserId, email}` | `{assignedAt}` | `{reason}` |

A seat's `reason` is `unassigned`, `member_removed`, `member_left`,
`account_deleted`, `workspace_deleted` or `license_ended`. Ending a membership
records its `seat.released` events before the membership's own event.
Deleting a workspace records, license by license, that license's
`seat.released` events and then its `license.ended`, and all of them before
`workspace.deleted`.
