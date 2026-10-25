/**
 * @fileoverview Core's seam to a portal module, such as billing.
 *
 * A portal module is a separately deployed service (`services/portal-modules/portal-modules.ts`) that brings
 * its own API and its own UI to the workspace portal. Core stores none of its data: it authenticates the
 * person, decides what the request covers, then forwards the request to the module and relays the answer, by
 * the shared forwarding code (`services/forwarding/forward.ts` and `assets.ts`: how a request is signed, what
 * the module receives, how its answer is mapped, how its UI assets are relayed). `portalModuleApi(name)` is
 * mounted at `/api/portal/<name>` in the workspace portal's API, behind its person gate
 * (`requireUserPrincipal("portal")`), and forwards two families of path:
 *
 *   /workspaces/:workspaceId/<rest>  ->  ${url}/v1/portal/workspaces/:workspaceId/<rest>   scope {kind: "workspace", workspaceId}
 *   /ui/<rest>                       ->  ${url}/v1/portal/ui/<rest>                        GET and HEAD only; scope {kind: "person"}
 *
 * Anything else under the mount, `/account/<rest>` included, is a 404 `{error: "not_found"}`: the first segment
 * must be exactly `workspaces` (with a workspace after it) or `ui`, in lowercase and unencoded. A person-scoped
 * family of routes is not forwarded: a license is always a workspace's, so what billing sells is reached
 * through a workspace.
 *
 * Who may call. Only people reach a module: a workspace key or an operator key is 403, and a request with no
 * principal is 401 (the gate in front says so first; this router fails closed as well). A workspace path is for
 * a member of that workspace or an Organization Admin (`authorize` with no capability: any role); anyone else is
 * 403, an unknown or deleted workspace is 404 `{error: "workspace_not_found"}`, and the module is not called. The
 * module decides what a person may do there itself, through Core's `/authorize` with the `mentra_user`
 * credential; Core's scope says only which workspace, or none, the request is about.
 *
 * The scope is Core's decision. It is built from the path, which Core has checked, and from the authenticated
 * person, and nothing the request carries, in its query, body or headers, can say otherwise. The workspace in the
 * scope is the path's segment decoded once, which is what the module decodes the path to. A UI asset is
 * `{kind: "person"}`: it is the same for everyone and about no workspace.
 *
 * Outcomes, in this order:
 *  - the caller is not a signed-in person: 401 or 403;
 *  - the module is not installed: 404 `{error: "module_not_installed"}`. An installed module is for every
 *    signed-in person, on every Core, alike (`services/portal-modules/portal-modules.ts`);
 *  - the settings are set but unusable: 503 `{error: "module_unavailable"}`;
 *  - a path with a `.` / `..` segment, an encoded or literal separator, a control character, a bad escape or a
 *    double encoding: 400 `{error: "invalid_path"}` (`isSafeSuffix`); not one of the two families: 404;
 *  - a workspace path for a person with no standing there: 403 or 404, as above;
 *  - then the shared forwarding code: 413 and 400 for the body, 503 `{error: "module_unavailable"}` for a
 *    module that fails, times out, redirects or sends too much, an upstream 401 relayed as a 403, and a 503
 *    naming one of the module's own codes (billing's `billing_unavailable`) relayed with that code alone.
 *
 * Public reads. `portalModulePublicApi(name)` is mounted at `/api/portal/<name>/public` ahead of the person gate,
 * and answers anyone, signed in or not, on every Core (billing: a product's name, for the sign-in page):
 *
 *   /public/products/<product>  ->  ${url}/v1/portal/public/products/<product>   GET only; principal {kind: "public"}
 *
 * The request must be one of the module's `publicReads` (`services/portal-modules/portal-modules.ts`), matched
 * from its method and its path as received: `GET`, and one key of 1 to 100 lowercase letters, digits, `.`, `_`
 * and `-`. Every other method, spelling and segment is 404 `{error: "module_not_installed"}`, as is everything
 * when the module is not installed, with nothing read or forwarded; unusable settings are 503
 * `{error: "module_unavailable"}`. Core forwards with the `public` principal, which names no person: whoever is
 * signed in is not looked up, and no query, cookie or credential of theirs is sent. Core relays the module's
 * answer only as the contract's `PublicProduct`, `{name}` and nothing else beside it, with `cache-control: public,
 * max-age=300`, since it is the same for everyone. A 404 from the module is 404 `{error: "not_found"}`; any other
 * answer, or a name that does not parse, is 503 `{error: "module_unavailable"}`. Both carry `cache-control:
 * no-store`. Core has no rate limit of its own on forwarding, so none applies here beyond the module's.
 *
 * Every JSON answer carries the labels of the shared code (`nosniff` and a sandbox policy). A forwarded JSON
 * answer is the module's answer to this person, under an address that is the same for everyone: billing's
 * catalog lists offers and prices to a billing manager and display content to anyone else. So when the module
 * sets no `cache-control` on it, Core answers `cache-control: private, no-store`, and no cache keeps one
 * viewer's answer for another; a `cache-control` the module sets is relayed as it is. The UI route's rules are
 * `assets.ts`'s: GET and HEAD only (any other method is 405 once the caller is allowed), the content types it
 * relays, and its limits. Its assets, billing's icons among them, are the same for everyone and keep the
 * caching the module gives them.
 */

import {PublicProductSchema} from "@mentra/workspace-contract/portal-billing"
import type {ForwardedPrincipal, UserScope} from "@mentra/workspace-contract/server"
import {Hono} from "hono"
import {assetResponseHeaders, methodNotAllowed, relayAsset, UI_ASSET_SEGMENT} from "../../services/forwarding/assets"
import {
  forwardJson,
  forwardedUser,
  jsonAnswerHeaders,
  limitBody,
  requestLogger,
  validRetryAfter,
  type Upstream,
} from "../../services/forwarding/forward"
import {DEFAULT_FORWARDING_LIMITS, isSafeSuffix, rawPathAndQuery} from "../../services/forwarding/upstream-url"
import {
  portalModuleAccess,
  portalModulePublicAccess,
  type PortalModuleAccess,
  type PortalModuleName,
} from "../../services/portal-modules/portal-modules"
import type {UserPrincipal} from "../../services/signin/principal.service"
import {authorize} from "../../services/workspaces/authorization.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {denied} from "../middleware/principal.middleware"

const MODULE_NOT_INSTALLED = "module_not_installed"
const MODULE_UNAVAILABLE = "module_unavailable"

/** How a forwarded JSON answer may be cached when the module does not say: by nobody, since it is one person's. */
const PER_PERSON_CACHE_CONTROL = "private, no-store"

/** `answer`, with {@link PER_PERSON_CACHE_CONTROL} unless it already says how it may be cached. */
function keptByNoCache(answer: Response): Response {
  if (!answer.headers.has("cache-control")) answer.headers.set("cache-control", PER_PERSON_CACHE_CONTROL)
  return answer
}

/** The path every module serves the portal under. */
const UPSTREAM_PREFIX = "/v1/portal"

const WORKSPACES_SEGMENT = "workspaces"

/** Which of the two families of path a request is for. */
type Route = {kind: "workspace"; workspaceId: string} | {kind: "ui"}

/**
 * The route for a path suffix (`/workspaces/ws_1/x`), or null when it is neither. The first segment
 * is matched exactly, as received: no case folding, no decoding, so a spelling the module's own router might
 * read differently is not a route.
 */
function routeOf(suffix: string): Route | null {
  const [, first, second] = suffix.split("/")
  switch (first) {
    case UI_ASSET_SEGMENT: {
      const scope = `/${UI_ASSET_SEGMENT}/`
      return suffix.length > scope.length && suffix.startsWith(scope) ? {kind: "ui"} : null
    }
    case WORKSPACES_SEGMENT:
      // `isSafeSuffix` has already decoded every segment once, so this cannot throw.
      return second ? {kind: "workspace", workspaceId: decodeURIComponent(second)} : null
    default:
      return null
  }
}

/** What a request's path says before anything is decided: the route it is for, or why it is for none. */
type ParsedPath =
  | {route: Route; suffix: string; query: string}
  | {route: null; refusal: "not_found" | "invalid_path"}

function parsePath(c: AppContext, name: PortalModuleName): ParsedPath {
  const {path, query} = rawPathAndQuery(c.req.url)
  const prefix = `/api/portal/${name}`
  const suffix = path.slice(prefix.length)
  if (!path.startsWith(prefix) || (suffix !== "" && !suffix.startsWith("/"))) return {route: null, refusal: "not_found"}
  if (!isSafeSuffix(suffix)) return {route: null, refusal: "invalid_path"}
  const route = routeOf(suffix)
  return route ? {route, suffix, query} : {route: null, refusal: "not_found"}
}

/** Module `name` as Core forwards to it, once it is ready. */
function upstreamOf(name: PortalModuleName, access: Extract<PortalModuleAccess, {state: "ready"}>): Upstream {
  return {
    service: `portal-module-${name}`,
    label: `Portal module ${name}`,
    unavailableError: MODULE_UNAVAILABLE,
    baseUrl: access.baseUrl,
    secret: access.secret,
    limits: DEFAULT_FORWARDING_LIMITS,
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
 * and usable, then the path. Returns the answer Core gives when a step refuses.
 */
function admit(c: AppContext, name: PortalModuleName): Admitted | Response {
  // Fail closed: the gate in front sets the principal, and a router mounted without it must not forward an
  // anonymous request, nor a credential as a person.
  const principal = c.get("principal")
  if (!principal) return c.json({error: "unauthorized"}, 401)
  if (principal.kind !== "user") return c.json({error: "forbidden"}, 403)

  const access = portalModuleAccess(name)
  if (access.state === "hidden") return c.json({error: MODULE_NOT_INSTALLED}, 404)
  if (access.state === "unavailable") return c.json({error: MODULE_UNAVAILABLE}, 503)
  const upstream = upstreamOf(name, access)

  const parsed = parsePath(c, name)
  if (!parsed.route) return c.json({error: parsed.refusal}, parsed.refusal === "invalid_path" ? 400 : 404)
  return {person: principal, upstream, route: parsed.route, suffix: parsed.suffix, query: parsed.query}
}

/** What a workspace path covers, or the refusal: it needs standing in that workspace. */
async function scopeOf(
  c: AppContext,
  person: UserPrincipal,
  route: Extract<Route, {kind: "workspace"}>,
): Promise<UserScope | Response> {
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
    // The body is limited only for a request that `admit` will let past the module's checks, by the same
    // `portalModuleAccess`: a request Core refuses before that is answered without reading it.
    limitBody(c => {
      const principal = c.get("principal")
      const ready = principal?.kind === "user" && portalModuleAccess(name).state === "ready"
      return ready ? DEFAULT_FORWARDING_LIMITS.maxBodyBytes : null
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
      return keptByNoCache(await forwardJson(c, {...request, principal: () => forwardedUser(person, scope)}))
    },
  )
  return api
}

// --- Public reads ------------------------------------------------------------

/** Under the module's mount, where its public reads are. */
const PUBLIC_SEGMENT = "public"

/** The principal of every public read: Core sent it, for nobody. */
const PUBLIC_PRINCIPAL: ForwardedPrincipal = {kind: "public", scope: {kind: "public"}}

/** How long anyone may keep a public read's answer: it is the same for everyone. */
const PUBLIC_CACHE_CONTROL = "public, max-age=300"

/** How a refusal of a public read may be kept: by nobody, so a product put on sale is named at once. */
const REFUSAL_CACHE_CONTROL = "no-store"

/** Core's refusal of a public read: kept by nobody, and with a backoff only when Core passes the module's on. */
function refusal(c: AppContext, error: string, status: 404 | 503, retryAfter: string | null = null): Response {
  c.header("cache-control", REFUSAL_CACHE_CONTROL)
  c.header("retry-after", retryAfter ?? undefined)
  return c.json({error}, status)
}

/**
 * The module's answer to a public read, as Core relays it: the name alone, or Core's refusal. `forwardJson` has
 * set the module's `content-type`, `cache-control` and `retry-after` on the context, and each is replaced here.
 */
async function nameOnly(c: AppContext, upstream: Upstream, answer: Response): Promise<Response> {
  if (answer.status === 404) return refusal(c, "not_found", 404)
  if (answer.status === 200) {
    let body: unknown = null
    try {
      body = JSON.parse(await answer.text())
    } catch {
      // Not JSON: refused below, as a value that is not a name.
    }
    const parsed = PublicProductSchema.safeParse(body)
    if (parsed.success) {
      c.header("cache-control", PUBLIC_CACHE_CONTROL)
      c.header("retry-after", undefined)
      return c.json({name: parsed.data.name}, 200)
    }
    requestLogger(c, upstream, c.get("reqId") ?? "").warn(
      {audience: "public", reason: "not_a_public_product"},
      `${upstream.label} public read answered no name`,
    )
    return refusal(c, MODULE_UNAVAILABLE, 503)
  }
  // Core's own 503 for a module that failed keeps the module's backoff; any other answer is not one Core relays.
  return refusal(c, MODULE_UNAVAILABLE, 503, answer.status === 503 ? validRetryAfter(answer.headers.get("retry-after")) : null)
}

/**
 * The public reads of module `name`, to be mounted at `/api/portal/<name>/public` ahead of the portal's person
 * gate. See the file header for what it forwards: anyone may call, and no person is told to the module.
 */
export function portalModulePublicApi(name: PortalModuleName): Hono<AppEnv> {
  const api = new Hono<AppEnv>()
  api.use("*", jsonAnswerHeaders)
  api.all("/*", async c => {
    // The path as received, so a spelling the router decoded to this mount is not taken for a public read.
    const prefix = `/api/portal/${name}/${PUBLIC_SEGMENT}/`
    const {path} = rawPathAndQuery(c.req.url)
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : null
    const access = rest === null ? {state: "hidden" as const} : portalModulePublicAccess(name, {method: c.req.method, rest})
    if (access.state === "hidden") return refusal(c, MODULE_NOT_INSTALLED, 404)
    if (access.state === "unavailable") return refusal(c, MODULE_UNAVAILABLE, 503)
    const upstream = upstreamOf(name, access)
    // `rest` is a public read, so it holds no character that needs encoding: it is the path the module gets.
    const answer = await forwardJson(c, {
      upstream,
      path: `${UPSTREAM_PREFIX}/${PUBLIC_SEGMENT}/${rest}`,
      // The answer is the same for everyone, and so is what Core asks: no query.
      query: "",
      audience: "public",
      principal: () => PUBLIC_PRINCIPAL,
    })
    return nameOnly(c, upstream, answer)
  })
  return api
}
