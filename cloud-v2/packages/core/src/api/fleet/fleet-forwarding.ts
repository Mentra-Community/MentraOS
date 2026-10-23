/**
 * @fileoverview Core's seam to the optional Fleet integration.
 *
 * Fleet is a separately deployed service (MFM). Core stores none of its data: it authenticates the
 * caller, decides what the caller may do, then forwards the request to Fleet and relays the answer.
 *
 *   /api/client/fleet/<rest>  ->  ${CLOUD_CORE_FLEET_URL}/v1/client/<rest>   (a signed-in phone)
 *   /api/admin/fleet/<rest>   ->  ${CLOUD_CORE_FLEET_URL}/v1/admin/<rest>    (an Organization Admin)
 *   /api/portal/fleet/workspaces/:workspaceId/<rest>
 *                             ->  ${CLOUD_CORE_FLEET_URL}/v1/portal/workspaces/:workspaceId/<rest>
 *                                                                        (a workspace Admin or Owner, or an Organization Admin)
 *   /api/portal/fleet/workspaces/:workspaceId/ui/<rest>
 *                             ->  ${CLOUD_CORE_FLEET_URL}/v1/portal/ui/<rest>   (the workspace portal's Fleet UI assets,
 *                                                                        for a person holding `fleet.read` there)
 *
 * What is Fleet's here is who may call, what the request covers and how Fleet is configured. How a request
 * is signed and sent, what Fleet receives, how its answer is mapped and how its UI assets are relayed are
 * the shared forwarding code (`services/forwarding/forward.ts` and `assets.ts`), which Core's portal modules
 * use as well; read its headers for those rules. Fleet's own error codes are `fleet_unavailable` and
 * `fleet_not_installed`.
 *
 * Who may call. Only people reach Fleet.
 *  - `/api/client/fleet`: a phone, by its access token (`userAuth`). Anything else, an admin portal
 *    session cookie included, is 401 and nothing is forwarded.
 *  - `/api/admin/fleet`: a signed-in person (`requireUserPrincipal("admin")`: a workspace key or an
 *    operator key is 403) who holds `organization.fleet.administer` (an Organization Admin; 403
 *    otherwise). The gates are this router's own, so every path under it has them, `ui/*` included. *
 *  - `/api/portal/fleet`: a person signed in to the workspace portal by its session cookie (a bearer, a workspace
 *    key or an operator key is 403; the admin portal's cookie is not read here). A workspace path then needs a
 *    capability in that workspace, decided by Core's `authorize`: `fleet.read` for GET and HEAD, `miniapps.assign`
 *    for every other method. An Organization Admin holds every workspace capability as an Owner does, member or
 *    not; a Member or Developer holds neither and gets 403; an unknown or deleted workspace is 404. Fleet is not
 *    called for a refused request. A workspace's UI assets (`/workspaces/:workspaceId/ui/*`) need `fleet.read`
 *    there, whatever the method. There is no unscoped `/api/portal/fleet/ui/*`: it is a 404.
 *
 * The scope is Core's decision. A person's Fleet request covers the organization (`scope:
 * {kind: "organization"}`) and nothing the request carries, in its query, body or headers, can say
 * otherwise: the principal is built from the authenticated caller and from nothing else. A phone's principal
 * is `{kind: "phone", mentraUserId, tenantId, sessionId, email}`, where `email` is the account's verified
 * email or null (a display attribute, never an identity key); a person's is `forwardedUser(person,
 * organization scope)`. `/v1/client` only ever receives phone principals and `/v1/admin` only user ones.
 *
 * Configuration comes from `fleetConfig()` and `fleetLimits()` (`services/fleet/fleet-config.ts`),
 * read on every request. Outcomes, in this order:
 *  - the caller is not authenticated (or not allowed): 401 or 403, as above;
 *  - Fleet is not installed (no `CLOUD_CORE_FLEET_URL`, or `CLOUD_CORE_ENABLED_FEATURES` is set
 *    without `fleet.managed`): 404 `{error: "fleet_not_installed"}`. This is how a phone learns
 *    that Fleet is absent, from the answer to its first report;
 *  - the URL is set but unusable or the secret is missing: 503 `{error: "fleet_unavailable"}`;
 *  - a body over `CLOUD_CORE_FLEET_MAX_BODY_BYTES`: 413 `{error: "payload_too_large"}`; a body that
 *    is not valid UTF-8: 400 `{error: "invalid_body"}`; a path with a `.` / `..` segment, an encoded
 *    or literal separator (`%2f`, `%5c`, `\`), a control character or a bad escape: 400
 *    `{error: "invalid_path"}`. Each segment is checked after one decoding and the path is forwarded
 *    exactly as received. A segment that is still `%2e`, `%2f` or `%5c` after that decoding (a
 *    double-encoded `%252e`) is refused too, so a Fleet that decodes a second time cannot be handed
 *    a dot segment or a separator (`isSafeSuffix`);
 *  - everything Fleet then does or fails to do is mapped as the shared forwarding code says, with 503
 *    `{error: "fleet_unavailable"}` for a failure, a timeout, a redirect or an oversized body, and an upstream
 *    401 relayed as a 403.
 *
 * Fleet UI assets. `GET` and `HEAD` `/api/admin/fleet/ui/<rest>` -> `${CLOUD_CORE_FLEET_URL}/v1/admin/ui/<rest>`
 * have a route of their own, ahead of the forwarder and behind the same admin gates. Only that route may
 * answer under `ui`: the forwarder refuses every spelling of the `ui` segment (`UI`, `//ui`) with a 404, so
 * nothing under it is ever relayed by the JSON rules. Its limit is `CLOUD_CORE_FLEET_MAX_ASSET_BYTES`
 * (default 25 MiB) and its wait `CLOUD_CORE_FLEET_TIMEOUT_MS`.
 */

import type {Logger} from "@mentra/cloud-shared"
import type {ForwardedPrincipal} from "@mentra/workspace-contract/server"
import {Hono, type Handler, type MiddlewareHandler} from "hono"
import {fleetConfig, fleetLimits, type FleetConfig, type FleetLimits} from "../../services/fleet/fleet-config"
import {phoneEmail} from "../../services/fleet/phone-email"
import {assetResponseHeaders, methodNotAllowed, relayAsset, UI_ASSET_SEGMENT} from "../../services/forwarding/assets"
import {
  forwardJson,
  forwardedUser,
  jsonAnswerHeaders,
  limitBody,
  type Upstream,
} from "../../services/forwarding/forward"
import {isSafeSuffix, joinUpstreamUrl, rawPathAndQuery} from "../../services/forwarding/upstream-url"
import type {UserPrincipal} from "../../services/signin/principal.service"
import type {AppContext, AppEnv, AppVariables} from "../../types/hono.types"
import {InvalidGrant, InvalidRequest} from "../../types/oauth.types"
import {authorize} from "../../services/workspaces/authorization.service"
import {denied, requireOrganizationCapability, requireUserPrincipal} from "../middleware/principal.middleware"
import {userAuth} from "../middleware/user-auth.middleware"

type Audience = "client" | "admin" | "portal"

/** Where each surface is mounted in the app: the part of the path that is not forwarded. */
const MOUNT_PREFIX: Record<Audience, string> = {
  client: "/api/client/fleet",
  admin: "/api/admin/fleet",
  portal: "/api/portal/fleet",
}

/** The `error` of Core's 503 when Fleet is installed but cannot answer. */
const FLEET_UNAVAILABLE = "fleet_unavailable"

/** What a person's Fleet request covers: the organization. Core decides; nothing in a request can change it. */
const ORGANIZATION_SCOPE = {kind: "organization"} as const

/** The path Fleet is sent for an audience and the caller's own path suffix: `/v1/<audience>` then the suffix. */
function fleetPath(audience: Audience, suffix: string): string {
  return `/v1/${audience}${suffix}`
}

/**
 * The URL a request is sent to: Fleet's base URL (its path prefix, if any, kept), `/v1/<audience>`,
 * then the caller's own path suffix and query.
 */
export function upstreamTarget(baseUrl: URL, audience: Audience, suffix: string, query: string): URL {
  return joinUpstreamUrl(baseUrl, fleetPath(audience, suffix), query)
}

/** The authenticated caller of a forwarded request. */
type Caller =
  | {audience: "client"; phone: NonNullable<AppVariables["user"]>}
  | {audience: "admin" | "portal"; person: UserPrincipal}

/**
 * The caller, or the refusal to send. Fail closed: the gates in front of a route set the caller, and a
 * route mounted without them must not forward an anonymous request, nor a credential as a person.
 */
function callerOf(c: AppContext, audience: Audience): Caller | Response {
  if (audience === "client") {
    const phone = c.get("user")
    return phone ? {audience, phone} : c.json({error: "unauthorized"}, 401)
  }
  const principal = c.get("principal")
  if (!principal) return c.json({error: "unauthorized"}, 401)
  return principal.kind === "user" ? {audience, person: principal} : c.json({error: "forbidden"}, 403)
}

/**
 * The caller as Fleet is told about it. Built from the authenticated caller only: nothing in the
 * request's query, body or headers reaches it.
 */
async function principalOf(caller: Caller, log: Logger): Promise<ForwardedPrincipal> {
  if (caller.audience === "client") {
    const {mentraUserId, tenantId, sessionId} = caller.phone
    return {kind: "phone", mentraUserId, tenantId, sessionId, email: await phoneEmail(mentraUserId, {log})}
  }
  // The workspace portal's scope is the authorized workspace in the path (`forwardPortal`); it must never fall
  // back to the organization's.
  if (caller.audience === "portal") throw new Error("a portal request's scope comes from its workspace path")
  return forwardedUser(caller.person, ORGANIZATION_SCOPE)
}

/** A Fleet that is installed and usable. */
type ReadyFleet = Extract<FleetConfig, {state: "ready"}>

/** Fleet as the shared forwarding code addresses it. */
function fleetUpstream(fleet: ReadyFleet, limits: FleetLimits): Upstream {
  return {
    service: "fleet-forwarding",
    label: "Fleet",
    unavailableError: FLEET_UNAVAILABLE,
    baseUrl: fleet.baseUrl,
    secret: fleet.secret,
    limits,
  }
}

/** What a forwarded request has settled before anything is read, signed or sent. */
interface Admitted {
  caller: Caller
  upstream: Upstream
  /** The path after the mount prefix, as received. */
  suffix: string
  /** The query as received, with its "?" (or ""). */
  query: string
}

/**
 * What every forwarded route settles first, in this order: who is calling, whether Fleet is installed
 * and usable, then the path. Returns the answer Core gives when a step refuses, or what the route may send.
 */
function admit(c: AppContext, audience: Audience): Admitted | Response {
  const caller = callerOf(c, audience)
  if (caller instanceof Response) return caller

  const fleet = fleetConfig()
  if (fleet.state === "not_installed") return c.json({error: "fleet_not_installed"}, 404)
  if (fleet.state === "misconfigured") return c.json({error: FLEET_UNAVAILABLE}, 503)
  const upstream = fleetUpstream(fleet, fleetLimits())

  const {path, query} = rawPathAndQuery(c.req.url)
  const prefix = MOUNT_PREFIX[audience]
  const suffix = path.slice(prefix.length)
  if (!path.startsWith(prefix) || (suffix !== "" && !suffix.startsWith("/"))) {
    return c.json({error: "not_found"}, 404)
  }
  if (!isSafeSuffix(suffix)) return c.json({error: "invalid_path"}, 400)
  return {caller, upstream, suffix, query}
}

/** Whether a path is under Fleet's UI assets, however its first segment is cased or spaced from the mount. */
function isUiAssetPath(suffix: string): boolean {
  const first = suffix.split("/").find(segment => segment !== "")
  // `isSafeSuffix` has already decoded every segment once, so this cannot throw.
  return first !== undefined && decodeURIComponent(first).toLowerCase() === UI_ASSET_SEGMENT
}

function forward(audience: Audience): Handler<AppEnv> {
  return async c => {
    const admitted = admit(c, audience)
    if (admitted instanceof Response) return admitted
    const {caller, upstream, suffix, query} = admitted
    // The UI assets have their own route and rules; however a path spells `ui`, it is not forwarded as JSON.
    if (audience === "admin" && isUiAssetPath(suffix)) return c.json({error: "not_found"}, 404)

    return forwardJson(c, {
      upstream,
      path: fleetPath(audience, suffix),
      query,
      audience: caller.audience,
      principal: log => principalOf(caller, log),
    })
  }
}

/**
 * The Fleet UI asset route: `GET` and `HEAD` `/api/admin/fleet/ui/<rest>` to `/v1/admin/ui/<rest>`, behind
 * the admin gates. See `services/forwarding/assets.ts` for the rules.
 */
function forwardAsset(): Handler<AppEnv> {
  return async c => {
    const admitted = admit(c, "admin")
    if (admitted instanceof Response) return admitted
    const {caller, upstream, suffix, query} = admitted
    return relayAsset(c, {
      upstream,
      path: fleetPath("admin", suffix),
      query,
      audience: "admin",
      principal: log => principalOf(caller, log),
    })
  }
}

/** Limits the request body to `CLOUD_CORE_FLEET_MAX_BODY_BYTES` before anything reads it. */
const limitFleetBody = limitBody(() => (fleetConfig().state === "ready" ? fleetLimits().maxBodyBytes : null))

/**
 * The phone's gate: its Core access token (`userAuth`). `userAuth` answers a missing or invalid token
 * as an OAuth error (400); on Fleet's routes the phone is told what every other caller is, 401, so it
 * refreshes its session instead of taking the answer for a bad request.
 */
const phoneAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    // `userAuth` sets `c.var.user`; the rest of the request runs here, not inside it.
    await userAuth(c, async () => {})
  } catch (err) {
    if (err instanceof InvalidRequest || err instanceof InvalidGrant) {
      return c.json({error: "unauthorized", error_description: "sign-in required"}, 401)
    }
    throw err
  }
  return next()
}

/**
 * The phone's forwarder, mounted at `/api/client/fleet`. Its own gate is the phone's access token; a
 * request with no user on the context is refused (401).
 */
export const clientFleetApi = new Hono<AppEnv>()
clientFleetApi.use("*", jsonAnswerHeaders, phoneAuth)
clientFleetApi.all("/*", limitFleetBody, forward("client"))

/**
 * The admin forwarder, mounted at `/fleet` inside the admin API. Its own gates are a signed-in person
 * (a key gets 403) who holds `organization.fleet.administer`. A request with no principal is refused (401).
 */
export const adminFleetApi = new Hono<AppEnv>()
adminFleetApi.use(
  "*",
  jsonAnswerHeaders,
  requireUserPrincipal("admin"),
  requireOrganizationCapability("organization.fleet.administer"),
)
// The UI assets, ahead of the JSON forwarder and behind the gates above: GET and HEAD relay the asset, any
// other method is a 405. Only the asset route may answer under `ui`; the forwarder refuses it.
adminFleetApi.use(`/${UI_ASSET_SEGMENT}/*`, assetResponseHeaders)
adminFleetApi.on(["GET", "HEAD"], `/${UI_ASSET_SEGMENT}/*`, forwardAsset())
adminFleetApi.all(`/${UI_ASSET_SEGMENT}/*`, methodNotAllowed)
adminFleetApi.all("/*", limitFleetBody, forward("admin"))


// --- The workspace portal ------------------------------------------------------

const WORKSPACES_SEGMENT = "workspaces"

/**
 * A path under the workspace portal's Fleet mount: one workspace's API, one workspace's UI assets (`assetPath`
 * is the rest after that workspace's `ui`, as received), or the UI assets outside any workspace.
 */
type PortalRoute =
  | {kind: "workspace"; workspaceId: string}
  | {kind: "workspace-ui"; workspaceId: string; assetPath: string}

/** Whether `rest` (the path after a `ui` segment) names an asset: a `/` and at least one more character. */
function isAssetRest(rest: string): boolean {
  return rest.length > 1 && rest.startsWith("/")
}

/**
 * The route for a path suffix (`/workspaces/ws_1/x`, `/workspaces/ws_1/ui/entry.js`), or null when
 * it is none. Segments are matched exactly, as received: no case folding, no decoding, so a spelling Fleet's own
 * router might read differently is not a route, and a workspace path whose third segment is another spelling of
 * `ui` (`UI`, `%75i`) is refused rather than forwarded as JSON. `isSafeSuffix` has already decoded every segment
 * once, so this cannot throw.
 */
function portalRouteOf(suffix: string): PortalRoute | null {
  const [, first, second, third] = suffix.split("/")
  if (first !== WORKSPACES_SEGMENT || !second) return null
  const workspaceId = decodeURIComponent(second)
  if (third === undefined || decodeURIComponent(third).toLowerCase() !== UI_ASSET_SEGMENT) {
    return {kind: "workspace", workspaceId}
  }
  if (third !== UI_ASSET_SEGMENT) return null
  const assetPath = suffix.slice(`/${first}/${second}/${third}`.length)
  return isAssetRest(assetPath) ? {kind: "workspace-ui", workspaceId, assetPath} : null
}

/** Reading is `fleet.read`; every other method changes something, which is `miniapps.assign`. */
function capabilityFor(method: string): "fleet.read" | "miniapps.assign" {
  return method === "GET" || method === "HEAD" ? "fleet.read" : "miniapps.assign"
}

/**
 * The workspace portal's forwarder, mounted at `/api/portal/fleet` behind the portal's person gate. In this
 * order: the caller is a person on the portal's session cookie; Fleet is installed and usable; the path is a
 * workspace path or an asset path; for a workspace path, `authorize` allows the capability the method needs in
 * that workspace. Only then is anything read, signed or sent.
 */
function forwardPortal(): Handler<AppEnv> {
  return async c => {
    const caller = callerOf(c, "portal")
    if (caller instanceof Response) return caller
    if (caller.audience !== "portal") return c.json({error: "forbidden"}, 403)
    // Only the portal's own session reaches Fleet from here: a bearer (a Core access token) is not a portal.
    if (caller.person.via !== "session") return c.json({error: "forbidden", error_description: "sign in to the portal"}, 403)

    const admitted = admit(c, "portal")
    if (admitted instanceof Response) return admitted
    const {upstream, suffix, query} = admitted
    const route = portalRouteOf(suffix)
    if (!route) return c.json({error: "not_found"}, 404)

    const request = {upstream, path: fleetPath("portal", suffix), query, audience: "portal"}
    const person = () => forwardedUser(caller.person, {kind: "person"})
    const capability = route.kind === "workspace-ui" ? "fleet.read" : capabilityFor(c.req.method)
    const decision = await authorize(caller.person, {workspaceId: route.workspaceId, capability})
    if (!decision.allowed) return denied(c, decision)
    if (route.kind === "workspace-ui") {
      // The module is the same for every workspace: Fleet serves it once, at `/v1/portal/ui`, for the person.
      if (c.req.method !== "GET" && c.req.method !== "HEAD") return methodNotAllowed(c)
      return relayAsset(c, {...request, path: fleetPath("portal", `/${UI_ASSET_SEGMENT}${route.assetPath}`), principal: person})
    }
    const scope = {kind: "workspace", workspaceId: route.workspaceId} as const
    return forwardJson(c, {...request, principal: () => forwardedUser(caller.person, scope)})
  }
}

/**
 * The workspace portal's Fleet router, mounted at `/fleet` inside the portal's API, behind `requireUserPrincipal("portal")`
 * (a workspace key or an operator key is 403, no principal 401). Fleet is not a portal module: it is not in the
 * portal modules' list, so the module routes never forward to it.
 */
export const portalFleetApi = new Hono<AppEnv>()
portalFleetApi.use("*", jsonAnswerHeaders)
portalFleetApi.use(`/${WORKSPACES_SEGMENT}/:workspaceId/${UI_ASSET_SEGMENT}/*`, assetResponseHeaders)
portalFleetApi.all("/*", limitFleetBody, forwardPortal())
