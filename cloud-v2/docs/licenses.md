# Licenses

Core holds the products that workspaces buy, and the licenses people get from
them: who holds each one. Billing (the Store's billing module) sells
the products and writes each license into Core; Core never changes a license's
terms itself. Workspaces, roles and the audit trail are described in
[Workspaces and keys](workspaces.md), and the signed service API in
[Store integration](store-integration.md).

- A **license** is a quantity of one **product** (`mentra.call.unlimited`) for a
  term: valid from `validFrom`, paid through `paidThrough`.
- A product unlocks **features** (`call.unlimited`), each for the packages it
  names (`com.mentra.call`). A feature for no package is a service's.
- A license's **owner** is a workspace, whose Admins and Owners assign its seats
  to members. A license has no other kind of owner: a person holds a license only
  through a seat, and buying for yourself is buying in your own workspace. The
  owner never changes.
- A **seat** belongs to one membership. A member holds at most one seat per
  license, and the seats in use never exceed the quantity.

**The words.** The screens use the Microsoft 365 meaning. A *license* is one
person's right to use a product; a workspace buys some number of licenses for a
*product*, and each license is assigned to one member. What the workspace buys
is a product (never "a license"), and a price per license is "per user". The screens never say "seat". Core's records
and API keep their names for the same things: a `License` is the owner's holding
of one product (its `quantity` is the number of licenses bought), and a license
assigned to a member is a *seat* (`license_seats`, `seatsUsed`, `/seats/`,
`/seat-assignments`, `seat.assigned`). This page uses Core's names where it
describes records and routes, and the screens' words where it describes what a
person sees.

Core keeps them in `licenses` (one document per license, `_id` billing's license
ID, a ULID) and `license_seats` (one document per assigned seat, unique per
license and membership). Licenses exist on hosted Core only: a Private Cloud
has none.

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
| `owner` | `{"type": "workspace", "workspaceId"}`. Any other owner is refused. |
| `product` | The product, such as `mentra.call.unlimited`. |
| `features` | `[{key, packages}]`; `packages` may be empty. |
| `quantity` | The number of licenses bought, a whole number of 0 or more. |
| `validFrom`, `paidThrough` | RFC 3339 times in UTC (`2026-10-01T00:00:00Z`). |
| `assignTo` | Optional: `{"mentraUserId"}`, the purchase's buyer ([The buyer's license](#the-buyers-license)). |
| `seatRequest` | Optional: `{"requestId", "mentraUserId", "quantity"}`, a person's request for one more license for themselves ([A license added for oneself](#a-license-added-for-oneself)). |

Core applies a write only if its revision is newer than the one it has, so
billing sends the latest version of each license until Core accepts it, and
repeats and late deliveries are harmless:

| Core answers | When | Billing |
| --- | --- | --- |
| `200 {"applied": true, "revision"}` | A new license, or a newer revision. | Delivered. |
| `200 {"applied": false, "revision"}` | The revision Core has. Nothing changes. | Delivered. |
| `409 stale_revision` | An older revision. The body's `revision` is Core's. | Delivered: Core has a newer one. |
| `404 owner_not_found` | The workspace is deleted, or never existed, or the license ended with it. | Stop sending it. |
| `400 invalid_request` | A malformed write, another license than the path's, an owner that is not a workspace (a person included), a `paidThrough` before `validFrom`, an `assignTo` other than `{"mentraUserId"}` with a non-blank ID, a malformed `seatRequest`, or a change of owner. | A bug to fix. |
| `5xx` | Core could not answer. | Send it again. |

`GET /api/internal/licenses?ownerType=workspace&ownerId=` answers
`{"licenses": [...]}`: the workspace's licenses, ended ones included, each a
`LicenseView` with `seatsUsed` and `endedAt`. Any other `ownerType` is
`400 invalid_request`. The Store only.

`createCoreWorkspaceClient` from `@mentra/workspace-contract/server` speaks both:
`putLicense(write)` resolves `{applied, revision}`, and throws
`CoreWorkspaceClientError` with `code` `stale_revision` (409), `owner_not_found`
(404), `core_unavailable` (5xx, or no answer) or `bad_request`, and the HTTP
`status`. `listLicenses(workspaceId)` resolves `{licenses}`.

A license is written in a transaction that also writes the workspace, so it
never lands after the workspace is deleted.

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

### A license added for oneself

When a person adds one license for themselves (`POST session` with `forMe`),
billing records their request and names it as `seatRequest` on the write whose
quantity reaches the request's, and on every later write until Core accepts one
that carries it: `requestId` (a non-blank id of at most 200 characters),
`mentraUserId` (theirs, a non-blank Core user ID) and `quantity` (the count the
license reaches with their license added, a whole number from 1 to 1,000,000).
Anything else is `400 invalid_request`.

Core decides each request once, on the first applied write (a new license or a
newer revision) that carries an id the license hasn't recorded. That write's
update records the id on the license (`seatRequests`, the latest 20), whatever
is decided, inside its transaction. Core gives the person one license only when
that write raises the quantity to the request's (the quantity Core had, 0 for a
new license, is below `seatRequest.quantity`, and the write's is at least that),
the person has an active membership in the owner workspace, they hold no seat of
this license and none of an in-term, not-ended license of the same product
there, and a seat is free. It takes the seat through the same conditional
increment as an assignment and records `seat.assigned` (actor `store`) after
`license.written` and the buyer's. Otherwise it assigns nothing, and the
license is left free for an Admin to assign. A repeat (`applied: false`), an
older revision (`stale_revision`), and every later write still carrying the
request decide nothing, even after the person is unassigned, and deliveries
that race decide it once. The request names the person who opened the session,
never the buyer `assignTo` names. A Core that predates it ignores the field.

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
says the [billing module](portal-modules.md#is-the-module-installed) is ready on
this Core, and with it its catalog, for everyone who signs in. The page asks only
for what its viewer's view needs ([Who sees what](#who-sees-what)).

- **The page.** A workspace has a Licenses item, first in its sidebar, when the
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
  for, then the product just bought, then by name. Nothing above them counts
  the products or adds up what they cost: each card has its own cost.
  - The head has the product's icon (a letter tile when billing sends none the
    portal may show), its name, one status badge, and, for a product with more
    than one feature, a chip per feature with the miniapp it works in. It has no
    description: the catalog and the Buy dialog say what a product is, for
    someone deciding whether to buy it.
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
  - Buy opens the licenses step for every workspace, the same way: a counter
    ("Licenses", with "One license fewer" and "One license more") held between
    billing's smallest and largest number of licenses and starting at the number
    of members the workspace has (imported members still waiting for their first
    sign-in count), the one sum the portal works out ("10 licenses × $15 · $150
    a month · before tax"), "Your workspace has 14 members.", and Continue to
    payment ↗. It says "Renews every month. Change the number of licenses or
    cancel at any time." In a workspace of one person there is no counter and no
    member line: the step reads "1 license · $29 a month · before tax" and "It's
    yours once payment goes through.", and Continue buys one. Continue asks
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
  `?purchase=<purchaseId>`. The page opens a dialog over the cards, like the
  link's dialogs below: titled with the product's name, its icon beside the
  words, and one OK. While the license is set up it says "Payment received" and
  "Setting up 5 Call Unlimited licenses. This takes a few seconds; you can stay
  on this page.", with a spinner, and the page reads billing's status and Core's
  licenses every 2 seconds for up to a minute. When billing says the purchase is
  ready and Core lists it, the dialog says "Your 5 Call Unlimited licenses are
  ready" and "Payment received, and Call Unlimited is active. Assign the
  licenses to members below.", and the card for that product is first and
  ringed in green. After a minute the reads stop and the dialog says "Your
  payment went through" and "The licenses can take a few minutes to appear.",
  with Reload beside OK; a product that arrives later still turns it ready. A
  purchase that collected no payment says "Purchase complete" and never
  "Payment received". An unknown purchase, or another owner's, opens no dialog.
  When the new license's holders include the viewer, whom billing named the
  buyer when it made the purchase, the dialog says so: "Your Call Unlimited
  license is ready" and "Payment received, and it's assigned to you." for one
  license ("Purchase complete" and "Call Unlimited is active, and it's assigned
  to you." when no payment was collected), or "Your 5 Call Unlimited licenses
  are ready" and "Payment received, and one is assigned to you. Assign the rest
  to members below." for more.
  OK closes the dialog in every state, and so do Escape, its × and the
  backdrop. Closing it removes `?purchase=` from the address in place, so
  neither Back nor a reload opens it again. Nothing else stops: the page goes on
  reading until the license is there or the minute is up, so a person who
  presses OK while it is setting up sees the card turn ready, and the card stays
  first and ringed for as long as the page is open.
- **Back from the page that added a license for the person.** The hosted page of
  row 5 above returns to `/licenses?workspace=<id>&added=<licenseId>`. The page
  opens the same dialog, for one unpaid license (the add may be charged now or
  on the next invoice, so it claims no payment), and reads Core's licenses (and
  billing's status, for a person offered billing) every 2 seconds for up to a
  minute, until the person's membership holds a seat of that license's product.
  While it waits the dialog says "Purchase complete" and "Setting up 1
  <product> license. This takes a few seconds; you can stay on this page."; then
  "<product> is active, and it's assigned to you." If the person does not hold
  the product by the end of the minute, it says "Your purchase went through"
  and "The licenses can take a few minutes to appear.", with Reload. A license
  Core does not list cannot be named, so for one the dialog opens only at the
  end of the minute. OK (or Escape, the × or the backdrop) closes it and
  removes `?added=` from the address in place, and the page goes on reading
  until the person holds the product or the minute is up.
- **One dialog at a time.** A link's answer (below) comes first, then the
  dialog back from checkout, then the one back from the page that added a
  license. The link's `?buy=` leaves the address before the browser goes to
  checkout, so the return finds no link; the order only matters for an address
  made by hand.
- **A link that asks to buy.** A person who follows
  `/licenses?buy=<product>` (a product's key) signs in if they have to (the
  sign-in page says "Sign in to buy <product's name>.", from a public read of the
  product's name that needs no session, and "Sign in to buy a license." where
  that can't be read), lands in their own workspace (their first visit makes
  one, see [the first run](workspaces.md#the-workspace-portal)), and the
  Licenses page acts once its reads are in. It removes `?buy=` from the address
  in place first, so Back, from a hosted page too, does not return to the link
  and a reload does not act again. The page opens even for a Member who holds
  nothing, so the answer is there. The first row that matches decides; the page
  writes no note above the cards:

  | # | Case | What happens |
  | --- | --- | --- |
  | 1 | The viewer holds the product (a seat of a license of it that has not ended) | A dialog: "You already have <product>." |
  | 2 | The viewer has a membership and may assign licenses, and a license of it is free (in its term, with a license left) | The page assigns it to them, with no click and no payment, and a dialog says "You now have <product>." |
  | 3 | The viewer is not an Admin or Owner | A dialog: "Only Admins and Owners of <workspace> can buy <product>. Ask one of them." (the product's name from the catalog, else "licenses" where it can't be read) |
  | 4 | Billing is not offered to the viewer here | A dialog: "Licenses can't be bought here." |
  | 5 | The workspace has a card for the product and the viewer has a membership | When one of its licenses lists `add_seats` and has no more people than licenses, the browser goes to billing's hosted page for one more license, assigned to the viewer (`add_seats` of 1, with `forMe`). Otherwise a dialog: "<workspace> has 3 <product> licenses, assigned to Ana Ruiz and 2 others." and "Unassign someone on the <product> card to free a license." |
  | 6 | The workspace has a card and the viewer is not a member (an Organization Admin visiting) | A dialog: "<workspace> already has <product>." |
  | 7 | Billing sells the product now | The browser goes to billing's checkout for one license, and Core assigns the buyer. Where billing's smallest purchase is more than one, the Buy dialog's licenses step opens instead. |
  | 8 | Anything else | A dialog: "That product isn't for sale." |

  Rows 2, 5 and 7 take no click, in this tab (the hosted page returns to the
  portal, so no other tab is opened). The page says "Opening checkout…" in a
  dialog while billing is asked for the page, and a refusal is a dialog with its
  words and Done: "Someone else is adding a <product> license right now. Try
  again in a few minutes.", "A purchase of <product> is already under way. Finish
  it, or try again in a minute.", and the others on this page. Row 2 comes
  before rows 3 and 4, because taking a free license needs no billing. A Member
  or Developer sees only their own licenses, so for them row 2 never matches.
  Every dialog is titled with the product's name ("Licenses" where the catalog
  doesn't know it) and shows its icon. A refused assignment is a dialog with the
  refusal ("That license was just taken. Nothing was assigned." where the license
  filled up first). Pressing Back from the hosted page can bring the page back
  from the browser's back/forward cache as it was, with the locked "Opening
  checkout…" dialog; the page closes that dialog when it is shown again from the
  cache (`pageshow` with `persisted`). Billing puts the buyer's Core user ID on the subscription it checks
  out, and Core gives the buyer one of the new licenses when the purchase's
  first write arrives, so they have it whether or not they keep the tab open. An
  Organization Admin buying in a workspace they are not a member of gets none.
- **Test mode.** Where billing sells with a test key, a banner above everything
  names the environment and the test card to pay with (with a copy button). A
  small × in its top-right corner ("Hide the test mode notice") hides it for the
  rest of the browser session, so a screenshot comes out clean: it is kept in `sessionStorage` under
  `mentra.testModeNotice.hidden`, so a new session shows it again, and where
  storage throws (a private mode) it is hidden for that page only. Test mode
  itself, the buy dialogs and their words are unchanged.
- **No personal Billing page.** Licenses belong to workspaces, and every
  person who signs in to the portal has one, so buying for yourself is buying in
  your own workspace: the account menu has Sign out and nothing else, and
  `/account/billing` is "Page not found".

## Ending

- **Deleting a workspace** ends its licenses (`endedReason: "workspace_deleted"`)
  and frees their seats in the deletion's transaction.
- **Deleting an account** ends no license. The person's memberships end, and the
  licenses assigned to them are freed with them (`seat.released`, reason
  `account_deleted`), before its `user.deleted` tombstone.

An ended license keeps its document, takes no seat and no write: Core answers
`404 owner_not_found` to every later write for it. Billing learns of the
deletion from the change feed (`workspace.deleted`) and stops charging.

## Listing every license

### Dev and staging support reset

On dev or staging, an Organization Admin can use **Admin → Workspaces → Reset licenses & billing**.
A short confirmation dialog names the workspace and offers Cancel or Reset; no reason or typed confirmation is required.
`GET /api/admin/workspace-license-resets/:workspaceId` previews the workspace's license and assignment counts.
`POST` to the same address takes `{confirmWorkspaceId}`. Both routes require an Organization Admin person
and `CLOUD_CORE_ENVIRONMENT=dev` or `staging`; other deployments refuse them.

Core asks the matching Store to cancel test subscriptions and expire unfinished checkouts before ending any licenses.
The Store independently requires dev or staging and test payment mode. Core then ends licenses and releases
their assignments transactionally, recording `workspace.licenses.reset`, the actor, and an administrative reset description. License records
remain as `admin_reset` tombstones, and every returned billing ID is retired on the workspace, including IDs whose
first delivery has not arrived. License writes check that retirement in their workspace transaction so delayed billing
writes cannot restore access. Members, ownership, credentials,
and the workspace remain intact, and new purchases are allowed. The admin action log also records reset requests,
including attempts that fail partway through billing. A failed attempt may already have canceled some subscriptions;
retrying safely finishes the action. If a new license arrives outside the canceled snapshot, cleanup refuses and asks
for a retry rather than ending a subscription billing did not cancel.

Deploy the Store's reset endpoint before enabling this Core/UI change. Missing or failed billing support never
produces a successful local reset. No additional secrets or environment settings are required.

An Organization Admin lists every license, with the workspace that holds it, in
the admin portal's Licenses page, which reads `GET /api/admin/licenses?query=&cursor=`. It
needs `organization.licenses.read`, which only an Organization Admin holds: an
operator key never does, and neither do a workspace admin, a workspace key or a
phone. The list is read-only: no admin route changes a license or a seat.

- **Items.** Newest first, 50 to a page: `{items, next}`. Each item is an
  `AdminLicenseView` (the license's id, owner, product, quantity, `seatsUsed`,
  `validFrom`, `paidThrough`, `endedAt` and `endedReason`). `next` is the `cursor`
  of the next page, or `null` on the last. A license written while an admin pages
  never moves a row between pages.
- **Owners.** Each license's workspace shows by its name, also once deleted. A
  workspace Core has no record of has a null name, and the portal shows its id.
  A page's workspaces are read in one query; no person's record is read.
- **Search.** `query` is plain text of up to 100 characters, compared without
  regard to case as a substring of the workspace's name or id, or of the
  product. A search reads the workspaces that hold a license, not only a page's,
  so it suits the few thousand licenses a deployment has.
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

- **a seat** in a workspace's license, the only way a person holds a license (a
  seat is deleted when its membership ends, so every seat Core finds is a
  current member's);
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

The lookup uses the collections' existing indexes: seats by `{mentraUserId}`
and the seated licenses by `_id`. A person with no seat costs one query.

## Who sees what

| Capability | Member | Developer | Admin | Owner |
| --- | --- | --- | --- | --- |
| See their own licenses | Yes | Yes | Yes | Yes |
| `workspace.licenses.read`: every product and who holds each license | | | Yes | Yes |
| `workspace.licenses.assign`: assign and unassign licenses | | | Yes | Yes |
| `workspace.billing.manage`: buy, change or cancel, payment methods, invoices | | | Yes | Yes |

Organization Admins act as Owner in every workspace, and hold
`organization.licenses.read`: every license on their Core, for support. It allows no seat change and no billing. Operator keys
never carry it.

The Licenses page draws what the viewer's capabilities and the portal's offer of
billing allow, and asks for no more than that. Core refuses the rest whatever
the page does.

| Viewer | The page shows | The page reads |
| --- | --- | --- |
| **A plain member** (Member or Developer) | Only the products they hold a license for, each as "Assigned to you" with "Your license" since when, "Given by" the workspace, and the miniapps it works in. No totals, no money, no one else's licenses, no controls. The Licenses item is in their sidebar while they hold a license. | Their licenses from Core, and the catalog for names and icons. Not billing's status, not the members. |
| **A billing manager** (an Admin or Owner offered billing) | Every product with its licenses and who holds each. They assign and unassign, from a card (Unassign asks in a dialog) or the people picker. Each license's cost and dates, billing's actions and the failed-payment notices, buying, the header actions, and the dialog after checkout. Where billing uses a test key, a test-mode banner above it all. | Core's licenses and the members, billing's catalog and billing's status. |

- **Who is a billing manager.** Billing is offered when `modules.billing` is true
  and the person holds `workspace.billing.manage`. The roles hold the three
  capabilities together, so wherever billing is installed every Admin and Owner
  is a billing manager, on every Core.
- **The catalog is for every member, the rest is not.** Billing answers the
  catalog for every member of the workspace, with display content only; it adds
  each product's price and how many licenses may be bought only for someone who
  manages the owner's billing. A plain member's page needs it for names and icons, so it asks for it
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
`store` service for a license write and the seat it gives a buyer or a requester, the person
for a seat change). A license's events are its workspace's, so they are on its
audit page and on the [change feed](fleet-integration.md#the-change-feed).

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
