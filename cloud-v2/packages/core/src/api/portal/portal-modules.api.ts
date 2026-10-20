/**
 * @fileoverview Core's seam to a portal module, such as billing.
 *
 * A portal module is a separately deployed service (`services/portal-modules/portal-modules.ts`) that brings
 * its own API and its own UI to the workspace portal. Core stores none of its data: it authenticates the
 * person, decides what the request covers, then forwards the request to the module and relays the answer, by
 * the shared forwarding code (`services/forwarding/forward.ts` and `assets.ts`: how a request is signed, what
 * the module receives, how its answer is mapped, how its UI assets are relayed). `portalModuleApi(name)` is
 * mounted at `/api/portal/<name>` in the workspace portal's API, behind its person gate
 * (`requireUserPrincipal("portal")`), and forwards three families of path:
 *
 *   /workspaces/:workspaceId/<rest>  ->  ${url}/v1/portal/workspaces/:workspaceId/<rest>   scope {kind: "workspace", workspaceId}
 *   /account/<rest>                  ->  ${url}/v1/portal/account/<rest>                   scope {kind: "person"}
 *   /ui/<rest>                       ->  ${url}/v1/portal/ui/<rest>                        GET and HEAD only; scope {kind: "person"}
 *
 * Anything else under the mount is a 404 `{error: "not_found"}`: the first segment must be exactly
 * `workspaces` (with a workspace after it), `account` or `ui`, in lowercase and unencoded.
 *
 * Who may call. Only people reach a module: a workspace key or an operator key is 403, and a request with no
 * principal is 401 (the gate in front says so first; this router fails closed as well). A workspace path is for
 * a member of that workspace or an Organization Admin (`authorize` with no capability: any role); anyone else is
 * 403, an unknown or deleted workspace is 404 `{error: "workspace_not_found"}`, and the module is not called. The
 * module decides what a person may do there itself, through Core's `/authorize` with the `mentra_user`
 * credential; Core's scope says only which workspace, or none, the request is about.
 *
 * The scope is Core's decision. It is built from the path, which Core has checked, and from the authenticated
 * person, and nothing the request carries, in its query, body or headers, can say otherwise: `/account/*` is
 * `{kind: "person"}` however the request asks for a workspace's. The workspace in the scope is the path's
 * segment decoded once, which is what the module decodes the path to.
 *
 * Outcomes, in this order:
 *  - the caller is not a signed-in person: 401 or 403;
 *  - the module is not installed, or is not visible to this person (billing is staff-only on a Core that is not
 *    prod, decision 17): 404 `{error: "module_not_installed"}`. A person the module is hidden from cannot tell
 *    it from one that is absent, whether or not it is broken;
 *  - the settings are set but unusable: 503 `{error: "module_unavailable"}`;
 *  - a path with a `.` / `..` segment, an encoded or literal separator, a control character, a bad escape or a
 *    double encoding: 400 `{error: "invalid_path"}` (`isSafeSuffix`); not one of the three families: 404;
 *  - a workspace path for a person with no standing there: 403 or 404, as above;
 *  - then the shared forwarding code: 413 and 400 for the body, 503 `{error: "module_unavailable"}` for a
 *    module that fails, times out, redirects or sends too much, an upstream 401 relayed as a 403.
 *
 * Every JSON answer carries the labels of the shared code (`nosniff` and a sandbox policy). The UI route's
 * rules are `assets.ts`'s: GET and HEAD only (any other method is 405 once the caller is allowed), the content
 * types it relays, and its limits.
 */

import type {ForwardedScope} from "@mentra/workspace-contract/server"
import {Hono} from "hono"
import {assetResponseHeaders, methodNotAllowed, relayAsset, UI_ASSET_SEGMENT} from "../../services/forwarding/assets"
import {forwardJson, forwardedUser, jsonAnswerHeaders, limitBody, type Upstream} from "../../services/forwarding/forward"
import {DEFAULT_FORWARDING_LIMITS, isSafeSuffix, rawPathAndQuery} from "../../services/forwarding/upstream-url"
import {
  portalModuleConfig,
  portalModuleVisibleTo,
  type PortalModuleName,
} from "../../services/portal-modules/portal-modules"
import type {UserPrincipal} from "../../services/signin/principal.service"
import {authorize} from "../../services/workspaces/authorization.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {denied} from "../middleware/principal.middleware"

const MODULE_NOT_INSTALLED = "module_not_installed"
const MODULE_UNAVAILABLE = "module_unavailable"

/** The path every module serves the portal under. */
const UPSTREAM_PREFIX = "/v1/portal"

const WORKSPACES_SEGMENT = "workspaces"
const ACCOUNT_SEGMENT = "account"

/** Which of the three families of path a request is for. */
type Route = {kind: "workspace"; workspaceId: string} | {kind: "account"} | {kind: "ui"}

/**
 * The route for a path suffix (`/workspaces/ws_1/x`), or null when it is none of the three. The first segment
 * is matched exactly, as received: no case folding, no decoding, so a spelling the module's own router might
 * read differently is not a route.
 */
function routeOf(suffix: string): Route | null {
  const [, first, second] = suffix.split("/")
  switch (first) {
    case UI_ASSET_SEGMENT:
      return suffix.length > `/${UI_ASSET_SEGMENT}/`.length && suffix.startsWith(`/${UI_ASSET_SEGMENT}/`) ? {kind: "ui"} : null
    case ACCOUNT_SEGMENT:
      return {kind: "account"}
    case WORKSPACES_SEGMENT:
      // `isSafeSuffix` has already decoded every segment once, so this cannot throw.
      return second ? {kind: "workspace", workspaceId: decodeURIComponent(second)} : null
    default:
      return null
  }
}

/** What a request to a module has settled before anything is read, signed or sent. */
interface Admitted {
  person: UserPrincipal
  upstream: Upstream
  route: Route
  /** The path after the mount prefix, as received. */
  suffix: string
  /** The query as received, with its "?" (or ""). */
  query: string
}

/**
 * What every route of a module settles first, in this order: who is calling, whether the module is installed
 * and visible to them and usable, then the path. Returns the answer Core gives when a step refuses.
 */
function admit(c: AppContext, name: PortalModuleName): Admitted | Response {
  // Fail closed: the gate in front sets the principal, and a router mounted without it must not forward an
  // anonymous request, nor a credential as a person.
  const principal = c.get("principal")
  if (!principal) return c.json({error: "unauthorized"}, 401)
  if (principal.kind !== "user") return c.json({error: "forbidden"}, 403)

  const config = portalModuleConfig(name)
  if (config.state === "not_installed" || !portalModuleVisibleTo(name, principal)) {
    return c.json({error: MODULE_NOT_INSTALLED}, 404)
  }
  if (config.state === "misconfigured") return c.json({error: MODULE_UNAVAILABLE}, 503)
  const upstream: Upstream = {
    service: `portal-module-${name}`,
    label: `Portal module ${name}`,
    unavailableError: MODULE_UNAVAILABLE,
    baseUrl: config.baseUrl,
    secret: config.secret,
    limits: DEFAULT_FORWARDING_LIMITS,
  }

  const {path, query} = rawPathAndQuery(c.req.url)
  const prefix = `/api/portal/${name}`
  const suffix = path.slice(prefix.length)
  if (!path.startsWith(prefix) || (suffix !== "" && !suffix.startsWith("/"))) {
    return c.json({error: "not_found"}, 404)
  }
  if (!isSafeSuffix(suffix)) return c.json({error: "invalid_path"}, 400)
  const route = routeOf(suffix)
  if (!route) return c.json({error: "not_found"}, 404)
  return {person: principal, upstream, route, suffix, query}
}

/** What the request covers, or the refusal: a workspace path needs standing in that workspace. */
async function scopeOf(c: AppContext, person: UserPrincipal, route: Route): Promise<ForwardedScope | Response> {
  if (route.kind !== "workspace") return {kind: "person"}
  const decision = await authorize(person, {workspaceId: route.workspaceId})
  return decision.allowed ? {kind: "workspace", workspaceId: route.workspaceId} : denied(c, decision)
}

/**
 * The router for module `name`, to be mounted at `/api/portal/<name>` behind the portal's person gate. See
 * the file header for what it forwards and who may call.
 */
export function portalModuleApi(name: PortalModuleName): Hono<AppEnv> {
  const api = new Hono<AppEnv>()
  api.use("*", jsonAnswerHeaders)
  api.use(`/${UI_ASSET_SEGMENT}/*`, assetResponseHeaders)
  api.all(
    "/*",
    // The body is limited only for a request that will be forwarded: a person the module is hidden from is
    // answered without reading it, so a large one cannot tell them the module is there.
    limitBody(c => {
      const principal = c.get("principal")
      const visible = principal?.kind === "user" && portalModuleVisibleTo(name, principal)
      return visible && portalModuleConfig(name).state === "ready" ? DEFAULT_FORWARDING_LIMITS.maxBodyBytes : null
    }),
    async c => {
      const admitted = admit(c, name)
      if (admitted instanceof Response) return admitted
      const {person, upstream, route, suffix, query} = admitted
      const request = {
        upstream,
        path: `${UPSTREAM_PREFIX}${suffix}`,
        query,
        audience: "portal",
      }

      if (route.kind === "ui") {
        if (c.req.method !== "GET" && c.req.method !== "HEAD") return methodNotAllowed(c)
        return relayAsset(c, {...request, principal: () => forwardedUser(person, {kind: "person"})})
      }
      const scope = await scopeOf(c, person, route)
      if (scope instanceof Response) return scope
      return forwardJson(c, {...request, principal: () => forwardedUser(person, scope)})
    },
  )
  return api
}
