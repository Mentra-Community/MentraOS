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
| `workspace.members.read`, `workspace.members.manage`, `workspace.settings.manage`, `workspace.audit.read`, `workspace.credentials.revoke`, `fleet.read`, `fleet.devices.manage`, `miniapps.assign` | | | Yes | Yes |
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

**Organization Admins** are the people whose verified email is on
`CLOUD_CORE_ADMIN_EMAILS` or in a domain on `CLOUD_CORE_ADMIN_EMAIL_DOMAINS`.
They hold every organization capability (`organization.workspaces.administer`,
`organization.credentials.manage`, `organization.incidents.read`,
`organization.supportProfiles.read`, `organization.testing.read`,
`organization.testing.manage`, `organization.fleet.administer`) and act as Owner
in every workspace, which is how they recover a workspace whose Owners are gone.
Recovery names an existing account; a deleted account is refused
(`404 user_not_found`).

## The workspace portal

The workspace portal (`websites/portal`) is centred on the current workspace. A switcher at
the top of the sidebar shows it and your role (your membership's; "Member · Organization
Admin" when an Organization Admin's powers go beyond it), and lists your other workspaces,
**Create workspace** and your pending invitations with **Accept** and **Dismiss**. Every
page carries its workspace:
`/w/<workspaceId>/members` (members, with pending invitations under them),
`/w/<workspaceId>/settings` and `/w/<workspaceId>/audit`; the sidebar offers only what your
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
  null), and the portals mark them "Pending first sign-in". They hold their role
  meanwhile: a pending Owner counts toward the last Owner while a verified email
  can still claim it (its legacy identity exists), Admins change or remove them
  like any other member, and the keys they created validate.
- Deleting a workspace ends its memberships and revokes its keys and
  invitations at once, without asking any other service. Miniapps it publishes
  in the Mentra Miniapp Store stay published until a Store operator assigns
  them to another workspace.
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
| `/api/admin/workspaces/*`, `/api/admin/organization/*` | The admin portal | Its session, or a bearer |
| `/api/workspaces/*`, `/api/organization/*` | Servers and tools | Identity-provider access tokens and Core keys |

Workspace routes (`GET`/`POST /`, `GET`/`PATCH`/`DELETE /:workspaceId`,
`/members`, `/invitations`, `/invitations/mine`, `/invitations/peek`, `/invitations/accept`
(by `token` or `invitationId`), `/credentials`, `/leave`, `/audit`) are for people; a key
gets 403. A workspace's detail says whether the caller is an Organization Admin
(`organizationAdmin`). Audit events name their subject: `target.email` for memberships and
invitations, `target.name` for keys. Each checks
the caller's capability in that workspace. `GET /api/organization` tells any
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
The Store calls Core through a signed service API ([Store integration](store-integration.md)).

## Configuration

| Variable | Meaning |
| --- | --- |
| `CLOUD_CORE_ADMIN_EMAILS`, `CLOUD_CORE_ADMIN_EMAIL_DOMAINS` | Organization Admins (verified emails only). |
| `CLOUD_CORE_WORKSPACE_CREATION` | Optional. `open` (default) or `organization-admins`. Any other value stops Core at startup. |
| `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE` | Optional. The invitation link, an absolute URL containing `{token}`. Default `<CLOUD_CORE_ENTERPRISE_PORTAL_URL origin>/?workspaceInvite={token}`, the workspace portal. With neither set, inviting answers `503 invitations_unavailable`. |
| `CLOUD_CORE_CREDENTIAL_ENVIRONMENTS` | Optional. Comma-separated environment labels keys may carry; the first is the one new keys get. Default: this Core's own label (`CLOUD_CORE_ENVIRONMENT`, else derived from `CONSOLE2_URL`, else `local`), which is the label existing keys carry. |
| `CLOUD_CORE_SERVICE_SECRETS` | Optional. The signed service API's secrets by service (`store`, `fleet`), `{"store": ["<newest>", "<older>"], "fleet": ["<newest>"]}`. Unset: every service call is refused. |
| `CLOUD_CORE_FLEET_URL`, `CLOUD_CORE_FLEET_SECRET`, `CLOUD_CORE_ENABLED_FEATURES` | Optional. The Fleet service Core forwards to, its shared secret, and (on a Private Cloud) the features the deployment has bought, which must list `fleet.managed` (case-sensitive). Unset: Fleet is not installed. See [Fleet integration](fleet-integration.md). |
| `RESEND_API_KEY`, `EMAIL_SENDER` | Invitation emails. Without them, inviting still works and returns the link to copy. |

Workspace writes use multi-document transactions across collections, so they
need a MongoDB replica set (Atlas, or `docker-compose.test.yml` locally). Azure
Cosmos DB for MongoDB (RU) and a standalone `mongod` cannot run them: there,
workspace writes fail, while sign-in, incidents and operator keys keep working
(an operator key is one document, written without a transaction). Core builds
the workspace collections and their unique indexes before it serves; a database
that refuses one is logged and does not stop Core.
