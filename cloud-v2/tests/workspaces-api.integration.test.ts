/**
 * @fileoverview Public workspace and organization API integration tests.
 *
 * These drive the real Core app (`createApp`) over its routes, with the real
 * middleware, services, models and transactions against a local replica set.
 * One boundary is faked: the identity provider. A fake Supabase project
 * (`support/fake-idp.ts`) signs the access tokens people present as bearers
 * and answers Core's account lookups, so whether a person's email is verified
 * comes from their fake account's confirmation, as it does from GoTrue.
 * Memberships, invitations and credentials are real rows made through the API.
 *
 * The same handlers serve `/api/workspaces` (bearers) and
 * `/api/portal/workspaces` (the workspace portal's session cookie). Most cases
 * drive the first; one representative flow drives the second with portal
 * session cookies.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/workspaces-api.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {createPortalSession} from "../packages/core/src/services/signin/browser-session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {clearDeletionHold, setDeletionHold} from "../packages/core/src/services/workspaces/deletion-hold.service"
import {OPERATOR_KEY_SCOPES, ORGANIZATION_CAPABILITIES} from "../packages/workspace-contract/src/index"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {nextHoldAsOf} from "./support/hold-as-of"
import {
  coreAccessToken,
  ADMIN_COOKIE,
  ADMIN_EMAIL,
  ADMIN_ORIGIN,
  applyEnv,
  HOSTED_ENV,
  PORTAL_COOKIE,
  PORTAL_ORIGIN,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  BrowserSessionModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
] as const

const INVITE_PREFIX = "https://core.example.test/invite/"
/** Hosted Core with a fake Supabase project; `ADMIN_EMAIL` is the only Organization Admin. */
const TEST_ENV: Record<string, string | undefined> = {
  ...HOSTED_ENV,
  CLOUD_CORE_ADMIN_EMAILS: ADMIN_EMAIL,
  CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
  CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: undefined,
  CLOUD_CORE_ENVIRONMENT: undefined,
  CONSOLE2_URL: undefined,
  CLOUD_CORE_WORKSPACE_CREATION: undefined,
  CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: `${INVITE_PREFIX}{token}`,
  RESEND_API_KEY: undefined,
}

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>
let idp: FakeIdp
let restoreEnv: () => void = () => {}

// --- Fixtures --------------------------------------------------------------

interface Person {
  sub: string
  email: string
  emailVerified: boolean
  /** An access token from the fake Supabase project, for `Authorization: Bearer`. */
  bearer: string
  mentraUserId: string
}

/** A portal session cookie, sent with the portal's own `Origin` on unsafe requests. */
interface Session {
  cookie: string
  origin: string
}

/**
 * A person with a Mentra account at the fake identity provider and a Core user, reachable with
 * `Bearer <person.bearer>`. Their email is verified unless `emailVerified` is false.
 */
async function person(key: string, options: {email?: string; emailVerified?: boolean} = {}): Promise<Person> {
  const sub = `supa-${key}`
  const email = options.email ?? `${key}@example.test`
  const emailVerified = options.emailVerified ?? true
  idp.registerUser({sub, email, emailConfirmed: emailVerified})
  const bearer = await coreAccessToken({sub, email, emailVerified})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})
  return {sub, email, emailVerified, bearer, mentraUserId}
}

/** A signed-in session of `who` on the workspace portal (`portal`) or the admin portal (`admin`). */
async function session(portal: "portal" | "admin", who: Person): Promise<Session> {
  const {cookieValue} = await createPortalSession(portal, {
    mentraUserId: who.mentraUserId,
    tenantId: "mentra",
    sourceId: "mentra",
    subject: who.sub,
    email: who.email,
    emailVerified: who.emailVerified,
    authTime: new Date(),
  })
  return portal === "portal"
    ? {cookie: `${PORTAL_COOKIE}=${cookieValue}`, origin: PORTAL_ORIGIN}
    : {cookie: `${ADMIN_COOKIE}=${cookieValue}`, origin: ADMIN_ORIGIN}
}

interface Reply {
  status: number
  headers: Headers
  json: any
  text: string
}

/**
 * One request through the real app. `as` is a person (their bearer), a raw bearer token, or a portal
 * session (its cookie); `raw` sends a body verbatim.
 */
async function call(
  method: string,
  path: string,
  opts: {as?: Person | Session | string; body?: unknown; raw?: string} = {},
): Promise<Reply> {
  const headers: Record<string, string> = {}
  const as = opts.as
  if (typeof as === "string") headers.authorization = `Bearer ${as}`
  else if (as && "bearer" in as) headers.authorization = `Bearer ${as.bearer}`
  else if (as) {
    headers.cookie = as.cookie
    if (method !== "GET" && method !== "HEAD") headers.origin = as.origin
  }
  let body: string | undefined
  if (opts.raw !== undefined) body = opts.raw
  else if (opts.body !== undefined) body = JSON.stringify(opts.body)
  if (body !== undefined) headers["content-type"] = "application/json"
  const response = await app.request(`http://localhost${path}`, {method, headers, body})
  const text = await response.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    // A non-JSON body (a router 404, say) shows up as a failed status assertion rather than a parse error.
  }
  return {status: response.status, headers: response.headers, text, json}
}

async function createWorkspace(owner: Person, name = "Acme") {
  const reply = await call("POST", "/api/workspaces", {as: owner, body: {name}})
  expect(reply.status).toBe(201)
  return reply.json as {workspaceId: string; authorizationRevision: number; membership: {membershipId: string}}
}

/** Invite `invitee` through the API and accept as them. Returns the new membership id. */
async function join(workspaceId: string, inviter: Person, invitee: Person, role: string) {
  const invited = await call("POST", `/api/workspaces/${workspaceId}/invitations`, {
    as: inviter,
    body: {email: invitee.email, role},
  })
  expect(invited.status).toBe(201)
  const token = (invited.json.inviteUrl as string).slice(INVITE_PREFIX.length)
  const accepted = await call("POST", "/api/workspaces/invitations/accept", {as: invitee, body: {token}})
  expect(accepted.status).toBe(200)
  return accepted.json.membershipId as string
}

async function revisionOf(workspaceId: string, as: Person | Session, base = "/api/workspaces"): Promise<number> {
  const reply = await call("GET", `${base}/${workspaceId}`, {as})
  expect(reply.status).toBe(200)
  return reply.json.authorizationRevision
}

/** A workspace with an owner, an admin, a developer and a plain member, all joined through invitations. */
async function newWorkspace() {
  const owner = await person("owner")
  const admin = await person("admin")
  const developer = await person("developer")
  const member = await person("member")
  const stranger = await person("stranger")
  const workspace = await createWorkspace(owner)
  const workspaceId = workspace.workspaceId
  const adminMembershipId = await join(workspaceId, owner, admin, "admin")
  const developerMembershipId = await join(workspaceId, owner, developer, "developer")
  const memberMembershipId = await join(workspaceId, owner, member, "member")
  return {
    workspaceId,
    owner,
    admin,
    developer,
    member,
    stranger,
    ownerMembershipId: workspace.membership.membershipId,
    adminMembershipId,
    developerMembershipId,
    memberMembershipId,
  }
}

/** An operator key (`mak_`) an Organization Admin created through the API. */
async function createOperatorKey(admin: Person, scopes: readonly string[] = ["organization.incidents.read"]) {
  const created = await call("POST", "/api/organization/credentials", {as: admin, body: {name: "ops", scopes}})
  expect(created.status).toBe(201)
  return created.json as {token: string; credential: {credentialId: string}}
}

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("workspaces-api")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  // Startup migrations do not run here; the transactions need their collections and indexes.
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: []})
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv(TEST_ENV)
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  resetIdpTokenCaches()
  idp = await installFakeIdp({
    issuer: SUPABASE_ISSUER,
    jwksUrl: SUPABASE_JWKS,
    hs256Secret: SUPABASE_SECRET,
    projectUrl: SUPABASE_PROJECT,
  })
})

afterEach(() => {
  idp.restore()
  restoreEnv()
})

// --- The owner journey -----------------------------------------------------

describe("owner journey", () => {
  test("create, invite a developer, accept, the developer creates a credential, the admin revokes it", async () => {
    const owner = await person("owner")
    const admin = await person("admin")
    const developer = await person("developer")

    // Create. The creator owns it and gets the full owner capability set back.
    const created = await call("POST", "/api/workspaces", {as: owner, body: {name: "  Acme  "}})
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({
      name: "Acme",
      status: "active",
      authorizationRevision: 0,
      membership: {role: "owner"},
    })
    expect(created.json.capabilities).toContain("workspace.delete")
    const workspaceId: string = created.json.workspaceId

    // Invite the admin, then the developer.
    await join(workspaceId, owner, admin, "admin")
    const invited = await call("POST", `/api/workspaces/${workspaceId}/invitations`, {
      as: owner,
      body: {email: developer.email, role: "developer"},
    })
    expect(invited.status).toBe(201)
    expect(invited.headers.get("cache-control")).toBe("no-store")
    expect(Object.keys(invited.json).sort()).toEqual(["expiresAt", "inviteUrl", "invitationId"].sort())
    expect(invited.json.inviteUrl.startsWith(INVITE_PREFIX)).toBe(true)
    expect(Number.isNaN(Date.parse(invited.json.expiresAt))).toBe(false)
    const token = (invited.json.inviteUrl as string).slice(INVITE_PREFIX.length)

    // The invitee can see what the link is for before accepting it.
    // The token goes in the body, not the path, so request logs never record it.
    const peeked = await call("POST", "/api/workspaces/invitations/peek", {as: developer, body: {token}})
    expect(peeked.status).toBe(200)
    expect(peeked.headers.get("cache-control")).toBe("no-store")
    expect(peeked.json).toEqual({
      invitationId: invited.json.invitationId,
      workspaceId,
      workspaceName: "Acme",
      email: developer.email,
      role: "developer",
      invitedByEmail: owner.email,
      expiresAt: invited.json.expiresAt,
    })
    const inPath = await call("GET", `/api/workspaces/invitations/${token}`, {as: developer})
    expect(inPath.status).toBe(404)
    expect(inPath.text).not.toContain("Acme")

    // The invitation shows in the pending list until it is accepted, without any token material.
    const pending = await call("GET", `/api/workspaces/${workspaceId}/invitations`, {as: owner})
    expect(pending.status).toBe(200)
    expect(pending.json.items).toHaveLength(1)
    expect(Object.keys(pending.json.items[0]).sort()).toEqual(
      ["email", "expiresAt", "invitationId", "invitedByMembershipId", "role"].sort(),
    )
    expect(pending.text).not.toContain(token)

    const accepted = await call("POST", "/api/workspaces/invitations/accept", {as: developer, body: {token}})
    expect(accepted.status).toBe(200)
    expect(accepted.json.workspaceId).toBe(workspaceId)
    expect(accepted.json.membershipId).toMatch(/^wm_/)
    expect((await call("GET", `/api/workspaces/${workspaceId}/invitations`, {as: owner})).json.items).toEqual([])

    // The invitee now lists the workspace with their role.
    const listed = await call("GET", "/api/workspaces", {as: developer})
    expect(listed.status).toBe(200)
    expect(listed.json.items).toHaveLength(1)
    expect(listed.json.items[0]).toMatchObject({workspaceId, name: "Acme", membership: {role: "developer"}})
    expect(listed.json.items[0].capabilities).toContain("miniapps.credentials.create")
    expect(listed.json.items[0].capabilities).not.toContain("workspace.members.read")

    // The developer creates a credential; the secret is returned once, uncached.
    const credential = await call("POST", `/api/workspaces/${workspaceId}/credentials`, {
      as: developer,
      body: {name: "ci", packageNames: ["com.acme.app"]},
    })
    expect(credential.status).toBe(201)
    expect(credential.headers.get("cache-control")).toBe("no-store")
    const secret: string = credential.json.token
    expect(secret).toMatch(/^msk_local_[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{43}$/)
    expect(credential.json.credential).toMatchObject({
      prefix: "msk",
      name: "ci",
      workspaceId,
      scopes: ["miniapps.publish"],
      packageNames: ["com.acme.app"],
      createdByEmail: developer.email,
    })
    const credentialId: string = credential.json.credential.credentialId

    // Listing never carries the token or its hash.
    const credentials = await call("GET", `/api/workspaces/${workspaceId}/credentials`, {as: developer})
    expect(credentials.status).toBe(200)
    expect(credentials.json.items.map((item: any) => item.credentialId)).toEqual([credentialId])
    expect(credentials.text).not.toContain(secret)
    expect(credentials.text).not.toContain(secret.split(".")[1]!)
    expect(credentials.json.items[0]).not.toHaveProperty("token")
    expect(credentials.json.items[0]).not.toHaveProperty("hash")

    // The workspace admin revokes it.
    const revoked = await call("DELETE", `/api/workspaces/${workspaceId}/credentials/${credentialId}`, {as: admin})
    expect(revoked.status).toBe(204)
    expect(revoked.text).toBe("")
    expect((await call("GET", `/api/workspaces/${workspaceId}/credentials`, {as: developer})).json.items).toEqual([])
    // The revoked key no longer authenticates at all.
    expect((await call("GET", "/api/organization", {as: secret})).status).toBe(401)

    // The trail reads newest first and carries the whole journey.
    const audit = await call("GET", `/api/workspaces/${workspaceId}/audit`, {as: owner})
    expect(audit.status).toBe(200)
    const actions = audit.json.items.map((item: any) => item.action)
    expect(actions[0]).toBe("credential.revoked")
    expect(actions).toEqual(
      expect.arrayContaining(["workspace.created", "invitation.created", "invitation.accepted", "credential.created"]),
    )
    expect(audit.json.next).toBeNull()
  })
})

// --- Authentication and credential principals ------------------------------

describe("authentication", () => {
  test("every route refuses an unauthenticated request with 401", async () => {
    const {workspaceId} = await newWorkspace()
    const routes: Array<[string, string]> = [
      ["GET", "/api/workspaces"],
      ["POST", "/api/workspaces"],
      ["GET", `/api/workspaces/${workspaceId}`],
      ["GET", `/api/workspaces/${workspaceId}/members`],
      ["GET", `/api/workspaces/${workspaceId}/audit`],
      ["POST", "/api/workspaces/invitations/peek"],
      ["POST", "/api/workspaces/invitations/accept"],
      ["GET", "/api/portal/workspaces"],
      ["GET", "/api/organization"],
      ["GET", "/api/organization/workspaces"],
      ["POST", `/api/organization/workspaces/${workspaceId}/owners`],
      ["GET", "/api/organization/credentials"],
    ]
    for (const [method, path] of routes) {
      const reply = await call(method, path)
      expect({route: `${method} ${path}`, status: reply.status}).toEqual({route: `${method} ${path}`, status: 401})
      expect(reply.json.error).toBe("unauthorized")
    }

    // A write under a portal's route group without a bearer is a cookie request, so it must come from
    // the portal: from anywhere else it is refused before Core looks for a session.
    const fromPortal = await call("POST", "/api/portal/workspaces", {as: {cookie: "", origin: PORTAL_ORIGIN}})
    expect(fromPortal.status).toBe(401)
    const fromNowhere = await call("POST", "/api/portal/workspaces")
    expect(fromNowhere.status).toBe(403)
    expect(fromNowhere.json.error).toBe("forbidden")
    expect(await WorkspaceModel.countDocuments({})).toBe(1)
  })

  test("a malformed or unknown Core key, or a token Core's sign-in server did not sign, is 401", async () => {
    expect((await call("POST", "/api/workspaces", {as: "msk_local_notakey", body: {name: "X"}})).status).toBe(401)
    expect((await call("GET", "/api/workspaces", {as: "mak_local_notakey"})).status).toBe(401)
    const forged = await idp.mint({sub: "supa-forger", aud: "authenticated"}, {alg: "RS256", key: "attacker"})
    expect((await call("GET", "/api/workspaces", {as: forged})).status).toBe(401)
    expect(await WorkspaceModel.countDocuments({})).toBe(0)
  })

  test("a Core access token from another environment's sign-in server is 401", async () => {
    const restore = applyEnv({CLOUD_CORE_OIDC_ISSUER: "https://account.staging.test"})
    const other = await coreAccessToken({sub: "supa-elsewhere", email: "elsewhere@example.test"})
    restore()
    expect((await call("GET", "/api/workspaces", {as: other})).status).toBe(401)
  })

  test("GET /api/organization is open to Core keys and reports what they may do", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const workspaceKey: string = (
      await call("POST", `/api/workspaces/${workspaceId}/credentials`, {as: developer, body: {name: "ci"}})
    ).json.token
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const operatorKey = (await createOperatorKey(admin)).token

    const asWorkspaceKey = await call("GET", "/api/organization", {as: workspaceKey})
    expect(asWorkspaceKey.status).toBe(200)
    expect(asWorkspaceKey.json).toEqual({capabilities: [], workspaceCreation: {allowed: false, reason: "not_a_person"}})

    const asOperatorKey = await call("GET", "/api/organization", {as: operatorKey})
    expect(asOperatorKey.status).toBe(200)
    expect(asOperatorKey.json).toEqual({
      capabilities: ["organization.incidents.read"],
      workspaceCreation: {allowed: false, reason: "not_a_person"},
    })
  })

  test("a signed-in person sees their organization capabilities", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const other = await person("other")

    const asAdmin = await call("GET", "/api/organization", {as: admin})
    expect(asAdmin.status).toBe(200)
    expect(asAdmin.json).toEqual({
      capabilities: [...ORGANIZATION_CAPABILITIES],
      workspaceCreation: {allowed: true, reason: null},
    })
    expect(await call("GET", "/api/organization", {as: other})).toMatchObject({
      status: 200,
      json: {capabilities: []},
    })
  })

  test("an allowlisted address the identity provider has not verified is not an organization admin", async () => {
    const unverified = await person("org-admin", {email: ADMIN_EMAIL, emailVerified: false})

    expect((await call("GET", "/api/organization/workspaces", {as: unverified})).status).toBe(403)
    expect((await call("GET", "/api/organization", {as: unverified})).json.capabilities).toEqual([])
  })
})

// --- Core keys -------------------------------------------------------------

describe("Core keys", () => {
  test("a workspace key and an operator key get 403 on every workspace route, and change nothing", async () => {
    const ws = await newWorkspace()
    const id = ws.workspaceId
    const workspaceKey = (
      await call("POST", `/api/workspaces/${id}/credentials`, {as: ws.developer, body: {name: "ci"}})
    ).json as {token: string; credential: {credentialId: string}}
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    // Every scope an operator key can carry; none of them is workspace administration.
    const operatorKey = await createOperatorKey(admin, OPERATOR_KEY_SCOPES)
    const invitation = await call("POST", `/api/workspaces/${id}/invitations`, {
      as: ws.owner,
      body: {email: "hire@example.test", role: "member"},
    })
    expect(invitation.status).toBe(201)
    const token = (invitation.json.inviteUrl as string).slice(INVITE_PREFIX.length)
    const revision = await revisionOf(id, ws.owner)
    const auditEvents = await WorkspaceAuditEventModel.countDocuments({})

    const routes: Array<[method: string, path: string, body?: unknown]> = [
      ["GET", "/api/workspaces"],
      ["POST", "/api/workspaces", {name: "Sneaky"}],
      ["POST", "/api/workspaces/invitations/peek", {token}],
      ["POST", "/api/workspaces/invitations/accept", {token}],
      ["GET", `/api/workspaces/${id}`],
      ["PATCH", `/api/workspaces/${id}`, {name: "Sneaky", expectedRevision: revision}],
      ["DELETE", `/api/workspaces/${id}`, {confirmName: "Acme"}],
      ["GET", `/api/workspaces/${id}/members`],
      ["PATCH", `/api/workspaces/${id}/members/${ws.memberMembershipId}`, {role: "admin", expectedRevision: revision}],
      ["DELETE", `/api/workspaces/${id}/members/${ws.memberMembershipId}`, {expectedRevision: revision}],
      ["POST", `/api/workspaces/${id}/leave`],
      ["GET", `/api/workspaces/${id}/invitations`],
      ["POST", `/api/workspaces/${id}/invitations`, {email: "sneaky@example.test", role: "owner"}],
      ["DELETE", `/api/workspaces/${id}/invitations/${invitation.json.invitationId}`],
      ["GET", `/api/workspaces/${id}/credentials`],
      ["POST", `/api/workspaces/${id}/credentials`, {name: "sneaky"}],
      ["DELETE", `/api/workspaces/${id}/credentials/${workspaceKey.credential.credentialId}`],
      ["GET", `/api/workspaces/${id}/audit`],
      // The same handlers under the portals' route groups refuse keys too.
      ["GET", "/api/portal/workspaces"],
      ["GET", `/api/portal/workspaces/${id}`],
      ["GET", `/api/admin/workspaces/${id}`],
    ]
    for (const [label, key] of [
      ["workspace key", workspaceKey.token],
      ["operator key", operatorKey.token],
    ] as const) {
      for (const [method, path, body] of routes) {
        const reply = await call(method, path, {as: key, body})
        const route = `${label}: ${method} ${path}`
        expect({route, status: reply.status}).toEqual({route, status: 403})
        expect(reply.json.error).toBe("forbidden")
      }
    }

    // Nothing moved: no workspace, revision, membership, invitation or key changed, and nothing was audited.
    expect(await WorkspaceModel.countDocuments({})).toBe(1)
    expect(await revisionOf(id, ws.owner)).toBe(revision)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: id, status: "active"})).toBe(4)
    expect(await WorkspaceInvitationModel.countDocuments({workspaceId: id, status: "pending"})).toBe(1)
    expect(await AccessCredentialModel.countDocuments({revokedAt: null})).toBe(2)
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(auditEvents)
  })
})

// --- Workspace creation policy ---------------------------------------------

describe("GET /api/organization: workspace creation", () => {
  test("a person with a verified email may create a workspace; an unverified one may not", async () => {
    const verifiedPerson = await person("verified")
    const unverifiedPerson = await person("unverified", {emailVerified: false})

    const allowed = await call("GET", "/api/organization", {as: verifiedPerson})
    expect(allowed.status).toBe(200)
    expect(allowed.json).toEqual({capabilities: [], workspaceCreation: {allowed: true, reason: null}})
    const unverified = await call("GET", "/api/organization", {as: unverifiedPerson})
    expect(unverified.json).toEqual({capabilities: [], workspaceCreation: {allowed: false, reason: "email_unverified"}})

    // The answer is what creating actually does.
    expect((await call("POST", "/api/workspaces", {as: verifiedPerson, body: {name: "Mine"}})).status).toBe(201)
    const refused = await call("POST", "/api/workspaces", {as: unverifiedPerson, body: {name: "Spam Inc"}})
    expect(refused.status).toBe(403)
    expect(refused.json.error).toBe("email_unverified")
  })

  test("under CLOUD_CORE_WORKSPACE_CREATION=organization-admins only Organization Admins may", async () => {
    process.env.CLOUD_CORE_WORKSPACE_CREATION = "organization-admins"
    const someone = await person("someone")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    expect((await call("GET", "/api/organization", {as: someone})).json.workspaceCreation).toEqual({
      allowed: false,
      reason: "organization_admins_only",
    })
    expect((await call("GET", "/api/organization", {as: admin})).json.workspaceCreation).toEqual({
      allowed: true,
      reason: null,
    })
    expect((await call("POST", "/api/workspaces", {as: someone, body: {name: "Acme"}})).status).toBe(403)
    expect((await call("POST", "/api/workspaces", {as: admin, body: {name: "Acme"}})).status).toBe(201)
  })

  test("a Core key is not a person and may never create one", async () => {
    const owner = await person("owner")
    const {workspaceId} = await createWorkspace(owner)
    const workspaceKey: string = (
      await call("POST", `/api/workspaces/${workspaceId}/credentials`, {as: owner, body: {name: "ci"}})
    ).json.token
    const operatorKey = (await createOperatorKey(await person("org-admin", {email: ADMIN_EMAIL}))).token

    for (const key of [workspaceKey, operatorKey]) {
      expect((await call("GET", "/api/organization", {as: key})).json.workspaceCreation).toEqual({
        allowed: false,
        reason: "not_a_person",
      })
      expect((await call("POST", "/api/workspaces", {as: key, body: {name: "Keyed"}})).status).toBe(403)
    }
    expect(await WorkspaceModel.countDocuments({name: "Keyed"})).toBe(0)
  })
})

// --- Workspaces ------------------------------------------------------------

describe("workspaces", () => {
  test("a person whose email is not verified cannot create a workspace", async () => {
    const unverified = await person("unverified-creator", {emailVerified: false})

    const reply = await call("POST", "/api/workspaces", {as: unverified, body: {name: "Spam Inc"}})

    expect(reply.status).toBe(403)
    expect(reply.json.error).toBe("email_unverified")
    expect(await WorkspaceModel.countDocuments({})).toBe(0)
  })

  test("creation validates the name", async () => {
    const owner = await person("owner")

    for (const body of [{}, {name: ""}, {name: "   "}, {name: 7}, {name: "x".repeat(81)}, {name: null}, []]) {
      const reply = await call("POST", "/api/workspaces", {as: owner, body})
      expect({body, status: reply.status}).toEqual({body, status: 400})
      expect(reply.json.error).toBe("invalid_request")
      expect(typeof reply.json.error_description).toBe("string")
    }
    expect((await call("POST", "/api/workspaces", {as: owner, raw: "{nope"})).status).toBe(400)
    expect(await WorkspaceModel.countDocuments({})).toBe(0)
    expect((await call("POST", "/api/workspaces", {as: owner, body: {name: "x".repeat(80)}})).status).toBe(201)
  })

  test("creation can be limited to organization admins", async () => {
    process.env.CLOUD_CORE_WORKSPACE_CREATION = "organization-admins"
    const owner = await person("owner")
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const refused = await call("POST", "/api/workspaces", {as: owner, body: {name: "Acme"}})
    expect(refused.status).toBe(403)
    expect(refused.json.error).toBe("forbidden")
    expect((await call("POST", "/api/workspaces", {as: admin, body: {name: "Acme"}})).status).toBe(201)
  })

  test("GET /:workspaceId returns the summary, the caller's membership and capabilities", async () => {
    const ws = await newWorkspace()

    const asDeveloper = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.developer})
    expect(asDeveloper.status).toBe(200)
    expect(asDeveloper.json).toMatchObject({
      workspaceId: ws.workspaceId,
      name: "Acme",
      status: "active",
      membership: {membershipId: ws.developerMembershipId, role: "developer"},
    })
    expect(asDeveloper.json.authorizationRevision).toBeGreaterThan(0)
    expect(asDeveloper.json.capabilities).toContain("miniapps.publish")
    expect(asDeveloper.json.capabilities).not.toContain("workspace.settings.manage")

    // An organization admin who is not a member acts as owner and has no membership of their own.
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const asOrgAdmin = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: admin})
    expect(asOrgAdmin.status).toBe(200)
    expect(asOrgAdmin.json.membership).toBeNull()
    expect(asOrgAdmin.json.capabilities).toContain("workspace.delete")
    // It says why, so a screen can name their role and where their powers come from.
    expect(asOrgAdmin.json.organizationAdmin).toBe(true)
    expect(asDeveloper.json.organizationAdmin).toBe(false)

    // An organization admin who joined as a Member: their membership says Member, their capabilities Owner.
    await join(ws.workspaceId, ws.owner, admin, "member")
    const asMemberAdmin = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: admin})
    expect(asMemberAdmin.json.membership).toMatchObject({role: "member"})
    expect(asMemberAdmin.json.capabilities).toContain("workspace.delete")
    expect(asMemberAdmin.json.organizationAdmin).toBe(true)
  })

  test("a non-member is 403 and an unknown workspace is 404", async () => {
    const ws = await newWorkspace()

    const nonMember = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.stranger})
    expect(nonMember.status).toBe(403)
    expect(nonMember.json.error).toBe("forbidden")
    const unknown = await call("GET", "/api/workspaces/ws_missing", {as: ws.owner})
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe("workspace_not_found")
  })

  test("GET /api/workspaces lists only the caller's workspaces", async () => {
    const ws = await newWorkspace()
    await createWorkspace(ws.stranger, "Elsewhere")

    const mine = await call("GET", "/api/workspaces", {as: ws.member})
    expect(mine.json.items.map((item: any) => item.workspaceId)).toEqual([ws.workspaceId])
    expect(await call("GET", "/api/workspaces", {as: await person("nobody")})).toMatchObject({
      status: 200,
      json: {items: []},
    })
  })

  describe("renaming", () => {
    test("an admin renames with the current revision and gets the new revision back", async () => {
      const ws = await newWorkspace()
      const revision = await revisionOf(ws.workspaceId, ws.admin)

      const renamed = await call("PATCH", `/api/workspaces/${ws.workspaceId}`, {
        as: ws.admin,
        body: {name: " Beta ", expectedRevision: revision},
      })

      expect(renamed.status).toBe(200)
      expect(renamed.json).toMatchObject({
        workspaceId: ws.workspaceId,
        name: "Beta",
        authorizationRevision: revision + 1,
        membership: {role: "admin"},
      })
      expect((await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.owner})).json.name).toBe("Beta")
    })

    test("a stale revision is 409 membership_changed", async () => {
      const ws = await newWorkspace()
      const revision = await revisionOf(ws.workspaceId, ws.admin)

      const stale = await call("PATCH", `/api/workspaces/${ws.workspaceId}`, {
        as: ws.admin,
        body: {name: "Beta", expectedRevision: revision - 1},
      })

      expect(stale.status).toBe(409)
      expect(stale.json.error).toBe("membership_changed")
    })

    test("a developer cannot rename", async () => {
      const ws = await newWorkspace()
      const revision = await revisionOf(ws.workspaceId, ws.developer)

      const reply = await call("PATCH", `/api/workspaces/${ws.workspaceId}`, {
        as: ws.developer,
        body: {name: "Beta", expectedRevision: revision},
      })

      expect(reply.status).toBe(403)
      expect(reply.json.error).toBe("forbidden")
    })

    test("the body is validated: expectedRevision must be a non-negative integer", async () => {
      const ws = await newWorkspace()
      const url = `/api/workspaces/${ws.workspaceId}`

      for (const expectedRevision of [undefined, -1, 1.5, "1", null, Number.MAX_VALUE * 2]) {
        const reply = await call("PATCH", url, {as: ws.admin, body: {name: "Beta", expectedRevision}})
        expect({expectedRevision, status: reply.status}).toEqual({expectedRevision, status: 400})
        expect(reply.json.error).toBe("invalid_request")
      }
      expect((await call("PATCH", url, {as: ws.admin, body: {expectedRevision: 0}})).status).toBe(400)
      expect((await call("PATCH", url, {as: ws.admin, body: {name: 5, expectedRevision: 0}})).status).toBe(400)
      expect((await call("PATCH", url, {as: ws.admin, raw: "[]"})).status).toBe(400)
      expect((await call("PATCH", url, {as: ws.admin, raw: ""})).status).toBe(400)
    })
  })

  describe("deleting", () => {
    test("the owner deletes the workspace without Core calling any other service", async () => {
      const ws = await newWorkspace()
      const outbound = spyOn(globalThis, "fetch")
      try {
        const reply = await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {
          as: ws.owner,
          body: {confirmName: "Acme"},
        })

        expect(reply.status).toBe(204)
        expect(reply.text).toBe("")
        // The owner's account was looked up (and cached) when they created the workspace.
        expect(outbound).not.toHaveBeenCalled()
      } finally {
        outbound.mockRestore()
      }
      expect((await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.owner})).status).toBe(404)
      expect((await call("GET", "/api/workspaces", {as: ws.owner})).json.items).toEqual([])
      expect(await WorkspaceModel.findOne({workspaceId: ws.workspaceId}).lean()).toMatchObject({status: "deleted"})
      expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws.workspaceId, status: "active"})).toBe(0)
      expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: ws.workspaceId, action: "workspace.deleted"})).toBe(
        1,
      )
    })

    test("the confirmation name must match", async () => {
      const ws = await newWorkspace()

      const wrong = await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {
        as: ws.owner,
        body: {confirmName: "Not Acme"},
      })
      expect(wrong.status).toBe(400)
      expect(wrong.json.error).toBe("invalid_request")
      expect((await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {as: ws.owner, body: {}})).status).toBe(400)
      expect((await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {as: ws.owner})).status).toBe(400)
      expect((await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.owner})).status).toBe(200)
    })

    test("only an owner (or an organization admin) can delete", async () => {
      const ws = await newWorkspace()

      const asAdmin = await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {
        as: ws.admin,
        body: {confirmName: "Acme"},
      })
      expect(asAdmin.status).toBe(403)

      const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})
      expect(
        (await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {as: orgAdmin, body: {confirmName: "Acme"}})).status,
      ).toBe(204)
    })

    test("a workspace a service holds is refused with 409 workspace_has_holds and the holds, on every route group, to an owner and an Organization Admin alike", async () => {
      const ws = await newWorkspace()
      await setDeletionHold("store", ws.workspaceId, {reason: "owns_miniapps", count: 3, asOf: nextHoldAsOf()})
      const orgAdmin = await person("org-admin", {email: ADMIN_EMAIL})
      const callers: Array<[string, Person | Session]> = [
        ["/api/workspaces", ws.owner],
        ["/api/workspaces", orgAdmin],
        ["/api/portal/workspaces", await session("portal", ws.owner)],
        ["/api/portal/workspaces", await session("portal", orgAdmin)],
        ["/api/admin/workspaces", await session("admin", orgAdmin)],
      ]

      for (const [base, as] of callers) {
        const reply = await call("DELETE", `${base}/${ws.workspaceId}`, {as, body: {confirmName: "Acme"}})
        expect({base, status: reply.status, body: reply.json}).toEqual({
          base,
          status: 409,
          body: {
            error: "workspace_has_holds",
            error_description: "This workspace still owns 3 miniapps. Delete them in the Developer Console first.",
            holds: [{service: "store", reason: "owns_miniapps", count: 3}],
          },
        })
      }
      expect((await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.owner})).status).toBe(200)
      expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: ws.workspaceId, action: "workspace.deleted"})).toBe(0)

      // The Store clears its hold once the workspace owns no miniapp; then the delete goes through.
      await clearDeletionHold("store", ws.workspaceId, {asOf: nextHoldAsOf()})
      expect(
        (await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {as: ws.owner, body: {confirmName: "Acme"}})).status,
      ).toBe(204)
    })

    test("someone who may not delete is refused as before, and learns nothing about the holds", async () => {
      const ws = await newWorkspace()
      await setDeletionHold("store", ws.workspaceId, {reason: "owns_miniapps", count: 3, asOf: nextHoldAsOf()})

      const reply = await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {as: ws.admin, body: {confirmName: "Acme"}})
      expect(reply.status).toBe(403)
      expect(reply.json.holds).toBeUndefined()
    })
  })

  test("GET /:workspaceId says what holds the workspace from deletion", async () => {
    const ws = await newWorkspace()
    const holdsSeenBy = async (as: Person) => (await call("GET", `/api/workspaces/${ws.workspaceId}`, {as})).json.deletionHolds

    expect(await holdsSeenBy(ws.owner)).toEqual([])
    await setDeletionHold("store", ws.workspaceId, {reason: "owns_miniapps", count: 2, asOf: nextHoldAsOf()})
    await setDeletionHold("fleet", ws.workspaceId, {reason: "manages_devices", asOf: nextHoldAsOf()})
    const expected = [
      {service: "fleet", reason: "manages_devices"},
      {service: "store", reason: "owns_miniapps", count: 2},
    ]
    expect(await holdsSeenBy(ws.owner)).toEqual(expected)
    expect(await holdsSeenBy(ws.developer)).toEqual(expected)
    // A rename answers the same detail, holds included.
    const renamed = await call("PATCH", `/api/workspaces/${ws.workspaceId}`, {
      as: ws.owner,
      body: {name: "Beta", expectedRevision: await revisionOf(ws.workspaceId, ws.owner)},
    })
    expect(renamed.json.deletionHolds).toEqual(expected)
    // A new workspace has none.
    expect((await createWorkspace(ws.stranger, "Fresh") as {deletionHolds?: unknown}).deletionHolds).toEqual([])
  })
})

// --- Members ---------------------------------------------------------------

describe("members", () => {
  test("an admin lists members with their membership ids, emails, roles and start times", async () => {
    const ws = await newWorkspace()

    const reply = await call("GET", `/api/workspaces/${ws.workspaceId}/members`, {as: ws.admin})

    expect(reply.status).toBe(200)
    const byId = new Map<string, any>(reply.json.items.map((item: any) => [item.membershipId, item]))
    expect(byId.size).toBe(4)
    expect(byId.get(ws.ownerMembershipId)).toMatchObject({
      mentraUserId: ws.owner.mentraUserId,
      email: ws.owner.email,
      role: "owner",
    })
    expect(byId.get(ws.adminMembershipId)).toMatchObject({mentraUserId: ws.admin.mentraUserId, role: "admin"})
    expect(byId.get(ws.developerMembershipId)).toMatchObject({email: ws.developer.email, role: "developer"})
    expect(byId.get(ws.memberMembershipId)).toMatchObject({email: ws.member.email, role: "member"})
    // Oldest first: the creator, then the invitees in the order they joined.
    expect(reply.json.items.map((item: any) => item.membershipId)).toEqual([
      ws.ownerMembershipId,
      ws.adminMembershipId,
      ws.developerMembershipId,
      ws.memberMembershipId,
    ])
    for (const item of reply.json.items) {
      expect(Object.keys(item).sort()).toEqual(["email", "membershipId", "mentraUserId", "pending", "role", "startedAt"].sort())
      expect(item.pending).toBe(false)
      expect(Number.isNaN(Date.parse(item.startedAt))).toBe(false)
    }
  })

  test("a member imported from the Store who has not signed in yet is listed as pending, with no user id", async () => {
    const ws = await newWorkspace()
    const startedAt = new Date("2026-01-05T10:00:00.000Z")
    await WorkspaceMembershipModel.create({
      membershipId: "wm_imported_pending",
      workspaceId: ws.workspaceId,
      mentraUserId: null,
      pendingWorkosUserId: "user_01PENDING",
      email: "dev@acme.example",
      role: "developer",
      roleHistory: [{role: "developer", from: startedAt, authorizationRevision: 0}],
      status: "active",
      startedAt,
    })

    for (const [base, as] of [
      ["/api/workspaces", ws.owner],
      ["/api/admin/workspaces", await session("admin", await person("orgadmin", {email: ADMIN_EMAIL}))],
    ] as const) {
      const reply = await call("GET", `${base}/${ws.workspaceId}/members`, {as})
      expect(reply.status).toBe(200)
      const pending = reply.json.items.find((item: any) => item.membershipId === "wm_imported_pending")
      // The WorkOS id is the Store's identifier, never shown.
      expect(pending).toEqual({
        membershipId: "wm_imported_pending",
        mentraUserId: null,
        email: "dev@acme.example",
        role: "developer",
        startedAt: startedAt.toISOString(),
        pending: true,
      })
      expect(reply.json.items.filter((item: any) => item.pending)).toHaveLength(1)
    }
  })

  test("a developer or a plain member gets 403", async () => {
    const ws = await newWorkspace()

    for (const caller of [ws.developer, ws.member, ws.stranger]) {
      const reply = await call("GET", `/api/workspaces/${ws.workspaceId}/members`, {as: caller})
      expect(reply.status).toBe(403)
      expect(reply.json.error).toBe("forbidden")
    }
  })

  test("an owner changes a role with the current revision; a stale revision is 409", async () => {
    const ws = await newWorkspace()
    const revision = await revisionOf(ws.workspaceId, ws.owner)
    const url = `/api/workspaces/${ws.workspaceId}/members/${ws.memberMembershipId}`

    const stale = await call("PATCH", url, {as: ws.owner, body: {role: "developer", expectedRevision: revision - 1}})
    expect(stale.status).toBe(409)
    expect(stale.json.error).toBe("membership_changed")

    const changed = await call("PATCH", url, {as: ws.owner, body: {role: "developer", expectedRevision: revision}})
    expect(changed.status).toBe(200)
    expect(changed.json).toMatchObject({workspaceId: ws.workspaceId, authorizationRevision: revision + 1})
    const members = await call("GET", `/api/workspaces/${ws.workspaceId}/members`, {as: ws.owner})
    expect(members.json.items.find((item: any) => item.membershipId === ws.memberMembershipId).role).toBe("developer")
  })

  test("the service enforces the role rules: an admin cannot promote to admin, a member cannot manage", async () => {
    const ws = await newWorkspace()
    const revision = await revisionOf(ws.workspaceId, ws.admin)
    const url = `/api/workspaces/${ws.workspaceId}/members/${ws.memberMembershipId}`

    const adminPromotes = await call("PATCH", url, {as: ws.admin, body: {role: "admin", expectedRevision: revision}})
    expect(adminPromotes.status).toBe(403)
    expect(adminPromotes.json.error).toBe("forbidden")
    const memberTries = await call("PATCH", url, {as: ws.member, body: {role: "admin", expectedRevision: revision}})
    expect(memberTries.status).toBe(403)
    // A stranger fails at the route's membership gate.
    expect(
      (await call("PATCH", url, {as: ws.stranger, body: {role: "admin", expectedRevision: revision}})).status,
    ).toBe(403)
    const adminDemotes = await call("PATCH", url, {as: ws.admin, body: {role: "developer", expectedRevision: revision}})
    expect(adminDemotes.status).toBe(200)
  })

  test("the role and the revision are validated", async () => {
    const ws = await newWorkspace()
    const revision = await revisionOf(ws.workspaceId, ws.owner)
    const url = `/api/workspaces/${ws.workspaceId}/members/${ws.memberMembershipId}`

    const badRole = await call("PATCH", url, {as: ws.owner, body: {role: "superuser", expectedRevision: revision}})
    expect(badRole.status).toBe(400)
    expect(badRole.json.error).toBe("invalid_role")
    expect((await call("PATCH", url, {as: ws.owner, body: {expectedRevision: revision}})).status).toBe(400)
    expect((await call("PATCH", url, {as: ws.owner, body: {role: ["owner"], expectedRevision: revision}})).status).toBe(
      400,
    )
    expect((await call("PATCH", url, {as: ws.owner, body: {role: "member"}})).status).toBe(400)
    expect((await call("PATCH", url, {as: ws.owner, body: {role: "member", expectedRevision: -3}})).status).toBe(400)
  })

  test("removing a member ends their membership; the last owner cannot be removed", async () => {
    const ws = await newWorkspace()
    const revision = await revisionOf(ws.workspaceId, ws.admin)
    const base = `/api/workspaces/${ws.workspaceId}/members`

    expect((await call("DELETE", `${base}/${ws.memberMembershipId}`, {as: ws.admin})).status).toBe(400)
    const removed = await call("DELETE", `${base}/${ws.memberMembershipId}`, {
      as: ws.admin,
      body: {expectedRevision: revision},
    })
    expect(removed.status).toBe(204)
    expect(removed.text).toBe("")
    expect((await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.member})).status).toBe(403)

    const lastOwner = await call("DELETE", `${base}/${ws.ownerMembershipId}`, {
      as: ws.owner,
      body: {expectedRevision: await revisionOf(ws.workspaceId, ws.owner)},
    })
    expect(lastOwner.status).toBe(409)
    expect(lastOwner.json.error).toBe("last_owner")
    const unknown = await call("DELETE", `${base}/wm_missing`, {
      as: ws.admin,
      body: {expectedRevision: await revisionOf(ws.workspaceId, ws.admin)},
    })
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe("not_found")
  })

  test("a membership of another workspace is 404 through this workspace's URL, even for someone who owns both", async () => {
    const ws = await newWorkspace()
    const other = await createWorkspace(ws.owner, "Other")
    const stranded = await person("other-member")
    const strandedMembershipId = await join(other.workspaceId, ws.owner, stranded, "member")
    const revisionHere = await revisionOf(ws.workspaceId, ws.owner)
    const revisionThere = await revisionOf(other.workspaceId, ws.owner)
    const here = `/api/workspaces/${ws.workspaceId}/members/${strandedMembershipId}`

    const promoted = await call("PATCH", here, {
      as: ws.owner,
      body: {role: "developer", expectedRevision: revisionHere},
    })
    expect(promoted.status).toBe(404)
    expect(promoted.json.error).toBe("not_found")
    const removed = await call("DELETE", here, {as: ws.owner, body: {expectedRevision: revisionHere}})
    expect(removed.status).toBe(404)
    expect(removed.json.error).toBe("not_found")

    // Nothing moved: not the member's role or status, nor either workspace's revision.
    const members = await call("GET", `/api/workspaces/${other.workspaceId}/members`, {as: ws.owner})
    expect(members.json.items.find((item: any) => item.membershipId === strandedMembershipId)).toMatchObject({
      role: "member",
      mentraUserId: stranded.mentraUserId,
    })
    expect(await revisionOf(ws.workspaceId, ws.owner)).toBe(revisionHere)
    expect(await revisionOf(other.workspaceId, ws.owner)).toBe(revisionThere)
    // Through its own workspace the same call works, so the 404 above was the scoping.
    const own = await call("PATCH", `/api/workspaces/${other.workspaceId}/members/${strandedMembershipId}`, {
      as: ws.owner,
      body: {role: "developer", expectedRevision: revisionThere},
    })
    expect(own.status).toBe(200)
  })

  test("a member leaves; the last owner cannot; a non-member is 403", async () => {
    const ws = await newWorkspace()

    const left = await call("POST", `/api/workspaces/${ws.workspaceId}/leave`, {as: ws.member})
    expect(left.status).toBe(204)
    expect((await call("GET", "/api/workspaces", {as: ws.member})).json.items).toEqual([])

    const lastOwner = await call("POST", `/api/workspaces/${ws.workspaceId}/leave`, {as: ws.owner})
    expect(lastOwner.status).toBe(409)
    expect(lastOwner.json.error).toBe("last_owner")
    expect((await call("POST", `/api/workspaces/${ws.workspaceId}/leave`, {as: ws.stranger})).status).toBe(403)
  })
})

// --- Invitations -----------------------------------------------------------

describe("invitations", () => {
  test("an admin whose email is not verified cannot invite", async () => {
    const ws = await newWorkspace()
    // The account's address lost its confirmation; Core records it at the admin's next sign-in.
    const unverified = await coreAccessToken({sub: ws.admin.sub, email: ws.admin.email, emailVerified: false})

    const reply = await call("POST", `/api/workspaces/${ws.workspaceId}/invitations`, {
      as: unverified,
      body: {email: "someone@example.test", role: "developer"},
    })

    expect(reply.status).toBe(403)
    expect(reply.json.error).toBe("email_unverified")
    expect(await WorkspaceInvitationModel.countDocuments({email: "someone@example.test"})).toBe(0)
  })

  test("an admin lists, invites and revokes; a developer cannot", async () => {
    const ws = await newWorkspace()
    const base = `/api/workspaces/${ws.workspaceId}/invitations`

    const created = await call("POST", base, {as: ws.admin, body: {email: "New.Hire@Example.test", role: "member"}})
    expect(created.status).toBe(201)
    const listed = await call("GET", base, {as: ws.admin})
    expect(listed.json.items).toHaveLength(1)
    expect(listed.json.items[0]).toMatchObject({
      invitationId: created.json.invitationId,
      email: "new.hire@example.test",
      role: "member",
    })

    expect((await call("GET", base, {as: ws.developer})).status).toBe(403)
    expect((await call("POST", base, {as: ws.developer, body: {email: "x@example.test", role: "member"}})).status).toBe(
      403,
    )
    expect((await call("DELETE", `${base}/${created.json.invitationId}`, {as: ws.developer})).status).toBe(403)

    const revoked = await call("DELETE", `${base}/${created.json.invitationId}`, {as: ws.admin})
    expect(revoked.status).toBe(204)
    expect((await call("GET", base, {as: ws.admin})).json.items).toEqual([])
    const again = await call("DELETE", `${base}/${created.json.invitationId}`, {as: ws.admin})
    expect(again.status).toBe(404)
    expect(again.json.error).toBe("invitation_not_found")
  })

  test("an invitation of another workspace is 404 through this workspace's URL, and stays pending", async () => {
    const ws = await newWorkspace()
    const other = await createWorkspace(ws.owner, "Other")
    const invited = await call("POST", `/api/workspaces/${other.workspaceId}/invitations`, {
      as: ws.owner,
      body: {email: "hire@example.test", role: "member"},
    })
    expect(invited.status).toBe(201)

    const wrongWorkspace = await call(
      "DELETE",
      `/api/workspaces/${ws.workspaceId}/invitations/${invited.json.invitationId}`,
      {as: ws.owner},
    )

    expect(wrongWorkspace.status).toBe(404)
    expect(wrongWorkspace.json.error).toBe("invitation_not_found")
    const pending = await call("GET", `/api/workspaces/${other.workspaceId}/invitations`, {as: ws.owner})
    expect(pending.json.items.map((item: any) => item.invitationId)).toEqual([invited.json.invitationId])
    const own = await call("DELETE", `/api/workspaces/${other.workspaceId}/invitations/${invited.json.invitationId}`, {
      as: ws.owner,
    })
    expect(own.status).toBe(204)
  })

  test("the body is validated, and the service enforces who may invite which role", async () => {
    const ws = await newWorkspace()
    const base = `/api/workspaces/${ws.workspaceId}/invitations`

    for (const body of [
      {},
      {email: "a@example.test"},
      {role: "member"},
      {email: 4, role: "member"},
      {email: "a@b.test", role: 4},
    ]) {
      const reply = await call("POST", base, {as: ws.admin, body})
      expect({body, status: reply.status}).toEqual({body, status: 400})
    }
    expect((await call("POST", base, {as: ws.admin, body: {email: "not-an-email", role: "member"}})).status).toBe(400)
    const badRole = await call("POST", base, {as: ws.admin, body: {email: "a@example.test", role: "emperor"}})
    expect(badRole.status).toBe(400)
    expect(badRole.json.error).toBe("invalid_role")
    expect((await call("POST", base, {as: ws.admin, body: {email: "a@example.test", role: "admin"}})).status).toBe(403)
    expect((await call("POST", base, {as: ws.owner, body: {email: "a@example.test", role: "admin"}})).status).toBe(201)
  })

  test("peeking an unknown token is 404, and accepting the wrong address is 403", async () => {
    const ws = await newWorkspace()
    const outsider = await person("outsider")

    const unknown = await call("POST", "/api/workspaces/invitations/peek", {
      as: outsider,
      body: {token: "not-a-real-token"},
    })
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe("invitation_not_found")
    expect((await call("POST", "/api/workspaces/invitations/peek", {as: outsider, body: {}})).status).toBe(400)
    expect((await call("POST", "/api/workspaces/invitations/peek", {as: outsider, body: {token: 5}})).status).toBe(400)
    expect((await call("POST", "/api/workspaces/invitations/peek", {as: outsider, raw: "{nope"})).status).toBe(400)

    const invited = await call("POST", `/api/workspaces/${ws.workspaceId}/invitations`, {
      as: ws.owner,
      body: {email: "someone-else@example.test", role: "member"},
    })
    const token = (invited.json.inviteUrl as string).slice(INVITE_PREFIX.length)
    const wrong = await call("POST", "/api/workspaces/invitations/accept", {as: outsider, body: {token}})
    expect(wrong.status).toBe(403)
    expect(wrong.json.error).toBe("email_mismatch")

    expect((await call("POST", "/api/workspaces/invitations/accept", {as: outsider, body: {}})).status).toBe(400)
    expect((await call("POST", "/api/workspaces/invitations/accept", {as: outsider, body: {token: 5}})).status).toBe(
      400,
    )
    const missing = await call("POST", "/api/workspaces/invitations/accept", {as: outsider, body: {token: "nope"}})
    expect(missing.status).toBe(404)
    expect(missing.json.error).toBe("invitation_not_found")
  })

  test("accepting needs the invited address verified by the identity provider", async () => {
    const ws = await newWorkspace()
    const invitee = await person("invitee", {emailVerified: false})
    const invited = await call("POST", `/api/workspaces/${ws.workspaceId}/invitations`, {
      as: ws.owner,
      body: {email: invitee.email, role: "member"},
    })
    const token = (invited.json.inviteUrl as string).slice(INVITE_PREFIX.length)

    const unverified = await call("POST", "/api/workspaces/invitations/accept", {as: invitee, body: {token}})
    expect(unverified.status).toBe(403)
    expect(unverified.json.error).toBe("email_mismatch")

    // Once the account confirms the address and the invitee signs in again, the same link works.
    const confirmed = await coreAccessToken({sub: invitee.sub, email: invitee.email, emailVerified: true})
    expect((await call("POST", "/api/workspaces/invitations/accept", {as: confirmed, body: {token}})).status).toBe(200)
  })

  test("the link defaults to the workspace portal's accept page; with neither setting, inviting fails and writes nothing", async () => {
    const ws = await newWorkspace()
    const base = `/api/workspaces/${ws.workspaceId}/invitations`
    delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE

    const defaulted = await call("POST", base, {as: ws.owner, body: {email: "first@example.test", role: "member"}})
    expect(defaulted.status).toBe(201)
    const link = new URL(defaulted.json.inviteUrl)
    expect(link.origin).toBe(PORTAL_ORIGIN)
    const token = link.searchParams.get("workspaceInvite")!
    expect((await call("POST", "/api/workspaces/invitations/peek", {as: ws.owner, body: {token}})).json).toMatchObject({
      workspaceName: "Acme",
      email: "first@example.test",
      role: "member",
    })

    delete process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL
    const invitations = await WorkspaceInvitationModel.countDocuments({})
    const auditEvents = await WorkspaceAuditEventModel.countDocuments({})
    const failed = await call("POST", base, {as: ws.owner, body: {email: "second@example.test", role: "member"}})
    expect(failed.status).toBe(503)
    expect(failed.json.error).toBe("invitations_unavailable")
    expect(failed.text).not.toContain("CLOUD_CORE")
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(invitations)
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(auditEvents)
    // A caller who may not invite this role still hears their own refusal, not the deployment's configuration.
    const refused = await call("POST", base, {as: ws.admin, body: {email: "third@example.test", role: "owner"}})
    expect(refused.status).toBe(403)
    expect(refused.json.error).toBe("forbidden")
  })
})

// --- Credentials -----------------------------------------------------------

describe("workspace credentials", () => {
  async function createKey(ws: {workspaceId: string}, as: Person, body: unknown = {name: "ci"}) {
    return call("POST", `/api/workspaces/${ws.workspaceId}/credentials`, {as, body})
  }

  test("a developer lists only the keys they created; admins and owners list every key", async () => {
    const ws = await newWorkspace()
    const other = await person("other-lister")
    await join(ws.workspaceId, ws.owner, other, "developer")
    const mine = (await createKey(ws, ws.developer, {name: "mine"})).json.credential.credentialId
    const theirs = (await createKey(ws, other, {name: "theirs"})).json.credential.credentialId
    const url = `/api/workspaces/${ws.workspaceId}/credentials`

    const asDeveloper = await call("GET", url, {as: ws.developer})
    expect(asDeveloper.status).toBe(200)
    expect(asDeveloper.json.items.map((item: any) => item.credentialId)).toEqual([mine])
    // Publishing access is not directory access: another creator's email is not shown.
    expect(asDeveloper.text).not.toContain(other.email)

    for (const caller of [ws.admin, ws.owner]) {
      const listed = await call("GET", url, {as: caller})
      expect(listed.json.items.map((item: any) => item.credentialId)).toEqual([theirs, mine])
    }
  })

  test("a plain member cannot list or create credentials", async () => {
    const ws = await newWorkspace()

    expect((await call("GET", `/api/workspaces/${ws.workspaceId}/credentials`, {as: ws.member})).status).toBe(403)
    expect((await createKey(ws, ws.member)).status).toBe(403)
  })

  test("the body is validated", async () => {
    const ws = await newWorkspace()
    const soon = new Date(Date.now() + 86_400_000).toISOString()

    for (const body of [
      {},
      {name: ""},
      {name: 4},
      {name: "ci", packageNames: "com.acme.app"},
      {name: "ci", packageNames: [1]},
      {name: "ci", packageNames: ["not a package"]},
      {name: "ci", expiresAt: "yesterday"},
      {name: "ci", expiresAt: "12345"},
      {name: "ci", expiresAt: "March 1 2030"},
      {name: "ci", expiresAt: "2030-03-01"},
      {name: "ci", expiresAt: "2030-03-01T00:00:00Zjunk"},
      {name: "ci", expiresAt: 12345},
      {name: "ci", expiresAt: new Date(Date.now() - 1000).toISOString()},
    ]) {
      const reply = await createKey(ws, ws.developer, body)
      expect({body, status: reply.status}).toEqual({body, status: 400})
      expect(reply.json.error).toBe("invalid_request")
    }
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)

    const ok = await createKey(ws, ws.developer, {
      name: "ci",
      packageNames: ["com.acme.one", "com.acme.one"],
      expiresAt: soon,
    })
    expect(ok.status).toBe(201)
    expect(ok.json.credential.packageNames).toEqual(["com.acme.one"])
    expect(ok.json.credential.expiresAt).toBe(soon)

    // An offset and a missing seconds field are still ISO 8601 date-times.
    const offset = await createKey(ws, ws.developer, {name: "ci-2", expiresAt: "2099-01-01T00:00+02:00"})
    expect(offset.status).toBe(201)
    expect(offset.json.credential.expiresAt).toBe("2098-12-31T22:00:00.000Z")
  })

  test("a credential can be revoked by its creator, not by another developer", async () => {
    const ws = await newWorkspace()
    const other = await person("other-dev")
    await join(ws.workspaceId, ws.owner, other, "developer")
    const key = (await createKey(ws, ws.developer)).json.credential.credentialId
    const url = `/api/workspaces/${ws.workspaceId}/credentials/${key}`

    const byOther = await call("DELETE", url, {as: other})
    expect(byOther.status).toBe(403)
    expect(byOther.json.error).toBe("forbidden")
    expect((await call("DELETE", url, {as: ws.member})).status).toBe(403)
    expect((await call("DELETE", url, {as: ws.stranger})).status).toBe(403)
    expect((await call("DELETE", url, {as: ws.developer})).status).toBe(204)
    // Revoking a revoked key changes nothing.
    expect((await call("DELETE", url, {as: ws.developer})).status).toBe(204)
  })

  test("a credential is only reachable through its own workspace", async () => {
    const ws = await newWorkspace()
    const otherOwner = await person("other-owner")
    const other = await createWorkspace(otherOwner, "Other")
    const key = (await createKey(ws, ws.developer)).json.credential.credentialId

    // The other workspace's owner may not revoke it through their own workspace's URL either.
    const viaWrongWorkspace = await call("DELETE", `/api/workspaces/${other.workspaceId}/credentials/${key}`, {
      as: otherOwner,
    })
    expect(viaWrongWorkspace.status).toBe(404)
    expect(viaWrongWorkspace.json.error).toBe("not_found")
    expect(await AccessCredentialModel.countDocuments({credentialId: key, revokedAt: null})).toBe(1)

    const unknown = await call("DELETE", `/api/workspaces/${ws.workspaceId}/credentials/nope`, {as: ws.admin})
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe("not_found")
  })
})

// --- Audit -----------------------------------------------------------------

describe("audit", () => {
  test("each event records the id of the request that caused it", async () => {
    const owner = await person("request-id-owner")

    const chosen = await app.request("http://localhost/api/workspaces", {
      method: "POST",
      headers: {authorization: `Bearer ${owner.bearer}`, "content-type": "application/json", "x-request-id": "caller-req-1"},
      body: JSON.stringify({name: "Traced"}),
    })
    const minted = await app.request("http://localhost/api/workspaces", {
      method: "POST",
      headers: {authorization: `Bearer ${owner.bearer}`, "content-type": "application/json"},
      body: JSON.stringify({name: "Minted"}),
    })
    expect([chosen.status, minted.status]).toEqual([201, 201])

    const traced = await WorkspaceAuditEventModel.findOne({
      workspaceId: ((await chosen.json()) as {workspaceId: string}).workspaceId,
    }).lean()
    expect(traced!.requestId).toBe("caller-req-1")
    const mintedId = minted.headers.get("x-request-id")
    expect(mintedId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    const mintedEvent = await WorkspaceAuditEventModel.findOne({
      workspaceId: ((await minted.json()) as {workspaceId: string}).workspaceId,
    }).lean()
    expect(mintedEvent!.requestId).toBe(mintedId)
  })

  test("only an admin or owner reads the audit trail", async () => {
    const ws = await newWorkspace()

    expect((await call("GET", `/api/workspaces/${ws.workspaceId}/audit`, {as: ws.admin})).status).toBe(200)
    for (const caller of [ws.developer, ws.member, ws.stranger]) {
      expect((await call("GET", `/api/workspaces/${ws.workspaceId}/audit`, {as: caller})).status).toBe(403)
    }
  })

  test("events are shaped for display and paged newest-first by `before`", async () => {
    const ws = await newWorkspace()
    const all = await call("GET", `/api/workspaces/${ws.workspaceId}/audit`, {as: ws.owner})
    expect(all.status).toBe(200)
    const total: number = all.json.items.length
    expect(total).toBeGreaterThan(4)
    expect(all.json.next).toBeNull()
    const [first] = all.json.items
    expect(Object.keys(first).sort()).toEqual(
      ["action", "actor", "after", "before", "eventId", "occurredAt", "target"].sort(),
    )
    expect(Object.keys(first.actor).sort()).toEqual(["credentialId", "email", "kind", "service"])
    expect(Number.isNaN(Date.parse(first.occurredAt))).toBe(false)
    const created = all.json.items.find((item: any) => item.action === "workspace.created")
    expect(created.actor).toEqual({kind: "user", email: ws.owner.email, credentialId: null, service: null})
    expect(created.target).toMatchObject({workspaceId: ws.workspaceId})
    expect(created.before).toBeNull()
    expect(created.after).toEqual({name: "Acme", role: "owner"})

    const seen: string[] = []
    let before: string | null = null
    for (let guard = 0; guard < 20; guard++) {
      const page: Reply = await call(
        "GET",
        `/api/workspaces/${ws.workspaceId}/audit?limit=3${before ? `&before=${before}` : ""}`,
        {as: ws.owner},
      )
      expect(page.status).toBe(200)
      expect(page.json.items.length).toBeLessThanOrEqual(3)
      seen.push(...page.json.items.map((item: any) => item.eventId))
      before = page.json.next
      if (!before) break
    }
    expect(seen).toEqual(all.json.items.map((item: any) => item.eventId))
    expect(new Set(seen).size).toBe(total)
  })

  test("credential-looking keys are stripped from target, before and after at any depth", async () => {
    const ws = await newWorkspace()
    await WorkspaceAuditEventModel.create({
      eventId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
      workspaceId: ws.workspaceId,
      action: "credential.created",
      actor: {kind: "user", email: ws.owner.email},
      target: {credentialId: "cred_1", tokenHash: "deadbeef", nested: {secret: "s3cret", keep: 1}},
      before: {password: "hunter2", role: "member"},
      after: {token: "msk_local_leak", list: [{apiSecret: "x", ok: true}], expiresAt: new Date("2030-01-02T03:04:05Z")},
      occurredAt: new Date(),
    })

    const reply = await call("GET", `/api/workspaces/${ws.workspaceId}/audit?limit=200`, {as: ws.owner})

    expect(reply.status).toBe(200)
    const event = reply.json.items.find((item: any) => item.eventId === "01ZZZZZZZZZZZZZZZZZZZZZZZZ")
    expect(event.target).toEqual({credentialId: "cred_1", nested: {keep: 1}})
    expect(event.before).toEqual({role: "member"})
    expect(event.after).toEqual({list: [{ok: true}], expiresAt: "2030-01-02T03:04:05.000Z"})
    for (const leaked of ["deadbeef", "s3cret", "hunter2", "msk_local_leak", "apiSecret"]) {
      expect(reply.text).not.toContain(leaked)
    }
  })

  test("a bad limit is 400 and an oversized one is clamped", async () => {
    const ws = await newWorkspace()
    const url = `/api/workspaces/${ws.workspaceId}/audit`

    for (const limit of ["0", "-1", "abc", "1.5", ""]) {
      expect({limit, status: (await call("GET", `${url}?limit=${limit}`, {as: ws.owner})).status}).toEqual({
        limit,
        status: 400,
      })
    }
    expect((await call("GET", `${url}?limit=100000`, {as: ws.owner})).status).toBe(200)
  })

  test("another workspace's events are never returned", async () => {
    const ws = await newWorkspace()
    const otherOwner = await person("other-owner")
    const other = await createWorkspace(otherOwner, "Other")

    const mine = await call("GET", `/api/workspaces/${ws.workspaceId}/audit`, {as: ws.owner})

    expect(mine.json.items.every((item: any) => item.target?.workspaceId !== other.workspaceId)).toBe(true)
    expect((await call("GET", `/api/workspaces/${other.workspaceId}/audit`, {as: ws.owner})).status).toBe(403)
  })
})

// --- The workspace portal route group ----------------------------------------

describe("the workspace portal route group", () => {
  const PORTAL = "/api/portal/workspaces"

  test("the same handlers serve a full flow with the workspace portal's session cookie", async () => {
    const owner = await person("portal-owner")
    const invitee = await person("portal-invitee")
    const ownerSession = await session("portal", owner)
    const inviteeSession = await session("portal", invitee)

    // Create.
    const created = await call("POST", PORTAL, {as: ownerSession, body: {name: "Portal Co"}})
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({name: "Portal Co", authorizationRevision: 0, membership: {role: "owner"}})
    const workspaceId: string = created.json.workspaceId
    const ownerMembershipId: string = created.json.membership.membershipId

    // Invite, then accept as the invitee.
    const invited = await call("POST", `${PORTAL}/${workspaceId}/invitations`, {
      as: ownerSession,
      body: {email: invitee.email, role: "member"},
    })
    expect(invited.status).toBe(201)
    const token = (invited.json.inviteUrl as string).slice(INVITE_PREFIX.length)
    const peeked = await call("POST", `${PORTAL}/invitations/peek`, {as: inviteeSession, body: {token}})
    expect(peeked.json).toMatchObject({workspaceName: "Portal Co", email: invitee.email, role: "member"})
    const accepted = await call("POST", `${PORTAL}/invitations/accept`, {as: inviteeSession, body: {token}})
    expect(accepted.status).toBe(200)
    expect(accepted.json.workspaceId).toBe(workspaceId)
    const inviteeMembershipId: string = accepted.json.membershipId
    expect((await call("GET", PORTAL, {as: inviteeSession})).json.items.map((item: any) => item.workspaceId)).toEqual([
      workspaceId,
    ])

    // Change the invitee's role.
    const revision = await revisionOf(workspaceId, ownerSession, PORTAL)
    const changed = await call("PATCH", `${PORTAL}/${workspaceId}/members/${inviteeMembershipId}`, {
      as: ownerSession,
      body: {role: "developer", expectedRevision: revision},
    })
    expect(changed.status).toBe(200)
    expect(changed.json.authorizationRevision).toBe(revision + 1)

    // The last owner cannot be removed.
    const lastOwner = await call("DELETE", `${PORTAL}/${workspaceId}/members/${ownerMembershipId}`, {
      as: ownerSession,
      body: {expectedRevision: revision + 1},
    })
    expect(lastOwner.status).toBe(409)
    expect(lastOwner.json.error).toBe("last_owner")

    // Remove the invitee.
    const removed = await call("DELETE", `${PORTAL}/${workspaceId}/members/${inviteeMembershipId}`, {
      as: ownerSession,
      body: {expectedRevision: revision + 1},
    })
    expect(removed.status).toBe(204)
    expect((await call("GET", PORTAL, {as: inviteeSession})).json.items).toEqual([])
    expect((await call("GET", `${PORTAL}/${workspaceId}`, {as: inviteeSession})).status).toBe(403)

    // The bearer route group sees the same workspace and the same trail.
    const members = await call("GET", `/api/workspaces/${workspaceId}/members`, {as: owner})
    expect(members.json.items.map((item: any) => item.membershipId)).toEqual([ownerMembershipId])
    const audit = await call("GET", `/api/workspaces/${workspaceId}/audit`, {as: owner})
    expect(audit.json.items.map((item: any) => item.action).reverse()).toEqual([
      "workspace.created",
      "invitation.created",
      "invitation.accepted",
      "membership.added",
      "membership.role_changed",
      "membership.removed",
    ])
  })

  test("the portal cookie gets the same refusals as a bearer", async () => {
    const ws = await newWorkspace()
    const strangerSession = await session("portal", ws.stranger)
    const developerSession = await session("portal", ws.developer)

    expect((await call("GET", `${PORTAL}/${ws.workspaceId}`, {as: strangerSession})).status).toBe(403)
    expect((await call("GET", `${PORTAL}/${ws.workspaceId}/members`, {as: developerSession})).status).toBe(403)
    expect((await call("GET", `${PORTAL}/ws_missing`, {as: developerSession})).json.error).toBe("workspace_not_found")
    // A cookie request that does not come from the portal is refused before the handler runs.
    const crossSite = await app.request(`http://localhost${PORTAL}/${ws.workspaceId}/leave`, {
      method: "POST",
      headers: {cookie: developerSession.cookie, origin: "https://evil.test"},
    })
    expect(crossSite.status).toBe(403)
    expect(await WorkspaceMembershipModel.countDocuments({membershipId: ws.developerMembershipId, status: "active"})).toBe(
      1,
    )
  })
})

// --- Organization ----------------------------------------------------------

describe("organization workspaces", () => {
  test("an organization admin lists every workspace, paged; a non-admin gets 403", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const one = await createWorkspace(await person("owner-one"), "One")
    const two = await createWorkspace(await person("owner-two"), "Two")
    const three = await createWorkspace(await person("owner-three"), "Three")

    const all = await call("GET", "/api/organization/workspaces", {as: admin})
    expect(all.status).toBe(200)
    // Newest first, and the admin is a member of none of them.
    expect(all.json.items.map((item: any) => item.workspaceId)).toEqual([
      three.workspaceId,
      two.workspaceId,
      one.workspaceId,
    ])
    expect(all.json.next).toBeNull()
    expect(all.json.items[0]).toEqual({
      workspaceId: three.workspaceId,
      name: "Three",
      status: "active",
      authorizationRevision: 0,
    })

    const firstPage = await call("GET", "/api/organization/workspaces?limit=2", {as: admin})
    expect(firstPage.json.items.map((item: any) => item.workspaceId)).toEqual([three.workspaceId, two.workspaceId])
    expect(firstPage.json.next).toBe(two.workspaceId)
    const secondPage = await call("GET", `/api/organization/workspaces?limit=2&before=${firstPage.json.next}`, {
      as: admin,
    })
    expect(secondPage.json.items.map((item: any) => item.workspaceId)).toEqual([one.workspaceId])
    expect(secondPage.json.next).toBeNull()
    expect((await call("GET", "/api/organization/workspaces?before=ws_nope", {as: admin})).status).toBe(400)
    expect((await call("GET", "/api/organization/workspaces?limit=0", {as: admin})).status).toBe(400)

    const nonAdmin = await person("owner-one-again")
    const refused = await call("GET", "/api/organization/workspaces", {as: nonAdmin})
    expect(refused.status).toBe(403)
    expect(refused.json.error).toBe("forbidden")
    // Owning a workspace is not organization authority.
    expect((await call("GET", "/api/organization/workspaces", {as: await person("owner-one")})).status).toBe(403)
  })
})

describe("a deleted account is no principal", () => {
  test("its bearer token, portal sessions and keys are refused from the moment deletion starts", async () => {
    const owner = await person("deleting", {email: ADMIN_EMAIL})
    const ws = await createWorkspace(owner)
    const workspaceKey = await call("POST", `/api/workspaces/${ws.workspaceId}/credentials`, {as: owner, body: {name: "ci"}})
    expect(workspaceKey.status).toBe(201)
    const operatorKey = await call("POST", "/api/organization/credentials", {
      as: owner,
      body: {name: "ops", scopes: ["organization.incidents.read"]},
    })
    expect(operatorKey.status).toBe(201)
    const portal = await session("portal", owner)
    const admin = await session("admin", owner)
    const reachable = async () => ({
      bearer: (await call("GET", "/api/workspaces", {as: owner})).status,
      portal: (await call("GET", "/api/portal/workspaces", {as: portal})).status,
      admin: (await call("GET", "/api/admin/workspaces", {as: admin})).status,
      // `/api/organization` answers every principal, a key included, with what it may do.
      workspaceKey: (await call("GET", "/api/organization", {as: workspaceKey.json.token})).status,
      operatorKey: (await call("GET", "/api/organization", {as: operatorKey.json.token})).status,
    })
    expect(await reachable()).toEqual({bearer: 200, portal: 200, admin: 200, workspaceKey: 200, operatorKey: 200})

    // Account deletion sets the tombstone first; nothing else about the account has changed yet.
    await UserModel.updateOne({mentraUserId: owner.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})

    expect(await reachable()).toEqual({bearer: 401, portal: 401, admin: 401, workspaceKey: 401, operatorKey: 401})
    // So it can neither create nor join a workspace.
    expect((await call("POST", "/api/workspaces", {as: owner, body: {name: "Again"}})).status).toBe(401)
    expect((await call("POST", "/api/portal/workspaces", {as: portal, body: {name: "Again"}})).status).toBe(401)
    expect(await WorkspaceModel.countDocuments({name: "Again"})).toBe(0)
  })
})

describe("ownership recovery", () => {
  test("by mentraUserId: 404 for a user that does not exist, 200 for one that does", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const heir = await person("heir")
    const url = `/api/organization/workspaces/${ws.workspaceId}/owners`

    const unknown = await call("POST", url, {as: admin, body: {mentraUserId: "mu_does_not_exist"}})
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe("user_not_found")
    expect(
      await WorkspaceMembershipModel.countDocuments({workspaceId: ws.workspaceId, mentraUserId: "mu_does_not_exist"}),
    ).toBe(0)

    const recovered = await call("POST", url, {as: admin, body: {mentraUserId: heir.mentraUserId}})
    expect(recovered.status).toBe(200)
    expect(recovered.json).toMatchObject({workspaceId: ws.workspaceId, name: "Acme", status: "active"})
    const heirView = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: heir})
    expect(heirView.json.membership.role).toBe("owner")
    const audit = await WorkspaceAuditEventModel.findOne({
      workspaceId: ws.workspaceId,
      action: "membership.ownership_recovered",
    }).lean()
    expect(audit).toMatchObject({
      actor: {kind: "user", email: ADMIN_EMAIL},
      target: {mentraUserId: heir.mentraUserId},
      before: {role: null},
      after: {role: "owner"},
    })
  })

  test("a deleted account's tombstone is user_not_found, by id or by email, and becomes no owner", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const gone = await person("gone")
    const url = `/api/organization/workspaces/${ws.workspaceId}/owners`
    // Account deletion keeps the users row as a tombstone, set before the account directory deletes the account.
    await UserModel.updateOne({mentraUserId: gone.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
    const revision = await revisionOf(ws.workspaceId, ws.owner)

    for (const body of [{mentraUserId: gone.mentraUserId}, {email: gone.email}]) {
      const reply = await call("POST", url, {as: admin, body})
      expect({body, status: reply.status, error: reply.json.error}).toEqual({body, status: 404, error: "user_not_found"})
    }
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws.workspaceId, mentraUserId: gone.mentraUserId})).toBe(0)
    expect(await revisionOf(ws.workspaceId, ws.owner)).toBe(revision)
  })

  test("an existing member is promoted in place, and an existing owner is left as is", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const url = `/api/organization/workspaces/${ws.workspaceId}/owners`

    expect((await call("POST", url, {as: admin, body: {mentraUserId: ws.member.mentraUserId}})).status).toBe(200)
    const memberView = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.member})
    expect(memberView.json.membership).toEqual({membershipId: ws.memberMembershipId, role: "owner"})

    const revision = await revisionOf(ws.workspaceId, ws.owner)
    expect((await call("POST", url, {as: admin, body: {mentraUserId: ws.owner.mentraUserId}})).status).toBe(200)
    expect(await revisionOf(ws.workspaceId, ws.owner)).toBe(revision)
  })

  test("by email: a confirmed account becomes an owner; an unknown or unconfirmed one is 404, a malformed one 400", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const url = `/api/organization/workspaces/${ws.workspaceId}/owners`
    const revision = await revisionOf(ws.workspaceId, ws.owner)

    const unknown = await call("POST", url, {as: admin, body: {email: "Nobody@Example.test"}})
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe("user_not_found")
    idp.registerUser({sub: "supa-unconfirmed-heir", email: "unconfirmed-heir@example.test", emailConfirmed: false})
    const unconfirmed = await call("POST", url, {as: admin, body: {email: "unconfirmed-heir@example.test"}})
    expect(unconfirmed.status).toBe(404)
    for (const email of ["not-an-email", "two words@example.test", "", 5, null]) {
      const reply = await call("POST", url, {as: admin, body: {email}})
      expect({email, status: reply.status}).toEqual({email, status: 400})
      expect(reply.json.error).toBe("invalid_request")
    }
    expect(await revisionOf(ws.workspaceId, ws.owner)).toBe(revision)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws.workspaceId, status: "active"})).toBe(4)

    // A confirmed account, named by its email in any case, is the Core user it signs in as.
    const heir = await person("email-heir")
    const byEmail = await call("POST", url, {as: admin, body: {email: heir.email.toUpperCase()}})
    expect(byEmail.status).toBe(200)
    const heirView = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: heir})
    expect(heirView.json.membership.role).toBe("owner")
    // The address they were found by names them: in the member list and in the audit log.
    const heirRow = await WorkspaceMembershipModel.findOne({
      workspaceId: ws.workspaceId,
      mentraUserId: heir.mentraUserId,
      status: "active",
    }).lean()
    expect(heirRow!.email).toBe(heir.email.toLowerCase())
    const audit = await WorkspaceAuditEventModel.findOne({
      workspaceId: ws.workspaceId,
      action: "membership.ownership_recovered",
    }).lean()
    expect(audit!.target).toMatchObject({mentraUserId: heir.mentraUserId, email: heir.email.toLowerCase()})
  })

  test("by email: an account directory that cannot answer is 503, never user_not_found", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const url = `/api/organization/workspaces/${ws.workspaceId}/owners`
    // The admin's own account was looked up (and cached) by an earlier request, so only the email lookup fails.
    expect((await call("GET", "/api/organization", {as: admin})).status).toBe(200)
    idp.outage = true
    try {
      const reply = await call("POST", url, {as: admin, body: {email: "someone@example.test"}})
      expect(reply.status).toBe(503)
      expect(reply.json.error).not.toBe("user_not_found")
    } finally {
      idp.outage = false
    }
  })

  test("a deployment without an account directory takes only the mentraUserId form", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const heir = await person("heir")
    const adminSession = await session("admin", admin)
    // Without the service-role key Core cannot ask GoTrue; the admin portal's session still names the admin.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const url = `/api/admin/organization/workspaces/${ws.workspaceId}/owners`

    const byEmail = await call("POST", url, {as: adminSession, body: {email: heir.email}})
    expect(byEmail.status).toBe(400)
    expect(byEmail.json.error).toBe("invalid_request")
    expect(byEmail.json.error_description).toContain("Mentra user id")
    expect((await call("POST", url, {as: adminSession, body: {mentraUserId: heir.mentraUserId}})).status).toBe(200)
  })

  test("recovering ownership needs organization authority, a live workspace and a valid body", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const url = `/api/organization/workspaces/${ws.workspaceId}/owners`

    // A workspace owner is not an organization admin.
    const byOwner = await call("POST", url, {as: ws.owner, body: {mentraUserId: ws.stranger.mentraUserId}})
    expect(byOwner.status).toBe(403)
    expect((await call("POST", url, {as: admin, body: {}})).status).toBe(400)
    expect((await call("POST", url, {as: admin, body: {mentraUserId: ""}})).status).toBe(400)
    // An object must not reach the user lookup as a query operator.
    expect((await call("POST", url, {as: admin, body: {mentraUserId: {$ne: ""}}})).status).toBe(400)
    const noWorkspace = await call("POST", "/api/organization/workspaces/ws_missing/owners", {
      as: admin,
      body: {mentraUserId: ws.stranger.mentraUserId},
    })
    expect(noWorkspace.status).toBe(404)
    expect(noWorkspace.json.error).toBe("not_found")

    await call("DELETE", `/api/workspaces/${ws.workspaceId}`, {as: ws.owner, body: {confirmName: "Acme"}})
    const deleted = await call("POST", url, {as: admin, body: {mentraUserId: ws.stranger.mentraUserId}})
    expect(deleted.status).toBe(410)
    expect(deleted.json.error).toBe("workspace_deleted")
  })
})

describe("operator keys", () => {
  test("creating returns the token once; listing never contains it", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const created = await call("POST", "/api/organization/credentials", {
      as: admin,
      body: {name: "ops", scopes: ["organization.incidents.read", "organization.testing.read"]},
    })
    expect(created.status).toBe(201)
    expect(created.headers.get("cache-control")).toBe("no-store")
    const token: string = created.json.token
    expect(token).toMatch(/^mak_local_[0-9A-HJKMNP-TV-Z]{26}\.[A-Za-z0-9_-]{43}$/)
    expect(created.json.credential).toMatchObject({
      prefix: "mak",
      name: "ops",
      workspaceId: null,
      scopes: ["organization.incidents.read", "organization.testing.read"],
      createdByEmail: ADMIN_EMAIL,
    })

    const listed = await call("GET", "/api/organization/credentials", {as: admin})
    expect(listed.status).toBe(200)
    expect(listed.json.items.map((item: any) => item.credentialId)).toEqual([created.json.credential.credentialId])
    expect(listed.text).not.toContain(token)
    expect(listed.text).not.toContain(token.split(".")[1]!)
    expect(listed.json.items[0]).not.toHaveProperty("token")
    expect(listed.json.items[0]).not.toHaveProperty("hash")
  })

  test("a non-admin, a workspace owner, a workspace key and an operator key are all refused", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const operatorKey = await createOperatorKey(admin, OPERATOR_KEY_SCOPES)
    const workspaceKey: string = (
      await call("POST", `/api/workspaces/${ws.workspaceId}/credentials`, {as: ws.developer, body: {name: "ci"}})
    ).json.token

    for (const caller of [ws.owner, ws.stranger, workspaceKey, operatorKey.token]) {
      for (const [method, path] of [
        ["GET", "/api/organization/credentials"],
        ["POST", "/api/organization/credentials"],
        ["DELETE", `/api/organization/credentials/${operatorKey.credential.credentialId}`],
        ["GET", "/api/organization/workspaces"],
        ["POST", `/api/organization/workspaces/${ws.workspaceId}/owners`],
      ] as const) {
        const reply = await call(method, path, {
          as: caller,
          body:
            method === "POST"
              ? {name: "x", scopes: ["organization.incidents.read"], mentraUserId: ws.stranger.mentraUserId}
              : undefined,
        })
        expect({route: `${method} ${path}`, status: reply.status}).toEqual({route: `${method} ${path}`, status: 403})
        expect(reply.json.error).toBe("forbidden")
      }
    }
    expect(await AccessCredentialModel.countDocuments({credentialKind: "organization", revokedAt: null})).toBe(1)
    expect(await WorkspaceMembershipModel.countDocuments({mentraUserId: ws.stranger.mentraUserId})).toBe(0)
  })

  test("the body is validated, and workspace administration is never a valid scope", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    for (const body of [
      {},
      {name: "ops"},
      {name: "ops", scopes: []},
      {name: "ops", scopes: "organization.incidents.read"},
      {name: "ops", scopes: [1]},
      {name: "ops", scopes: ["organization.workspaces.administer"]},
      {name: "ops", scopes: ["organization.credentials.manage"]},
      {name: "ops", scopes: ["nonsense"]},
      {name: "", scopes: ["organization.incidents.read"]},
      {name: "ops", scopes: ["organization.incidents.read"], expiresAt: "soon"},
      {name: "ops", scopes: ["organization.incidents.read"], expiresAt: "12345"},
      {name: "ops", scopes: ["organization.incidents.read"], expiresAt: "March 1 2030"},
    ]) {
      const reply = await call("POST", "/api/organization/credentials", {as: admin, body})
      expect({body, status: reply.status}).toEqual({body, status: 400})
      expect(reply.json.error).toBe("invalid_request")
    }
    expect(await AccessCredentialModel.countDocuments({})).toBe(0)
  })

  test("revoking ends the key; a workspace key cannot be revoked through the organization route", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const operator = await createOperatorKey(admin)
    const workspaceKey = (
      await call("POST", `/api/workspaces/${ws.workspaceId}/credentials`, {as: ws.developer, body: {name: "ci"}})
    ).json
    expect((await call("GET", "/api/organization", {as: operator.token})).status).toBe(200)

    const wrongRoute = await call("DELETE", `/api/organization/credentials/${workspaceKey.credential.credentialId}`, {
      as: admin,
    })
    expect(wrongRoute.status).toBe(404)
    expect(wrongRoute.json.error).toBe("not_found")
    expect(
      await AccessCredentialModel.countDocuments({credentialId: workspaceKey.credential.credentialId, revokedAt: null}),
    ).toBe(1)
    // And the other way round: an operator key is not a workspace credential.
    const viaWorkspace = await call(
      "DELETE",
      `/api/workspaces/${ws.workspaceId}/credentials/${operator.credential.credentialId}`,
      {as: ws.owner},
    )
    expect(viaWorkspace.status).toBe(404)

    const revoked = await call("DELETE", `/api/organization/credentials/${operator.credential.credentialId}`, {
      as: admin,
    })
    expect(revoked.status).toBe(204)
    expect(revoked.text).toBe("")
    expect((await call("GET", "/api/organization/credentials", {as: admin})).json.items).toEqual([])
    expect((await call("GET", "/api/organization", {as: operator.token})).status).toBe(401)
    expect((await call("DELETE", "/api/organization/credentials/missing", {as: admin})).status).toBe(404)
  })
})
