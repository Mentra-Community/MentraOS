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
- Every change carries the workspace revision the caller last saw
  (`expectedRevision`); a stale one answers `409 membership_changed`.
- Membership rows are never deleted. Leaving or removal ends the membership and
  keeps it as history, with every role it held; rejoining starts a new one.

**Organization Admins** are the people whose verified email is on
`CLOUD_CORE_ADMIN_EMAILS` or in a domain on `CLOUD_CORE_ADMIN_EMAIL_DOMAINS`.
They hold every organization capability (`organization.workspaces.administer`,
`organization.credentials.manage`, `organization.incidents.read`,
`organization.supportProfiles.read`, `organization.testing.read`,
`organization.testing.manage`) and act as Owner in every workspace, which is how
they recover a workspace whose Owners are gone.

## Creating and joining

- Anyone signed in with a verified email may create a workspace and becomes its
  Owner. A Private Cloud may limit creation to Organization Admins with
  `CLOUD_CORE_WORKSPACE_CREATION=organization-admins`.
- An invitation names an email, a role and an expiry (14 days). Admins invite
  Members and Developers, Owners anyone. Core stores only a hash of the
  invitation token; the link carries the token. The invitee opens the link in
  the workspace portal, signs in with that verified email, and accepts.
  Accepting adds the membership without touching others. A newer invitation to
  the same address replaces the pending one.
- Deleting a workspace ends its memberships and revokes its keys and
  invitations at once, without asking any other service. Miniapps it publishes
  in the Mentra Miniapp Store stay published until a Store operator assigns
  them to another workspace.
- Deleting a Mentra account ends that person's memberships and revokes the keys
  they created.

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
  while its creator remains an Organization Admin, so create shared keys from an
  admin who will stay. Operator keys never administer workspaces or keys.
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
`/members`, `/invitations`, `/invitations/peek`, `/invitations/accept`,
`/credentials`, `/leave`, `/audit`) are for people; a key gets 403. Each checks
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
to write). `/api/admin/me` answers any caller with its capabilities. The Store
calls Core through a signed service API ([Store integration](store-integration.md)).

## Configuration

| Variable | Meaning |
| --- | --- |
| `CLOUD_CORE_ADMIN_EMAILS`, `CLOUD_CORE_ADMIN_EMAIL_DOMAINS` | Organization Admins (verified emails only). |
| `CLOUD_CORE_WORKSPACE_CREATION` | Optional. `open` (default) or `organization-admins`. Any other value stops Core at startup. |
| `CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE` | Optional. The invitation link, an absolute URL containing `{token}`. Default `<CLOUD_CORE_ENTERPRISE_PORTAL_URL origin>/?workspaceInvite={token}`, the workspace portal. With neither set, inviting fails. |
| `CLOUD_CORE_CREDENTIAL_ENVIRONMENTS` | Optional. Comma-separated environment labels keys may carry; the first is the one new keys get. Default: this Core's own label (`CLOUD_CORE_ENVIRONMENT`, else derived from `CONSOLE2_URL`, else `local`), which is the label existing keys carry. |
| `CLOUD_CORE_SERVICE_SECRETS` | Optional. The signed service API's secrets, `{"store": ["<newest>", "<older>"]}`. Unset: every service call is refused. |
| `RESEND_API_KEY`, `EMAIL_SENDER` | Invitation emails. Without them, inviting still works and returns the link to copy. |

Workspace writes use multi-document transactions, so Core's MongoDB must be a
replica set (Atlas, or `docker-compose.test.yml` locally). Core builds the
workspace collections and their unique indexes before it serves.
