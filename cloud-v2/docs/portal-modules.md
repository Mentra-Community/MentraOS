# Portal modules

A portal module is a separately deployed service that brings its own API and its
own UI to the workspace portal. Core hosts it the way it hosts
[Fleet](fleet-integration.md): Core authenticates the person, decides what the
request covers, forwards it to the module with a signed statement of that, and
relays the answer. It also relays the module's UI bundle, which the portal
mounts. Core stores none of the module's data.

There is one portal module:

| Module | Mounted at | Settings | What it is |
| --- | --- | --- | --- |
| `billing` | `/api/portal/billing` | `CLOUD_CORE_BILLING_URL`, `CLOUD_CORE_BILLING_SECRET` | The Mentra Miniapp Store's billing module: Licenses & Billing. Hosted Core only; a Private Cloud leaves it unset. |

How a request is signed and sent, what a module receives, how its answer is mapped
and how its UI assets are relayed are the same as Fleet's, in code
(`packages/core/src/services/forwarding/`) and in this page. The rules that are
Fleet's alone (its audiences, its gates, its settings) stay in
[Fleet integration](fleet-integration.md).

## Configuration

Set on Core. Values are read on every request, so a change takes effect at once.

- `CLOUD_CORE_BILLING_URL`: the module's base URL with an optional path prefix.
  Unset or blank means the module is not installed. `https` is accepted
  everywhere. Plain `http` is accepted on a local or test Core for any host. A
  deployed Core (`NODE_ENV=production`, or `CLOUD_CORE_ENVIRONMENT` set to `dev`,
  `staging`, `prod` or `production`) accepts it only for `localhost` and
  `127.0.0.1`. No credentials, query or fragment.
- `CLOUD_CORE_BILLING_SECRET`: the shared secret that signs everything Core
  sends. Required when the URL is set. A secret without a URL does nothing.
- `CLOUD_CORE_ENVIRONMENT`: decides who may see billing (below).

A module has three states, never conflated:

- **not installed**: no URL. Core answers `404 {"error":"module_not_installed"}`.
- **misconfigured**: the URL is set but unusable, or the secret is missing. Core
  answers `503 {"error":"module_unavailable"}` and logs, once per process, which
  variable is wrong and never its value.
- **ready**: Core forwards.

The limits are Fleet's defaults and are not settings: a request body up to 1 MiB,
a JSON answer up to 10 MiB, an asset up to 25 MiB, and 10 seconds for the module
to answer, body included.

## Is the module installed, and is it for me?

`GET /api/portal/me` answers `modules: {"billing": true | false}`. It is true when
billing is ready on this Core and visible to the person who asked (below), so the
portal offers Licenses & Billing only where it works. A module whose settings are
unusable is false, not true: the portal could not load its page.

### Who sees billing

On a Core whose `CLOUD_CORE_ENVIRONMENT` is exactly `prod`, billing is visible to
everyone. On every other Core (`dev`, `staging`, a misspelling, nothing at all)
it is visible to staff only, because billing sells with a test key there. Staff
are Organization Admins, as `CLOUD_CORE_ADMIN_EMAILS` and
`CLOUD_CORE_ADMIN_EMAIL_DOMAINS` decide from a verified email; the forwarded
principal carries the answer as `isOrganizationAdmin`. For anyone else on such a
Core, `modules.billing` is `false` and every `/api/portal/billing/*` request
answers `404 module_not_installed`, with the module never called, exactly as if
it were not installed.

The module repeats the rule on its side: on a test key it answers `403
billing_staff_only` to a principal without `isOrganizationAdmin`, before it does
anything, so Core and the module reach one answer.

## Forwarding paths

| Core path | Forwarded to | Scope | Caller |
| --- | --- | --- | --- |
| `/api/portal/<module>/workspaces/:workspaceId/<rest>` | `${url}/v1/portal/workspaces/:workspaceId/<rest>` | `{"kind": "workspace", "workspaceId"}` | A member of that workspace, or an Organization Admin |
| `/api/portal/<module>/account/<rest>` | `${url}/v1/portal/account/<rest>` | `{"kind": "person"}` | Any signed-in person |
| `/api/portal/<module>/ui/<rest>` | `${url}/v1/portal/ui/<rest>` | `{"kind": "person"}` | Any signed-in person; `GET` and `HEAD` only |

The method, query string and body are forwarded. The URL may carry a path prefix;
Core joins it to `/v1/portal/...` with or without a trailing slash. The path and
query Core signs are exactly the ones it sends. Anything else under the mount is
`404 {"error":"not_found"}`: the first segment must be exactly `workspaces` (with
a workspace after it), `account` or `ui`, in lowercase and unencoded.

Only people reach a module. Core answers, in this order:

1. **Authenticate.** A signed-in person (a workspace portal session, or a Core
   access token) is required: none is `401`, and a workspace key or an operator
   key is `403 {"error":"forbidden"}`. The admin portal's session cookie
   authenticates nothing here. A cookie-authenticated write must come from the
   workspace portal's origin.
2. **Installed and visible?** `404 module_not_installed` if the module is not
   installed or is hidden from this person; `503 module_unavailable` if it is
   misconfigured. Neither learns anything about workspaces: this comes before the
   scope check.
3. **Path.** A path with a `.` or `..` segment, an encoded or literal separator
   (`%2f`, `%5c`, `\`), a control character, a bad escape or a double encoding
   (`%252e`) is `400 {"error":"invalid_path"}`, as for Fleet.
4. **Scope.** A workspace path needs standing in that workspace: a member of any
   role, or an Organization Admin, who acts as an Owner in every workspace. A
   non-member is `403 {"error":"forbidden","reason":"not_a_member"}`, and an
   unknown or deleted workspace is `404 workspace_not_found`; the module is not
   called in either case.
5. **Forward.**

Core decides which workspace a request is about, from the path alone. Nothing the
request carries in its query, body or headers can change the scope Core signs:
`/api/portal/billing/account/checkout?scope=workspace` is still `{"kind":
"person"}`. The workspace in the scope is the path's segment decoded once, which
is what the module decodes the path to.

Core says which workspace the person is in, not what they may do there. The module
decides capabilities itself: it asks Core's signed service API, `POST /authorize`
with the `mentra_user` credential and the principal's `mentraUserId`
([Store integration](store-integration.md)), so a role change takes effect on the
next request.

## What the module receives

With `<ts>` the request time in milliseconds, Core adds the headers described in
[What Fleet receives](fleet-integration.md#what-fleet-receives): `x-mentra-service`,
`x-mentra-service-timestamp`, `x-mentra-service-signature`, `x-mentra-principal`,
`x-mentra-principal-signature` and `x-request-id`, signed with
`CLOUD_CORE_BILLING_SECRET`. Core copies only the `content-type` and `accept`
request headers, so nothing the browser sent under `x-mentra-*`, `authorization` or
`cookie` reaches the module. The module verifies both signatures before it trusts
the principal, with `verifyForwardedPrincipal` from
`@mentra/workspace-contract/server`.

The principal on every module route is a user:

```jsonc
{"kind": "user", "mentraUserId": "...", "email": "..." /* or null */, "emailVerified": true,
 "isOrganizationAdmin": false,
 "organizationCapabilities": [],
 "scope": {"kind": "workspace", "workspaceId": "..."} /* or {"kind": "person"} */}
```

`/v1/portal` only ever receives user principals. `organizationCapabilities` is
empty for anyone who is not an Organization Admin. A module's `email` is a display
attribute: key records by `mentraUserId`.

The module's answer is mapped as Fleet's is, with `module_unavailable` for Core's
`503`: an upstream `5xx`, a redirect (never followed), a timeout, an oversized body
or a success that is not JSON is `503 {"error":"module_unavailable"}`; an
upstream `401` reaches the browser as a `403` (a `401` from Core means "sign in
again"); every JSON answer carries `x-content-type-options: nosniff` and a
sandbox `content-security-policy`; and the module's `x-request-id` is returned.
Core logs each request that reaches the module once, as `Portal module billing
request forwarded`, without a body, header, query or secret.

## The module's UI

`GET` and `HEAD` `/api/portal/<module>/ui/<rest>` relay the module's UI bundle,
through Core, so that it loads from the workspace portal's own origin under its
`script-src 'self'`. What it relays therefore runs in the portal, and the rules
are the Fleet UI asset rules, with `module_unavailable` for `fleet_unavailable`
([Fleet UI assets](fleet-integration.md#fleet-ui-assets)): only `GET` and `HEAD`
(`405` otherwise); a fixed list of content types (`text/javascript`,
`text/css`, images, fonts, `application/json`; SVG under Core's own policy; `text/html`
is refused); no `content-encoding`; the body read whole, never streamed, up to 25
MiB; `x-content-type-options: nosniff` on every answer. Serve assets uncompressed,
with an exact `content-length` and an `etag`, and have `ui/entry.js` ignore a
`?retry=` query.

The entry is an ES module whose default export is a `PortalModule`. The types and
the contract version live in `@mentra/workspace-contract/portal-module-ui`
(import that path, not the package root: it names DOM types), and the host and the
module share them.

```ts
import {PORTAL_MODULE_CONTRACT_VERSION, type PortalModule} from "@mentra/workspace-contract/portal-module-ui"

const module: PortalModule = {
  contractVersion: PORTAL_MODULE_CONTRACT_VERSION, // 1
  mount(element, ctx) {
    // Render into `element` (an open ShadowRoot); route with ctx.route; call the module at ctx.apiBase.
    return {
      unmount() { /* remove everything the module added */ },
      setRoute(route) { /* optional: the host's route changed */ },
    }
  },
}
export default module
```

- **`PortalModuleContext`.** `apiBase`
  (`/api/portal/billing`: the module sends its API requests to
  `${apiBase}/workspaces/<workspaceId>/<rest>` or `${apiBase}/account/<rest>`, on
  the portal's own origin, with the portal's session cookie); `me`
  (`{authenticated: true, user: {mentraUserId, email, emailVerified}}`, all the host
  tells the module about the caller); `scope` (`{kind: "workspace", workspaceId}`
  when the page is a workspace's, `{kind: "person"}` when it is the person's own
  account; it tells the module which API root to call and grants nothing, since
  Core decides the scope of each request from its path); `route` (`{path, query}`
  when the module mounts); `navigate(path, {replace?})`; and `onSessionExpired()`,
  which the module calls when the API answers `401`.
- **Versions.** The host imports `ui/entry.js` and mounts it only when its
  `contractVersion` equals the host's `PORTAL_MODULE_CONTRACT_VERSION`; a module
  built for another version is not mounted.
- **Routes.** The host owns the route. A route change after mount reaches the
  module through its handle's `setRoute(route)` when it has one; otherwise the host
  unmounts and mounts it again, so provide `setRoute`.
- **The policy the module runs under.** Scripts only from the portal's origin (the
  entry and every chunk come from `/api/portal/<module>/ui/`, with relative import
  specifiers), no inline `<script>`, no `eval`; styles from the same origin or
  inline; images from the same origin or `data:`; and connections to the same
  origin only, so the module is reached through `apiBase` and nowhere else.

## Compatibility

Core and a module deploy separately, in either order. The scope kinds a module
may receive are `organization`, `workspace` and `person`; a receiver that reads
the principal with `parseForwardedPrincipal` ignores any field it does not know.
A future restriction on what a caller may do must change the value of a field that
exists, never add a field (an older receiver would ignore it).
