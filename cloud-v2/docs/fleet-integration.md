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

Signing, the headers a service receives, the mapping of its answers and the relay
of its UI assets are shared with Core's other forwarding seam, the
[portal modules](portal-modules.md) (billing), which follow the same rules under
their own paths and error codes.

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
  reads only the feature names; the packages are for the features in miniapp
  tokens ([Licenses](licenses.md#features-in-miniapp-tokens)). Blank or
  unset, as on the hosted Core, leaves the installation to the URL and the
  secret. Set, it must list `fleet.managed` for
  Fleet to be installed; a Core that lists other features and not `fleet.managed`
  has no Fleet, whatever its Fleet URL says. Feature names are case-sensitive
  (`Fleet.Managed` is not `fleet.managed`), and a value of nothing but separators
  lists no feature. Core logs one warning per process, naming
  `CLOUD_CORE_FLEET_URL` and `CLOUD_CORE_ENABLED_FEATURES` and no value, when a
  Fleet URL is set and this list switches Fleet off, since every phone then gets
  the `404` of an absent Fleet.
- `CLOUD_CORE_FLEET_MAX_BODY_BYTES`: the largest request body Core forwards.
  Default `1048576` (1 MiB).
- `CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES`: the largest response body Core buffers
  from Fleet. A larger one is a `503 {"error":"fleet_unavailable"}`. Default
  `10485760` (10 MiB).
- `CLOUD_CORE_FLEET_TIMEOUT_MS`: how long Fleet has to answer, body included.
  Default `10000`. A value above `2147483647`, the longest a timer holds, is
  treated as `2147483647`.
- `CLOUD_CORE_FLEET_MAX_ASSET_BYTES`: the largest Fleet UI asset Core relays
  (see [Fleet UI assets](#fleet-ui-assets)). A larger one is a
  `503 {"error":"fleet_unavailable"}`. Default `26214400` (25 MiB); the JSON
  routes' response limit does not apply to assets.
- `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`: how far back Core's membership interval
  history reaches (`GET /api/internal/workspaces/membership-intervals`, read by
  Fleet only). Default `90`; a whole number of days from 1 to 3650. Fleet's
  Overview calculates over up to 114 days, so a deployment that runs Fleet sets
  at least `120`; Fleet refuses a query window longer than the lookback its last
  bootstrap was given. An open membership older than the window is still
  returned, with its real start. Each interval carries `roles`, the role
  intervals within it that overlap the window (a role held before the
  membership's claim is never counted).
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
| `/api/portal/fleet/workspaces/<workspaceId>/<rest>` | `${CLOUD_CORE_FLEET_URL}/v1/portal/workspaces/<workspaceId>/<rest>` | A person on the workspace portal's session cookie (never a bearer) who `authorize` allows `fleet.read` (GET, HEAD) or `miniapps.assign` (every other method) in that workspace; an Organization Admin counts as Owner |
| `/api/portal/fleet/workspaces/<workspaceId>/ui/<rest>` | `${CLOUD_CORE_FLEET_URL}/v1/portal/ui/<rest>` | The workspace's UI assets: a person on the portal's session cookie whom `authorize` allows `fleet.read` in that workspace, whatever the method; `GET` and `HEAD` only (any other is `405`), signed with `scope: {kind: "person"}`. Only that exact `ui` segment; another spelling (`UI`, `%75i`) is 404 |

The workspace portal's principal is signed with `scope: {kind: "workspace", workspaceId}` taken from the
path only; nothing in the query, headers or body can change it. Any other path under `/api/portal/fleet` is 404,
the old unscoped `/api/portal/fleet/ui/*` included: the portal loads its module from the workspace route above, so a
person who may not read Fleet in a workspace cannot fetch its UI either.

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
- On the JSON routes (`/api/client/fleet/<rest>` and `/api/admin/fleet/<rest>`
  other than `ui/`), Fleet's response passes through (status and body) with only
  its `content-type`, `cache-control`, `retry-after` and `x-request-id` headers.
  A `429` with `Retry-After` reaches the caller with it. Redirects are never
  followed. The [UI asset route](#fleet-ui-assets) relays a different set of
  headers under different rules.
- **The JSON routes relay JSON.** A `2xx` answer with a body must have the
  content type `application/json`, with or without parameters
  (`application/json; charset=utf-8`) and in any case, and a single value. Any
  other (`text/html`, `text/plain`, a vendor type, none at all) is
  `503 {"error":"fleet_unavailable"}`, logged at warn with the reason
  `content_type_not_json`, and none of Fleet's body or headers reach the caller.
  A `204`, `205` or `304`, an answer to a `HEAD` and an empty body are not
  checked, and neither is an error answer (`4xx`): those are relayed as Fleet
  gave them, under the headers below.
- **Every JSON answer is labelled as data.** Core's own answers (a `401`, `403`,
  `404`, `400`, `413` or `503`, the gates' refusals included) and Fleet's relayed
  ones carry `x-content-type-options: nosniff` and `content-security-policy:
  default-src 'none'; frame-ancestors 'none'; sandbox`. The admin session cookie
  is `SameSite=Lax`, so a top-level `GET` to `/api/admin/fleet/<rest>` carries
  it, and the browser would treat whatever came back as a document of the admin
  origin (on a Private Cloud, of Core's own origin, where `/api/*` has no portal
  policy). Fleet's own `x-content-type-options` and `content-security-policy` are
  not relayed, so Fleet cannot loosen these. Fleet should answer every JSON
  endpoint with `Content-Type: application/json`.
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
network error, a timeout, a `5xx`, a redirect, an oversized body, a `401`, a
success that is not JSON) at warn. So a secret that does not match Fleet's, which Fleet refuses with `403`,
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
  email as an identity key, key records by `mentraUserId`. Core reads it from
  its own copy of the account's email, not from the account directory, so
  reports cost the directory nothing. An email changed in the Mentra App
  reaches Fleet within five minutes, with the account's next report; one changed
  in the directory itself (Supabase's console), within a day. A report also
  carries null when Core could not learn the email in time, so keep the last
  email you were sent rather than clearing it on a null.
- A user's `isOrganizationAdmin` is computed from a verified identity email, so
  Fleet may rely on it. Its `email` may be unverified (`emailVerified` says
  whether the identity provider verified it); even a verified email is not an
  authorization.
- `organizationCapabilities` is what Core decided this person may do to the
  organization, and `scope` is what this request covers. Core sends
  `{"kind": "organization"}` on the admin surface and the person must hold
  `organization.fleet.administer` for the request to be forwarded at all. The
  contract also defines `{"kind": "workspace", "workspaceId": "..."}` and
  `{"kind": "person"}` (the scopes of [portal modules](portal-modules.md)), which
  a receiver must be ready to read. A third kind, `{"kind": "public", "scope":
  {"kind": "public"}}`, names no person: Core sends it only to a portal module's
  public reads, never to Fleet, and a `user` principal never has that scope.
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

## Fleet UI assets

`GET` and `HEAD` `/api/admin/fleet/ui/<rest>` are relayed to
`${CLOUD_CORE_FLEET_URL}/v1/admin/ui/<rest>`. This is how the admin portal gets
the Fleet UI module it imports and mounts (`ui/entry.js`, see
[the UI module contract](#the-fleet-ui-module-contract)): through Core, so that it
loads from the portal's own origin under the portal's `script-src 'self'`. What
this route relays therefore **runs in the admin portal**, which is why its rules
are stricter than the JSON routes' and differ from them.

The route is behind the same gates as the rest of `/api/admin/fleet` (a signed-in
Organization Admin; `401` or `403` otherwise), then answers `404
fleet_not_installed`, `503 fleet_unavailable` or `400 invalid_path` as the JSON
routes do. The request Fleet receives is signed and carries the principal like
any other.

- **Methods.** Only `GET` and `HEAD`. Any other method is
  `405 {"error":"method_not_allowed"}` with `Allow: GET, HEAD`. The JSON
  forwarder refuses every other spelling of the `ui` segment (`UI`, `//ui` and
  the like) with `404 {"error":"not_found"}`, so nothing under `ui` is ever
  relayed by the JSON rules.
- **What Fleet receives.** The caller's `if-none-match` and `if-modified-since`,
  and no other header of theirs, plus Core's `accept-encoding: identity` (outside
  the signature) so that the bytes Core relays are the bytes Fleet sent.
- **What the caller gets.** `content-type`, `etag`, `last-modified`,
  `cache-control` and `vary` (added to any `Vary` already on the response),
  `content-length` (the length of the body the caller gets, set by Core from the
  bytes it holds) and `x-request-id` as for the JSON routes. Core adds
  `x-content-type-options: nosniff` and `cross-origin-resource-policy:
  same-origin` to every answer of the route, its own refusals included. The
  JSON routes' sandbox policy is on this route's own JSON refusals but not on a
  relayed asset, which has to run in the portal.
- **Content types.** The content type is checked first, for an error answer too.
  `text/javascript`, `application/javascript`, `text/css`,
  `image/png|jpeg|webp|gif|avif`, `font/woff2|woff` and `application/json` are
  relayed as Fleet sent them. `image/svg+xml` is relayed under Core's own
  `content-security-policy: default-src 'none'; style-src 'unsafe-inline'`, which
  replaces any Fleet sent. Anything else, `text/html` above all, is
  `503 fleet_unavailable`. So is a value holding a comma (a browser keeps the last
  of several, so `text/javascript, text/html` would be read as html) and an
  answer with no content type, unless it declares an empty body (a bare `404`).
  A `204`, `205` or `304` has no representation: it is relayed with its
  validators and is not checked, so a revalidation (`If-None-Match`) works.
- **No commas, no encodings.** Besides the comma above, any `content-encoding`
  but `identity` is refused: Core asks for none, `fetch` would decode it and the
  declared length would no longer describe the body. Serve assets uncompressed
  (compress at the edge in front of Fleet, if at all).
- **Buffered, not streamed.** Core reads the whole body, under
  `CLOUD_CORE_FLEET_MAX_ASSET_BYTES` (default 25 MiB) and
  `CLOUD_CORE_FLEET_TIMEOUT_MS` (the wait for the answer and the read of the
  whole body), and answers only when the body is complete and as long as the
  `content-length` Fleet declared. Bun turns a stream that fails (a short body, a
  reset, a timeout, the cap) into a normal end of the response, so a browser
  would otherwise take a truncated module for a complete, cacheable `200` with
  Fleet's `etag` and `cache-control`. Otherwise the answer is a
  `503 fleet_unavailable` with none of Fleet's headers, logged at warn with a
  `reason`: a declared length over the cap (a `HEAD`'s included, refused before
  any of the body is read), a body over the cap with no (or a wrong) length, a
  body of another length than declared, a Fleet that resets the connection or
  stalls past the timeout after its headers, and a `content-encoding` other than
  `identity`. Send an exact `content-length` and an `etag`.
- **The rest is the JSON routes'.** Not installed, misconfigured, an unsafe path,
  an upstream `5xx` (with its `Retry-After`), a redirect (never followed), a `401`
  turned into a `403`, a network error, a timeout before the headers, and the
  logging.

## The Fleet UI module contract

The module that `ui/entry.js` serves is an ES module whose default export is a
`FleetUiModule`. The types and the contract version live in
`@mentra/workspace-contract/fleet-ui` (import that path, not the package root: it
names DOM types), and the host, the admin portal's Fleet page
(`websites/admin/src/pages/fleet.tsx`), and the module share them.

```ts
import {FLEET_UI_CONTRACT_VERSION, type FleetUiContext, type FleetUiModule} from "@mentra/workspace-contract/fleet-ui"

const module: FleetUiModule = {
  contractVersion: FLEET_UI_CONTRACT_VERSION, // 1
  mount(element, ctx) {
    // Render into `element` (an open ShadowRoot); route with ctx.route; call Fleet at ctx.apiBase.
    return {
      unmount() { /* remove everything the module added */ },
      setRoute(route) { /* optional: the host's route changed */ },
    }
  },
}
export default module
```

- **Loading.** The portal imports `/api/admin/fleet/ui/entry.js` once per open
  Fleet page and checks the default export: it must be an object with a numeric
  `contractVersion` and a `mount` function, and `contractVersion` must equal the
  host's `FLEET_UI_CONTRACT_VERSION` (1). A module that cannot be imported (the
  `404` and `503` Core answers while Fleet is absent or down), is not a module,
  or speaks another version is not mounted: the page says Fleet is unavailable
  and offers Retry.
- **`mount(element, ctx)`.** `element` is an `HTMLElement | ShadowRoot`; the host
  passes an open shadow root, which keeps the module's styles and the portal's
  apart, so the module's styles go inside it. It returns a handle,
  `{unmount(), setRoute?(route)}`. `unmount` removes everything the module added.
  A `mount` that throws leaves the page on "Fleet could not start" with Retry.
- **`FleetUiContext`.** `contractVersion` (`1`); `apiBase` (`/api/admin/fleet`:
  the module sends its API requests to `${apiBase}/<rest>` on the portal's own
  origin, with the portal's session cookie; Core forwards them to Fleet as
  `/v1/admin/<rest>`); `me` (`{authenticated: true, user: {mentraUserId, email} |
  null, organization: {capabilities}, fleet: {installed}}`, all the host tells the
  module about the caller); `route` (`{path, query}` when the module mounts);
  `navigate(path, {replace?})`; and `onSessionExpired()`, which the module calls
  when the API answers `401`, so that the host can send the caller to sign in
  (a Fleet `401` reaches the module as a `403`; see
  [Not installed versus unavailable](#not-installed-versus-unavailable)).
- **Routes.** The host owns the route. It lives in the portal's address as
  `?fleet=<path and query>`, so a Fleet screen has a link and Back and Forward
  work. A path is normalized: leading slashes collapse to one, and a control
  character or more than 2048 characters gives `/`. `ctx.route` splits it into
  `path` and `query` (with its `?`, or `""`). `navigate(path)` asks the host to go
  there (a new history entry, or with `replace` the current one replaced); only
  the module that is on screen can move the page.
- **A route change after mount** (the module's own `navigate`, Back, Forward)
  reaches the module through the handle's `setRoute(route)`, when it has one, and
  does not remount it. A module without `setRoute` is unmounted and mounted again
  with the new `ctx.route`, in one synchronous step, in the same shadow root, so
  it loses its state on every route change; a `setRoute` that throws falls back to
  the same remount. Provide `setRoute`.
- **One evaluation, and Retry.** The module is imported once per open Fleet page;
  a route change and a Retry after a failed `mount` reuse it (a module with
  import-time side effects, a `customElements.define` say, runs them once). A
  Retry after a failed *import* asks for `/api/admin/fleet/ui/entry.js?retry=<n>`,
  with `<n>` a millisecond timestamp, because browsers remember a module, and some
  a failed import, by URL. **The entry route must ignore the `?retry=` query**: it
  serves the same module for any value of it. Core forwards the query to Fleet
  unchanged and signs it with the rest of the path.
- **The policy the module runs under.** It runs in the admin portal, under the
  portal's Content Security Policy when Core serves the portal (a Private Cloud):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`. In practice:
  scripts only from the portal's origin, so the entry and every chunk it imports
  come from `/api/admin/fleet/ui/` (use relative import specifiers), with no
  inline `<script>`, no `eval` and no `new Function`; styles from the same origin
  or inline; images from the same origin or `data:`; fonts from the same origin
  (`font-src` follows `default-src`, so no `data:` fonts); and connections
  (`fetch`, XHR, WebSocket, EventSource) to the same origin only, so Fleet is
  reached through `apiBase` and nowhere else. A deployment whose portal is served
  elsewhere may not enforce the policy yet; a module that needs more would break
  wherever it is enforced.

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
and answer Fleet `403 {"error":"forbidden"}`. A deletion hold
(`PUT`/`DELETE /workspaces/:workspaceId/deletion-holds/:service`,
[Store integration](store-integration.md#deletion-holds)) answers any service for
its own name: Fleet may hold a workspace as `fleet`, never as `store`.

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
  number back. On a database that runs transactions (a replica set), a later read
  therefore never shows an event with a lower `seq` than one already seen. The
  feed leaves organization-level events (operator keys) out, so consecutive feed
  events can skip numbers. A skipped number is never a missed workspace event.
- **Re-read an overlap.** On a database that cannot run the transaction (a
  standalone `mongod`, or Azure Cosmos DB for MongoDB, which fails a transaction
  across two collections), the one event Core can still record, the
  `user.deleted` tombstone of a person in no workspace, is written without one:
  Core reserves its `seq`, then inserts the event, as two separate writes. Its
  `seq` is unique and increasing but not ordered against concurrent writers, so
  with overlapping deletions an event with a lower `seq` can become readable after
  an event with a higher one. A consumer that only reads forward from its cursor
  would skip it for good. A consumer of such a deployment must therefore read the
  feed from a point behind its cursor on each poll, for example the last 100
  `seq` (`after` = cursor minus 100, floored at 0), and process events
  idempotently, since the overlap returns events it has already handled; `eventId`
  and `seq` identify them. The overlap is harmless on any deployment, and on a
  replica set it never finds anything new. A transaction that fails on a database
  that can run them (a failover, a timeout, contention) is never recorded without
  one: the deletion fails and Core retries it within a minute.
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
| `workspace.deletion_hold_set` | `{workspaceId, service}` | `{reason, count}` (the service's previous hold), or null | `{reason, count}` |
| `workspace.deletion_hold_cleared` | `{workspaceId, service}` | `{reason, count}` | null |
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
| `invitation.declined` | `{invitationId, email}` | `{status: "pending", role}` | `{status: "declined"}`. The invitee turned it down; no membership changes, so Fleet's membership intervals are untouched |
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
  and records no per-membership event: treat it as ending them all. The
  workspace's licenses and their seats end before it, each with its own
  `license.ended` and `seat.released` event.
- `license.written`, `license.ended`, `seat.assigned` and `seat.released` are a
  workspace license's and its seats' changes; their shapes are in
  [Licenses](licenses.md#audit-and-the-change-feed). A membership's
  seats are released just before its `membership.removed` or `membership.left`
  event.
- `workspace.deletion_hold_*` events say which service holds the workspace from
  deletion and why; `count` is null when the service gave none. They change no
  membership, and a workspace is never deleted while held.
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
  than `304`, a response body over the limit, or a `2xx` that is not JSON (on the
  JSON routes), or an asset that fails the checks of the
  [UI asset route](#fleet-ui-assets). Never an empty success. Retry later.
- `401 {"error":"unauthorized"}`: the caller is not signed in. A phone treats it
  as an expired session and refreshes.
- `403 {"error":"forbidden"}`: the admin caller is a key, or lacks
  `organization.fleet.administer`.

A `401` from Fleet reaches the caller as a `403` with Fleet's body. Phones and
the admin dashboard treat a 401 as "your session ended, sign in again", which a
Fleet answer never means. Answer `403` for "not allowed" (not enrolled, say).

Any other status Fleet answers, 4xx included, is relayed unchanged.
