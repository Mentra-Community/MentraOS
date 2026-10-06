/**
 * @fileoverview Principal resolution and workspace authorization tests.
 *
 * These run the real middleware, services, models and transactions against a
 * local replica set. Only the WorkOS identity adapter is stubbed (the same
 * boundary `admin-reports.integration.test.ts` stubs): a bearer or cookie value
 * maps to a fixed WorkOS identity. Memberships, identity links and credentials
 * are real rows.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/principal-auth.integration.test.ts`
 */

import {createHash, randomBytes} from "node:crypto"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"
import {Hono} from "hono"
import {
  principalAuth,
  principalLabel,
  requireOrganizationCapability,
  requireWorkspaceCapability,
} from "../packages/core/src/api/middleware/principal.middleware"
import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {IdentityLinkModel} from "../packages/core/src/models/identity-link.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {
  authorize,
  organizationCapabilities,
  principalFromToken,
} from "../packages/core/src/services/workspaces/authorization.service"
import {
  createOperatorKey,
  createWorkspaceCredential,
  mintServiceCredential,
} from "../packages/core/src/services/workspaces/credential.service"
import {resolveWorkosUser} from "../packages/core/src/services/workspaces/identity-link.service"
import {createWorkspace, getWorkspace, type Actor} from "../packages/core/src/services/workspaces/workspace.service"
import type {AppEnv} from "../packages/core/src/types/hono.types"
import * as developerAuth from "../packages/developer-auth/src/index"
import {
  capabilitiesForRole,
  ORGANIZATION_CAPABILITIES,
  type OrganizationCapability,
} from "../packages/workspace-contract/src/index"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

// Index builds and per-test cleanup on a shared, busy local replica set can take longer than the 5 s default.
setDefaultTimeout(30_000)

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
const ENV_KEYS = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
  "CLOUD_CORE_CREDENTIAL_ENVIRONMENTS",
  "CLOUD_CORE_ENVIRONMENT",
  "CLOUD_CORE_ORGANIZATION_ID",
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

// --- WorkOS stub -----------------------------------------------------------

interface Identity {
  id: string
  email: string
  emailVerified: boolean
  /** Defaults to "Test" / "User"; pass `null` or blanks to model a profile with no name. */
  firstName?: string | null
  lastName?: string | null
  /** The WorkOS profile lookup failed, so `emailVerified` is unknown rather than false. */
  profileUnavailable?: boolean
}

/** WorkOS access token or session cookie value -> the identity it stands for. */
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
      firstName: identity.firstName === undefined ? "Test" : identity.firstName,
      lastName: identity.lastName === undefined ? "User" : identity.lastName,
    },
    organizationId: null,
    accessToken: value!,
    ...(identity.profileUnavailable ? {profileUnavailable: true} : {}),
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

function actorOf(p: Person, isOrganizationAdmin = false): Actor & {kind: "user"} {
  return {kind: "user", mentraUserId: p.mentraUserId, email: p.email, emailVerified: true, isOrganizationAdmin}
}

let membershipCounter = 0
async function addMember(workspaceId: string, p: Person, role: string, fields: Record<string, unknown> = {}) {
  const membershipId = `wm_test_${membershipCounter++}`
  await WorkspaceMembershipModel.create({
    membershipId,
    organizationId: "local",
    workspaceId,
    mentraUserId: p.mentraUserId,
    email: p.email,
    role,
    status: "active",
    startedAt: new Date(),
    ...fields,
  })
  return membershipId
}

/** A workspace owned by "owner", with a developer, an admin and a plain member. */
async function newWorkspace() {
  const owner = await person("owner")
  const developer = await person("developer")
  const admin = await person("admin")
  const member = await person("member")
  const stranger = await person("stranger")
  const workspace = await createWorkspace(actorOf(owner), {name: "Acme"})
  const workspaceId = workspace.workspaceId
  await addMember(workspaceId, developer, "developer")
  await addMember(workspaceId, admin, "admin")
  await addMember(workspaceId, member, "member")
  return {workspaceId, workspace, owner, developer, admin, member, stranger}
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const ulid = () => Array.from(randomBytes(26), byte => CROCKFORD[byte % 32]).join("")

/** Insert a credential row with a known secret, standing in for rows that were not created through the service. */
async function seedKey(fields: Record<string, unknown> = {}) {
  const credentialId = ulid()
  const secret = randomBytes(32).toString("base64url")
  const prefix = (fields.prefix as string | undefined) ?? "msk"
  await AccessCredentialModel.create({
    credentialId,
    prefix,
    credentialKind: prefix === "mak" ? "organization" : "workspace",
    organizationId: "local",
    name: "seeded",
    env: "local",
    hash: createHash("sha256").update(secret).digest("hex"),
    last4: secret.slice(-4),
    scopes: ["miniapps.publish"],
    ...fields,
  })
  return `${prefix}_local_${credentialId}.${secret}`
}

// --- App under test --------------------------------------------------------

const app = new Hono<AppEnv>()
app.get("/me", principalAuth, c => c.json({principal: c.get("principal")}))
app.get("/org/incidents", requireOrganizationCapability("organization.incidents.read"), c => c.json({ok: true}))
app.get("/org/testing-manage", requireOrganizationCapability("organization.testing.manage"), c => c.json({ok: true}))
app.get("/org/workspaces", requireOrganizationCapability("organization.workspaces.administer"), c => c.json({ok: true}))
app.get("/workspaces/:workspaceId/publish", requireWorkspaceCapability("miniapps.publish"), c =>
  c.json({authorization: c.get("workspaceAuthorization")}),
)
app.get("/workspaces/:workspaceId/delete", requireWorkspaceCapability("workspace.delete"), c =>
  c.json({authorization: c.get("workspaceAuthorization")}),
)
app.get("/spaces/:space/read", requireWorkspaceCapability("workspace.read", "space"), c =>
  c.json({authorization: c.get("workspaceAuthorization")}),
)
// Every gate stacked: the principal must be resolved once and reused.
app.get(
  "/stacked/:workspaceId",
  principalAuth,
  requireOrganizationCapability("organization.workspaces.administer"),
  requireWorkspaceCapability("workspace.delete"),
  c => c.json({principal: c.get("principal"), authorization: c.get("workspaceAuthorization")}),
)
// A route that forgot its `:workspaceId` parameter must not authorize anything.
app.get("/misconfigured", requireWorkspaceCapability("workspace.read"), c => c.json({ok: true}))

function get(path: string, headers: Record<string, string> = {}) {
  return app.request(`http://localhost${path}`, {headers})
}

const bearer = (token: string) => ({authorization: `Bearer ${token}`})

// --- Lifecycle -------------------------------------------------------------

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("principal-middleware")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.init()))

  requestAuth = spyOn(developerAuth, "authenticateWorkosRequest").mockImplementation((async (c: any) => {
    const header = c.req.header("authorization")
    const cookie = c.req.header("cookie")?.match(/mentra_console_session=([^;]+)/)?.[1]
    return authResult(header?.startsWith("Bearer ") ? header.slice(7) : cookie)
  }) as any)
  tokenAuth = spyOn(developerAuth, "authenticateWorkosAccessToken").mockImplementation((async (token: string) =>
    authResult(token)) as any)
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
  requestAuth.mockClear()
  tokenAuth.mockClear()
  process.env.CLOUD_CORE_ADMIN_EMAILS = ADMIN_EMAIL
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  delete process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS
  delete process.env.CLOUD_CORE_ENVIRONMENT
  delete process.env.CLOUD_CORE_ORGANIZATION_ID
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

// --- principalAuth ---------------------------------------------------------

describe("principalAuth", () => {
  test("no credentials is 401", async () => {
    const response = await get("/me")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })

  test("a WorkOS token the identity provider does not know is 401", async () => {
    const response = await get("/me", bearer("not-a-known-token"))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })

  test("WorkOS not configured on this deployment is 401", async () => {
    const owner = await person("owner")
    delete process.env.WORKOS_API_KEY

    expect((await get("/me", bearer(owner.bearer))).status).toBe(401)
  })

  test("a WorkOS bearer resolves to a user principal linked to its Mentra user", async () => {
    const owner = await person("owner")

    const response = await get("/me", bearer(owner.bearer))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      principal: {
        kind: "user",
        organizationId: "local",
        mentraUserId: owner.mentraUserId,
        email: owner.email,
        emailVerified: true,
        name: "Test User",
        workosUserId: owner.workosUserId,
        isOrganizationAdmin: false,
      },
    })
  })

  test("the principal's name is the identity provider's first and last name, trimmed, or null when it has none", async () => {
    const cases: Array<[string | null | undefined, string | null | undefined, string | null]> = [
      ["  Ada ", " Lovelace  ", "Ada Lovelace"],
      ["Ada", null, "Ada"],
      [null, "Lovelace", "Lovelace"],
      ["   ", "", null],
      [null, null, null],
    ]
    for (const [index, [firstName, lastName, expected]] of cases.entries()) {
      const key = `named-${index}`
      await person(key)
      identities.set(`tok-${key}`, {...identities.get(`tok-${key}`)!, firstName, lastName})

      const response = await get("/me", bearer(`tok-${key}`))

      expect({index, name: ((await response.json()) as any).principal.name}).toEqual({index, name: expected})
    }
  })

  test("a WorkOS session cookie resolves the same way", async () => {
    const owner = await person("owner")
    identities.set("sealed-session", identities.get(owner.bearer)!)

    const response = await get("/me", {cookie: "mentra_console_session=sealed-session"})

    expect(response.status).toBe(200)
    expect(((await response.json()) as any).principal).toMatchObject({kind: "user", mentraUserId: owner.mentraUserId})
  })

  test("a first sign-in links the WorkOS user and claims a migrated membership", async () => {
    const {workspaceId} = await newWorkspace()
    identities.set("tok-migrated", {id: "workos_migrated", email: "migrated@example.test", emailVerified: true})
    await WorkspaceMembershipModel.create({
      membershipId: "wm_migrated",
      organizationId: "local",
      workspaceId,
      mentraUserId: null,
      pendingWorkosUserId: "workos_migrated",
      email: "migrated@example.test",
      role: "developer",
      status: "active",
      startedAt: new Date(),
    })

    const response = await get(`/workspaces/${workspaceId}/publish`, bearer("tok-migrated"))

    expect(response.status).toBe(200)
    const claimed = await WorkspaceMembershipModel.findOne({membershipId: "wm_migrated"}).lean()
    expect(claimed?.mentraUserId).toEqual(expect.stringMatching(/^mu_/))
    expect(claimed?.pendingWorkosUserId).toBeNull()
  })

  test("an allowlisted address that WorkOS has not verified is not an organization admin", async () => {
    const impostor = await person("impostor", {email: ADMIN_EMAIL, emailVerified: false})

    const response = await get("/me", bearer(impostor.bearer))

    expect(((await response.json()) as any).principal).toMatchObject({
      emailVerified: false,
      isOrganizationAdmin: false,
    })
  })

  test("an msk_ or mak_ bearer is checked as a credential and never sent to WorkOS", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})

    const response = await get("/me", bearer(token))

    expect(response.status).toBe(200)
    expect(((await response.json()) as any).principal).toMatchObject({
      kind: "credential",
      credentialKind: "workspace",
      workspaceId,
      scopes: ["miniapps.publish"],
    })
    expect(requestAuth).not.toHaveBeenCalled()
    expect(tokenAuth).not.toHaveBeenCalled()
  })

  test("a credential-shaped bearer that does not validate is 401, not a WorkOS attempt", async () => {
    const revoked = await seedKey({prefix: "mak", createdByEmail: ADMIN_EMAIL, revokedAt: new Date()})
    for (const token of [revoked, `msk_local_${ulid()}.${"A".repeat(43)}`, "mak_garbage"]) {
      const response = await get("/me", bearer(token))
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({error: "unauthorized"})
    }
    expect(requestAuth).not.toHaveBeenCalled()
  })

  test("an invalid msk_ bearer is 401 even when a valid session cookie rides along", async () => {
    const owner = await person("owner")
    identities.set("sealed-session", identities.get(owner.bearer)!)

    const response = await get("/me", {
      authorization: `Bearer msk_local_${ulid()}.${"A".repeat(43)}`,
      cookie: "mentra_console_session=sealed-session",
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
    expect(requestAuth).not.toHaveBeenCalled()
  })

  describe("when WorkOS cannot be asked about the profile", () => {
    const configureGotrue = () => {
      // Never reached: the first sign-in is refused before any directory lookup.
      process.env.SUPABASE_URL = "http://127.0.0.1:9"
      process.env.SUPABASE_SERVICE_ROLE_KEY = "unused-test-key"
    }
    const unknownProfile = (key: string, email = `${key}@example.test`): Identity => ({
      id: `workos_${key}`,
      email,
      emailVerified: false,
      profileUnavailable: true,
    })

    test("a first sign-in is 503 identity_unavailable at every gate, and creates no link or user", async () => {
      const {workspaceId} = await newWorkspace()
      configureGotrue()
      identities.set("tok-newcomer", unknownProfile("newcomer"))
      const usersBefore = await UserModel.countDocuments({})
      const linksBefore = await IdentityLinkModel.countDocuments({})

      for (const path of ["/me", "/org/incidents", `/workspaces/${workspaceId}/publish`]) {
        const response = await get(path, bearer("tok-newcomer"))
        expect({path, status: response.status, body: await response.json()}).toEqual({
          path,
          status: 503,
          body: {error: "identity_unavailable"},
        })
      }

      expect(await UserModel.countDocuments({})).toBe(usersBefore)
      expect(await IdentityLinkModel.countDocuments({})).toBe(linksBefore)
      expect(await IdentityLinkModel.countDocuments({subject: "workos_newcomer"})).toBe(0)
    })

    test("a person who is already linked still signs in, with the email unverified", async () => {
      const owner = await person("owner")
      configureGotrue()
      identities.set(owner.bearer, unknownProfile("owner"))

      const response = await get("/me", bearer(owner.bearer))

      expect(response.status).toBe(200)
      expect(((await response.json()) as any).principal).toMatchObject({
        mentraUserId: owner.mentraUserId,
        emailVerified: false,
        isOrganizationAdmin: false,
      })
    })

    test("an organization admin loses organization capabilities while their email cannot be verified", async () => {
      const admin = await person("org-admin", {email: ADMIN_EMAIL})
      configureGotrue()
      identities.set(admin.bearer, unknownProfile("org-admin", ADMIN_EMAIL))

      const response = await get("/org/incidents", bearer(admin.bearer))

      expect(response.status).toBe(403)
    })

    test("with no GoTrue directory a first sign-in has nothing to be wrong about and links normally", async () => {
      identities.set("tok-newcomer", unknownProfile("newcomer"))

      const response = await get("/me", bearer("tok-newcomer"))

      expect(response.status).toBe(200)
      const link = await IdentityLinkModel.findOne({provider: "workos", subject: "workos_newcomer"}).lean()
      expect(link).toMatchObject({linkedVia: "workos_tenant"})
    })
  })

  test("a missing email is null, never the placeholder: not on the principal, the link or the label", async () => {
    for (const [key, email] of [
      ["placeholder", developerAuth.UNKNOWN_EMAIL],
      ["blank", ""],
    ] as const) {
      identities.set(`tok-${key}`, {id: `workos_${key}`, email, emailVerified: false})

      const response = await get("/me", bearer(`tok-${key}`))

      expect(response.status).toBe(200)
      const principal = ((await response.json()) as any).principal
      expect(principal).toMatchObject({kind: "user", email: null, emailVerified: false, isOrganizationAdmin: false})
      expect(principalLabel(principal)).toBe(`user:${principal.mentraUserId}`)
      const link = await IdentityLinkModel.findOne({subject: `workos_${key}`}).lean()
      expect(link).toMatchObject({mentraUserId: principal.mentraUserId, email: null})
    }
  })

  test("resolves the principal once per request however many gates read it", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const {workspaceId} = await newWorkspace()

    const response = await get(`/stacked/${workspaceId}`, bearer(admin.bearer))

    expect(response.status).toBe(200)
    expect(requestAuth).toHaveBeenCalledTimes(1)
    const body = (await response.json()) as any
    expect(body.principal.mentraUserId).toBe(admin.mentraUserId)
    expect(body.authorization.principal).toEqual(body.principal)
  })
})

// --- Organization capabilities ---------------------------------------------

describe("organization capabilities", () => {
  test("an allowlisted user with a verified email gets every organization capability", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const principal = (await principalFromToken(admin.bearer))!

    expect(principal).toMatchObject({kind: "user", isOrganizationAdmin: true})
    expect(organizationCapabilities(principal)).toEqual(new Set(ORGANIZATION_CAPABILITIES))
    expect((await get("/org/incidents", bearer(admin.bearer))).status).toBe(200)
    expect((await get("/org/testing-manage", bearer(admin.bearer))).status).toBe(200)
    expect((await get("/org/workspaces", bearer(admin.bearer))).status).toBe(200)
  })

  test("the allowlist can name a domain, and a different domain does not match", async () => {
    process.env.CLOUD_CORE_ADMIN_EMAILS = ""
    process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "ops.example.test"
    const inside = await person("inside", {email: "someone@ops.example.test"})
    const outside = await person("outside", {email: "someone@sub.ops.example.test"})

    expect((await get("/org/incidents", bearer(inside.bearer))).status).toBe(200)
    expect((await get("/org/incidents", bearer(outside.bearer))).status).toBe(403)
  })

  test("an allowlisted address WorkOS has not verified gets none", async () => {
    const impostor = await person("impostor", {email: ADMIN_EMAIL, emailVerified: false})

    const principal = (await principalFromToken(impostor.bearer))!

    expect(organizationCapabilities(principal).size).toBe(0)
    const response = await get("/org/incidents", bearer(impostor.bearer))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: "forbidden"})
  })

  test("an ordinary user gets none", async () => {
    const {owner} = await newWorkspace()

    const response = await get("/org/incidents", bearer(owner.bearer))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: "forbidden"})
  })

  test("a gate with no principal is 401, not 403", async () => {
    const response = await get("/org/incidents")

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })

  test("a mak_ key passes the capabilities it was given and fails the others", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const {token} = await createOperatorKey(actorOf(admin, true), {
      name: "incident reader",
      scopes: ["organization.incidents.read"],
    })

    const allowed = await get("/org/incidents", bearer(token))
    expect(allowed.status).toBe(200)
    const denied = await get("/org/testing-manage", bearer(token))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({error: "forbidden"})
    expect(organizationCapabilities((await principalFromToken(token))!)).toEqual(
      new Set<OrganizationCapability>(["organization.incidents.read"]),
    )
  })

  test("a stored mak_ row with a non-operator scope does not grant it", async () => {
    const token = await seedKey({
      prefix: "mak",
      createdByEmail: ADMIN_EMAIL,
      scopes: ["organization.incidents.read", "organization.workspaces.administer", "miniapps.publish", "bogus"],
    })

    const principal = (await principalFromToken(token))!
    // The stored scopes are what the credential service reports; the capability set is what counts.
    expect(principal).toMatchObject({kind: "credential", credentialKind: "organization"})
    expect(organizationCapabilities(principal)).toEqual(
      new Set<OrganizationCapability>(["organization.incidents.read"]),
    )
    expect((await get("/org/incidents", bearer(token))).status).toBe(200)
    expect((await get("/org/workspaces", bearer(token))).status).toBe(403)
  })

  test("a mak_ key stops working when its creator is no longer an organization admin", async () => {
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const {token} = await createOperatorKey(actorOf(admin, true), {
      name: "incident reader",
      scopes: ["organization.incidents.read"],
    })
    process.env.CLOUD_CORE_ADMIN_EMAILS = "someone-else@example.test"

    expect((await get("/org/incidents", bearer(token))).status).toBe(401)
  })

  test("an msk_ key gets no organization capability", async () => {
    const {workspaceId, developer} = await newWorkspace()
    const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})

    expect(organizationCapabilities((await principalFromToken(token))!).size).toBe(0)
    for (const path of ["/org/incidents", "/org/testing-manage", "/org/workspaces"]) {
      const response = await get(path, bearer(token))
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({error: "forbidden"})
    }
  })
})

// --- authorize -------------------------------------------------------------

describe("authorize", () => {
  test("no principal is unauthenticated", async () => {
    const {workspaceId} = await newWorkspace()

    expect(await authorize(null, {workspaceId, capability: "workspace.read"})).toEqual({
      allowed: false,
      reason: "unauthenticated",
      organizationId: "local",
      principal: null,
      capabilities: [],
    })
  })

  test("reports the organization's id", async () => {
    process.env.CLOUD_CORE_ORGANIZATION_ID = "acme-prod"

    expect((await authorize(null, {})).organizationId).toBe("acme-prod")
  })

  test("without a workspace, any principal is allowed and echoed with no capabilities", async () => {
    const owner = await person("owner")
    const principal = (await principalFromToken(owner.bearer))!

    expect(await authorize(principal, {})).toEqual({
      allowed: true,
      organizationId: "local",
      principal,
      capabilities: [],
    })
  })

  test("a capability cannot be satisfied without a workspace", async () => {
    const owner = await person("owner")
    const principal = (await principalFromToken(owner.bearer))!

    const result = await authorize(principal, {capability: "workspace.read"})

    expect(result).toMatchObject({allowed: false, reason: "capability_missing", capabilities: []})
  })

  test("an unknown workspace is workspace_not_found", async () => {
    const owner = await person("owner")
    const principal = (await principalFromToken(owner.bearer))!

    expect(await authorize(principal, {workspaceId: "ws_unknown", capability: "workspace.read"})).toEqual({
      allowed: false,
      reason: "workspace_not_found",
      organizationId: "local",
      principal,
      workspace: null,
      capabilities: [],
    })
  })

  test("a deleted workspace is workspace_deleted, with its summary", async () => {
    const {workspaceId, owner} = await newWorkspace()
    await WorkspaceModel.updateOne({workspaceId}, {$set: {status: "deleted", deletedAt: new Date()}})
    const principal = (await principalFromToken(owner.bearer))!

    const result = await authorize(principal, {workspaceId, capability: "workspace.read"})

    expect(result).toMatchObject({
      allowed: false,
      reason: "workspace_deleted",
      workspace: {workspaceId, name: "Acme", status: "deleted"},
      capabilities: [],
    })
  })

  describe("a user", () => {
    test("gets their role's capabilities and membership", async () => {
      const {workspaceId, workspace, developer} = await newWorkspace()
      const principal = (await principalFromToken(developer.bearer))!

      const result = await authorize(principal, {workspaceId, capability: "miniapps.publish"})

      expect(result).toMatchObject({
        allowed: true,
        organizationId: "local",
        principal,
        workspace,
        membership: {role: "developer", membershipId: expect.stringMatching(/^wm_/)},
      })
      expect(result.reason).toBeUndefined()
      expect(new Set(result.capabilities)).toEqual(new Set(capabilitiesForRole("developer")))
    })

    test("a member lacks miniapps.publish", async () => {
      const {workspaceId, member} = await newWorkspace()
      const principal = (await principalFromToken(member.bearer))!

      const result = await authorize(principal, {workspaceId, capability: "miniapps.publish"})

      expect(result).toMatchObject({allowed: false, reason: "capability_missing", membership: {role: "member"}})
      // The capabilities they do have are still reported.
      expect(new Set(result.capabilities)).toEqual(new Set(capabilitiesForRole("member")))
      expect((await authorize(principal, {workspaceId, capability: "workspace.read"})).allowed).toBe(true)
    })

    test("without a capability, membership alone is enough", async () => {
      const {workspaceId, member} = await newWorkspace()

      const result = await authorize((await principalFromToken(member.bearer))!, {workspaceId})

      expect(result.allowed).toBe(true)
    })

    test("a non-member is not_a_member and learns nothing about the workspace", async () => {
      const {workspaceId, stranger} = await newWorkspace()
      const principal = (await principalFromToken(stranger.bearer))!

      const result = await authorize(principal, {workspaceId, capability: "workspace.read"})

      expect(result).toEqual({
        allowed: false,
        reason: "not_a_member",
        organizationId: "local",
        principal,
        capabilities: [],
      })
    })

    test("a membership that has ended does not count", async () => {
      const {workspaceId, developer} = await newWorkspace()
      await WorkspaceMembershipModel.updateOne(
        {workspaceId, mentraUserId: developer.mentraUserId},
        {$set: {status: "ended", endedAt: new Date(), endedReason: "removed"}},
      )

      const result = await authorize((await principalFromToken(developer.bearer))!, {workspaceId})

      expect(result).toMatchObject({allowed: false, reason: "not_a_member"})
    })

    test("an organization admin has owner capabilities on any workspace", async () => {
      const {workspaceId, workspace} = await newWorkspace()
      const admin = await person("org-admin", {email: ADMIN_EMAIL})
      const principal = (await principalFromToken(admin.bearer))!

      const result = await authorize(principal, {workspaceId, capability: "workspace.delete"})

      expect(result).toMatchObject({allowed: true, principal, workspace, membership: null})
      expect(new Set(result.capabilities)).toEqual(new Set(capabilitiesForRole("owner")))
    })

    test("an organization admin who also holds a lower role still acts as owner", async () => {
      const {workspaceId} = await newWorkspace()
      const admin = await person("org-admin", {email: ADMIN_EMAIL})
      await addMember(workspaceId, admin, "member")

      const result = await authorize((await principalFromToken(admin.bearer))!, {
        workspaceId,
        capability: "workspace.delete",
      })

      expect(result).toMatchObject({allowed: true, membership: {role: "member"}})
      expect(new Set(result.capabilities)).toEqual(new Set(capabilitiesForRole("owner")))
    })

    test("a user whose email WorkOS has not verified still has the capabilities of their membership", async () => {
      const {workspaceId} = await newWorkspace()
      const unverified = await person("unverified-dev", {emailVerified: false})
      await addMember(workspaceId, unverified, "developer")
      const principal = (await principalFromToken(unverified.bearer))!

      const result = await authorize(principal, {workspaceId, capability: "miniapps.publish"})

      expect(principal).toMatchObject({emailVerified: false})
      expect(result).toMatchObject({allowed: true, membership: {role: "developer"}})
      expect(new Set(result.capabilities)).toEqual(new Set(capabilitiesForRole("developer")))
    })

    test("an allowlisted address WorkOS has not verified gets no owner access", async () => {
      const {workspaceId} = await newWorkspace()
      const impostor = await person("impostor", {email: ADMIN_EMAIL, emailVerified: false})

      const result = await authorize((await principalFromToken(impostor.bearer))!, {workspaceId})

      expect(result).toMatchObject({allowed: false, reason: "not_a_member"})
    })
  })

  describe("an msk_ credential", () => {
    test("is allowed in its own workspace with its scopes as capabilities", async () => {
      const {workspaceId, developer} = await newWorkspace()
      const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})
      const principal = (await principalFromToken(token))!

      const result = await authorize(principal, {workspaceId, capability: "miniapps.publish"})

      // Creating the credential changed the workspace's revision, so read it back.
      const workspace = await getWorkspace(workspaceId)
      expect(result).toMatchObject({allowed: true, principal, workspace, capabilities: ["miniapps.publish"]})
      expect(result.membership).toBeUndefined()
    })

    test("is denied on another workspace with not_a_member", async () => {
      const a = await newWorkspace()
      const b = await createWorkspace(actorOf(a.owner), {name: "Other"})
      const {token} = await createWorkspaceCredential(actorOf(a.developer), a.workspaceId, {name: "CI"})
      const principal = (await principalFromToken(token))!

      const result = await authorize(principal, {workspaceId: b.workspaceId, capability: "miniapps.publish"})

      expect(result).toMatchObject({allowed: false, reason: "not_a_member", capabilities: []})
    })

    test("lacks capabilities its scopes do not carry", async () => {
      const {workspaceId, developer} = await newWorkspace()
      const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})

      const result = await authorize((await principalFromToken(token))!, {workspaceId, capability: "workspace.delete"})

      expect(result).toMatchObject({allowed: false, reason: "capability_missing", capabilities: ["miniapps.publish"]})
    })

    test("a package outside its package list is package_out_of_scope", async () => {
      const {workspaceId} = await newWorkspace()
      const {token} = await mintServiceCredential("store", {
        workspaceId,
        name: "Store key",
        packageNames: ["com.acme.one", "com.acme.two"],
        actorEmail: "staff@example.test",
      })
      const principal = (await principalFromToken(token))!

      const inside = await authorize(principal, {
        workspaceId,
        capability: "miniapps.publish",
        packageName: "com.acme.two",
      })
      expect(inside).toMatchObject({allowed: true, capabilities: ["miniapps.publish"]})

      const outside = await authorize(principal, {
        workspaceId,
        capability: "miniapps.publish",
        packageName: "com.acme.three",
      })
      expect(outside).toMatchObject({allowed: false, reason: "package_out_of_scope"})
      expect(outside.capabilities).toEqual([])

      // Not naming a package is not a package check.
      expect((await authorize(principal, {workspaceId, capability: "miniapps.publish"})).allowed).toBe(true)
    })

    test("a credential with no package list may publish any package", async () => {
      const {workspaceId, developer} = await newWorkspace()
      const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})

      const result = await authorize((await principalFromToken(token))!, {
        workspaceId,
        capability: "miniapps.publish",
        packageName: "com.acme.anything",
      })

      expect(result.allowed).toBe(true)
    })

    test("a deleted workspace is workspace_deleted before the credential is considered", async () => {
      const {workspaceId, developer} = await newWorkspace()
      const {token} = await createWorkspaceCredential(actorOf(developer), workspaceId, {name: "CI"})
      const principal = (await principalFromToken(token))!
      await WorkspaceModel.updateOne({workspaceId}, {$set: {status: "deleted", deletedAt: new Date()}})

      const result = await authorize(principal, {workspaceId, capability: "miniapps.publish"})

      expect(result).toMatchObject({allowed: false, reason: "workspace_deleted"})
    })
  })

  describe("a mak_ credential", () => {
    test("is never authorized for workspace capabilities", async () => {
      const {workspaceId} = await newWorkspace()
      const admin = await person("org-admin", {email: ADMIN_EMAIL})
      const {token} = await createOperatorKey(actorOf(admin, true), {
        name: "reader",
        scopes: ["organization.incidents.read"],
      })
      const principal = (await principalFromToken(token))!

      for (const request of [{workspaceId}, {workspaceId, capability: "workspace.read" as const}]) {
        expect(await authorize(principal, request)).toMatchObject({
          allowed: false,
          reason: "not_a_member",
          capabilities: [],
        })
      }
    })

    test("is not given workspace capabilities by a stored scope that names one", async () => {
      const {workspaceId} = await newWorkspace()
      const token = await seedKey({
        prefix: "mak",
        createdByEmail: ADMIN_EMAIL,
        scopes: ["organization.incidents.read", "workspace.read", "workspace.delete"],
      })

      const result = await authorize((await principalFromToken(token))!, {workspaceId, capability: "workspace.read"})

      expect(result).toMatchObject({allowed: false, reason: "not_a_member", capabilities: []})
    })
  })
})

// --- principalFromToken ----------------------------------------------------

describe("principalFromToken", () => {
  test("a WorkOS access token resolves without a request context", async () => {
    const owner = await person("owner")

    expect(await principalFromToken(owner.bearer)).toMatchObject({
      kind: "user",
      mentraUserId: owner.mentraUserId,
      workosUserId: owner.workosUserId,
      email: owner.email,
    })
    expect(tokenAuth).toHaveBeenCalledTimes(1)
  })

  test("an unknown token is null", async () => {
    expect(await principalFromToken("nope")).toBeNull()
    expect(await principalFromToken("")).toBeNull()
  })

  test("a credential token that does not validate is null and never reaches WorkOS", async () => {
    expect(await principalFromToken("msk_local_garbage")).toBeNull()
    expect(tokenAuth).not.toHaveBeenCalled()
  })
})

// --- requireWorkspaceCapability --------------------------------------------

describe("requireWorkspaceCapability", () => {
  test("no credentials is 401", async () => {
    const {workspaceId} = await newWorkspace()

    const response = await get(`/workspaces/${workspaceId}/publish`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({error: "unauthorized"})
  })

  test("a developer passes and the authorization is on the context", async () => {
    const {workspaceId, workspace, developer} = await newWorkspace()

    const response = await get(`/workspaces/${workspaceId}/publish`, bearer(developer.bearer))

    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.authorization).toMatchObject({
      allowed: true,
      organizationId: "local",
      workspace,
      membership: {role: "developer"},
      principal: {kind: "user", mentraUserId: developer.mentraUserId},
    })
    expect(body.authorization.capabilities).toContain("miniapps.publish")
  })

  test("a member lacks miniapps.publish: 403 with the reason", async () => {
    const {workspaceId, member} = await newWorkspace()

    const response = await get(`/workspaces/${workspaceId}/publish`, bearer(member.bearer))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: "forbidden", reason: "capability_missing"})
  })

  test("a non-member is 403 not_a_member", async () => {
    const {workspaceId, stranger} = await newWorkspace()

    const response = await get(`/workspaces/${workspaceId}/publish`, bearer(stranger.bearer))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: "forbidden", reason: "not_a_member"})
  })

  test("an unknown workspace is 404", async () => {
    const owner = await person("owner")

    const response = await get("/workspaces/ws_unknown/publish", bearer(owner.bearer))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: "workspace_not_found"})
  })

  test("a deleted workspace is 404", async () => {
    const {workspaceId, owner} = await newWorkspace()
    await WorkspaceModel.updateOne({workspaceId}, {$set: {status: "deleted", deletedAt: new Date()}})

    const response = await get(`/workspaces/${workspaceId}/publish`, bearer(owner.bearer))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: "workspace_not_found"})
  })

  test("an organization admin passes on any workspace", async () => {
    const {workspaceId} = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})

    const response = await get(`/workspaces/${workspaceId}/delete`, bearer(admin.bearer))

    expect(response.status).toBe(200)
    expect(((await response.json()) as any).authorization).toMatchObject({allowed: true, membership: null})
  })

  test("an msk_ key passes for its workspace and is 403 not_a_member for another", async () => {
    const a = await newWorkspace()
    const b = await createWorkspace(actorOf(a.owner), {name: "Other"})
    const {token} = await createWorkspaceCredential(actorOf(a.developer), a.workspaceId, {name: "CI"})

    expect((await get(`/workspaces/${a.workspaceId}/publish`, bearer(token))).status).toBe(200)
    const other = await get(`/workspaces/${b.workspaceId}/publish`, bearer(token))
    expect(other.status).toBe(403)
    expect(await other.json()).toEqual({error: "forbidden", reason: "not_a_member"})
  })

  test("a mak_ key is 403 on a workspace", async () => {
    const {workspaceId} = await newWorkspace()
    const admin = await person("org-admin", {email: ADMIN_EMAIL})
    const {token} = await createOperatorKey(actorOf(admin, true), {
      name: "reader",
      scopes: ["organization.incidents.read"],
    })

    const response = await get(`/workspaces/${workspaceId}/publish`, bearer(token))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: "forbidden", reason: "not_a_member"})
  })

  test("reads the workspace id from the named route parameter", async () => {
    const {workspaceId, member} = await newWorkspace()

    const response = await get(`/spaces/${workspaceId}/read`, bearer(member.bearer))

    expect(response.status).toBe(200)
    expect(((await response.json()) as any).authorization.workspace.workspaceId).toBe(workspaceId)
  })

  test("a route with no such parameter authorizes nothing", async () => {
    const owner = await person("owner")

    const response = await get("/misconfigured", bearer(owner.bearer))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: "workspace_not_found"})
  })
})
