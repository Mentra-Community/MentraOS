/**
 * @fileoverview Internal workspace service API, mounted at `/api/internal/workspaces`.
 *
 * This is how the Store and Fleet ask Core about people and workspaces, and how
 * they follow what changes. `serviceAuth` authenticates every route (a signed
 * request from a service Core has a secret for); the request and response shapes
 * are the contract's (`@mentra/workspace-contract`), spoken by its
 * `createCoreWorkspaceClient`.
 *
 * | Route                          | Service      | Answers                                     |
 * | ------------------------------ | ------------ | ------------------------------------------- |
 * | `POST /authorize`              | any          | `AuthorizeResponse`                         |
 * | `POST /principal`              | any          | `PrincipalResponse`, or 401 `invalid_token` |
 * | `POST /memberships/check`      | any          | `{memberships}`                             |
 * | `GET /workspaces/:workspaceId` | any          | `WorkspaceSummary`, or 404                  |
 * | `GET /changes?after=&limit=`   | store, fleet | `WorkspaceChangesResponse`                  |
 * | `POST /credentials`            | store        | `{credentialId, token}`                     |
 * | `POST /users/resolve-email`    | store        | `{mentraUserId}`, or 404 `user_not_found`   |
 *
 * `GET /changes` is the change feed: workspace events and `user.deleted`
 * tombstones in commit order, for a service that follows them (`listChanges`).
 * `after` is the last `seq` it processed, as a decimal string; `limit` defaults to
 * 100 and is clamped to between 1 and 500.
 *
 * A service knows which organization it is talking to from the Core URL it is
 * configured with, and the shared secret proves both sides, so no response
 * names the organization.
 *
 * Failures: a service that may not call a route is 403 `{error: "forbidden"}`; a
 * body that is not what the route takes is 400 `invalid_request`; an identity
 * provider that could not be asked is 503 `{error: "temporarily_unavailable"}`,
 * retryable; expected failures of the services behind a route
 * (`WorkspaceError`) are rendered by the app's error handler.
 *
 * A bearer credential is what a person or a key presented to the Store: a Core
 * key, or a Core access token from Core's sign-in server. Phone tokens, ID
 * tokens and tokens from another issuer are refused. A `mentra_user` credential is the service
 * vouching for a person it already authenticated; Core trusts that assertion,
 * so the person is never an Organization Admin here: that standing comes only
 * from a verified identity (`bearer`).
 *
 * `POST /users/resolve-email` turns an account email into the opaque Mentra
 * user id (the Store's private-miniapp and beta invitations). Core stays the
 * only service that maps account-provider identities to Mentra users: only an
 * email the account directory has confirmed resolves, and its Mentra user is
 * created on first use. A directory that cannot answer is a 503, never "no such
 * person".
 */

import {
  INVALID_TOKEN_ERROR,
  USER_NOT_FOUND_ERROR,
  WORKSPACE_NOT_FOUND_ERROR,
  type AuthorizeCredential,
  type AuthorizeResponse,
  type CorePrincipal as WirePrincipal,
  type MembershipCheckResponse,
  type PrincipalResponse,
  type ResolveEmailResponse,
  type ServiceCredentialResponse,
  type WorkspaceCapability,
  type WorkspaceChangesResponse,
} from "@mentra/workspace-contract"
import {Hono} from "hono"
import {z} from "zod"
import {findAccountByEmail, isGotrueAdminConfigured} from "../../services/account/gotrue.client"
import {principalFromToken, wirePrincipal, type CorePrincipal} from "../../services/signin/principal.service"
import {MENTRA_TENANT_ID} from "../../services/signin/config"
import {findOrCreateUser, isDeletedAccount, isDeletedAccountId} from "../../services/user.service"
import {listChanges} from "../../services/workspaces/audit.service"
import {authorize} from "../../services/workspaces/authorization.service"
import {isCredentialToken, mintServiceCredential} from "../../services/workspaces/credential.service"
import {getWorkspace, listWorkspacesForUser} from "../../services/workspaces/workspace.service"
import type {AppContext, AppEnv} from "../../types/hono.types"
import {InvalidRequest} from "../../types/oauth.types"
import {requireService, serviceAuth} from "../middleware/service-auth.middleware"
import {parseJsonObject, requiredString, requiredStringArray, type JsonObject} from "../workspaces/request"

/** Most workspaces one membership check may ask about. */
const MAX_MEMBERSHIP_CHECK = 100

const app = new Hono<AppEnv>()

// Every route is for a service. This also authenticates the request, so no route is open.
app.use("*", serviceAuth)

// --- Authorization decisions -----------------------------------------------

app.post("/authorize", async c => {
  const body = jsonBody(c)
  const credential = parseCredential(body.credential)
  const request = authorizeFields(body)

  const principal: CorePrincipal | WirePrincipal | null =
    credential.type === "bearer" ? await principalFromToken(credential.token) : await mentraUserPrincipal(credential)

  const decision = wireDecision(await authorize(principal, request))
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

  const principal: CorePrincipal | null = await principalFromToken(token)
  // 401 `invalid_token` is the one 401 the client reads as "this bearer token is not valid".
  if (!principal) return c.json({error: INVALID_TOKEN_ERROR}, 401)

  // A person's memberships; a credential acts for its own workspace and has none.
  const workspaces = principal.kind === "user" ? await listWorkspacesForUser(principal.mentraUserId) : []
  const resolved: PrincipalResponse = {principal: wirePrincipal(principal), workspaces}
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

  // Active workspaces the person is an active member of: anything else (no such workspace, deleted,
  // not a member, left) is null, and a deleted account is a member of nothing.
  const held = new Map(
    (await isDeletedAccountId(mentraUserId) ? [] : await listWorkspacesForUser(mentraUserId)).map(entry => [
      entry.workspaceId,
      entry,
    ]),
  )
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

// --- Change feed -----------------------------------------------------------

// Explicitly the two services that follow it, not "any": a service added later reads nothing until it is named here.
app.get("/changes", requireService("store", "fleet"), async c => {
  const page: WorkspaceChangesResponse = await listChanges({
    after: c.req.query("after") ?? null,
    limit: changesLimit(c.req.query("limit")),
  })
  return c.json(page)
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
  // A deployment without Mentra accounts (a Private Cloud) has nobody to resolve.
  if (!isGotrueAdminConfigured()) return c.json({error: USER_NOT_FOUND_ERROR}, 404)
  const identity = await findAccountByEmail(parsed.data)
  // An address nobody has proven they own names nobody. Only a confirmed email counts, as at sign-in.
  if (!identity?.emailConfirmed) return c.json({error: USER_NOT_FOUND_ERROR}, 404)
  const user = await findOrCreateUser({tenantId: MENTRA_TENANT_ID, tenantUserId: identity.id})
  // An account being deleted names nobody either.
  if (isDeletedAccount(user)) return c.json({error: USER_NOT_FOUND_ERROR}, 404)
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
function requiredId(body: JsonObject, field: string): string {
  const value = body[field]
  if (typeof value !== "string" || !value.trim()) throw new InvalidRequest(`${field} must be a non-empty string`)
  return value
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

/**
 * The `limit` query parameter: absent for the feed's default, otherwise an integer. A number outside the
 * feed's range is clamped by `listChanges`; something that is not a number at all is a malformed request.
 */
function changesLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  if (!/^-?\d+$/.test(raw)) throw new InvalidRequest("limit must be an integer")
  return Number(raw)
}

/**
 * The person a service vouches for, or null for a deleted account (no principal). Never an
 * Organization Admin: that needs a verified identity.
 */
async function mentraUserPrincipal(
  credential: Extract<AuthorizeCredential, {type: "mentra_user"}>,
): Promise<WirePrincipal | null> {
  if (await isDeletedAccountId(credential.mentraUserId)) return null
  return {
    kind: "user",
    mentraUserId: credential.mentraUserId,
    email: null,
    emailVerified: false,
    isOrganizationAdmin: false,
  }
}

/** The decision with its principal in the contract's shape. */
function wireDecision(decision: AuthorizeResponse): AuthorizeResponse {
  return {...decision, principal: decision.principal ? wirePrincipal(decision.principal) : null}
}

export default app
