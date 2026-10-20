# Licenses and seats

Core holds the licenses people and workspaces buy, and who holds each seat.
Billing (the Store's billing module) sells them and writes each license into
Core; Core never changes a license's terms itself. Workspaces, roles and the
audit trail are described in [Workspaces and keys](workspaces.md), and the
signed service API in [Store integration](store-integration.md).

- A **license** is a quantity of one **product** (`mentra.call.unlimited`) for a
  term: valid from `validFrom`, paid through `paidThrough`.
- A product unlocks **features** (`call.unlimited`), each for the packages it
  names (`com.mentra.call`). A feature for no package is a service's.
- A license's **owner** is a workspace, whose Admins and Owners assign its seats
  to members, or a person (by Core user ID), who holds its one seat. The owner
  never changes.
- A **seat** belongs to one membership. A member holds at most one seat per
  license, and the seats in use never exceed the quantity.

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
| `quantity` | Seats, a whole number of 0 or more. Always 1 for a person. |
| `validFrom`, `paidThrough` | RFC 3339 times in UTC (`2026-10-01T00:00:00Z`). |

Core applies a write only if its revision is newer than the one it has, so
billing sends the latest version of each license until Core accepts it, and
repeats and late deliveries are harmless:

| Core answers | When | Billing |
| --- | --- | --- |
| `200 {"applied": true, "revision"}` | A new license, or a newer revision. | Delivered. |
| `200 {"applied": false, "revision"}` | The revision Core has. Nothing changes. | Delivered. |
| `409 stale_revision` | An older revision. The body's `revision` is Core's. | Delivered: Core has a newer one. |
| `404 owner_not_found` | The workspace or account is deleted, or never existed, or the license ended with its owner. For a personal license this is checked on every write, a repeat or an older revision included. | Stop sending it. |
| `400 invalid_request` | A malformed write, another license than the path's, a person's quantity other than 1, a `paidThrough` before `validFrom`, or a change of owner. | A bug to fix. |
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

## Seats

People assign seats through the workspace routes, under each portal's route
group ([APIs](workspaces.md#apis)):

| Route | Who | Answers |
| --- | --- | --- |
| `GET /:workspaceId/licenses` | Any member | `{items}`: with `workspace.licenses.read`, every license and every seat; otherwise the licenses the caller holds a seat in, each with only their own seat. |
| `PUT /:workspaceId/licenses/:licenseId/seats/:membershipId` | `workspace.licenses.assign` | The license with its seats. Assigning a seat the member already holds changes nothing. |
| `DELETE /:workspaceId/licenses/:licenseId/seats/:membershipId` | `workspace.licenses.assign` | `204`. Unassigning a seat nobody holds changes nothing. |

They are for people: a key gets `403`. A seat assignment is refused with
`404 license_not_found` for a license that is not this workspace's,
`404 not_found` for a membership that is not an active one of this workspace,
`400 invalid_request` for an imported membership still waiting for its person's
first sign-in, and `409 no_seats_available` when every seat is taken.

- **The cap.** Assigning a seat increments the license's `seatsUsed` only while
  it is below `quantity`, in the same transaction as the seat's insert.
  Concurrent assignments conflict on the license, and the database retries them
  against the latest count, so two admins taking the last seat at once never
  both get it, and an assignment is refused only for want of a seat.
- **Fewer seats.** A write that lowers the quantity below the seats in use frees
  no seat: the license takes no new assignment until the seats in use fall below
  the quantity again, so a license that is `n` over needs `n + 1` unassigned
  before it takes one.
- **Membership.** Removing a member, the member leaving, or deleting their
  account ends the membership and frees its seats in that same transaction, and
  the freed seat can be assigned again at once. Rejoining is a new membership,
  with no seat.

## In the workspace portal

Mentra Portal shows licenses in two places. Whether it offers billing there
follows `GET /api/portal/me`, whose `modules.billing` says that the
[billing module](portal-modules.md#is-the-module-installed-and-is-it-for-me) is
ready on this Core and visible to the person.

- **Licenses & Billing.** A workspace's page has this item, last in its sidebar,
  when the person is offered billing or the workspace has licenses to show them
  (an Admin's every license, a member's own seats). A Private Cloud has neither,
  so it never shows the item. The page lists the workspace's licenses and, where
  the person is offered billing, the billing module for that workspace below
  them ([the module's UI](portal-modules.md#the-modules-ui)). If the licenses
  cannot be loaded, the item is offered only with billing, and the page's address
  opens the list's own error with Try again.
- **The list** follows the capabilities of `GET /:workspaceId/licenses`:
  - a member sees only the licenses they hold a seat in, as "You hold a seat"
    with the term, and nothing about anyone else;
  - with `workspace.licenses.read`, every license shows its seats used of its
    quantity and who holds each seat;
  - with `workspace.licenses.assign` as well, each seat has Unassign (after a
    confirm step), and a license with a seat free has a form to give one to a
    member who has none. Members still waiting for their first sign-in are not
    offered one;
  - a license that holds more seats than its quantity says by how many, and to
    those who can assign, how many to unassign to get back within the quantity.
    It takes no new seat until then.
- **Billing.** The person's own page is `/account/billing`, with a Billing entry in
  the account menu. Its sidebar is Your account with Billing under it, and a way
  back to one of the person's workspaces if they have one; a person in no
  workspace gets the page all the same. It mounts the billing module with the
  person's scope, for personal licenses. Where the person is not offered billing,
  the menu has no Billing entry and the address is "Page not found".

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
  the name and email of their latest sign-in through Core's sign-in server, or by
  Core's copy of their verified email when they have not signed in through it;
  both are null for a deleted account, and the portal shows the id. A page's
  owners are read in one query per collection.
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
| See their own seats | Yes | Yes | Yes | Yes |
| `workspace.licenses.read`: every license and seat | | | Yes | Yes |
| `workspace.licenses.assign`: assign and unassign seats | | | Yes | Yes |
| `workspace.billing.manage`: buy, change or cancel, payment methods, invoices | | | Yes | Yes |

Organization Admins act as Owner in every workspace, and hold
`organization.licenses.read`: every license on their Core, personal ones
included, for support. It allows no seat change and no billing. Operator keys
never carry it.

## Audit and the change feed

Every license and seat change is in Core's audit trail, with its actor (the
`store` service for a license write, the person for a seat change). A workspace
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
