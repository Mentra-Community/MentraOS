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
  is accepted outside production for any host, and in production
  (`NODE_ENV=production`) only for `localhost` and `127.0.0.1`. No credentials,
  query or fragment.
- `CLOUD_CORE_FLEET_SECRET`: the shared secret that signs everything Core sends.
  Required when the URL is set.
- `CLOUD_CORE_FLEET_MAX_BODY_BYTES`: the largest request body Core forwards.
  Default `1048576`.
- `CLOUD_CORE_FLEET_TIMEOUT_MS`: how long Fleet has to answer, body included.
  Default `10000`.
- `CLOUD_CORE_SERVICE_SECRETS`: its `fleet` list holds the secrets Fleet signs its
  calls to Core with (below).

Values that are not positive integers fall back to the defaults.

The two secrets cover the two directions. Core signs what it forwards to Fleet
with `CLOUD_CORE_FLEET_SECRET`; Fleet signs its calls to Core with a secret from
the `fleet` list. They may hold the same value.

A phone learns whether Fleet exists from `GET /api/client/capabilities`, which
returns `{"organizationId": "...", "fleet": {"installed": true | false}}` for a
signed-in user. `installed` is true only when the URL and secret are both
usable.

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
  decoding, and the path is forwarded exactly as received. **Fleet must decode a
  path at most once**: a double-encoded `%252e` reaches Fleet as the literal
  text `%2e`, and decoding it again turns it into a dot segment.
- Bodies are treated as UTF-8 text (the Fleet API is JSON). Core signs the text
  and sends the same bytes. A body that is not valid UTF-8 is
  `400 {"error":"invalid_body"}`; one over the limit is
  `413 {"error":"payload_too_large"}`.
- Core copies only the `content-type` and `accept` request headers. Everything
  else the caller sent, including every `x-mentra-*` header, `authorization` and
  `cookie`, is dropped.
- Fleet's response passes through (status and body) with only its `content-type`
  and `cache-control` headers. Redirects are never followed.

## What Fleet receives

With `<ts>` the request time in milliseconds, Core adds:

- `x-mentra-service`: `core`.
- `x-mentra-service-timestamp`: `<ts>`.
- `x-mentra-service-signature`: HMAC-SHA256, base64url, over
  `<ts>\n<METHOD>\n<path with query as sent, prefix included>\n<sha256 hex of the body>`.
- `x-mentra-organization-id`: this Core's organization id.
- `x-mentra-principal`: the caller, as base64url JSON (shapes below).
- `x-mentra-principal-signature`: HMAC-SHA256, base64url, keyed with the same
  secret, over `<ts>\n<x-mentra-organization-id value>\n<x-mentra-principal value>`.

The first three are `signServiceRequest` / `verifyServiceRequest` from
`@mentra/workspace-contract/server`. Verification allows 60 seconds of clock
skew and accepts a list of secrets, newest first, so a secret can be rotated.

The service signature does **not** cover the two identity headers. Without the
principal signature, anyone who captured one signed request could replay it with
another identity inside the skew window. **Fleet must verify both signatures
before it trusts either header**, using the same `<ts>` for both. The two signed
strings cannot be mistaken for each other: the service one contains three
newlines and this one two, and neither a header value nor a path can contain a
newline.

```ts
import {createHmac, timingSafeEqual} from "node:crypto"
import {SERVICE_HEADERS, verifyServiceRequest} from "@mentra/workspace-contract/server"

function principalFrom(
  request: {method: string; pathWithQuery: string; body: string; header(name: string): string | undefined},
  secrets: string[],
) {
  const timestamp = request.header(SERVICE_HEADERS.timestamp)!
  const organization = request.header("x-mentra-organization-id")!
  const principal = request.header("x-mentra-principal")!
  const serviceOk =
    request.header(SERVICE_HEADERS.service) === "core" &&
    verifyServiceRequest({
      method: request.method,
      pathWithQuery: request.pathWithQuery,
      body: request.body,
      timestampMs: Number(timestamp),
      nowMs: Date.now(),
      signature: request.header(SERVICE_HEADERS.signature)!,
      secrets,
    })
  const given = Buffer.from(request.header("x-mentra-principal-signature") ?? "")
  const principalOk = secrets.some((secret) => {
    const expected = Buffer.from(
      createHmac("sha256", secret).update(`${timestamp}\n${organization}\n${principal}`).digest("base64url"),
    )
    return expected.length === given.length && timingSafeEqual(expected, given)
  })
  if (!serviceOk || !principalOk) return null
  return {organization, principal: JSON.parse(Buffer.from(principal, "base64url").toString())}
}
```

Also check that `x-mentra-organization-id` is the organization Fleet is bound to.

### Principal shapes

```jsonc
// /v1/client: a signed-in phone
{"kind": "phone", "mentraUserId": "...", "tenantId": "...", "sessionId": "..."}

// /v1/admin: a signed-in person
{"kind": "user", "mentraUserId": "...", "email": "..." /* or null */, "isOrganizationAdmin": false}

// /v1/admin: a Core credential
{"kind": "credential", "credentialId": "...", "credentialKind": "workspace" /* or "organization" */,
 "workspaceId": "..." /* null for an operator key */, "scopes": ["..."]}
```

`isOrganizationAdmin` is computed from a verified identity email, so Fleet may
rely on it. **The `email` field may be unverified**: it is what the identity
provider reported, not proof of ownership. Never authorize on it. Authorize on
`mentraUserId` through Core's internal API (below).

## Asking Core what a caller may do

Fleet calls Core's internal workspace API at
`/api/internal/workspaces/*`, signing each request as service `fleet` with a
secret listed under `fleet` in `CLOUD_CORE_SERVICE_SECRETS`. The client
`createCoreWorkspaceClient` in `@mentra/workspace-contract/server` speaks it and
refuses any answer that names a different organization.

- `POST /authorize`: may this caller do `capability` in `workspaceId`? For a user
  principal send
  `{"credential": {"type": "mentra_user", "mentraUserId": "..."}, "workspaceId": "...", "capability": "fleet.read"}`.
  The answer carries `allowed`, a `reason` when denied, the membership and the
  caller's capabilities.
- `POST /memberships/check`: the roles and capabilities one person holds in up to
  100 workspaces.
- `GET /workspaces/:workspaceId`: the workspace's name, `active` or `deleted`
  status and authorization revision, or `404 workspace_not_found`.
- `GET /changes?after=&limit=`: workspace and membership changes in commit order;
  page by the last `seq` processed.
- `GET /workspaces/:workspaceId/memberships/history?mentraUserId=`: when a person
  held which role (Fleet only).

A `mentra_user` assertion is Fleet vouching for a person it already
authenticated, so Core never treats that person as an Organization Admin from
it. Use the principal's `isOrganizationAdmin` for that.

The Fleet capabilities are `fleet.read` and `fleet.devices.manage` (workspace
admins and owners hold both), plus `miniapps.assign`. A credential principal
carries its own `workspaceId` and `scopes`.

## Not installed versus unavailable

Clients can tell the two apart and should: one means "hide Fleet", the other
"try again".

- `404 {"error":"fleet_not_installed"}`: there is no `CLOUD_CORE_FLEET_URL`. Hide
  Fleet features.
- `503 {"error":"fleet_unavailable"}`: Fleet is configured but cannot answer. The
  URL is unusable or the secret is missing (logged by variable name, never value),
  or there was a network error, a timeout, an upstream 5xx or any upstream 3xx.
  Never an empty success. Retry later.
- `401 {"error":"unauthorized"}`: no principal reached the forwarder.

Any other status Fleet answers, 4xx included, is relayed unchanged.
