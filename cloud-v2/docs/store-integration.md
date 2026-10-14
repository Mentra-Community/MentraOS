# Store integration: Core's service API

The Mentra Miniapp Store is a separate service with its own database. It asks
Core who someone is and which workspaces they belong to, through a signed
service API at `/api/internal/workspaces/*`. Core never calls the Store and needs
no Store address. Workspaces, roles and keys are described in
[Workspaces and keys](workspaces.md).

The client is `createCoreWorkspaceClient` from
`@mentra/workspace-contract/server`; the request and response types are in
`@mentra/workspace-contract`.

## Signing

Every request carries:

- `x-mentra-service`: `store`;
- `x-mentra-service-timestamp`: Unix milliseconds, digits only, within 60
  seconds of Core's clock;
- `x-mentra-service-signature`: HMAC-SHA256, base64url, over
  `<timestamp>\n<METHOD>\n<path with query>\n<sha256 hex of the body>`.

Core accepts any secret in its list for the service, so a secret rotates by
listing the new one beside the old one. A missing header, a wrong signature, an
unknown service or a stale timestamp all answer
`401 {"error": "service_unauthorized"}`. A malformed `CLOUD_CORE_SERVICE_SECRETS`
answers `503 {"error": "service_auth_misconfigured"}` to every call. No request
or answer names an organization: the Store knows which Core it talks to from the
URL it is configured with, and the shared secret proves both sides.

Core's `CLOUD_CORE_SERVICE_SECRETS` is `{"store": ["<newest>", "<older>"]}`; the
Store holds one value from that list. Keep both in the secret manager. Fleet is the
other service Core knows: it adds a `"fleet"` list, with `x-mentra-service: fleet`
([Fleet integration](fleet-integration.md#following-cores-changes)).

## Routes

| Route | Answers |
| --- | --- |
| `POST /authorize` | `AuthorizeResponse`: may this principal do `capability` in `workspaceId`, for `packageName`? |
| `POST /principal` | `PrincipalResponse`: the principal behind a bearer token and its workspaces, or `401 invalid_token`. |
| `POST /memberships/check` | `{memberships}`: one person's role and capabilities in up to 100 workspaces, `null` where they are not a member. |
| `GET /workspaces/:workspaceId` | `WorkspaceSummary` (name, status, authorization revision), or `404 workspace_not_found`. |
| `GET /changes?after=&limit=` | The change feed: workspace events and `user.deleted` tombstones in commit order, for the Store and Fleet ([Fleet integration](fleet-integration.md#the-change-feed)). |
| `POST /credentials` | `{credentialId, token}`: a workspace key limited to the named packages, minted for the Store on behalf of a staff member (`issuedBy.actorEmail`). The token is returned once. |
| `POST /users/resolve-email` | `{mentraUserId}` of the Mentra account whose confirmed email this is (the Core user is created on first use), or `404 user_not_found`. |
| `PUT /workspaces/:workspaceId/deletion-holds/:service` | `{workspaceId, holds}`: the calling service holds the workspace from deletion, replacing its previous hold ([Deletion holds](#deletion-holds)). |
| `DELETE /workspaces/:workspaceId/deletion-holds/:service` | `{workspaceId, holds}`: the calling service's hold is cleared. |

- **Principals.** A bearer credential is what a person or a key presented to the
  Store: a Core access token from the Core's sign-in server (issued to the
  Developer Console or the CLI, first-party clients in
  `CLOUD_CORE_OIDC_CLIENTS`; see [`signin.md`](signin.md)) or a Core key. Phone
  Core tokens, ID tokens, Supabase tokens and another environment's tokens are
  refused. A `mentra_user` credential is the Store vouching for a
  person it already authenticated; that person is never an Organization Admin
  here.
- **Package scope.** A key limited to some packages is refused
  (`package_out_of_scope`) for any other package, but only when `packageName`
  is sent: without it the capability is granted workspace-wide. Send
  `packageName` on every route that reads or changes one package, and filter
  package lists by the principal's `packageNames`.
- **Denials** never throw: `allowed` is false and `reason` says why
  (`unauthenticated`, `not_a_member`, `capability_missing`,
  `workspace_not_found`, `workspace_deleted`, `package_out_of_scope`,
  `credential_invalid`). A key that does not validate is `credential_invalid`.
- **Outages.** When the identity provider cannot be asked, `/authorize` and
  `/principal` answer `503 {"error": "temporarily_unavailable"}`. Treat it as
  retryable; never as an allow.

Authorization decisions use current state. Display data (workspace names) may
be cached for up to five minutes; a cached answer never authorizes a write.

## Deletion holds

Core does not know which miniapps a workspace owns, so the Store tells it. While
a workspace owns published miniapps, the Store holds it from deletion; Core then
refuses to delete it from anywhere (the workspace portal, the admin portal, the
API), to its owners and to Organization Admins alike, until the Store clears the
hold.

```ts
// Before a publish takes effect: hold for what the workspace will own. If Core refuses, refuse the publish.
await core.setDeletionHold(workspaceId, {reason: "owns_miniapps", count: published + 1})

// After an unpublish, a miniapp delete or a failed publish, from the Store's own records:
if (published > 0) await core.setDeletionHold(workspaceId, {reason: "owns_miniapps", count: published})
else await core.clearDeletionHold(workspaceId)
```

- **Hold first, release last.** Take the hold before a publish takes effect, and
  lower or clear it only after an unpublish or delete has. A workspace deleted
  between a publish and its hold would leave the miniapp published with nobody
  to manage it. So if Core refuses the hold (`410 workspace_deleted`,
  `404 workspace_not_found`), refuse the publish. A publish that fails after
  the hold sets the count back from the Store's records. At worst the workspace
  is held a moment longer than it needs to be, never released early.
- **One writer per workspace.** Each call replaces the Store's hold, so two
  updates of one workspace that race can land in the wrong order: a stale
  count, or a clear after a publish. Serialize hold updates per workspace:
  count and call Core under one per-workspace lock.
- **Reconcile.** At startup, and on a schedule, set every workspace's hold from
  the Store's records: hold the workspaces that own published miniapps, clear
  the rest. This repairs a call that failed. The first run is the backfill for
  workspaces that published before holds existed: until it has run, they are
  not held.

- **The calls.** `PUT /api/internal/workspaces/workspaces/:workspaceId/deletion-holds/store`
  with `{"reason": "owns_miniapps", "count": 3}` sets the hold; `DELETE` on the
  same path, with an empty body, clears it. Both are signed like every other
  call, and `:service` must be the service that signs (`store`); naming another
  service is `403 {"error":"forbidden"}`. The client's `setDeletionHold` and
  `clearDeletionHold` fill it in.
- **The hold.** `reason` is a lowercase code of letters, digits and underscores
  (`owns_miniapps` for the Store); `count` is optional and, when sent, a positive
  whole number. Anything else is `400 invalid_request`. Each service has one hold
  per workspace: setting replaces it.
- **Idempotent.** Setting the hold the Store already has, or clearing one it does
  not have, changes nothing and records nothing, so the Store can set the current
  count after every change, or reconcile every workspace at startup, without
  bookkeeping. Every change is recorded in the workspace's audit log and on the
  change feed (`workspace.deletion_hold_set`, `workspace.deletion_hold_cleared`).
- **Answers.** `200 {workspaceId, holds}`: every hold on the workspace afterwards,
  each `{service, reason, count?}`. An unknown workspace is
  `404 workspace_not_found`. Holding a deleted workspace is
  `410 workspace_deleted`; clearing on one answers `200` with no holds, since a
  workspace with a hold is never deleted.
- **What a delete gets.** `409 {"error": "workspace_has_holds",
  "error_description": "This workspace still owns 3 published miniapps. Delete them in the Developer Console first.",
  "holds": [...]}`. The portals show the same sentence where the delete is, before
  anyone tries (`deletionHolds` on the workspace's detail).
- **Nothing else.** A hold blocks only deleting the workspace. Membership
  changes, keys, invitations and account deletion work as before: deleting an
  account never deletes a workspace, so a held workspace whose last owner deletes
  their account stays, with its hold, for an Organization Admin to recover.

## Signing people in to the Store

The Developer Console and the `mentra` CLI sign in through the Core the Store
belongs to ([`signin.md`](signin.md)):

- **The Console** is that Core's `console` client. The Store's
  `MENTRA_STORE_OIDC_ISSUER` is the Core's `CLOUD_CORE_OIDC_ISSUER`;
  `MENTRA_STORE_OIDC_CLIENT_ID` and `MENTRA_STORE_OIDC_CLIENT_SECRET` are the
  client's ID and secret; `MENTRA_STORE_CONSOLE_URL` is the Console's origin,
  whose `/api/console/auth/callback` is the client's redirect URI. The Store
  keeps the person's tokens on its side, passes the access token to
  `POST /principal` on every request, and ends the Console session when Core
  answers `401 invalid_token`.
- **The CLI** is the Core's `cli` client. The Store answers
  `GET /api/console/auth/cli-config` with `{issuer, clientId}` from
  `MENTRA_STORE_OIDC_ISSUER` and `MENTRA_STORE_CLI_CLIENT_ID`; the CLI then signs
  in on a loopback port and sends its Core access token to the Store as a bearer.
  CI sends a workspace key (`msk_`) instead.

Either way the Store passes what it was given to `/authorize` and `/principal`;
it never validates a person's token itself.

### Private miniapps

A private miniapp reaches the members of the workspace that owns it, the members
of the workspaces its publisher shares it with (present and future members), and
the people invited to it by email; access never installs it. The Store checks membership with `POST /memberships/check` for the Core
user named by the phone's Store miniapp token, whatever sign-in source that person
uses (a Mentra account, an OEM's users, a Private Cloud provider's), but only when
the token comes from this Core: a Store that also serves phones signed in to other
Cores (for its public catalog) never asks this Core about their user ids. Every
download is authorized when it is requested.

## Moving developer organizations from the Store

The Store's developer organizations become Core workspaces with the same IDs, so
package ownership does not change. Two operator scripts in
`packages/core/scripts` move them, run from `cloud-v2`. People then claim their
memberships themselves, with their verified email.

### Importing the organizations

```sh
bun packages/core/scripts/migrate-store-developer-orgs.ts \
  --source <Store database URL> --target <Core database URL> [--apply] [--i-understand-remote]
```

The script only reads the Store database. Without `--apply` it writes nothing:
it compares the Store with Core and prints a JSON report of what an apply would
do on stdout (progress and warnings go to stderr). `--apply` refuses unless
both URLs are `mongodb://` on `127.0.0.1`, `localhost` or `[::1]` without
credentials; `--i-understand-remote` lifts that for the operator. An apply
validates the whole Store first, creates only the collections it writes, and
imports one organization per transaction.

- **Memberships.** Active ones: owner → Owner, admin → Admin, member → Developer,
  the highest role when one person has several. An organization without an
  Owner gets its recorded owner as Owner (`promotedOwners`,
  `synthesizedOwners`), or is reported (`ownerlessOrgs`) for an Organization
  Admin to recover. Each membership waits under the Store's WorkOS user ID until
  its person claims it (below).
- **Invitations.** Pending, unexpired ones, the newest per address: admin →
  Admin, member → Developer. Each stays acceptable as it was in the Store (Core
  records it on the system's authority), and ending the inviter's membership
  revokes it.
- **Keys.** Every key, revoked ones included, with its dates. Imported keys keep
  validating with their existing tokens; Store package keys stay limited to
  their package. Not imported: a key whose creator has no membership
  (`keysWithoutCreator`), and a key whose ID, hash or environment could never
  validate (`malformedKeys`, with `reason` `malformed_id`, `malformed_hash` or
  `malformed_env`). The progress output lists the keys' environment labels:
  each must be in `CLOUD_CORE_CREDENTIAL_ENVIRONMENTS`.

Applying again is safe. A run adds only what is missing, never overwrites a
change made in Core, and writes nothing when there is nothing to add. It carries
forward access the Store has removed since: a revoked key or invitation is
revoked, and a membership nobody has claimed yet is ended with its keys. A
claimed membership is never changed, only reported. A run never leaves a
workspace without an Owner: when ending the Store's removals would leave none, it
keeps those Owner memberships and reports them. Apply once more immediately
before the Store starts deferring to Core.

| Report field | Meaning |
| --- | --- |
| `counts` | Organizations, memberships, invitations and keys imported (rows an earlier run imported count again), and `skippedKeys`: every key not imported, each named once in `malformedKeys`, `keysWithoutCreator` or `pendingCollisions`. |
| `targetCompared` | Whether Core was read. The fields below compare the Store with Core and are empty when it was not. |
| `skippedWorkspaces` | Organizations whose workspace was deleted in Core: nothing is imported or changed, and nothing else in the report counts them. |
| `workspaceProfiles` | Not organizations: once the Store serves from Core it keeps each workspace's publishing profile in the same Store collection, so a later run (a roll-forward) also reads the profiles of workspaces made in Core. A document with no recorded owner and no memberships, invitations or keys, whose workspace exists in Core and was not created by the import, is listed here and nothing else in the report counts it. |
| `revokedCredentials`, `revokedInvitations`, `removedMemberships` | Access the Store removed, carried into Core, each audited as the system. A removed membership the Store replaced with another of the same person (removed and re-added) hands its live keys and pending invitations to the replacement (`movedCredentialIds`). |
| `demotedMemberships` | Unclaimed memberships whose role the Store lowered, and Core had not changed since the import: lowered in Core, audited as the system. |
| `roleDrift` | Memberships whose Store role differs from Core's and that the run leaves alone, with why: `claimed` (the person signed in), `changed_in_core`, or `raised_in_store` (a run only carries reductions). |
| `claimedMembershipDrift` | Claimed memberships the Store removed, left for an admin to act on in Core. |
| `invitationConflicts` | Store invitations not imported because Core already has a pending invitation for that email made in Core; the one in Core is kept. (A newer Store invitation for an email replaces the one an earlier run imported, which then appears in `revokedInvitations`.) |
| `keptLastOwners` | Unclaimed Owner memberships the Store removed or demoted, kept because the workspace would have no other Owner. An Organization Admin decides in Core; a later run ends them once the workspace has another Owner. |
| `pendingCollisions` | Memberships not imported because the person already holds an unclaimed one in that workspace, with the keys bound to them. |
| `duplicateMemberships` | People with several active memberships in one organization; the highest role was kept. |

The report never contains a key hash or an invitation token hash.

### Exporting the verified emails

```sh
WORKOS_API_KEY=<key> bun packages/core/scripts/export-legacy-browser-identities.ts \
  --target <Core database URL> [--apply] [--i-understand-remote]
```

Run it after the import. It collects the WorkOS user IDs that still matter to
Core: those of imported memberships waiting for their person, and enterprise
org owners that are not Core users. It reads each user from WorkOS and records
the email, lowercased, in `legacy_browser_identities` only where WorkOS reports
it verified. `WORKOS_API_KEY` comes from the operator's shell; Core does not use
it. The dry run, the report on stdout and the `--apply` guard work as for the
import. The report counts the users and lists, by WorkOS user ID only, those
skipped as unverified, those WorkOS does not know, and those already claimed.
Running it again writes nothing that has not changed and never touches a
claimed identity. It removes an unclaimed identity whose email WorkOS no longer
reports verified, or whose user WorkOS no longer knows (`removed`), so a stale
address claims nothing. A WorkOS failure stops it before anything is written.

### The claim

A person claims what waits for them with their verified email, at every sign-in
through Core's sign-in server and at the first Core access token a Core process
resolves for them: on Core's API, or when the Store passes it to `POST /principal`
or `POST /authorize`. Core checks a person on that second path at most once per
ten minutes per process, and a failed claim never fails the request.

The claim takes every unclaimed legacy identity with exactly that email, in one
transaction. The memberships waiting under it become the person's: one in a
workspace where they already belong merges into their membership, at the higher
of the two roles, with its keys and pending invitations. Enterprise orgs the
WorkOS user owned move to the person. Each move is audited
(`membership.claimed`, `membership.merged_duplicate`).

- A claimed identity is never claimed by anyone else. Memberships a later import
  adds under it go to the person who claimed it, at their next sign-in.
- An unverified email claims nothing. A Private Cloud provider's email outside
  its verified domains is unverified.
- The Mentra App's token exchange never claims.
- A WorkOS user without a verified email stays unclaimed; a workspace admin
  re-invites that person. Developers who signed in to the Store with GitHub sign
  in with a Mentra account that uses the same verified email.
