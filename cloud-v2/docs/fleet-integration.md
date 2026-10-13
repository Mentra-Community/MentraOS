# Fleet integration

Fleet is an optional, separately deployed service (MFM) that collects usage from
the Mentra App and shows an organization its devices and activity. Core stores
none of its data. It authenticates the caller, decides who the caller is and what
the request covers, forwards the request to Fleet with a signed statement of
that, and relays Fleet's answer. This page is the contract between the two; the
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

A limit that is not a positive integer falls back to its default.

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
