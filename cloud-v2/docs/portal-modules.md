# Portal modules

A portal module is a separately deployed service that brings its API to the
workspace portal, and sometimes its UI. Core hosts it the way it hosts
[Fleet](fleet-integration.md): Core authenticates the person, decides what the
request covers, forwards it to the module with a signed statement of that, and
relays the answer. Core stores none of the module's data.

A module is one of two kinds:

- **A data module** returns typed values and nothing to draw. The portal draws
  its pages from components of its own and formats every value and every sentence
  itself. It serves no `ui/entry.js`; its `ui/` holds only the assets those pages
  show, such as icons.
- **A UI module** also serves a bundle, `ui/entry.js`, which the portal mounts in
  a page of its own ([The UI of a UI module](#the-ui-of-a-ui-module)).

There is one portal module:

| Module | Kind | Mounted at | Settings | What it is |
| --- | --- | --- | --- | --- |
| `billing` | Data | `/api/portal/billing` | `CLOUD_CORE_BILLING_URL`, `CLOUD_CORE_BILLING_SECRET` | The Mentra Miniapp Store's billing module: what it sells, what each workspace holds, and the hosted pages where they pay. The portal draws the Licenses page and the Members list's licenses from its answers. Hosted Core only; a Private Cloud leaves it unset. |

Billing is a data module. Fleet's is the only UI module: the admin portal mounts
its bundle from `/api/admin/fleet/ui/entry.js` ([Fleet
integration](fleet-integration.md#the-fleet-ui-module-contract)), and the workspace
portal keeps a module host (`websites/portal/src/components/portal-module-host.tsx`)
for Fleet Management's UI. No workspace portal page mounts it, and the registry
above lists billing alone. [The UI of a UI module](#the-ui-of-a-ui-module) is the
contract that host speaks.

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

A module has three states, never conflated:

- **not installed**: no URL. Core answers `404 {"error":"module_not_installed"}`.
- **misconfigured**: the URL is set but unusable, or the secret is missing. Core
  answers `503 {"error":"module_unavailable"}` and logs, once per process, which
  variable is wrong and never its value.
- **ready**: Core forwards.

The limits are Fleet's defaults and are not settings: a request body up to 1 MiB,
a JSON answer up to 10 MiB, an asset up to 25 MiB, and 10 seconds for the module
to answer, body included.

## Is the module installed?

`GET /api/portal/me` answers `modules: {"billing": true | false}`. `billing` is
true when billing is ready on this Core, so the portal offers billing's pages
only where they work. A module whose settings are unusable is false, not true:
the portal could not load its page. So is one that is not installed.

An installed module is for every signed-in person, on every Core, alike:
`CLOUD_CORE_ENVIRONMENT` and whether the person is an Organization Admin change
nothing about whether Core forwards. What a person may do inside the module is
the module's own decision ([Forwarding paths](#forwarding-paths)). Billing sells
with a test key on every Core but the production one, and the Licenses page then
shows a test-mode banner ([Licenses](licenses.md)).

### Public reads

A module's `publicReads` in the registry are for anyone, signed in or not, on
every Core, whatever its environment: they are marketing content. They are
mounted ahead of the portal's sign-in gate, so Core looks up no person for them.
Billing's one public read is a product's name, for the sign-in page ("Sign in to
buy <name>."):

| Public read | Methods | Matched |
| --- | --- | --- |
| `/api/portal/billing/public/products/<product>` | `GET` | One key after `public/products/`: 1 to 100 lowercase letters, digits, `.`, `_` and `-`, and not only dots |

Every other method (`HEAD` included), spelling (another case, an encoding, a
trailing slash) and extra segment is `404 module_not_installed`, with nothing read
or forwarded, as is every public read of a module that is not installed. One whose
settings are unusable answers it with `503 module_unavailable`.

Core forwards it to `${url}/v1/portal/public/products/<product>` with the
`public` principal, `{"kind": "public", "scope": {"kind": "public"}}`, which names
no person: not the one who is signed in, whose cookie, token and query are not
sent either. Core relays only the contract's `PublicProduct`, `{"name"}`, whatever
else the module says beside it, with `cache-control: public, max-age=300`, since
the answer is the same for everyone. A `404` from the module is `404 not_found`;
any other answer, or a name that does not parse, is `503 module_unavailable`. Both
carry `cache-control: no-store`.

Core's forwarding has no rate limit of its own, so none applies here beyond the
module's; the answer is cacheable by anyone for five minutes.

### Billing's routes

Billing is a data module. Its routes are under
`/api/portal/billing/workspaces/:workspaceId/`, since a license is always a
workspace's, and the contract of what they send is
`@mentra/workspace-contract/portal-billing`:

| Route | What it answers | Who |
| --- | --- | --- |
| `GET catalog` | What billing sells to workspaces, and what this one holds. Display content for everyone; a viewer who manages billing also gets each product's price and how many licenses may be bought | Any member of the workspace |
| `GET status` | The workspace's licenses as billing holds them, their dates and actions, the total, and the state of a purchase (`?purchase=`) | The module decides |
| `POST purchase` | Starts a purchase and answers the hosted payment page's address | The module decides |
| `POST session` | Opens a hosted billing page for a license or for the workspace's billing and answers its address | The module decides |
| `GET ui/icons/<file>` | A product's icon | Any signed-in person |
| `GET /api/portal/billing/public/products/<product>` | A product's name, `{"name"}`, for the sign-in page | Anyone, signed in or not ([public read](#public-reads)) |

Billing serves no `ui/entry.js`. It sends values and the actions it offers, and the
workspace portal words every sentence and formats every amount, date and count
from them, and follows only the hosted-page addresses the contract accepts.

## Forwarding paths

| Core path | Forwarded to | Scope | Caller |
| --- | --- | --- | --- |
| `/api/portal/<module>/workspaces/:workspaceId/<rest>` | `${url}/v1/portal/workspaces/:workspaceId/<rest>` | `{"kind": "workspace", "workspaceId"}` | A member of that workspace, or an Organization Admin |
| `/api/portal/<module>/ui/<rest>` | `${url}/v1/portal/ui/<rest>` | `{"kind": "person"}` | Any signed-in person; `GET` and `HEAD` only |
| `/api/portal/<module>/public/<family>/<key>` | `${url}/v1/portal/public/<family>/<key>` | `{"kind": "public"}`, with the `public` principal | Anyone, signed in or not, for a [public read](#public-reads); `GET` only, no query |

The method, query string and body are forwarded. The URL may carry a path prefix;
Core joins it to `/v1/portal/...` with or without a trailing slash. The path and
query Core signs are exactly the ones it sends. Anything else under the mount is
`404 {"error":"not_found"}`, `/account/<rest>` included: the first segment must be
exactly `workspaces` (with a workspace after it) or `ui`, in lowercase and
unencoded.

Only people reach a module, but for its public reads. Core answers, in this order:

1. **Authenticate.** A signed-in person (a workspace portal session, or a Core
   access token) is required: none is `401`, and a workspace key or an operator
   key is `403 {"error":"forbidden"}`. The admin portal's session cookie
   authenticates nothing here. A cookie-authenticated write must come from the
   workspace portal's origin.
2. **Installed?** `404 module_not_installed` if the module is not installed;
   `503 module_unavailable` if it is misconfigured. Neither learns anything about
   workspaces: this comes before the scope check. A request body is not read
   for either.
3. **Path.** A path with an encoded separator (`%2f`, `%5c`), a control
   character, a bad escape or a double encoding (`%252e`) is `400
   {"error":"invalid_path"}`, as for Fleet. The server in front of Core resolves a
   literal or encoded dot segment (`..`, `%2e%2e`) and turns a backslash into a
   separator before Core sees the request, as a URL parser does, so Core judges
   the path it resolves to: `status/../catalog` arrives as `catalog`. Core's own
   refusal of a dot segment is a second line, for a server that does not resolve
   them.
4. **Scope.** A workspace path needs standing in that workspace: a member of any
   role, or an Organization Admin, who acts as an Owner in every workspace. A
   non-member is `403 {"error":"forbidden","reason":"not_a_member"}`, and an
   unknown or deleted workspace is `404 workspace_not_found`; the module is not
   called in either case.
5. **Forward.**

Core decides which workspace a request is about, from the path alone. Nothing the
request carries in its query, body or headers can change the scope Core signs:
`/api/portal/billing/workspaces/ws_1/purchase?workspaceId=ws_2` is still
`{"kind": "workspace", "workspaceId": "ws_1"}`. The workspace in the scope is the
path's segment decoded once, which is what the module decodes the path to. A UI
asset is `{"kind": "person"}`: it is the same for everyone and about no workspace.

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
A JSON answer is the module's answer to one person at an address that is the
same for everyone (billing's catalog lists offers to a billing manager and
display content to anyone else), so one the module sets no `cache-control` on
carries `cache-control: private, no-store`; a module's own `cache-control` is
relayed as it is. UI assets, billing's icons among them, keep the module's.
Core logs each request that reaches the module once, as `Portal module billing
request forwarded`, without a body, header, query or secret.

## The UI of a UI module

`GET` and `HEAD` `/api/portal/<module>/ui/<rest>` relay the module's assets,
through Core, so that they load from the workspace portal's own origin under its
`script-src 'self'`. For a UI module they include the bundle, which therefore runs
in the portal. A data module's are images, such as billing's icons. The rules are
the Fleet UI asset rules, with `module_unavailable` for `fleet_unavailable`
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
  `${apiBase}/workspaces/<workspaceId>/<rest>`, on the portal's own origin, with
  the portal's session cookie); `me`
  (`{authenticated: true, user: {mentraUserId, email, emailVerified}}`, all the host
  tells the module about the caller); `scope` (`{kind: "workspace", workspaceId}`
  when the page is a workspace's, `{kind: "person"}` when it is about no
  workspace, where Core forwards no API request; it tells the module which API
  root to call and grants nothing, since Core decides the scope of each request
  from its path); `route` (`{path, query}`
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
