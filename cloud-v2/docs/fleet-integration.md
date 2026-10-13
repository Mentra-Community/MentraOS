# Fleet integration

Fleet is an optional, separately deployed service (MFM) that collects usage from
the Mentra App and shows an organization its devices and activity. Core stores
none of its data. It authenticates the caller, decides who the caller is and what
the request covers, forwards the request to Fleet with a signed statement of
that, and relays Fleet's answer. Fleet follows Core's change feed to learn when
Core deletes an account. This page is the contract between the two; the
behavior is implemented and tested in
`packages/core/src/api/fleet/fleet-forwarding.ts`, with the configuration in
`packages/core/src/services/fleet/fleet-config.ts` and the signing in
`packages/workspace-contract`.

Nothing here changes a deployment that has no Fleet: the forwarding routes answer
`404 {"error":"fleet_not_installed"}`.

## Configuration

Set on Core. Values are read on every request, so a change takes effect at once.
See [private deployment](../deploy/private-deployment.md#core-configuration) for
every Core variable.

- `CLOUD_CORE_FLEET_URL`: Fleet's base URL with an optional path prefix. Unset or
  blank means Fleet is not installed. `https` is accepted everywhere. Plain `http`
  is accepted on a local or test Core for any host. A deployed Core
  (`NODE_ENV=production`, or `CLOUD_CORE_ENVIRONMENT` set to `dev`, `staging`,
  `prod` or `production`) accepts it only for `localhost` and `127.0.0.1`. No
  credentials, query or fragment.
- `CLOUD_CORE_FLEET_SECRET`: the shared secret that signs everything Core sends.
  Required when the URL is set. A secret without a URL does nothing.
- `CLOUD_CORE_ENABLED_FEATURES`: how a Private Cloud switches first-party
  features on, as comma-separated `feature[:package+package]` entries. Fleet
  reads only the feature names. Blank or unset, as on the hosted Core, leaves the
  installation to the URL and the secret. Set, it must list `fleet.managed` for
  Fleet to be installed; a Core that lists other features and not `fleet.managed`
  has no Fleet, whatever its Fleet URL says. Feature names are case-sensitive
  (`Fleet.Managed` is not `fleet.managed`), and a value of nothing but separators
  lists no feature.
- `CLOUD_CORE_FLEET_MAX_BODY_BYTES`: the largest request body Core forwards.
  Default `1048576` (1 MiB).
- `CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES`: the largest response body Core buffers
  from Fleet. A larger one is a `503 {"error":"fleet_unavailable"}`. Default
  `10485760` (10 MiB).
- `CLOUD_CORE_FLEET_TIMEOUT_MS`: how long Fleet has to answer, body included.
  Default `10000`. A value above `2147483647`, the longest a timer holds, is
  treated as `2147483647`.
- `CLOUD_CORE_SERVICE_SECRETS`: its `fleet` list holds the secrets Fleet signs
  its calls to Core with (below), for example
  `{"store": ["<newest>", "<older>"], "fleet": ["<newest>", "<older>"]}`. Without
  a `fleet` list, Core refuses every call from Fleet.

A limit that is not a positive integer falls back to its default.

The two secrets cover the two directions. Core signs what it forwards to Fleet
with `CLOUD_CORE_FLEET_SECRET`; Fleet signs its calls to Core with a secret from
the `fleet` list. They may hold the same value.

## Is Fleet installed?

Fleet is installed when the URL and the secret are both usable and the feature
setting above allows it. Core has no capabilities endpoint:

- A phone learns it from Core's answer to a report to
  `POST /api/client/fleet/report`: `404 {"error":"fleet_not_installed"}` means
  Fleet is not installed, and the phone stops collecting and asks again at its
  next sign-in or start; `503 {"error":"fleet_unavailable"}` means Fleet is
  installed but cannot answer now, and the phone keeps its records and retries.
- The admin portal reads `fleet.installed` from `GET /api/admin/me`, so it offers
  Fleet only where it exists. `installed` is true for an install whose URL or
  secret is unusable too, so the portal can say Fleet is unavailable instead of
  hiding a broken install. It says nothing about what a caller may do in Fleet.

## Forwarding paths

| Core path                  | Forwarded to                               | Caller                                           |
| -------------------------- | ------------------------------------------ | ------------------------------------------------ |
| `/api/client/fleet/<rest>` | `${CLOUD_CORE_FLEET_URL}/v1/client/<rest>` | A signed-in phone                                |
| `/api/admin/fleet/<rest>`  | `${CLOUD_CORE_FLEET_URL}/v1/admin/<rest>`  | An Organization Admin (`organization.fleet.administer`) |

The method, query string and body are forwarded. Fleet's URL may carry a path
prefix; Core joins it to `/v1/...` the same way with or without a trailing slash
(`https://mfm.example`, `https://mfm.example/fleet` and `https://mfm.example/fleet/`
give `/v1/...`, `/fleet/v1/...` and `/fleet/v1/...`). The path and query Core signs
are exactly the ones it sends.

Only people reach Fleet. Core decides who may call, in this order:

1. **Authenticate.** A phone presents its access token. An admin portal session
   cookie, a token issued for a portal, a workspace key or an operator key is not
   one: `401`. The admin surface takes a signed-in person (a portal session or a
   Core access token): none is `401`, a workspace key or an operator key is
   `403 {"error":"forbidden"}`, and a person without
   `organization.fleet.administer` (anyone who is not an Organization Admin) is
   `403`. A cookie-authenticated write must come from the admin portal's origin,
   like every other admin write.
2. **Installed?** `404 {"error":"fleet_not_installed"}` if not, `503
   {"error":"fleet_unavailable"}` if the URL or secret is unusable. An
   unauthenticated request never learns whether Fleet is installed.
3. **Path and body** (below), then forward.

Fleet can rely on two rules:

- `/v1/client` only ever receives **phone** principals.
- `/v1/admin` only ever receives **user** principals.

The surface fixes the principal kind. Nothing in the request chooses it, and
nothing in the request's query, body or headers can change the scope Core
signs.

### Paths and bodies

- Core rejects a path with a `.` or `..` segment, an encoded or literal path
  separator (`%2f`, `%5c`, `\`), a control character or a bad escape, with
  `400 {"error":"invalid_path"}`. Each segment is checked after **one** round of
  decoding, and the path is forwarded exactly as received. A segment that still
  contains `%2e`, `%2f` or `%5c` (any case) after that decoding, such as a
  double-encoded `%252e`, is refused the same way, so a Fleet that decodes a
  second time is never handed a dot segment or a separator. Fleet should still
  decode a path at most once.
- Bodies are treated as UTF-8 text (the Fleet API is JSON). Core signs the text
  and sends the same bytes. A body that is not valid UTF-8 is
  `400 {"error":"invalid_body"}`; one over the limit is
  `413 {"error":"payload_too_large"}`.
- Core copies only the `content-type` and `accept` request headers. Everything
  else the caller sent, including every `x-mentra-*` header, `authorization` and
  `cookie`, is dropped.
- Fleet's response passes through (status and body) with only its
  `content-type`, `cache-control`, `retry-after` and `x-request-id` headers. A
  `429` with `Retry-After` reaches the caller with it. Redirects are never
  followed.
- A `204`, `205` or `304` from Fleet, and any answer to a `HEAD` request, has no
  body. Core does not read one (a `HEAD` answer's `content-length` is not held
  against the response limit) and adds no `content-type` Fleet did not send.
- Per-record results must ride in a `2xx` or `4xx` body: a `5xx` is turned into
  `503 fleet_unavailable` and its body is dropped. Fleet's `Retry-After` on that
  `5xx`, when it is a whole number of seconds, is repeated on Core's `503`, so
  send one when Fleet is down or shutting down.

### Correlation

Core sends Fleet its own request id as `x-request-id`: the caller's
`x-request-id` when it sent one of up to 64 characters, a fresh ULID otherwise.
Use it as Fleet's request id. Core answers with Fleet's `x-request-id` when Fleet
returns one, and its own otherwise.

Core logs every request that reaches Fleet once, with its request id, Fleet's
request id, the status Core answered, Fleet's status and the time taken. A
success is logged at debug, an answer Fleet gives that is not a success (a `403`,
a `429`, a `404`) at info, and what Core could not relay as Fleet said it (a
network error, a timeout, a `5xx`, a redirect, an oversized body, a `401`) at
warn. So a secret that does not match Fleet's, which Fleet refuses with `403`,
shows in the log at the production level. Core never logs a body, a header, a
query, an email or a secret.

## What Fleet receives

With `<ts>` the request time in milliseconds, Core adds:

- `x-mentra-service`: `core`.
- `x-mentra-service-timestamp`: `<ts>`.
- `x-mentra-service-signature`: HMAC-SHA256, base64url, over
  `<ts>\n<METHOD>\n<path with query as sent, prefix included>\n<sha256 hex of the body>`.
- `x-mentra-principal`: the caller, as base64url JSON (shapes below).
- `x-mentra-principal-signature`: HMAC-SHA256, base64url, keyed with the same
  secret, over `<ts>\n<x-mentra-principal value>`.
- `x-request-id`: Core's request id (above).

No header names the organization: Fleet knows which Core is calling from the
secret it shares with that Core. The service signature does **not** cover the
principal header. Without the principal signature, anyone who captured one
signed request could replay it with another identity inside the skew window.
**Fleet must verify both signatures before it trusts the principal**, using the
same `<ts>` and secret for both. The two signed strings cannot be mistaken for
each other: the service one contains three newlines and this one a single
newline, and neither a header value nor a path can contain a newline.

Use `verifyForwardedPrincipal` from `@mentra/workspace-contract/server` rather
than checking the signatures by hand. It checks `x-mentra-service: core`, the
service signature (method, path with query, body, 60 seconds of clock skew) and
the principal signature with the same timestamp and secret, then returns the
typed `ForwardedPrincipal`, or null. It takes a list of secrets, newest first,
so a secret can be rotated. The header names are `SERVICE_HEADERS` and
`FORWARDED_PRINCIPAL_HEADERS`, and Core signs with the same package
(`signForwardedPrincipal`), so the two sides cannot drift.

```ts
import {verifyForwardedPrincipal, type ForwardedPrincipal} from "@mentra/workspace-contract/server"

// `pathWithQuery` and `body` exactly as received; `headers` a Headers or Node's IncomingHttpHeaders.
const principal: ForwardedPrincipal | null = verifyForwardedPrincipal(
  {method: request.method, pathWithQuery, body: rawBodyText, headers: request.headers},
  secrets, // CLOUD_CORE_FLEET_SECRET values Fleet accepts, newest first
)
if (!principal) return new Response(JSON.stringify({error: "forbidden"}), {status: 403})
// Then check the kind against the surface: /v1/client takes phones, /v1/admin users.
```

### Principal shapes

`ForwardedPrincipal` in `@mentra/workspace-contract`:

```jsonc
// /v1/client: a signed-in phone
{"kind": "phone", "mentraUserId": "...", "tenantId": "...", "sessionId": "...", "email": "..." /* or null */}

// /v1/admin: a signed-in person
{"kind": "user", "mentraUserId": "...", "email": "..." /* or null */, "emailVerified": true,
 "isOrganizationAdmin": true,
 "organizationCapabilities": ["organization.fleet.administer", "..."],
 "scope": {"kind": "organization"}}
```

- A phone's `email` is the account's **verified** email, or null when the
  account has none or it is unverified. It is a display attribute: never use an
  email as an identity key, key records by `mentraUserId`. Core remembers the
  answer for a few minutes, so a change reaches Fleet a little late.
- A user's `isOrganizationAdmin` is computed from a verified identity email, so
  Fleet may rely on it. Its `email` may be unverified (`emailVerified` says
  whether the identity provider verified it); even a verified email is not an
  authorization.
- `organizationCapabilities` is what Core decided this person may do to the
  organization, and `scope` is what this request covers. Core sends
  `{"kind": "organization"}` on the admin surface and the person must hold
  `organization.fleet.administer` for the request to be forwarded at all. The
  contract also defines `{"kind": "workspace", "workspaceId": "..."}`, which a
  receiver must be ready to read.
- Core decided both within the signature's 60-second window, so Fleet acts on
  them as signed and does not ask Core again.

### Compatibility

Core and Fleet deploy separately, in either order. A receiver that reads the
principal with `parseForwardedPrincipal` (which `verifyForwardedPrincipal` uses)
ignores any field it does not know and drops any organization capability it does
not know. The consequence for Core is one rule: **a future restriction on what a
caller may do must change the value of a field that exists, never add a field.**
A field an older Fleet does not know would be ignored, and the restriction with
it.

## Following Core's changes

Fleet keeps data keyed by the people who use it, so it learns from Core when a
person is gone. It calls Core's internal workspace API at
`/api/internal/workspaces/*`, signing each request as service `fleet` with a
secret from the `fleet` list in `CLOUD_CORE_SERVICE_SECRETS`. The signature, the
60-second clock skew and the refusals (`401 service_unauthorized`) are the
Store's, described in [Store integration](store-integration.md#signing), with
`x-mentra-service: fleet`. `createCoreWorkspaceClient` in
`@mentra/workspace-contract/server` speaks the API, refuses an answer that does
not have the documented shape, and reads the feed with `listChanges`:

```ts
import {createCoreWorkspaceClient} from "@mentra/workspace-contract/server"

const core = createCoreWorkspaceClient({baseUrl: CORE_URL, service: "fleet", secret: FLEET_SERVICE_SECRET})
const {events, next} = await core.listChanges({after: cursor, limit: 500}) // cursor: string | null
```

The feed (`GET /changes`) answers the `store` and `fleet` services. The routes
that answer any service ([Store integration](store-integration.md#routes)) answer
Fleet too. `POST /credentials` and `POST /users/resolve-email` are the Store's
and answer Fleet `403 {"error":"forbidden"}`.

### The change feed

`GET /changes?after=&limit=` lists workspace changes in commit order, so a service
that was offline can catch up:

- **Paging.** `after` is the `seq` of the last event processed, as a decimal
  string (omit it to start from the beginning); anything else is
  `400 invalid_request`. `limit` defaults to 100 and is clamped to 1 to 500; a
  value that is not an integer is `400 invalid_request`. `next` is the cursor for
  the following page, or null when the page was not full. A full page may be the
  last: the next call returns no events. Store your cursor only after processing
  an event.
- **Order and gaps.** `seq` is assigned in commit order from one counter, inside
  the transaction that records the event, and a rolled-back transaction gives its
  number back. A later read therefore never shows an event with a lower `seq` than
  one already seen. The feed leaves organization-level events (operator keys) out,
  so consecutive feed events can skip numbers. A skipped number is never a missed
  workspace event. On a database that cannot run transactions, the one event Core
  can still record, the `user.deleted` tombstone of a person in no workspace, is
  written without one: its `seq` is still unique and increasing, and only two such
  tombstones written within milliseconds of each other could be seen out of order.
- **Retention.** Nothing is ever pruned. The feed begins with the first event
  Core recorded for it: events recorded before Core had a feed carry no `seq` and
  are not on it, so it cannot rebuild earlier history. A service that needs the
  current state asks `GET /workspaces/:workspaceId` and `POST /memberships/check`.
- **Contents.** Each event is `{eventId, seq, workspaceId, action, occurredAt,
  target, before, after}`. `target`, `before` and `after` are snapshots with
  every credential-looking key (`token`, `secret`, `hash`, `password`) removed at
  any depth; each is null when the change has none. The actor and request id are
  not on the feed. Treat unknown actions as no-ops. Membership and invitation
  events name the member's or invitee's email in `target`: it is a display
  attribute, never an identity key. Key records by `mentraUserId`.
- **Scope.** Workspace-scoped events (a `workspaceId`) and user-level tombstones
  (`workspaceId` null) only. Fleet sees every workspace's events and filters to
  the workspaces it serves.

### Event catalog

| `action` | `target` | `before` | `after` |
| --- | --- | --- | --- |
| `workspace.created` | `{workspaceId, membershipId}` | null | `{name, role: "owner"}` (the creator's membership) |
| `workspace.renamed` | `{workspaceId}` | `{name}` | `{name}` |
| `workspace.deleted` | `{workspaceId}` | `{name, status: "active"}` | `{status: "deleted"}` |
| `workspace.imported` | `{workspaceId}` | null | `{name, created, memberships, invitations, credentials}` (counts) |
| `membership.added` | `{membershipId, mentraUserId, email}` | `{role: null}` | `{role}` |
| `membership.role_changed` | `{membershipId, mentraUserId, email}` | `{role}` | `{role}` |
| `membership.removed` | `{membershipId, mentraUserId, email}` | `{role, status: "active"}` | `{status: "ended", endedReason, revokedCredentialIds, revokedInvitationIds}` |
| `membership.left` | `{membershipId, mentraUserId, email}` | `{role, status: "active"}` | `{status: "ended", endedReason: "left", revokedCredentialIds, revokedInvitationIds}` |
| `membership.claimed` | `{membershipId, mentraUserId, email}` | `{mentraUserId: null}` | `{mentraUserId, role}` |
| `membership.merged_duplicate` | `{membershipId, mentraUserId, email}` | `{role, status, keptMembershipId, keptRole}` | `{status: "ended", endedReason: "removed", keptMembershipId, resultingRole, repointedCredentialIds, repointedInvitationIds}` |
| `membership.replaced` | `{membershipId, mentraUserId: null, email}` | null | `{replacedByMembershipId, repointedCredentialIds, repointedInvitationIds}` |
| `membership.ownership_recovered` | `{membershipId, mentraUserId, email}` | `{role}` (null when there was no membership) | `{role: "owner"}` |
| `invitation.created` | `{invitationId, email}` | null | `{email, role, expiresAt}` |
| `invitation.accepted` | `{invitationId, membershipId, email}` | `{status: "pending"}` | `{status: "accepted"}` |
| `invitation.revoked` | `{invitationId, email}` | `{status: "pending", role}` | `{status: "revoked"}`, with `reason: "superseded", supersededBy` when a new invitation replaced it and `reason: "inviter_account_deleted"` when the inviter's account was deleted |
| `credential.created` | `{credentialId, prefix, credentialKind, workspaceId, name}` | null | `{scopes, packageNames, expiresAt, createdByMembershipId, issuedByService}` |
| `credential.revoked` | `{credentialId, prefix, credentialKind, workspaceId, name}` | `{revokedAt: null}` | `{revokedAt}` |
| `user.deleted` | `{mentraUserId}` | null | null |

Notes:

- `membership.removed` has `endedReason` `removed` (an administrator removed the
  person, or an import ended a membership the Store no longer has) or
  `account_deleted`. `mentraUserId` is null for a membership nobody has signed in
  with yet.
- `workspace.deleted` ends every membership of the workspace
  (`endedReason: "workspace_deleted"`), revokes its credentials and invitations,
  and records no per-membership event: treat it as ending them all.
- A role change made by merging a duplicate shows as `membership.merged_duplicate`
  with `resultingRole`; the surviving membership's history has the new role.
- Credentials revoked because their creator's membership ended are listed in
  that membership's `revokedCredentialIds`, and pending invitations it sent in
  `revokedInvitationIds`, without their own events.
- `credential.*` events are the workspace keys'. Operator keys belong to the
  organization and are not on the feed.

### Account deletion

Deleting a Mentra account ends all of that person's workspace access in one
transaction, before the account itself is deleted:

1. Each active membership ends with `endedReason: "account_deleted"`: one
   `membership.removed` event each, the workspace's revision bumped and the
   credentials and pending invitations that membership created revoked.
2. The other pending invitations the person sent are revoked
   (`invitation.revoked`, `after.reason: "inviter_account_deleted"`).
3. Last, a `user.deleted` tombstone: `workspaceId` null,
   `target: {"mentraUserId": "..."}`. Delete or anonymize what Fleet keeps keyed
   by that user, and refuse delayed uploads that would recreate it. Core records
   it for every deleted account, including a person who belongs to no workspace,
   and once. Process it idempotently anyway: a service may read a page twice.

The tombstone follows the removals in `seq`, so by the time Fleet reads it the
person's memberships have ended. Deletion is never refused for a workspace's sake.
A workspace whose last owner deleted their account stays active without an owner,
and an Organization Admin recovers it. Invitations addressed to the person's email
stay valid, since they name an address and not an account. The operator keys the
person created are revoked outside the feed, and their identity is cleared from
the rows that stay as history.

## Not installed versus unavailable

Clients can tell the two apart and should: one means "hide Fleet" or "stop
sending", the other "try again".

- `404 {"error":"fleet_not_installed"}`: Fleet is not installed (no
  `CLOUD_CORE_FLEET_URL`, or `CLOUD_CORE_ENABLED_FEATURES` is set without
  `fleet.managed`).
- `503 {"error":"fleet_unavailable"}`: Fleet is configured but cannot answer. The
  URL is unusable or the secret is missing (logged by variable name, never value),
  or there was a network error, a timeout, an upstream 5xx, an upstream 3xx other
  than `304`, or a response body over the limit. Never an empty success. Retry
  later.
- `401 {"error":"unauthorized"}`: the caller is not signed in. A phone treats it
  as an expired session and refreshes.
- `403 {"error":"forbidden"}`: the admin caller is a key, or lacks
  `organization.fleet.administer`.

A `401` from Fleet reaches the caller as a `403` with Fleet's body. Phones and
the admin dashboard treat a 401 as "your session ended, sign in again", which a
Fleet answer never means. Answer `403` for "not allowed" (not enrolled, say).

Any other status Fleet answers, 4xx included, is relayed unchanged.
