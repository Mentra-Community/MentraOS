/**
 * @fileoverview Public workspace and organization API integration tests.
 *
 * These drive the real Core app (`createApp`) over its routes, with the real
 * middleware, services, models and transactions against a local replica set.
 * One boundary is faked: WorkOS identity. A bearer value maps to a fixed
 * WorkOS identity (the same stub `principal-auth.integration.test.ts` uses).
 * Memberships, identity links and credentials are real rows.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/workspaces-api.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {IdentityLinkModel} from "../packages/core/src/models/identity-link.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {resolveWorkosUser} from "../packages/core/src/services/workspaces/identity-link.service"
import * as developerAuth from "../packages/developer-auth/src/index"
import {ORGANIZATION_CAPABILITIES} from "../packages/workspace-contract/src/index"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const MODELS = [
  AccessCredentialModel,
  IdentityLinkModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const ADMIN_EMAIL = "org-admin@example.test"
const INVITE_PREFIX = "https://core.example.test/invite/"
const ENV_KEYS = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
  "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS",
  "CLOUD_CORE_ENVIRONMENT",
  "CLOUD_CORE_WORKSPACE_CREATION",
  "CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE",
  "RESEND_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false
let app: ReturnType<typeof createApp>

// --- WorkOS stub -----------------------------------------------------------

interface Identity {
  id: string
  email: string
  emailVerified: boolean
}

/** WorkOS access token -> the identity it stands for. */
const identities = new Map<string, Identity>()
let requestAuth: ReturnType<typeof spyOn>
let tokenAuth: ReturnType<typeof spyOn>

function authResult(value: string | undefined): developerAuth.DeveloperAuthResult {
  const identity = value ? identities.get(value) : undefined
  if (!identity) return {authenticated: false, reason: "invalid_token"}
  return {
    authenticated: true,
    user: {
      id: identity.id,
      email: identity.email,
      emailVerified: identity.emailVerified,
      firstName: "Test",
      lastName: "User",
    },
    organizationId: null,
    accessToken: value!,
  }
}

// --- Fixtures --------------------------------------------------------------

interface Person {
  bearer: string
  workosUserId: string
  email: string
  mentraUserId: string
}

/** A signed-in WorkOS person with a linked Mentra user, reachable with `Bearer <person.bearer>`. */
async function person(key: string, options: {email?: string; emailVerified?: boolean} = {}): Promise<Person> {
  const workosUserId = `workos_${key}`
  const email = options.email ?? `${key}@example.test`
  const emailVerified = options.emailVerified ?? true
  const bearer = `tok-${key}`
  identities.set(bearer, {id: workosUserId, email, emailVerified})
  const {mentraUserId} = await resolveWorkosUser({workosUserId, email, emailVerified, name: null})
  return {bearer, workosUserId, email, mentraUserId}
}

interface Reply {
  status: number
  headers: Headers
  json: any
  text: string
}

/** One request through the real app. `as` is a person or a raw bearer token; `raw` sends a body verbatim. */
async function call(
  method: string,
  path: string,
  opts: {as?: Person | string; body?: unknown; raw?: string} = {},
): Promise<Reply> {
  const headers: Record<string, string> = {}
  if (opts.as) headers.authorization = `Bearer ${typeof opts.as === "string" ? opts.as : opts.as.bearer}`
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

async function revisionOf(workspaceId: string, as: Person): Promise<number> {
  const reply = await call("GET", `/api/workspaces/${workspaceId}`, {as})
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

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("workspaces-api")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.init()))

  requestAuth = spyOn(developerAuth, "authenticateWorkosRequest").mockImplementation((async (c: any) => {
    const header = c.req.header("authorization")
    return authResult(header?.startsWith("Bearer ") ? header.slice(7) : undefined)
  }) as any)
  tokenAuth = spyOn(developerAuth, "authenticateWorkosAccessToken").mockImplementation((async (token: string) =>
    authResult(token)) as any)
  app = createApp({readinessChecks: []})
})

afterAll(async () => {
  requestAuth?.mockRestore()
  tokenAuth?.mockRestore()
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  identities.clear()
  process.env.CLOUD_CORE_ADMIN_EMAILS = ADMIN_EMAIL
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  delete process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS
  delete process.env.CLOUD_CORE_ENVIRONMENT
  delete process.env.CLOUD_CORE_WORKSPACE_CREATION
  delete process.env.RESEND_API_KEY
  process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = `${INVITE_PREFIX}{token}`
  // No GoTrue: a first sign-in links to a `workos` tenant user.
  delete process.env.SUPABASE_URL
  delete process.env.SUPABASE_SERVICE_ROLE_KEY
  process.env.WORKOS_API_KEY = "test-workos-service-secret"
  process.env.WORKOS_CLIENT_ID = "client_test"
  process.env.WORKOS_COOKIE_PASSWORD = "test-cookie-password-with-at-least-32-characters"
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
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
    expect(peeked.json).toEqual({workspaceName: "Acme", email: developer.email, role: "developer"})
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
      ["GET", "/api/organization"],
      ["GET", "/api/organization/workspaces"],
      ["GET", "/api/organization/credentials"],
    ]
    for (const [method, path] of routes) {
      const reply = await call(method, path)
      expect({route: `${method} ${path}`, status: reply.status}).toEqual({route: `${method} ${path}`, status: 401})
      expect(reply.json).toEqual({error: "unauthorized"})
    }
  })

  test("an msk_ bearer is refused on every workspace route, even for its own workspace", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const created = await call("POST", `/api/workspaces/${workspaceId}/credentials`, {
      as: developer,
      body: {name: "ci"},
    })
    const key: string = created.json.token

    const create = await call("POST", "/api/workspaces", {as: key, body: {name: "Sneaky"}})
    expect([401, 403]).toContain(create.status)
    expect(create.status).toBe(403)
    expect(create.json).toEqual({error: "forbidden"})

    for (const [method, path] of [
      ["GET", "/api/workspaces"],
      ["GET", `/api/workspaces/${workspaceId}`],
      ["GET", `/api/workspaces/${workspaceId}/credentials`],
      ["POST", `/api/workspaces/${workspaceId}/leave`],
    ] as const) {
      const reply = await call(method, path, {as: key})
      expect({route: `${method} ${path}`, status: reply.status}).toEqual({route: `${method} ${path}`, status: 403})
      expect(reply.json).toEqual({error: "forbidden"})
    }
    expect(await WorkspaceModel.countDocuments({name: "Sneaky"})).toBe(0)
  })

  test("a malformed or unknown msk_ bearer is 401", async () => {
    expect((await call("POST", "/api/workspaces", {as: "msk_local_notakey", body: {name: "X"}})).status).toBe(401)
  })

  test("GET /api/organization is open to credential principals and reports what they may do", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const workspaceKey: string = (
      await call("POST", `/api/workspaces/${workspaceId}/credentials`, {as: developer, body: {name: "ci"}})
    ).json.token
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const operatorKey: string = (
      await call("POST", "/api/organization/credentials", {
        as: admin,
        body: {name: "ops", scopes: ["organization.incidents.read"]},
      })
    ).json.token

    const asWorkspaceKey = await call("GET", "/api/organization", {as: workspaceKey})
    expect(asWorkspaceKey.status).toBe(200)
    expect(asWorkspaceKey.json).toEqual({capabilities: []})

    const asOperatorKey = await call("GET", "/api/organization", {as: operatorKey})
    expect(asOperatorKey.status).toBe(200)
    expect(asOperatorKey.json).toEqual({capabilities: ["organization.incidents.read"]})
  })

  test("a signed-in person sees their organization capabilities", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const other = await person("other")

    const asAdmin = await call("GET", "/api/organization", {as: admin})
    expect(asAdmin.status).toBe(200)
    expect(asAdmin.json).toEqual({capabilities: [...ORGANIZATION_CAPABILITIES]})
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
  })

  test("a non-member is 403 and an unknown workspace is 404", async () => {
    const ws = await newWorkspace()

    const nonMember = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: ws.stranger})
    expect(nonMember.status).toBe(403)
    expect(nonMember.json.error).toBe("forbidden")
    const unknown = await call("GET", "/api/workspaces/ws_missing", {as: ws.owner})
    expect(unknown.status).toBe(404)
    expect(unknown.json).toEqual({error: "workspace_not_found"})
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
  })
})

// --- Members ---------------------------------------------------------------

describe("members", () => {
  test("an admin lists members with their membership ids, roles and start times", async () => {
    const ws = await newWorkspace()
    // A migrated member who has not signed in yet is listed, marked pending.
    await WorkspaceMembershipModel.create({
      membershipId: "wm_pending",
      workspaceId: ws.workspaceId,
      mentraUserId: null,
      pendingWorkosUserId: "workos_not_yet",
      email: "later@example.test",
      name: "Later",
      role: "developer",
      status: "active",
      startedAt: new Date("2026-01-02T03:04:05.000Z"),
    })

    const reply = await call("GET", `/api/workspaces/${ws.workspaceId}/members`, {as: ws.admin})

    expect(reply.status).toBe(200)
    const byId = new Map<string, any>(reply.json.items.map((item: any) => [item.membershipId, item]))
    expect(byId.size).toBe(5)
    expect(byId.get(ws.ownerMembershipId)).toMatchObject({
      mentraUserId: ws.owner.mentraUserId,
      email: ws.owner.email,
      role: "owner",
      pending: false,
    })
    expect(byId.get(ws.developerMembershipId)).toMatchObject({role: "developer", pending: false})
    // Names come from the identity provider: the creator's at creation, an invitee's on acceptance.
    expect(byId.get(ws.ownerMembershipId)!.name).toBe("Test User")
    for (const joined of [ws.adminMembershipId, ws.developerMembershipId, ws.memberMembershipId]) {
      expect(byId.get(joined)!.name).toBe("Test User")
    }
    expect(byId.get("wm_pending")).toEqual({
      membershipId: "wm_pending",
      mentraUserId: null,
      email: "later@example.test",
      name: "Later",
      role: "developer",
      startedAt: "2026-01-02T03:04:05.000Z",
      pending: true,
    })
    for (const item of reply.json.items) {
      expect(Object.keys(item).sort()).toEqual(
        ["email", "membershipId", "mentraUserId", "name", "pending", "role", "startedAt"].sort(),
      )
      expect(Number.isNaN(Date.parse(item.startedAt))).toBe(false)
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
    identities.set(ws.admin.bearer, {id: ws.admin.workosUserId, email: ws.admin.email, emailVerified: false})

    const reply = await call("POST", `/api/workspaces/${ws.workspaceId}/invitations`, {
      as: ws.admin,
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
      seq: 1_000_000,
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
    expect(refused.json).toEqual({error: "forbidden"})
    // Owning a workspace is not organization authority.
    expect((await call("GET", "/api/organization/workspaces", {as: await person("owner-one")})).status).toBe(403)
  })

  test("recovering ownership: 404 for a user that does not exist, 200 for one that does", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const heir = await person("heir")
    const url = `/api/organization/workspaces/${ws.workspaceId}/owners`

    const unknown = await call("POST", url, {as: admin, body: {mentraUserId: "mu_does_not_exist"}})
    expect(unknown.status).toBe(404)
    expect(unknown.json).toEqual({error: "user_not_found"})
    expect(
      await WorkspaceMembershipModel.countDocuments({workspaceId: ws.workspaceId, mentraUserId: "mu_does_not_exist"}),
    ).toBe(0)

    const recovered = await call("POST", url, {as: admin, body: {mentraUserId: heir.mentraUserId}})
    expect(recovered.status).toBe(200)
    expect(recovered.json).toMatchObject({workspaceId: ws.workspaceId, name: "Acme", status: "active"})
    const heirView = await call("GET", `/api/workspaces/${ws.workspaceId}`, {as: heir})
    expect(heirView.json.membership.role).toBe("owner")
  })

  test("recovering ownership needs organization authority and a valid body", async () => {
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

  test("a non-admin, a workspace owner and an operator key are all refused", async () => {
    const ws = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const operatorKey: string = (
      await call("POST", "/api/organization/credentials", {
        as: admin,
        body: {name: "ops", scopes: ["organization.incidents.read"]},
      })
    ).json.token

    for (const caller of [ws.owner, ws.stranger, operatorKey]) {
      for (const [method, path] of [
        ["GET", "/api/organization/credentials"],
        ["POST", "/api/organization/credentials"],
        ["DELETE", "/api/organization/credentials/anything"],
        ["GET", "/api/organization/workspaces"],
        ["POST", `/api/organization/workspaces/${ws.workspaceId}/owners`],
      ] as const) {
        const reply = await call(method, path, {
          as: caller,
          body:
            method === "POST" ? {name: "x", scopes: ["organization.incidents.read"], mentraUserId: "mu_x"} : undefined,
        })
        expect({route: `${method} ${path}`, status: reply.status}).toEqual({route: `${method} ${path}`, status: 403})
        expect(reply.json).toEqual({error: "forbidden"})
      }
    }
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
    const operator = (
      await call("POST", "/api/organization/credentials", {
        as: admin,
        body: {name: "ops", scopes: ["organization.incidents.read"]},
      })
    ).json
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
