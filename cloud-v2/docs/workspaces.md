# Workspaces and keys

Core owns who belongs to which team and what they may do there.

- An **organization** is one Core deployment and its database. It has no
  identifier: services reach it at its URL.
- A **workspace** is a team inside the organization. Core stores its id
  (`ws_…`), name, memberships, invitations, keys and audit trail.
- A person is a Core user (`mentraUserId`), the same one the Mentra App has. A
  person can belong to any number of workspaces, with an independent role in
  each.

## Roles and capabilities

Roles are cumulative: each holds everything the one before it holds.

| Capability | Member | Developer | Admin | Owner |
| --- | --- | --- | --- | --- |
| `workspace.read`, `miniapps.access` | Yes | Yes | Yes | Yes |
| `miniapps.publish`, `miniapps.credentials.create` | | Yes | Yes | Yes |
| `workspace.members.read`, `workspace.members.manage`, `workspace.settings.manage`, `workspace.audit.read`, `workspace.credentials.revoke`, `fleet.read`, `fleet.devices.manage`, `miniapps.assign`, `workspace.licenses.read`, `workspace.licenses.assign`, `workspace.billing.manage` | | | Yes | Yes |
| `workspace.roles.managePrivileged`, `workspace.delete` | | | | Yes |

- Admins invite, remove and change Members and Developers. Only Owners grant,
  demote or remove Admins and Owners, on either side of the change.
- A workspace keeps at least one Owner: the last Owner cannot leave, be demoted
  or be removed. Concurrent changes are serialized in a transaction on the
  workspace, so two Owners demoting each other at once leave one Owner.
- Renaming, changing a role and removing a member carry the workspace revision
  the caller last saw (`expectedRevision`); a stale one answers
  `409 membership_changed`.
- Membership rows are never deleted. Leaving or removal ends the membership and
  keeps it as history, with every role it held; rejoining starts a new one.
- The member list (`GET /:workspaceId/members`, the same on the workspace and
  admin portals' routes) names each member. `name` is the last one a sign-in
  through Core's provider carried, trimmed, read for the whole list in one
  query; a sign-in that carries no name keeps the one Core has. It is `null`
  when no sign-in has carried a name, when the person has not signed in through
  the provider, and for a pending imported membership; the `email` stays the
  one the membership was made for.
- Every member sees the licenses they hold; Admins and Owners see every product and
  assign its licenses ([Licenses and seats](licenses.md)). Ending a membership frees
  its licenses, and deleting a workspace ends its products.

**Organization Admins** are the people whose verified email is on
`CLOUD_CORE_ADMIN_EMAILS` or in a domain on `CLOUD_CORE_ADMIN_EMAIL_DOMAINS`.
They hold every organization capability (`organization.workspaces.administer`,
`organization.credentials.manage`, `organization.incidents.read`,
`organization.supportProfiles.read`, `organization.testing.read`,
`organization.testing.manage`, `organization.fleet.administer`,
`organization.licenses.read`) and act as Owner in every workspace, which is how
they recover a workspace whose Owners are gone. Recovery names an existing
account; a deleted account is refused (`404 user_not_found`).

## The workspace portal

The workspace portal (`websites/portal`) is centred on the current workspace. A switcher at
the top of the sidebar shows it and your role (your membership's; "Member · Organization
Admin" when an Organization Admin's powers go beyond it), and lists your other workspaces,
**Create workspace** and your pending invitations with **Accept** and **Dismiss**. Every
page carries its workspace:
`/w/<workspaceId>/members` (members, with pending invitations under them),
`/w/<workspaceId>/settings`, `/w/<workspaceId>/audit` and `/w/<workspaceId>/licenses`
([Licenses and seats](licenses.md#in-the-workspace-portal)); the sidebar offers only what your
role opens. Above your account, the sidebar links to the environment's Developer Console in a
new tab; a Private Cloud, which has no Developer Console, shows no link. `/` opens your
last-used workspace (remembered in the browser, never an authority), else your first, else the
first run: your pending invitations if you have any
you can accept, otherwise **Create your workspace**. An invitation link lands on
`/invitation`, which reads the token from the tab's session storage. A link Core reports
as no longer valid is shown as such once and then forgotten. Pending invitations are the
link's and those addressed to your verified email, each shown once; **Dismiss** hides one
in this browser only (Core does not record a refusal, and its link keeps working). Company sign-in
(enterprise orgs and trusted issuers) is not in the navigation; its pages stay reachable
at `/enterprise` until it returns as workspace settings.

**Members** lists each member by name over email (the email alone where Core has no
name), with a "You" mark on your own row, "Pending first sign-in" on an imported
membership, their role, the licenses they hold and when they joined (the date is left
out on a phone). A row opens the member panel.

- **Licenses.** Where billing's catalog can be read, and you hold
  `workspace.licenses.read` in a workspace with a product that has not ended, the list
  has a Licenses column: a chip per product the member holds a license for (three chips
  and "+n" past four), "None", or "After first sign-in" for a pending membership. With
  `workspace.licenses.assign`, each member who has signed in also has a checkbox, and
  selecting some shows "2 selected · Assign licenses", which assigns them licenses for
  any of the workspace's products in one step ([Seats](licenses.md#seats)). Without the
  catalog, and on a Private Cloud, the list has no column and no selection.
- **The member panel** is a side panel for one member: their role and when they joined,
  Change role, Remove from workspace (it asks first), and a Licenses section with a
  switch for each product the workspace holds
  ([the portal's Licenses](licenses.md#in-the-workspace-portal)). The address carries
  which member is open, `?member=<membershipId>`, so a link opens the panel, Back closes
  it, and an id that names no member opens nothing. Change role offers the roles you
  may move that member between, and Remove appears where you may remove them; neither is
  offered on your own row (you leave in Settings, and another Owner or an Organization
  Admin changes your role). Both carry the revision you last saw
  (`409 membership_changed`).
- **The admin portal** has the same list and panel, so role changes and Remove are
  there too, with each member's Mentra user id and a Copy id button for recovering a
  workspace's ownership. It has no Licenses column, no selection and no Licenses
  section, and its panel is not in the address.

## Creating and joining

- Anyone signed in with a verified email may create a workspace and becomes its
  Owner. A Private Cloud may limit creation to Organization Admins with
  `CLOUD_CORE_WORKSPACE_CREATION=organization-admins`.
- An invitation names an email, a role and an expiry (14 days). Admins invite
  Members and Developers, Owners anyone. Core stores only a hash of the
  invitation token; the link carries the token. The email names the inviter.
  The invitee opens the link in the workspace portal, signs in with that
  verified email, and accepts. Signed in with that verified email, they also see
  the invitation without the link (`GET /invitations/mine`) and can accept it by
  its id, with the same checks.
  Accepting adds the membership without touching others. A newer invitation to
  the same address replaces the pending one.
- An invitation is only as good as its inviter, and records the authority it
  was sent with. Sent on a membership whose role grants it, it is revoked when
  that membership ends and refused at acceptance once the role no longer grants
  the invited role. Sent by an Organization Admin on the organization's
  authority, it is refused while the inviter's email is off the admin allowlist,
  and revoked when their account is deleted. A person may send 100 invitations
  an hour, and a workspace hold 200 pending ones; replacing the pending
  invitation to an address does not count against that.
- Memberships imported from the Mentra Miniapp Store's developer organizations
  ([Store integration](store-integration.md#moving-developer-organizations-from-the-store))
  wait for their person's first sign-in with a matching verified email. Until
  then the member list shows them as pending (`pending: true`, `mentraUserId`
  and `name` null), and the portals mark them "Pending first sign-in". They
  hold their role meanwhile: a pending Owner counts toward the last Owner while
  a verified email can still claim it (its legacy identity exists), Admins
  change or remove them like any other member, and the keys they created
  validate.
- Deleting a workspace ends its memberships and revokes its keys and
  invitations at once. It is refused (`409 workspace_has_holds`) while a
  service holds the workspace, whoever asks, Organization Admins included: the
  Mentra Miniapp Store holds a workspace while it owns any miniapp that is not
  deleted, a draft included, and the portals say so where the delete is ("This
  workspace still owns 3 miniapps. Delete them in the Developer Console
  first."). Once the miniapps are deleted, the Store clears its hold and the
  workspace can be deleted ([Store
  integration](store-integration.md#deletion-holds)).
- Deleting a Mentra account first marks it deleted, which makes it no
  principal at all (see `signin.md`), so it can neither create nor join a
  workspace, and its owner memberships never count toward the last Owner. It
  then ends that person's memberships and revokes the keys (both kinds) and
  pending invitations they created. It then clears their
  identity from the rows that stay as history: the email on their membership
  rows, the creator's email and user id on their keys, their address on keys a
  service issued at their request, and the inviter's email and user id on their
  invitations. Membership rows keep the opaque user id their history is keyed
  by, and audit events keep what they recorded. The last write of the transaction
  that ends the memberships is a `user.deleted` event, on the change feed services
  read ([Fleet integration](fleet-integration.md#account-deletion)).

## Keys

Both kinds are shown once, at creation, and Core keeps only the SHA-256 of the
secret. A token is `<prefix>_<env>_<id>.<secret>`; Core accepts only the
environment labels it is configured for.

- **Workspace keys** (`msk_…`) belong to one workspace and its creator's
  membership. A key does what its scopes allow, narrowed to what its creator's
  role allows now: demoting the creator narrows it, and their leaving or removal
  revokes it. A key may be limited to some packages. Developers manage their own
  keys; Admins and Owners can revoke any. Workspace keys hold no organization
  capability and never administer people, keys or workspaces.
- **Operator keys** (`mak_…`) are for tools that read organization data, such as
  `scripts/fetch-incident-logs.sh`. An Organization Admin creates one in the
  admin portal's **Operator keys** page with some of
  `organization.incidents.read`, `organization.supportProfiles.read`,
  `organization.testing.read` and `organization.testing.manage`. It works only
  while its creator's email stays on the Organization Admin allowlist, so create
  shared keys from an admin who will stay. A key whose creator is admitted by
  `CLOUD_CORE_ADMIN_EMAIL_DOMAINS` keeps working while the domain is listed:
  revoke it when that person leaves. Operator keys never administer workspaces
  or keys.
- **Admin keys made before operator keys** (`msk_…` with their address,
  `api-key@<keyId>.local`, on `CLOUD_CORE_ADMIN_EMAILS`) become operator keys
  at Core's startup, with every operator scope, and keep their tokens. They work
  while that address stays on the allowlist.

## APIs

The same handlers serve each portal under its own route group, so each portal's
session authenticates only its own routes:

| Route group | Who | Authenticates with |
| --- | --- | --- |
| `/api/portal/workspaces/*` | The workspace portal | Its session, or a bearer |
| `/api/portal/billing/*` | The workspace portal | Its session, or a bearer; forwarded to the billing module ([Portal modules](portal-modules.md)) |
| `/api/admin/workspaces/*`, `/api/admin/organization/*` | The admin portal | Its session, or a bearer |
| `/api/workspaces/*`, `/api/organization/*` | Servers and tools | Identity-provider access tokens and Core keys |

Workspace routes (`GET`/`POST /`, `GET`/`PATCH`/`DELETE /:workspaceId`,
`/members`, `/invitations`, `/invitations/mine`, `/invitations/peek`, `/invitations/accept`
(by `token` or `invitationId`), `/credentials`, `/leave`, `/audit`, and `/licenses` with
its seats and `/seat-assignments`, [Licenses and seats](licenses.md#seats)) are for people;
a key gets 403. A workspace's detail says whether the caller is an Organization Admin
(`organizationAdmin`). Audit events name their subject: `target.email` for memberships and
invitations, `target.name` for keys. Each checks
the caller's capability in that workspace. A workspace's detail lists what holds it
from deletion (`deletionHolds`), and `DELETE /:workspaceId` answers
`409 workspace_has_holds` with those holds while there are any. `GET /api/organization` tells any
caller, a key included, its organization capabilities and whether it may create
a workspace. `/api/organization/workspaces` lists every workspace and
`/api/organization/workspaces/:workspaceId/owners` makes a person (by Core user
id, or on hosted Core by confirmed email) an Owner; `/api/organization/credentials`
manages operator keys. Those need the matching organization capability and a
person.

`/api/admin/*` checks a capability per area: incidents
(`organization.incidents.read`), support profiles
(`organization.supportProfiles.read`), test runs, the routine catalog and
system health (`organization.testing.read`, and `organization.testing.manage`
to write). `/api/admin/me` answers any caller with its capabilities and whether
Fleet is installed on this Core (`fleet.installed`). `/api/admin/fleet/*` forwards
to the optional Fleet service for a person holding `organization.fleet.administer`
(an Organization Admin); keys get 403 ([Fleet integration](fleet-integration.md)).
The Store calls Core through a signed service API ([Store integration](store-integration.md)),
and its billing module writes licenses through it ([Licenses and seats](licenses.md)).
`/api/portal/billing/*` forwards the workspace portal's billing requests
to that module for a signed-in person, with the workspace or the person's own
account as the scope Core decides ([Portal modules](portal-modules.md)).
`/api/portal/me` says whether to offer it (`modules.billing`) and whether its catalog
can be read (`modules.billingCatalog`), which names the licenses on the Members list for
everyone who may see them.

## Configuration

| Variable | Meaning |
| --- | --- |
| `CLOUD_CORE_ADMIN_EMAILS`, `CLOUD_CORE_ADMIN_EMAIL_DOMAINS` | Organization Admins (verified emails only). |
| `CLOUD_CORE_WORKSPACE_CREATION` | Optional. `open` (default) or `organization-admins`. Any other value stops Core at startup. |
| `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE` | Optional. The invitation link, an absolute URL containing `{token}`. Default `<CLOUD_CORE_ENTERPRISE_PORTAL_URL origin>/?workspaceInvite={token}`, the workspace portal. With neither set, inviting answers `503 invitations_unavailable`. |
| `CLOUD_CORE_CREDENTIAL_ENVIRONMENTS` | Optional. Comma-separated environment labels keys may carry; the first is the one new keys get. Default: this Core's own label (`CLOUD_CORE_ENVIRONMENT`, else derived from `CONSOLE2_URL`, else `local`), which is the label existing keys carry. |
| `CLOUD_CORE_SERVICE_SECRETS` | Optional. The signed service API's secrets by service (`store`, `fleet`), `{"store": ["<newest>", "<older>"], "fleet": ["<newest>"]}`. Unset: every service call is refused. |
| `CLOUD_CORE_FLEET_URL`, `CLOUD_CORE_FLEET_SECRET`, `CLOUD_CORE_ENABLED_FEATURES` | Optional. The Fleet service Core forwards to, its shared secret, and (on a Private Cloud) the features the deployment has bought, which must list `fleet.managed` (case-sensitive). Unset: Fleet is not installed. See [Fleet integration](fleet-integration.md). |
| `CLOUD_CORE_BILLING_URL`, `CLOUD_CORE_BILLING_SECRET` | Optional, hosted Core only. The billing module Core forwards to, and its shared secret. Unset: billing is not installed. Outside `CLOUD_CORE_ENVIRONMENT=prod` its pages are visible to Organization Admins only, and its catalog stays readable by members. See [Portal modules](portal-modules.md). |
| `RESEND_API_KEY`, `EMAIL_SENDER` | Invitation emails. Without them, inviting still works and returns the link to copy. |

Workspace writes use multi-document transactions across collections, so they
need a MongoDB replica set (Atlas, or `docker-compose.test.yml` locally). Azure
Cosmos DB for MongoDB (RU) and a standalone `mongod` cannot run them: there,
workspace writes fail, while sign-in, incidents and operator keys keep working
(an operator key is one document, written without a transaction). Core builds
the workspace collections and their unique indexes before it serves; a database
that refuses one is logged and does not stop Core.
