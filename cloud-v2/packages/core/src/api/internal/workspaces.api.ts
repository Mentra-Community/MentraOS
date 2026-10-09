/**
 * @fileoverview Internal workspace service API, mounted at `/api/internal/workspaces`.
 *
 * This is how the Store and the Fleet integration ask Core about workspaces.
 * `serviceAuth` authenticates every route (a signed request from a service
 * Core has a secret for); the request and response shapes are the contract's
 * (`@mentra/workspace-contract`), spoken by its `createCoreWorkspaceClient`.
 *
 * | Route                                               | Service | Answers                                      |
 * | --------------------------------------------------- | ------- | -------------------------------------------- |
 * | `POST /authorize`                                   | any     | `AuthorizeResponse`                          |
 * | `POST /principal`                                   | any     | `PrincipalResponse`, or 401 `invalid_token`  |
 * | `POST /memberships/check`                           | any     | `{memberships}`                              |
 * | `GET /workspaces/:workspaceId`                      | any     | `WorkspaceSummary`, or 404                   |
 * | `GET /changes?after=&limit=`                        | any     | `{events, next}`                             |
 * | `GET /workspaces/:workspaceId/memberships/history`  | fleet   | `MembershipHistoryResponse`                  |
 * | `GET /workspaces/:workspaceId/memberships/as-of`    | fleet   | `MembershipAsOfResponse`                     |
 * | `POST /memberships/as-of`                           | fleet   | `MembershipAsOfBatchResponse`                |
 * | `POST /credentials`                                 | store   | `{credentialId, token}`                      |
 * | `POST /users/resolve-email`                         | store   | `{mentraUserId}`, or 404 `user_not_found`    |
 *
 * A service knows which organization it is talking to from the Core URL it is
 * configured with, and the shared secret proves both sides, so no response
 * names the organization.
 *
 * Failures: a service that may not call a route is 403 `{error: "forbidden"}`; a
 * body or query that is not what the route takes is 400 `invalid_request`; a
 * sign-in the identity provider could not vouch for is 503
 * `{error: "identity_unavailable"}`, retryable; expected failures of the
 * services behind a route (`WorkspaceError`) are rendered by the app's error
 * handler.
 *
 * The membership history routes are Fleet's, for attributing delayed uploads to the membership and
 * role in effect when they were observed (`membership-history.service`). They are bounded by
 * `CLOUD_CORE_FLEET_HISTORY_MAX_DAYS`: asking about an earlier time is 400 `history_window_exceeded`.
 * They do not limit which workspaces Fleet may ask about yet (`historyScopeAllows`).
 *
 * `POST /users/resolve-email` turns an account email into the opaque Mentra user
 * id (the Store's private-miniapp and beta invitations). Core stays the only
 * service that maps account-provider identities to Mentra users: only an email
 * the account directory has verified resolves, and its Mentra user is created
 * on first use.
 *
 * A `mentra_user` credential is the service vouching for a person it already
 * authenticated (the Store's own sessions). Core trusts that assertion, so the
 * person is never an Organization Admin here: that standing comes only from a
 * verified identity (`bearer`).
 */

import {
  INVALID_TOKEN_ERROR,
  MAX_MEMBERSHIP_AS_OF_QUERIES,
  USER_NOT_FOUND_ERROR,
  WORKSPACE_NOT_FOUND_ERROR,
  type AuthorizeCredential,
  type AuthorizeResponse,
  type CorePrincipal,
  type MembershipAsOfBatchResponse,
  type MembershipAsOfResponse,
  type MembershipCheckResponse,
  type MembershipHistoryResponse,
  type PrincipalResponse,
  type ResolveEmailResponse,
  type ServiceCredentialResponse,
  type WorkspaceCapability,
} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {z} from "zod"
import {findUserByEmail} from "../../services/account/gotrue.client"
import {findOrCreateUser} from "../../services/user.service"
import {authorize, principalFromToken} from "../../services/workspaces/authorization.service"
import {listChanges} from "../../services/workspaces/audit.service"
import {isCredentialToken, mintServiceCredential} from "../../services/workspaces/credential.service"
import {IdentityUnavailableError} from "../../services/workspaces/identity-link.service"
import {
  historyScopeAllows,
  historyWindowStart,
  listMembershipHistory,
  membershipsAsOf,
  parseHistoryTime,
} from "../../services/workspaces/membership-history.service"
import {fail} from "../../services/workspaces/workspace-error"
import {getWorkspace, listWorkspacesForUser} from "../../services/workspaces/workspace.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {requireService, serviceAuth} from "../middleware/service-auth.middleware"
import {parseJsonObject, requiredString, requiredStringArray, type JsonObject} from "../workspaces/request"

/** Most workspaces one membership check may ask about. */
const MAX_MEMBERSHIP_CHECK = 100
/** The default and the largest page of the change feed. */
const DEFAULT_CHANGES_LIMIT = 100
const MAX_CHANGES_LIMIT = 500

const app = new Hono<AppEnv>()

// Every route is for a service. This also authenticates the request, so no route is open.
app.use("*", serviceAuth)

// --- Authorization decisions -----------------------------------------------

app.post("/authorize", async c => {
  const body = jsonBody(c)
  const credential = parseCredential(body.credential)
  const request = authorizeFields(body)

  let principal: CorePrincipal | null
  try {
    principal =
      credential.type === "bearer" ? await principalFromToken(credential.token) : mentraUserPrincipal(credential)
  } catch (err) {
    if (err instanceof IdentityUnavailableError) return identityUnavailable(c)
    throw err
  }

  const decision = await authorize(principal, request)
  // A Core credential that does not validate is a different failure from a person nobody knows.
  if (!principal && credential.type === "bearer" && isCredentialToken(credential.token.trim())) {
    const invalid: AuthorizeResponse = {...decision, reason: "credential_invalid"}
    return c.json(invalid)
  }
  return c.json(decision)
})

app.post("/principal", async c => {
  const {token} = jsonBody(c)
  if (typeof token !== "string") throw new InvalidRequest("token must be a string")

  let principal: CorePrincipal | null
  try {
    principal = await principalFromToken(token)
  } catch (err) {
    if (err instanceof IdentityUnavailableError) return identityUnavailable(c)
    throw err
  }
  // 401 `invalid_token` is the one 401 the client reads as "this bearer token is not valid".
  if (!principal) return c.json({error: INVALID_TOKEN_ERROR}, 401)

  // A person's memberships; a credential acts for its own workspace and has none.
  const workspaces = principal.kind === "user" ? await listWorkspacesForUser(principal.mentraUserId) : []
  const resolved: PrincipalResponse = {principal, workspaces}
  return c.json(resolved)
})

// --- Memberships and workspaces --------------------------------------------

app.post("/memberships/check", async c => {
  const body = jsonBody(c)
  const mentraUserId = requiredId(body, "mentraUserId")
  const workspaceIds = requiredStringArray(body, "workspaceIds")
  if (workspaceIds.length > MAX_MEMBERSHIP_CHECK) {
    throw new InvalidRequest(`workspaceIds may hold at most ${MAX_MEMBERSHIP_CHECK} ids`)
  }
  if (workspaceIds.some(id => !id.trim())) throw new InvalidRequest("each workspace id must be a non-empty string")

  // Active workspaces the person is an active, claimed member of: anything else (no such workspace,
  // deleted, not a member, left) is null.
  const held = new Map((await listWorkspacesForUser(mentraUserId)).map(entry => [entry.workspaceId, entry]))
  const checked: MembershipCheckResponse = {
    // `fromEntries` defines each id as an own property, so an id such as `__proto__` is just a key.
    memberships: Object.fromEntries(
      workspaceIds.map(id => {
        const entry = held.get(id)
        return [id, entry ? {role: entry.membership.role, capabilities: entry.capabilities} : null]
      }),
    ),
  }
  return c.json(checked)
})

app.get("/workspaces/:workspaceId", async c => {
  const workspace = await getWorkspace(c.req.param("workspaceId"))
  if (!workspace) return c.json({error: WORKSPACE_NOT_FOUND_ERROR}, 404)
  return c.json(workspace)
})

// --- Membership history (Fleet) --------------------------------------------
// A workspace that does not exist, or a person who never belonged to it, simply has no history.

app.get("/workspaces/:workspaceId/memberships/history", requireService("fleet"), async c => {
  const workspaceId = historyWorkspace(c)
  const mentraUserId = requiredQueryId(c, "mentraUserId")
  const now = new Date()
  const windowStart = historyWindowStart(now)
  const sinceParam = c.req.query("since")
  const since = sinceParam === undefined ? windowStart : parseHistoryTime(sinceParam, "since", now, windowStart)

  const history: MembershipHistoryResponse = {
    windowStart: windowStart.toISOString(),
    items: await listMembershipHistory(workspaceId, mentraUserId, since),
  }
  return c.json(history)
})

app.get("/workspaces/:workspaceId/memberships/as-of", requireService("fleet"), async c => {
  const workspaceId = historyWorkspace(c)
  const mentraUserId = requiredQueryId(c, "mentraUserId")
  const now = new Date()
  const windowStart = historyWindowStart(now)
  const atParam = c.req.query("at")
  const at = atParam === undefined ? now : parseHistoryTime(atParam, "at", now, windowStart)

  const [result] = await membershipsAsOf([{workspaceId, mentraUserId, at}])
  const answer: MembershipAsOfResponse = {windowStart: windowStart.toISOString(), ...result!}
  return c.json(answer)
})

app.post("/memberships/as-of", requireService("fleet"), async c => {
  const service = c.get("service")!
  const items = jsonBody(c).items
  if (!Array.isArray(items)) throw new InvalidRequest("items must be an array")
  if (items.length > MAX_MEMBERSHIP_AS_OF_QUERIES) {
    throw new InvalidRequest(`items may hold at most ${MAX_MEMBERSHIP_AS_OF_QUERIES} queries`)
  }
  const now = new Date()
  const windowStart = historyWindowStart(now)
  const queries = items.map((item, index) => {
    if (!isRecord(item)) throw new InvalidRequest(`items[${index}] must be an object`)
    const workspaceId = requiredId(item, "workspaceId", `items[${index}].`)
    const mentraUserId = requiredId(item, "mentraUserId", `items[${index}].`)
    if (!historyScopeAllows(service, workspaceId)) fail("forbidden", "outside this service's workspace scope")
    const at =
      item.at === undefined || item.at === null ? now : parseHistoryTime(item.at, `items[${index}].at`, now, windowStart)
    return {workspaceId, mentraUserId, at}
  })

  const answer: MembershipAsOfBatchResponse = {
    windowStart: windowStart.toISOString(),
    items: await membershipsAsOf(queries),
  }
  return c.json(answer)
})

// --- Change feed -----------------------------------------------------------

app.get("/changes", async c => {
  const {events, next} = await listChanges(c.req.query("after") ?? null, changesLimit(c.req.query("limit")))
  return c.json({events, next})
})

// --- Credentials -----------------------------------------------------------

app.post("/credentials", requireService("store"), async c => {
  const service = c.get("service")
  if (!service) throw new Error("serviceAuth did not set the service")
  const body = jsonBody(c)

  const issuedBy = body.issuedBy
  if (!isRecord(issuedBy)) throw new InvalidRequest("issuedBy must be an object")
  // The issuer is whoever signed this request. A body naming another service is refused, not corrected.
  if (issuedBy.service !== undefined && issuedBy.service !== service) {
    return c.json(
      {error: "forbidden", error_description: "issuedBy.service must be the service that signed the request"},
      403,
    )
  }

  const {credential, token} = await mintServiceCredential(service, {
    // `requiredId`, not `requiredString`: an id of only whitespace names no workspace and is a malformed request.
    workspaceId: requiredId(body, "workspaceId"),
    name: requiredString(body, "name"),
    packageNames: requiredStringArray(body, "packageNames"),
    actorEmail: requiredString(issuedBy, "actorEmail"),
  })
  // The token is shown once.
  c.header("cache-control", "no-store")
  const minted: ServiceCredentialResponse = {credentialId: credential.credentialId, token}
  return c.json(minted, 201)
})

// --- People ----------------------------------------------------------------

const emailSchema = z.string().trim().toLowerCase().email()

app.post("/users/resolve-email", requireService("store"), async c => {
  const parsed = emailSchema.safeParse(jsonBody(c).email)
  if (!parsed.success) throw new InvalidRequest("email must be an email address")
  const identity = await findUserByEmail(parsed.data)
  // An address nobody has proven they own names nobody.
  if (!identity?.emailVerified) return c.json({error: USER_NOT_FOUND_ERROR}, 404)
  const user = await findOrCreateUser({tenantId: "mentra", tenantUserId: identity.id})
  const resolved: ResolveEmailResponse = {mentraUserId: user.mentraUserId}
  return c.json(resolved)
})

// --- Helpers ---------------------------------------------------------------

/** The request body, parsed from the text `serviceAuth` verified. */
function jsonBody(c: AppContext): JsonObject {
  return parseJsonObject(c.get("serviceBody") ?? "")
}

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** A string that is not blank: an id with nothing in it names nobody. */
function requiredId(body: JsonObject, field: string, label = ""): string {
  const value = body[field]
  if (typeof value !== "string" || !value.trim()) throw new InvalidRequest(`${label}${field} must be a non-empty string`)
  return value
}

/** A query parameter that must be a non-blank id. */
function requiredQueryId(c: AppContext, name: string): string {
  const value = c.req.query(name)
  if (!value?.trim()) throw new InvalidRequest(`${name} is required`)
  return value
}

/** The workspace a history route names, once the calling service may read its history. */
function historyWorkspace(c: AppContext): string {
  const workspaceId = c.req.param("workspaceId")
  if (!workspaceId?.trim()) throw new InvalidRequest("workspaceId is required")
  if (!historyScopeAllows(c.get("service")!, workspaceId)) fail("forbidden", "outside this service's workspace scope")
  return workspaceId
}

function parseCredential(value: unknown): AuthorizeCredential {
  if (!isRecord(value)) throw new InvalidRequest("credential must be an object")
  if (value.type === "bearer") {
    if (typeof value.token !== "string") throw new InvalidRequest("credential.token must be a string")
    return {type: "bearer", token: value.token}
  }
  if (value.type === "mentra_user") return {type: "mentra_user", mentraUserId: requiredId(value, "mentraUserId")}
  throw new InvalidRequest('credential.type must be "bearer" or "mentra_user"')
}

/**
 * The optional workspace, capability and package of an authorize request; each must be a string when
 * present, and a capability must not be blank.
 */
function authorizeFields(body: JsonObject): {
  workspaceId?: string
  capability?: WorkspaceCapability
  packageName?: string
} {
  const optional = (field: string): string | undefined => {
    const value = body[field]
    if (value === undefined || value === null) return undefined
    if (typeof value !== "string") throw new InvalidRequest(`${field} must be a string`)
    return value
  }
  const workspaceId = optional("workspaceId")
  const capability = optional("capability")
  const packageName = optional("packageName")
  // A blank capability is a malformed request, not "no capability": taken as the latter it would be an allow.
  if (capability !== undefined && !capability.trim()) throw new InvalidRequest("capability must be a non-empty string")
  return {
    ...(workspaceId !== undefined ? {workspaceId} : {}),
    // An unknown, non-empty capability is not granted to anyone: `authorize` denies it as capability_missing.
    ...(capability !== undefined ? {capability: capability as WorkspaceCapability} : {}),
    ...(packageName !== undefined ? {packageName} : {}),
  }
}

/** The person a service vouches for. Never an Organization Admin: that needs a verified identity. */
function mentraUserPrincipal(credential: Extract<AuthorizeCredential, {type: "mentra_user"}>): CorePrincipal {
  return {
    kind: "user",
    mentraUserId: credential.mentraUserId,
    email: null,
    emailVerified: false,
    name: null,
    workosUserId: null,
    isOrganizationAdmin: false,
  }
}

function changesLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_CHANGES_LIMIT
  if (!/^[1-9]\d*$/.test(raw)) throw new InvalidRequest("limit must be a positive integer")
  return Math.min(Number(raw), MAX_CHANGES_LIMIT)
}

/** Nothing was written and trying again once the identity provider answers works. */
function identityUnavailable(c: AppContext) {
  return c.json({error: "identity_unavailable"}, 503)
}

export default app
