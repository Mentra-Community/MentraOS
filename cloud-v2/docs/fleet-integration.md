# Fleet integration

Fleet is an optional, separately deployed service for managing the devices of an
organization. Core stores none of its data. It authenticates the caller, forwards
the request to Fleet with a signed statement of who the caller is, and relays
Fleet's answer. Fleet asks Core who may do what through Core's internal workspace
API. This page is the contract between the two; the behavior is implemented and
tested in `packages/core/src/api/fleet/fleet-forwarding.ts` and
`packages/workspace-contract`.

Nothing here changes a deployment that has no Fleet: the forwarding routes answer
`404 {"error":"fleet_not_installed"}`.

## Configuration

Set on Core. Values are read on every request, so a change takes effect at once.
See [private deployment](../deploy/private-deployment.md#organization-workspaces-and-credentials)
for every Core variable.

- `CLOUD_CORE_FLEET_URL`: Fleet's base URL with an optional path prefix. Unset or
  blank means Fleet is not installed. `https` is accepted everywhere. Plain `http`
  is accepted on a local or test Core for any host. A deployed Core
  (`NODE_ENV=production`, or `CLOUD_CORE_ENVIRONMENT` set to `dev`, `staging`,
  `prod` or `production`) accepts it only for `localhost` and `127.0.0.1`. No
  credentials, query or fragment.
- `CLOUD_CORE_FLEET_SECRET`: the shared secret that signs everything Core sends.
  Required when the URL is set.
- `CLOUD_CORE_FLEET_MAX_BODY_BYTES`: the largest request body Core forwards.
  Default `1048576`.
- `CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES`: the largest response body Core buffers
  from Fleet. A larger one is a `503 {"error":"fleet_unavailable"}`. Default
  `10485760` (10 MiB).
- `CLOUD_CORE_FLEET_TIMEOUT_MS`: how long Fleet has to answer, body included.
  Default `10000`.
- `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`: how far back Fleet may ask about
  membership history (below). Default `90`.
- `CLOUD_CORE_SERVICE_SECRETS`: its `fleet` list holds the secrets Fleet signs its
  calls to Core with (below).

Values that are not positive integers fall back to the defaults.

The two secrets cover the two directions. Core signs what it forwards to Fleet
with `CLOUD_CORE_FLEET_SECRET`; Fleet signs its calls to Core with a secret from
the `fleet` list. They may hold the same value.

A phone learns whether Fleet exists from `GET /api/client/capabilities`, which
returns `{"fleet": {"installed": true | false}}` for a signed-in user. The admin
dashboard reads the same flag from `GET /api/admin/me` (`fleet.installed`), so it
offers Fleet only where it exists. `installed` is true only when the URL and
secret are both usable; it says nothing about what a caller may do in Fleet.

## Forwarding paths

| Core path                  | Forwarded to                               | Caller                        |
| -------------------------- | ------------------------------------------ | ----------------------------- |
| `/api/client/fleet/<rest>` | `${CLOUD_CORE_FLEET_URL}/v1/client/<rest>` | A signed-in phone             |
| `/api/admin/fleet/<rest>`  | `${CLOUD_CORE_FLEET_URL}/v1/admin/<rest>`  | A person or a Core credential |

The method, query string and body are forwarded. The admin forwarder needs a
principal but no organization capability: a workspace admin who is not an
Organization Admin must be able to reach Fleet, and Fleet decides what each
caller may do.

Two rules follow from the table, and Fleet can rely on both:

- `/v1/client` only ever receives **phone** principals.
- `/v1/admin` only ever receives **user** or **credential** principals.

Core does not decide that a phone may use an admin route or the reverse; the
surface fixes the principal kind.

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
  `429` or `503` with `Retry-After` reaches the caller with it. Redirects are
  never followed.
- A `204`, `205` or `304` from Fleet, and any answer to a `HEAD` request, has no
  body. Core does not read one (a `HEAD` answer's `content-length` is not held
  against the response limit) and adds no `content-type` Fleet did not send.
- Per-record results must ride in a `2xx` or `4xx` body: a `5xx` is turned into
  `503 fleet_unavailable` and its body is dropped.

### Correlation

Core sends Fleet its own request id as `x-request-id`: the caller's
`x-request-id` when it sent one of up to 64 characters, a fresh ULID otherwise.
Use it as Fleet's request id. Core answers with Fleet's `x-request-id` when Fleet
returns one, and its own otherwise, and logs both when they differ. The same id is
recorded as `requestId` on the workspace audit events a Core request causes.

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
// Then check the kind against the surface: /v1/client takes phones, /v1/admin users and credentials.
```

### Principal shapes

`ForwardedPrincipal` in `@mentra/workspace-contract`:

```jsonc
// /v1/client: a signed-in phone
{"kind": "phone", "mentraUserId": "...", "tenantId": "...", "sessionId": "..."}

// /v1/admin: a signed-in person
{"kind": "user", "mentraUserId": "...", "email": "..." /* or null */, "emailVerified": true,
 "isOrganizationAdmin": false}

// /v1/admin: a Core credential
{"kind": "credential", "credentialId": "...", "credentialKind": "workspace" /* or "organization" */,
 "workspaceId": "..." /* null for an operator key */, "scopes": ["..."], "packageNames": ["..."]}
```

`isOrganizationAdmin` is computed from a verified identity email, so Fleet may
rely on it. **The `email` field may be unverified**: `emailVerified` says whether
the identity provider verified it. Even a verified email is not an authorization:
authorize on `mentraUserId` through Core's internal API (below).

A credential with a non-empty `packageNames` may act only on those packages.
Core never forwards the bearer, so Fleet cannot ask `/authorize` about a
credential: it must apply `scopes` and `packageNames` itself.

## Asking Core what a caller may do

Fleet calls Core's internal workspace API at
`/api/internal/workspaces/*`, signing each request as service `fleet` with a
secret listed under `fleet` in `CLOUD_CORE_SERVICE_SECRETS`. The client
`createCoreWorkspaceClient` in `@mentra/workspace-contract/server` speaks it and
refuses an answer that does not have the documented shape.

- `POST /authorize`: may this caller do `capability` in `workspaceId`? For a user
  principal send
  `{"credential": {"type": "mentra_user", "mentraUserId": "..."}, "workspaceId": "...", "capability": "fleet.read"}`.
  The answer carries `allowed`, a `reason` when denied, the membership, the
  caller's capabilities and the workspace with its `authorizationRevision`.
- `POST /memberships/check`: the roles and capabilities one person holds in up to
  100 workspaces.
- `GET /workspaces/:workspaceId`: the workspace's name, `active` or `deleted`
  status and authorization revision, or `404 workspace_not_found`.
- `GET /changes?after=&limit=`: the change feed (below).
- The membership history routes (below), Fleet only.

A `mentra_user` assertion is Fleet vouching for a person it already
authenticated, so Core never treats that person as an Organization Admin from
it. Use the principal's `isOrganizationAdmin` for that.

The Fleet capabilities are `fleet.read` and `fleet.devices.manage` (workspace
admins and owners hold both), plus `miniapps.assign`. A credential principal
carries its own `workspaceId` and `scopes`.

Current authorization always comes from `/authorize` or `/memberships/check`.
History answers "what was true then" and never authorizes anything now.

### Membership history

For attributing an observation to the membership in effect when it was made,
for instance a delayed upload. A **generation** is one membership: joining
starts it; removal, leaving, workspace deletion or account deletion ends it.
Rejoining is a new generation with a new `membershipId`. Within a generation,
each **role interval** is a role held over `[from, to)`: `to` is the next role's
`from` or the generation's `endedAt`, and `null` while it is still held. The
intervals of a generation never overlap and leave no gap. A role that changes at
time T is the new role at T.

Each interval carries `authorizationRevision`: the workspace's revision from the
change that started that role, which is the revision `/authorize` and
`GET /workspaces/:workspaceId` report from then on. The revision is per
workspace: any membership change in the workspace bumps it, so a record stamped
with revision R from `/authorize` belongs to the interval with the highest
`authorizationRevision` not above R. A role imported from the Store carries the
workspace's revision at import, and starts at the Store membership's creation
time.

| Route | Client method | Answers |
| --- | --- | --- |
| `GET /workspaces/:workspaceId/memberships/history?mentraUserId=&since=` | `membershipHistory(workspaceId, mentraUserId, {since?})` | `MembershipHistoryResponse` |
| `GET /workspaces/:workspaceId/memberships/as-of?mentraUserId=&at=` | `membershipAsOf({workspaceId, mentraUserId, at?})` | `MembershipAsOfResponse` |
| `POST /memberships/as-of` with `{"items": [{workspaceId, mentraUserId, at?}]}` | `membershipsAsOf(queries)` | `MembershipAsOfBatchResponse` |

```jsonc
// GET .../memberships/history: generations in effect at or after windowStart (or since), oldest first
{"windowStart": "2026-07-10T12:00:00.000Z",
 "items": [{"membershipId": "wm_...", "startedAt": "2026-06-01T09:00:00.000Z",
            "endedAt": "2026-09-01T10:00:00.000Z", "endedReason": "removed",
            "roles": [{"role": "member", "from": "2026-06-01T09:00:00.000Z", "to": "2026-08-01T08:00:00.000Z", "authorizationRevision": 3},
                      {"role": "admin", "from": "2026-08-01T08:00:00.000Z", "to": "2026-09-01T10:00:00.000Z", "authorizationRevision": 7}]}]}

// GET .../memberships/as-of: the generation and role in effect at `at` (default: now), or null
{"windowStart": "...", "workspaceId": "ws_...", "mentraUserId": "...", "at": "2026-08-15T00:00:00.000Z",
 "membership": {"membershipId": "wm_...", "startedAt": "...", "endedAt": "...", "endedReason": "removed",
                "role": {"role": "admin", "from": "2026-08-01T08:00:00.000Z", "to": "2026-09-01T10:00:00.000Z", "authorizationRevision": 7}}}

// POST /memberships/as-of: one result per query, in the order asked
{"windowStart": "...", "items": [{"workspaceId": "...", "mentraUserId": "...", "at": "...", "membership": null}]}
```

`endedReason` is `removed`, `left`, `workspace_deleted` or `account_deleted`.
Times are ISO 8601 with a time zone and are answered in UTC; `at` and `since` may
be up to a minute ahead of Core's clock, and further ahead is
`400 invalid_request`. A batch holds at most 100 queries (`400 invalid_request`
beyond that) and may repeat a pair. A workspace that does not exist, or a person
who never belonged to it, has no history and no membership; only signed-in
(claimed) memberships count, so a migrated membership waiting for its first
sign-in matches nobody.

**The lookback window.** Reads are bounded by `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`
(default 90): `windowStart` is now minus that many days, and every answer
carries it. Asking about anything earlier, a `since` or an `at` before
`windowStart`, is `400 history_window_exceeded` (the client's
`history_window_exceeded` error code); one such query fails the whole batch.
Keep Fleet's replay window inside Core's. A generation or role interval that
began before the window and was still in effect at its start is returned
**whole**, with its real `startedAt` and `from`, not clipped to the window;
anything that ended at or before `windowStart` is left out. An answer therefore
does not depend on when it was asked.

The routes do not yet limit which workspaces Fleet may ask about. The spec
limits historical reads to the service's configured workspace scope, but where
that scope is configured is open; Core has one place to apply it
(`historyScopeAllows` in `membership-history.service.ts`).

## The change feed

`GET /changes?after=&limit=` lists workspace changes in commit order, for any
service (Store or Fleet), so a service that was offline can catch up:

- **Paging.** `after` is the `seq` of the last event processed, as a decimal
  string (omit it to start from the beginning); `limit` is 1 to 500 (default
  100). `next` is the cursor for the following page, or null when the page was
  not full. Store your cursor only after processing an event.
- **Order and gaps.** `seq` is Core's audit-trail position, assigned in commit
  order: a later read never shows an event with a lower `seq` than one already
  seen. The feed leaves organization-level events (operator keys) out, so
  consecutive feed events can skip numbers. A skipped number is never a missed
  workspace event.
- **Retention.** Nothing is ever pruned. Replaying from the beginning (no
  `after`) rebuilds the full history at any time.
- **Contents.** Each event is `{eventId, seq, workspaceId, action, occurredAt,
  target, before, after}`. `target`, `before` and `after` are snapshots with
  every credential-looking key (`token`, `secret`, `hash`, `password`) removed at
  any depth; `before` and `after` are null when the change has none. The actor
  and request id are not on the feed. Treat unknown actions as no-ops.
- **Scope.** Workspace-scoped events (a `workspaceId`) and user-level tombstones
  (`workspaceId` null) only. Fleet sees every workspace's events and filters to
  the workspaces it serves.

### Event catalog

| `action` | `target` | `before` | `after` |
| --- | --- | --- | --- |
| `workspace.created` | `{workspaceId, membershipId}` | null | `{name, role: "owner"}` (the creator's membership) |
| `workspace.renamed` | `{workspaceId}` | `{name}` | `{name}` |
| `workspace.deleted` | `{workspaceId}` | `{name, status: "active"}` | `{status: "deleted"}` |
| `workspace.imported` | `{workspaceId}` | null | `{name, memberships, invitations, credentials}` (counts) |
| `membership.added` | `{membershipId, mentraUserId}` | `{role: null}` | `{role}` |
| `membership.role_changed` | `{membershipId, mentraUserId}` | `{role}` | `{role}` |
| `membership.removed` | `{membershipId, mentraUserId}` | `{role, status: "active"}` | `{status: "ended", endedReason, revokedCredentialIds}` |
| `membership.left` | `{membershipId, mentraUserId}` | `{role, status: "active"}` | `{status: "ended", endedReason: "left", revokedCredentialIds}` |
| `membership.claimed` | `{membershipId, mentraUserId}` | `{pendingWorkosUserId}` | `{mentraUserId, role}` |
| `membership.merged_duplicate` | `{membershipId, mentraUserId}` | `{membershipId, role, status, pendingWorkosUserId, keptMembershipId, keptRole}` | `{membershipId, status: "ended", endedReason: "removed", keptMembershipId, resultingRole, repointedCredentialIds}` |
| `membership.ownership_recovered` | `{membershipId, mentraUserId}` | `{role}` (null when there was no membership) | `{role: "owner"}` |
| `invitation.created` | `{invitationId}` | null | `{email, role, expiresAt}` |
| `invitation.revoked` | `{invitationId}` | `{status: "pending", role}` | `{status: "revoked"}`, with `reason: "superseded", supersededBy` when a new invitation replaced it |
| `invitation.accepted` | `{invitationId, membershipId}` | `{status: "pending"}` | `{status: "accepted"}` |
| `credential.created` | `{credentialId, prefix, credentialKind, workspaceId, name}` | null | `{scopes, packageNames, expiresAt, createdByMembershipId, issuedByService}` |
| `credential.revoked` | `{credentialId, prefix, credentialKind, workspaceId, name}` | `{revokedAt: null}` | `{revokedAt}` |
| `user.deleted` | `{mentraUserId}` | null | null |

Notes:

- `membership.removed` has `endedReason` `removed` (an admin, or a Store
  migration re-run, removed them) or `account_deleted`. `mentraUserId` is null
  for a migrated membership nobody has signed in with yet.
- `workspace.deleted` ends every membership of the workspace
  (`endedReason: "workspace_deleted"`), revokes its credentials and invitations,
  and records no per-membership event: treat it as ending them all.
- A role change made by merging a duplicate shows as `membership.merged_duplicate`
  with `resultingRole`; the surviving membership's history has the new role.
- Credentials revoked because their creator's membership ended are listed in
  that membership's `revokedCredentialIds`, without their own
  `credential.revoked`.

### Account deletion

Deleting a Mentra account ends all of that person's workspace access in one
transaction, before the account itself is deleted:

1. Each active membership, and each migrated membership still waiting for a
   WorkOS user linked to the account, ends with `endedReason: "account_deleted"`:
   one `membership.removed` event each, the workspace's revision bumped and the
   credentials that membership created revoked.
2. The account's identity links are deleted, so a later sign-in with the same
   WorkOS user becomes a new Mentra user rather than reviving this one.
3. Last, a `user.deleted` tombstone: `workspaceId` null,
   `target: {"mentraUserId": "..."}`. Delete or anonymize what Fleet keeps keyed
   by that user, and refuse delayed uploads that would recreate it. Process it
   idempotently: a retried deletion can record a second one.

Deletion is never refused for a workspace's sake. A workspace whose last owner
deleted their account stays active without an owner, and an Organization Admin
recovers it. Invitations the person sent stay valid (an invitation never depended
on its inviter's membership), and invitations addressed to their email stay too.
Organization operator keys they created are not revoked: those follow the
Organization Admin allowlist, not the account.

## Not installed versus unavailable

Clients can tell the two apart and should: one means "hide Fleet", the other
"try again".

- `404 {"error":"fleet_not_installed"}`: there is no `CLOUD_CORE_FLEET_URL`. Hide
  Fleet features.
- `503 {"error":"fleet_unavailable"}`: Fleet is configured but cannot answer. The
  URL is unusable or the secret is missing (logged by variable name, never value),
  or there was a network error, a timeout, an upstream 5xx, an upstream 3xx other
  than `304`, or a response body over the limit. Never an empty success. Retry
  later.
- `401 {"error":"unauthorized"}`: no principal reached the forwarder.

A `401` from Fleet reaches the caller as a `403` with Fleet's body. Phones and
the admin dashboard treat a 401 as "your session ended, sign in again", which a
Fleet answer never means. Answer `403` for "not allowed" (not enrolled, say).

Any other status Fleet answers, 4xx included, is relayed unchanged.
