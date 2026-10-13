/**
 * @fileoverview The membership claim at a person's first Core contact (C01).
 *
 * Memberships imported from the Store wait under the Store's WorkOS user ids.
 * The legacy identity export records each WorkOS user's verified email, and a
 * person's first sign-in through Core's provider, or first Core access token
 * Core resolves, claims every unclaimed legacy identity with exactly that
 * verified email, in one transaction: the pending memberships, duplicates merged
 * to the higher role with their keys and invitations, and enterprise org
 * ownership. A claimed identity is never claimed by anyone else.
 *
 * Core is started with `startCore`, so the claim after a provider sign-in is the
 * one Core's startup registers; requests go to Core's app in-process. The Store
 * database of the end-to-end case and the WorkOS API are stand-ins: a second
 * local database and a stubbed `fetch`.
 *
 * Safety: `localTestMongoUrl` (loopback only, random databases, ignores
 * `MONGO_URL`); the databases are dropped afterwards.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/legacy-identity-claim.integration.test.ts`
 */

import {createHash, randomBytes} from "node:crypto"
import {join} from "node:path"

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"

import {
  exportLegacyBrowserIdentities,
  ExportError,
  parseArgs as parseExportArgs,
  UsageError as ExportUsageError,
} from "../packages/core/scripts/export-legacy-browser-identities"
import {migrateStoreDeveloperOrgs, openSourceConnection} from "../packages/core/scripts/migrate-store-developer-orgs"
import {createApp} from "../packages/core/src/api/app"
import {mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {startCore, type CoreHandle} from "../packages/core/src/index"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {EnterpriseOrgModel} from "../packages/core/src/models/enterprise-org.model"
import {LegacyBrowserIdentityModel} from "../packages/core/src/models/legacy-browser-identity.model"
import {SigninIdentityModel} from "../packages/core/src/models/signin-identity.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {resetUpstreamCaches} from "../packages/core/src/services/oidc/upstream"
import {createSession} from "../packages/core/src/services/session.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {resetPortalSigninCaches} from "../packages/core/src/services/signin/portal-signin.service"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {validateCredentialToken} from "../packages/core/src/services/workspaces/credential.service"
import {
  claimLegacyIdentities,
  resetLegacyIdentityClaimChecks,
} from "../packages/core/src/services/workspaces/membership-claim.service"
import {countActiveOwners} from "../packages/core/src/services/workspaces/workspace.service"
import {createCoreWorkspaceClient} from "../packages/workspace-contract/src/server"
import {installFakeIdp, type FakeIdp, type FakePerson} from "./support/fake-idp"
import {resetCoreKeyCaches} from "./support/key-caches"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {routeOriginsToApp} from "./support/oidc-harness"
import {
  ADMIN_COOKIE,
  ADMIN_ORIGIN,
  applyEnv,
  CORE_API_CLIENT,
  CORE_API_SECRET,
  coreAccessToken,
  ENTRA_CALLBACK,
  ENTRA_ISSUER,
  ENTRA_JWKS,
  ENTRA_TENANT,
  HOSTED_ENV,
  OIDC_ISSUER,
  PORTAL_COOKIE,
  PORTAL_ORIGIN,
  portalSignIn,
  PRIVATE_CLOUD_ENV,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(60_000)

const EXPORT_SCRIPT = join(import.meta.dir, "../packages/core/scripts/export-legacy-browser-identities.ts")

/** What every case runs with on top of the sign-in fixture: no WorkOS, the Store's service secret, local keys. */
const CORE_EXTRAS: Record<string, string | undefined> = {
  WORKOS_API_KEY: undefined,
  WORKOS_CLIENT_ID: undefined,
  WORKOS_COOKIE_PASSWORD: undefined,
  REFRESH_TOKEN_PEPPER: "legacy-identity-claim-pepper",
  CLOUD_CORE_SERVICE_SECRETS: JSON.stringify({store: ["store-s1"]}),
  CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: "local",
  CLOUD_CORE_ENVIRONMENT: undefined,
  CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
  CLOUD_CORE_WORKSPACE_CREATION: undefined,
}

const databaseUrl = localTestMongoUrl("legacy-identity-claim")
const storeUrl = localTestMongoUrl("legacy-claim-store")
let core: CoreHandle
let app: ReturnType<typeof createApp>
let verified = false
let restoreEnv: () => void = () => {}

const CLEANED = [
  AccessCredentialModel,
  EnterpriseOrgModel,
  LegacyBrowserIdentityModel,
  SigninIdentityModel,
  UserModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
] as unknown as Array<typeof WorkspaceModel>

beforeAll(async () => {
  restoreEnv = applyEnv({...HOSTED_ENV, ...CORE_EXTRAS})
  resetCoreKeyCaches()
  resetIdpTokenCaches()
  resetPortalSigninCaches()
  resetUpstreamCaches()
  // The real startup: migrations, indexes, and the claim registered to run after every provider sign-in.
  core = await startCore({port: 0, mongoUrl: databaseUrl})
  assertConnectedTo(databaseUrl, UserModel.db.name)
  verified = true
  app = createApp({readinessChecks: [mongoReadinessCheck]})
})

afterAll(async () => {
  if (verified) {
    assertConnectedTo(databaseUrl, UserModel.db.name)
    await UserModel.db.dropDatabase()
  }
  await core?.stop()
  restoreEnv()
  resetCoreKeyCaches()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, UserModel.db.name)
  await Promise.all(CLEANED.map(model => model.deleteMany({})))
  resetLegacyIdentityClaimChecks()
  resetIdpTokenCaches()
  resetPortalSigninCaches()
  resetUpstreamCaches()
})

// --- Fixtures --------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const ulid = () => Array.from(randomBytes(26), byte => CROCKFORD[byte % 32]).join("")
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex")
const STARTED = new Date("2026-03-01T10:00:00.000Z")

async function seedWorkspace(workspaceId: string, fields: Record<string, unknown> = {}) {
  await WorkspaceModel.create({workspaceId, name: workspaceId, ...fields})
}

/** A membership imported from the Store, waiting under `workosUserId`. */
async function seedPending(workspaceId: string, workosUserId: string, role: string, membershipId = `wm_${randomBytes(12).toString("hex")}`) {
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId,
      workspaceId,
      mentraUserId: null,
      pendingWorkosUserId: workosUserId,
      email: `${workosUserId.toLowerCase()}@store.example`,
      role,
      status: "active",
      startedAt: STARTED,
    }),
  )
  return membershipId
}

async function seedIdentity(workosUserId: string, email: string) {
  await LegacyBrowserIdentityModel.create({workosUserId, email})
}

/** A workspace key created by `membershipId`, and its token. */
async function seedKey(workspaceId: string, membershipId: string, fields: Record<string, unknown> = {}) {
  const credentialId = ulid()
  const secret = randomBytes(32).toString("base64url")
  await AccessCredentialModel.create({
    credentialId,
    prefix: "msk",
    credentialKind: "workspace",
    workspaceId,
    name: "CI",
    env: "local",
    hash: sha256Hex(secret),
    last4: secret.slice(-4),
    scopes: ["miniapps.publish"],
    createdByMembershipId: membershipId,
    ...fields,
  })
  return {credentialId, token: `msk_local_${credentialId}.${secret}`}
}

/** The Core user a Mentra account (`sub`) has: the same one the Mentra App gets. */
async function mentraUser(sub: string) {
  return (await findOrCreateUser({tenantId: "mentra", tenantUserId: sub})).mentraUserId
}

async function membership(membershipId: string) {
  return (await WorkspaceMembershipModel.findOne({membershipId}).lean())!
}

async function identity(workosUserId: string) {
  return (await LegacyBrowserIdentityModel.findOne({workosUserId}).lean())!
}

/** The claim's audit trail: `[action, workspaceId, membershipId]`, oldest first. */
async function claimEvents() {
  const events = await WorkspaceAuditEventModel.find({action: {$in: ["membership.claimed", "membership.merged_duplicate"]}})
    .sort({eventId: 1})
    .lean()
  return events.map(event => [event.action, event.workspaceId, (event.target as {membershipId: string}).membershipId])
}

async function bearerRequest(path: string, token: string) {
  return app.request(`http://localhost${path}`, {headers: {authorization: `Bearer ${token}`}})
}

/** The Store's client of Core's signed service API, calling the app in-process. */
const store = () =>
  createCoreWorkspaceClient({
    baseUrl: "https://core.test",
    service: "store",
    secret: "store-s1",
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(app.fetch(new Request(input, init)))) as typeof fetch,
  })

/** A stand-in for WorkOS's user API: `users` by id; anything else is 404. Records each request. */
function workosStub(users: Record<string, {email: string; email_verified: boolean} | {status: number}>) {
  const requests: Array<{url: string; authorization: string | null}> = []
  const stub = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push({url: request.url, authorization: request.headers.get("authorization")})
    const id = decodeURIComponent(new URL(request.url).pathname.split("/").pop()!)
    const user = users[id]
    if (!user) return Response.json({code: "entity_not_found"}, {status: 404})
    if ("status" in user) return Response.json({message: "failure"}, {status: user.status})
    return Response.json({object: "user", id, first_name: null, ...user})
  }) as typeof fetch
  return {stub, requests}
}

// --- Hosted Core -----------------------------------------------------------

describe("hosted Core: Supabase behind Core's sign-in server", () => {
  let idp: FakeIdp
  let restoreFetch: () => void = () => {}

  beforeEach(async () => {
    idp = await installFakeIdp({issuer: SUPABASE_ISSUER, jwksUrl: SUPABASE_JWKS, hs256Secret: SUPABASE_SECRET, projectUrl: SUPABASE_PROJECT})
    restoreFetch = routeOriginsToApp(app, [OIDC_ISSUER])
  })

  afterEach(() => {
    restoreFetch()
    idp.restore()
  })

  const signIn = (person: FakePerson, portal: "portal" | "admin" = "portal") => portalSignIn(app, idp, {portal, person})

  test("a developer imported from the Store signs in through Core's provider with their verified email and receives both memberships, once", async () => {
    // The Store: Dee owns one developer org and is a member of another.
    const source = await openSourceConnection(storeUrl)
    try {
      assertConnectedTo(storeUrl, source.name)
      const at = new Date("2026-02-01T10:00:00.000Z")
      await source.db!.collection("developer_orgs").insertMany([
        {orgId: "dorg_studio", ownerUserId: "user_01DEE", displayName: "Studio", createdAt: at, updatedAt: at},
        {orgId: "dorg_partner", ownerUserId: "user_01PAT", displayName: "Partner", createdAt: at, updatedAt: at},
      ])
      await source.db!.collection("developer_org_memberships").insertMany([
        {orgId: "dorg_studio", userId: "user_01DEE", role: "owner", status: "active", email: "dee@studio.example", createdAt: at},
        {orgId: "dorg_partner", userId: "user_01PAT", role: "owner", status: "active", email: "pat@partner.example", createdAt: at},
        {orgId: "dorg_partner", userId: "user_01DEE", role: "member", status: "active", email: "dee@studio.example", createdAt: at},
      ])
      expect((await migrateStoreDeveloperOrgs({source, apply: true})).counts).toMatchObject({orgs: 2, memberships: 3})

      // The operator exports the WorkOS users' verified emails (Pat's is not verified).
      const workos = workosStub({
        user_01DEE: {email: "Dee@Studio.example", email_verified: true},
        user_01PAT: {email: "pat@partner.example", email_verified: false},
      })
      const exported = await exportLegacyBrowserIdentities({apply: true, apiKey: "sk_test_export", fetch: workos.stub})
      expect(exported.skippedUnverified).toEqual(["user_01PAT"])
      expect(await identity("user_01DEE")).toMatchObject({email: "dee@studio.example", claimedAt: null, claimedBy: null})

      // Dee signs in to the workspace portal with a Mentra account confirmed for that address.
      const first = await signIn({sub: "supa-dee", email: "Dee@Studio.example", emailConfirmed: true})
      expect(first.sessionCookie).toBeTruthy()
      const dee = await mentraUser("supa-dee")

      const held = await WorkspaceMembershipModel.find({mentraUserId: dee, status: "active"}).sort({workspaceId: 1}).lean()
      expect(held.map(row => [row.workspaceId, row.role, row.pendingWorkosUserId])).toEqual([
        ["dorg_partner", "developer", null],
        ["dorg_studio", "owner", null],
      ])
      expect(await identity("user_01DEE")).toMatchObject({claimedBy: dee})
      expect((await identity("user_01DEE")).claimedAt).toBeInstanceOf(Date)
      expect((await claimEvents()).map(([action, workspaceId]) => [action, workspaceId]).sort()).toEqual([
        ["membership.claimed", "dorg_partner"],
        ["membership.claimed", "dorg_studio"],
      ])
      // Pat has not signed in: their memberships still wait.
      expect(await WorkspaceMembershipModel.countDocuments({pendingWorkosUserId: "user_01PAT", status: "active"})).toBe(1)

      const listed = await app.request(`${PORTAL_ORIGIN}/api/portal/workspaces`, {
        headers: {cookie: `${PORTAL_COOKIE}=${first.sessionCookie}`},
      })
      expect(((await listed.json()) as {items: Array<{workspaceId: string}>}).items.map(item => item.workspaceId).sort()).toEqual([
        "dorg_partner",
        "dorg_studio",
      ])

      // Once: signing in again (to the other portal, too) changes nothing.
      const memberships = await WorkspaceMembershipModel.find({}).sort({membershipId: 1}).lean()
      const events = await WorkspaceAuditEventModel.countDocuments({})
      await signIn({sub: "supa-dee", email: "dee@studio.example", emailConfirmed: true})
      await signIn({sub: "supa-dee", email: "dee@studio.example", emailConfirmed: true}, "admin")
      expect(await WorkspaceMembershipModel.find({}).sort({membershipId: 1}).lean()).toEqual(memberships)
      expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)
    } finally {
      assertConnectedTo(storeUrl, source.name)
      await source.dropDatabase()
      await source.close()
    }
  })

  test("a developer's first Core access token claims their memberships without any portal sign-in", async () => {
    await seedWorkspace("ws_a")
    await seedWorkspace("ws_b")
    await seedPending("ws_a", "user_01API", "admin")
    await seedPending("ws_b", "user_01API", "developer")
    await seedIdentity("user_01API", "api@studio.example")
    const token = await coreAccessToken({sub: "supa-api", email: "api@studio.example", emailVerified: true, clientId: "mentra-cli"})
    expect((await identity("user_01API")).claimedAt).toBeNull()

    const reply = await bearerRequest("/api/workspaces", token)

    expect(reply.status).toBe(200)
    const items = ((await reply.json()) as {items: Array<{workspaceId: string; membership: {role: string}}>}).items
    expect(items.map(item => [item.workspaceId, item.membership.role]).sort()).toEqual([
      ["ws_a", "admin"],
      ["ws_b", "developer"],
    ])
    expect(await identity("user_01API")).toMatchObject({claimedBy: await mentraUser("supa-api")})
  })

  test("the Store's first request for a developer, through the signed service API, claims their memberships", async () => {
    await seedWorkspace("ws_store")
    await seedPending("ws_store", "user_01SVC", "owner")
    await seedIdentity("user_01SVC", "svc@studio.example")
    // A Core access token the Developer Console's server received, as the Store passes it on.
    const token = await coreAccessToken({sub: "supa-svc", email: "svc@studio.example", emailVerified: true, clientId: "console"})

    const resolved = await store().resolvePrincipal(token)

    expect(resolved?.principal).toMatchObject({kind: "user", mentraUserId: await mentraUser("supa-svc")})
    expect(resolved?.workspaces.map(workspace => [workspace.workspaceId, workspace.membership.role])).toEqual([["ws_store", "owner"]])
    const decision = await store().authorize({
      credential: {type: "bearer", token},
      capability: "workspace.members.manage",
      workspaceId: "ws_store",
    })
    expect(decision.allowed).toBe(true)
  })

  test("the bearer path checks a person at most once per ten minutes in a process; a provider sign-in always checks", async () => {
    const token = await coreAccessToken({sub: "supa-late", email: "late@studio.example", emailVerified: true})
    expect((await bearerRequest("/api/workspaces", token)).status).toBe(200)
    // The export lands after the person's first request.
    await seedWorkspace("ws_late")
    const pending = await seedPending("ws_late", "user_01LATE", "developer")
    await seedIdentity("user_01LATE", "late@studio.example")
    const findIdentities = spyOn(LegacyBrowserIdentityModel, "find")
    try {
      expect((await bearerRequest("/api/workspaces", token)).status).toBe(200)
      // Checked moments ago: no lookup at all, and nothing claimed yet.
      expect(findIdentities).not.toHaveBeenCalled()
    } finally {
      findIdentities.mockRestore()
    }
    expect((await membership(pending)).mentraUserId).toBeNull()

    // Signing in through Core's provider checks again.
    await signIn({sub: "supa-late", email: "late@studio.example", emailConfirmed: true})
    expect(await membership(pending)).toMatchObject({mentraUserId: await mentraUser("supa-late"), pendingWorkosUserId: null})
  })

  test("a membership the person already holds absorbs the imported one: the higher role wins, keys and invitations follow, all audited", async () => {
    const merged = await mentraUser("supa-merge")
    await seedWorkspace("ws_m", {authorizationRevision: 3})
    await seedWorkspace("ws_n")
    // Mo joined ws_m in Core as a developer; the Store had Mo as its owner.
    await WorkspaceMembershipModel.create(
      membershipRow({membershipId: "wm_held", workspaceId: "ws_m", mentraUserId: merged, email: "mo@studio.example", role: "developer", status: "active", startedAt: STARTED}),
    )
    const duplicate = await seedPending("ws_m", "user_01MO", "owner")
    const live = await seedKey("ws_m", duplicate)
    const revoked = await seedKey("ws_m", duplicate, {revokedAt: STARTED})
    await WorkspaceInvitationModel.create({
      invitationId: "winv_by_duplicate",
      workspaceId: "ws_m",
      email: "friend@studio.example",
      role: "developer",
      tokenHash: sha256Hex("invite"),
      invitedByAuthority: "system",
      invitedByMembershipId: duplicate,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    const fresh = await seedPending("ws_n", "user_01MO", "member")
    await seedIdentity("user_01MO", "mo@studio.example")
    expect(await validateCredentialToken(live.token)).not.toBeNull()

    expect(await claimLegacyIdentities({mentraUserId: merged, email: "MO@studio.example", emailVerified: true})).toEqual({
      claimedIdentities: 1,
    })

    // The membership Mo already held is kept and raised to owner, at the revision the merge produced.
    const kept = await membership("wm_held")
    expect(kept).toMatchObject({status: "active", role: "owner", mentraUserId: merged})
    expect(kept.roleHistory.map(entry => [entry.role, entry.authorizationRevision])).toEqual([
      ["developer", 0],
      ["owner", 4],
    ])
    expect(await membership(duplicate)).toMatchObject({status: "ended", endedReason: "removed", mentraUserId: null})
    expect((await WorkspaceModel.findOne({workspaceId: "ws_m"}).lean())?.authorizationRevision).toBe(4)
    expect(await countActiveOwners("ws_m")).toBe(1)
    // Its live key now belongs to the kept membership and keeps publishing; the revoked one stays history.
    expect(await AccessCredentialModel.findOne({credentialId: live.credentialId}).lean()).toMatchObject({
      createdByMembershipId: "wm_held",
      createdByMentraUserId: merged,
    })
    expect(await validateCredentialToken(live.token)).toMatchObject({workspaceId: "ws_m", scopes: ["miniapps.publish"]})
    expect(await AccessCredentialModel.findOne({credentialId: revoked.credentialId}).lean()).toMatchObject({
      createdByMembershipId: duplicate,
      createdByMentraUserId: merged,
    })
    // So does the invitation it sent: ending the kept membership would revoke it.
    expect(await WorkspaceInvitationModel.findOne({invitationId: "winv_by_duplicate"}).lean()).toMatchObject({
      status: "pending",
      invitedByMembershipId: "wm_held",
      invitedByMentraUserId: merged,
    })
    // In ws_n there was nothing to merge with: the membership is claimed in place.
    expect(await membership(fresh)).toMatchObject({mentraUserId: merged, pendingWorkosUserId: null, role: "member"})
    expect((await WorkspaceModel.findOne({workspaceId: "ws_n"}).lean())?.authorizationRevision).toBe(1)

    expect(await claimEvents()).toEqual([
      ["membership.merged_duplicate", "ws_m", duplicate],
      ["membership.claimed", "ws_n", fresh],
    ])
    const [mergedEvent] = await WorkspaceAuditEventModel.find({action: "membership.merged_duplicate"}).lean()
    expect(mergedEvent).toMatchObject({
      actor: {kind: "system"},
      target: {membershipId: duplicate, mentraUserId: merged},
      before: {role: "owner", keptMembershipId: "wm_held", keptRole: "developer"},
      after: {
        status: "ended",
        endedReason: "removed",
        keptMembershipId: "wm_held",
        resultingRole: "owner",
        repointedCredentialIds: [live.credentialId],
        repointedInvitationIds: ["winv_by_duplicate"],
      },
    })
    expect(JSON.stringify(mergedEvent)).not.toContain("user_01MO")
    const [claimedEvent] = await WorkspaceAuditEventModel.find({action: "membership.claimed"}).lean()
    expect(claimedEvent).toMatchObject({
      actor: {kind: "system"},
      target: {membershipId: fresh, mentraUserId: merged},
      after: {mentraUserId: merged, role: "member"},
    })
  })

  test("an unverified email claims nothing, through a provider sign-in or a Core access token", async () => {
    await seedWorkspace("ws_u")
    const pending = await seedPending("ws_u", "user_01UNV", "owner")
    await seedIdentity("user_01UNV", "unverified@studio.example")

    await signIn({sub: "supa-unverified", email: "unverified@studio.example", emailConfirmed: false})
    expect(await SigninIdentityModel.findOne({mentraUserId: await mentraUser("supa-unverified")}).lean()).toMatchObject({
      emailVerified: false,
    })
    const token = await coreAccessToken({sub: "supa-unverified-2", email: "unverified@studio.example", emailVerified: false})
    expect((await bearerRequest("/api/workspaces", token)).status).toBe(200)
    expect(await claimLegacyIdentities({mentraUserId: await mentraUser("supa-unverified-3"), email: "unverified@studio.example", emailVerified: false})).toEqual({claimedIdentities: 0})

    expect(await membership(pending)).toMatchObject({mentraUserId: null, pendingWorkosUserId: "user_01UNV"})
    expect(await identity("user_01UNV")).toMatchObject({claimedAt: null, claimedBy: null})
    expect(await claimEvents()).toEqual([])
  })

  test("once claimed, a legacy identity is never claimed again: another Core user with the same email gets nothing", async () => {
    await seedWorkspace("ws_once")
    const pending = await seedPending("ws_once", "user_01ONCE", "admin")
    await seedIdentity("user_01ONCE", "once@studio.example")
    await signIn({sub: "supa-first", email: "once@studio.example", emailConfirmed: true})
    const first = await mentraUser("supa-first")
    expect((await membership(pending)).mentraUserId).toBe(first)
    const events = await WorkspaceAuditEventModel.countDocuments({})

    // Someone else who also verified that address later (a second Mentra account) gets nothing.
    await signIn({sub: "supa-second", email: "once@studio.example", emailConfirmed: true})
    const second = await mentraUser("supa-second")
    const token = await coreAccessToken({sub: "supa-second", email: "once@studio.example", emailVerified: true})
    expect((await bearerRequest("/api/workspaces", token)).status).toBe(200)
    expect(await claimLegacyIdentities({mentraUserId: second, email: "once@studio.example", emailVerified: true})).toEqual({
      claimedIdentities: 0,
    })
    expect(await WorkspaceMembershipModel.countDocuments({mentraUserId: second})).toBe(0)
    expect(await identity("user_01ONCE")).toMatchObject({claimedBy: first})
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)

    // A membership an import re-run adds under that WorkOS user later goes to the person who claimed it.
    await seedWorkspace("ws_rerun")
    const late = await seedPending("ws_rerun", "user_01ONCE", "developer")
    expect(await claimLegacyIdentities({mentraUserId: second, email: "once@studio.example", emailVerified: true})).toEqual({
      claimedIdentities: 0,
    })
    expect((await membership(late)).mentraUserId).toBeNull()
    await signIn({sub: "supa-first", email: "once@studio.example", emailConfirmed: true})
    expect(await membership(late)).toMatchObject({mentraUserId: first, pendingWorkosUserId: null})
  })

  test("an enterprise org owned by the WorkOS user moves to the person who claims it", async () => {
    const org = (enterpriseOrgId: string, ownerUserId: string) => ({
      enterpriseOrgId,
      ownerUserId,
      tenantId: `tenant_${enterpriseOrgId}`,
      displayName: enterpriseOrgId,
      slug: enterpriseOrgId,
    })
    await EnterpriseOrgModel.create([org("eo_mine", "user_01ENT"), org("eo_also_mine", "user_01ENT"), org("eo_other", "user_01OTHER")])
    await seedIdentity("user_01ENT", "ent@studio.example")
    const token = await coreAccessToken({sub: "supa-ent", email: "ent@studio.example", emailVerified: true})

    expect((await bearerRequest("/api/workspaces", token)).status).toBe(200)

    const owner = await mentraUser("supa-ent")
    expect((await EnterpriseOrgModel.find({}).sort({enterpriseOrgId: 1}).lean()).map(row => [row.enterpriseOrgId, row.ownerUserId])).toEqual([
      ["eo_also_mine", owner],
      ["eo_mine", owner],
      ["eo_other", "user_01OTHER"],
    ])
    expect(await identity("user_01ENT")).toMatchObject({claimedBy: owner})

    // An enterprise org added later under the WorkOS user (a re-run or a repair) goes to the person
    // at their next sign-in, though they have no pending membership left.
    await EnterpriseOrgModel.create(org("eo_added_later", "user_01ENT"))
    await claimLegacyIdentities({mentraUserId: owner, email: "ent@studio.example", emailVerified: true})
    expect((await EnterpriseOrgModel.findOne({enterpriseOrgId: "eo_added_later"}).lean())?.ownerUserId).toBe(owner)
  })

  test("an imported owner still waiting counts toward the last owner only while someone can claim it", async () => {
    await seedWorkspace("ws_owners")
    await seedPending("ws_owners", "user_01PO", "owner")
    // No legacy identity (never exported, or removed because WorkOS stopped verifying it): nobody can
    // ever take it up, so it does not keep the workspace owned.
    expect(await countActiveOwners("ws_owners")).toBe(0)
    await seedIdentity("user_01PO", "po@studio.example")
    expect(await countActiveOwners("ws_owners")).toBe(1)
    // Claimed by an account since deleted: nobody can take it up any more.
    await UserModel.create({mentraUserId: "mu_PO_DELETED", tenantId: "t_po", tenantUserId: "po", email: "po@studio.example", supportTelemetryDeletedAt: new Date()})
    await LegacyBrowserIdentityModel.updateOne({workosUserId: "user_01PO"}, {$set: {claimedAt: new Date(), claimedBy: "mu_PO_DELETED"}})
    expect(await countActiveOwners("ws_owners")).toBe(0)
  })

  test("the phone token exchange claims nothing, and its token claims nothing at Core's API", async () => {
    await seedWorkspace("ws_phone")
    const pending = await seedPending("ws_phone", "user_01PHN", "developer")
    await seedIdentity("user_01PHN", "phone@studio.example")
    idp.registerUser({sub: "supa-phone", email: "phone@studio.example", emailConfirmed: true})
    const subjectToken = await idp.mint({sub: "supa-phone", aud: "authenticated", role: "authenticated", email: "phone@studio.example"})

    const {access_token: phoneToken} = await createSession({subjectToken})
    expect(phoneToken).toBeTruthy()
    expect((await bearerRequest("/api/workspaces", phoneToken)).status).toBe(401)
    expect(await store().resolvePrincipal(phoneToken)).toBeNull()

    expect(await membership(pending)).toMatchObject({mentraUserId: null, pendingWorkosUserId: "user_01PHN"})
    expect((await identity("user_01PHN")).claimedAt).toBeNull()
  })

  test("a person with nothing to claim opens no transaction", async () => {
    await seedIdentity("user_01ELSE", "else@studio.example")
    const someone = await mentraUser("supa-nothing")
    const startSession = spyOn(UserModel.db, "startSession")
    try {
      expect(await claimLegacyIdentities({mentraUserId: someone, email: "nothing@studio.example", emailVerified: true})).toEqual({
        claimedIdentities: 0,
      })
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      startSession.mockRestore()
    }
    // Neither does one who claimed long ago, with nothing new waiting.
    await LegacyBrowserIdentityModel.updateOne({workosUserId: "user_01ELSE"}, {$set: {claimedAt: STARTED, claimedBy: someone}})
    const again = spyOn(UserModel.db, "startSession")
    try {
      await claimLegacyIdentities({mentraUserId: someone, email: "else@studio.example", emailVerified: true})
      expect(again).not.toHaveBeenCalled()
    } finally {
      again.mockRestore()
    }
  })

  test("concurrent first requests claim each membership exactly once", async () => {
    const racer = await mentraUser("supa-race")
    await seedWorkspace("ws_r1")
    await seedWorkspace("ws_r2")
    await WorkspaceMembershipModel.create(
      membershipRow({membershipId: "wm_race_held", workspaceId: "ws_r1", mentraUserId: racer, role: "member", status: "active", startedAt: STARTED}),
    )
    const duplicate = await seedPending("ws_r1", "user_01RACE", "admin")
    const fresh = await seedPending("ws_r2", "user_01RACE", "developer")
    await seedIdentity("user_01RACE", "race@studio.example")

    const results = await Promise.all(
      Array.from({length: 8}, () => claimLegacyIdentities({mentraUserId: racer, email: "race@studio.example", emailVerified: true})),
    )

    expect(results.reduce((sum, result) => sum + result.claimedIdentities, 0)).toBe(1)
    expect(await claimEvents()).toEqual([
      ["membership.merged_duplicate", "ws_r1", duplicate],
      ["membership.claimed", "ws_r2", fresh],
    ])
    expect(await membership("wm_race_held")).toMatchObject({role: "admin", status: "active"})
    expect(await WorkspaceMembershipModel.countDocuments({mentraUserId: racer, status: "active"})).toBe(2)
  })
})

// --- A Private Cloud -------------------------------------------------------

describe("a Private Cloud: Entra behind Core's sign-in server", () => {
  let entra: FakeIdp
  let restorePrivateEnv: () => void = () => {}
  let restoreFetch: () => void = () => {}

  beforeEach(async () => {
    restorePrivateEnv = applyEnv({...PRIVATE_CLOUD_ENV, ...CORE_EXTRAS})
    resetPortalSigninCaches()
    resetUpstreamCaches()
    entra = await installFakeIdp({
      issuer: ENTRA_ISSUER,
      jwksUrl: ENTRA_JWKS,
      kind: "oidc",
      clients: [{id: CORE_API_CLIENT, secret: CORE_API_SECRET, redirectUris: [ENTRA_CALLBACK]}],
    })
    restoreFetch = routeOriginsToApp(app, [ADMIN_ORIGIN])
  })

  afterEach(() => {
    restoreFetch()
    entra.restore()
    restorePrivateEnv()
    resetPortalSigninCaches()
    resetUpstreamCaches()
  })

  const entraPerson = (oid: string, email: string) => ({sub: `pairwise-${oid}`, email, claims: {oid, tid: ENTRA_TENANT}})

  test("an email outside the provider's verified domains is unverified and claims nothing; one inside them claims", async () => {
    await seedWorkspace("ws_outside")
    await seedWorkspace("ws_inside")
    const outside = await seedPending("ws_outside", "user_01OUT", "owner")
    const inside = await seedPending("ws_inside", "user_01IN", "owner")
    await seedIdentity("user_01OUT", "dev@outside.example")
    await seedIdentity("user_01IN", "dev@contoso.com")

    const refused = await portalSignIn(app, entra, {portal: "admin", person: entraPerson("oid-outside", "dev@outside.example")})
    expect(refused.sessionCookie).toBeTruthy()
    const outsider = (await findOrCreateUser({tenantId: "contoso", tenantUserId: "oid-outside"})).mentraUserId
    expect(await SigninIdentityModel.findOne({mentraUserId: outsider}).lean()).toMatchObject({
      email: "dev@outside.example",
      emailVerified: false,
    })
    expect(await membership(outside)).toMatchObject({mentraUserId: null, pendingWorkosUserId: "user_01OUT"})
    expect((await identity("user_01OUT")).claimedAt).toBeNull()

    const accepted = await portalSignIn(app, entra, {portal: "admin", person: entraPerson("oid-inside", "dev@contoso.com")})
    expect(accepted.sessionCookie).toBeTruthy()
    const insider = (await findOrCreateUser({tenantId: "contoso", tenantUserId: "oid-inside"})).mentraUserId
    expect(await membership(inside)).toMatchObject({mentraUserId: insider, pendingWorkosUserId: null})
    const me = await app.request(`${ADMIN_ORIGIN}/api/admin/workspaces`, {headers: {cookie: `${ADMIN_COOKIE}=${accepted.sessionCookie}`}})
    expect(me.status).toBe(200)
  })
})

// --- The export ------------------------------------------------------------

describe("export-legacy-browser-identities", () => {
  /** Pending memberships, enterprise orgs and one identity already claimed, as an import and a claim leave them. */
  async function seedExportSource() {
    await seedWorkspace("ws_x")
    await seedPending("ws_x", "user_01A", "owner")
    await seedPending("ws_x", "user_01B", "developer")
    await seedPending("ws_x", "user_01C", "developer")
    const ended = await seedPending("ws_x", "user_01D", "developer")
    await WorkspaceMembershipModel.updateOne({membershipId: ended}, {$set: {status: "ended", endedAt: STARTED, endedReason: "removed"}})
    await seedPending("ws_x", "user_01F", "member")
    await EnterpriseOrgModel.create([
      {enterpriseOrgId: "eo_e", ownerUserId: "user_01E", tenantId: "t_e", displayName: "E", slug: "e"},
      {enterpriseOrgId: "eo_mu", ownerUserId: "mu_ALREADY", tenantId: "t_mu", displayName: "MU", slug: "mu"},
    ])
    await LegacyBrowserIdentityModel.create({workosUserId: "user_01F", email: "f@studio.example", claimedAt: STARTED, claimedBy: "mu_F"})
  }

  const WORKOS_USERS = {
    user_01A: {email: "A@Studio.example", email_verified: true},
    user_01B: {email: "b@studio.example", email_verified: false},
    user_01E: {email: "e@studio.example", email_verified: true},
  }

  const rows = () => LegacyBrowserIdentityModel.find({}).sort({workosUserId: 1}).lean()

  test("a dry run reads WorkOS and the target, reports, and writes nothing", async () => {
    await seedExportSource()
    const workos = workosStub(WORKOS_USERS)
    const target = await openSourceConnection(databaseUrl)
    let report
    try {
      report = await exportLegacyBrowserIdentities({apply: false, target, apiKey: "sk_test_export", fetch: workos.stub})
    } finally {
      await target.close()
    }

    expect(report).toEqual({
      mode: "dry-run",
      counts: {
        workosUsers: 5,
        verified: 2,
        inserted: 2,
        updated: 0,
        unchanged: 0,
        removed: 0,
        skippedUnverified: 1,
        notFound: 1,
        alreadyClaimed: 1,
      },
      skippedUnverified: ["user_01B"],
      notFound: ["user_01C"],
      alreadyClaimed: ["user_01F"],
      removed: [],
    })
    // Only the WorkOS users with active pending memberships or enterprise ownership, and never a claimed one.
    expect(workos.requests.map(request => request.url)).toEqual(
      ["user_01A", "user_01B", "user_01C", "user_01E"].map(id => `https://api.workos.com/user_management/users/${id}`),
    )
    expect(workos.requests.every(request => request.authorization === "Bearer sk_test_export")).toBe(true)
    expect((await rows()).map(row => row.workosUserId)).toEqual(["user_01F"])
    // The report names people by WorkOS id only.
    expect(JSON.stringify(report)).not.toContain("@")
  })

  test("apply writes verified emails, lowercased; a second run changes nothing; a changed email updates an unclaimed row only", async () => {
    await seedExportSource()
    const first = await exportLegacyBrowserIdentities({apply: true, apiKey: "sk_test_export", fetch: workosStub(WORKOS_USERS).stub})
    expect(first).toMatchObject({mode: "apply", counts: {inserted: 2, updated: 0, unchanged: 0}})
    const written = await rows()
    expect(written.map(row => [row.workosUserId, row.email, row.claimedAt ?? null, row.claimedBy ?? null])).toEqual([
      ["user_01A", "a@studio.example", null, null],
      ["user_01E", "e@studio.example", null, null],
      ["user_01F", "f@studio.example", STARTED, "mu_F"],
    ])

    const second = await exportLegacyBrowserIdentities({apply: true, apiKey: "sk_test_export", fetch: workosStub(WORKOS_USERS).stub})
    expect(second.counts).toMatchObject({inserted: 0, updated: 0, unchanged: 2})
    expect(await rows()).toEqual(written)

    const changed = await exportLegacyBrowserIdentities({
      apply: true,
      apiKey: "sk_test_export",
      fetch: workosStub({...WORKOS_USERS, user_01A: {email: "a.new@studio.example", email_verified: true}}).stub,
    })
    expect(changed.counts).toMatchObject({inserted: 0, updated: 1, unchanged: 1})
    expect((await identity("user_01A")).email).toBe("a.new@studio.example")
    expect(await identity("user_01F")).toMatchObject({email: "f@studio.example", claimedBy: "mu_F"})
  })

  test("an unclaimed identity whose email WorkOS no longer verifies, or whose user WorkOS no longer knows, is removed", async () => {
    await seedExportSource()
    await exportLegacyBrowserIdentities({apply: true, apiKey: "sk_test_export", fetch: workosStub(WORKOS_USERS).stub})
    expect((await rows()).map(row => row.workosUserId)).toEqual(["user_01A", "user_01E", "user_01F"])
    // WorkOS now reports user_01A's address unverified (it may have changed hands), and no longer knows user_01E.
    const later = {user_01A: {email: "a@studio.example", email_verified: false}, user_01B: WORKOS_USERS.user_01B}

    const target = await openSourceConnection(databaseUrl)
    let dry
    try {
      dry = await exportLegacyBrowserIdentities({apply: false, target, apiKey: "sk_test_export", fetch: workosStub(later).stub})
    } finally {
      await target.close()
    }
    expect(dry.removed).toEqual(["user_01A", "user_01E"])
    expect(dry.counts).toMatchObject({removed: 2, verified: 0})
    expect((await rows()).map(row => row.workosUserId)).toEqual(["user_01A", "user_01E", "user_01F"])

    const applied = await exportLegacyBrowserIdentities({apply: true, apiKey: "sk_test_export", fetch: workosStub(later).stub})
    expect(applied).toEqual({...dry, mode: "apply"})
    // Nobody can claim with the stale address; the claimed identity is untouched.
    expect((await rows()).map(row => row.workosUserId)).toEqual(["user_01F"])
    await expect(
      claimLegacyIdentities({mentraUserId: "mu_A", email: "a@studio.example", emailVerified: true}),
    ).resolves.toEqual({claimedIdentities: 0})
  })

  test("a WorkOS answer it cannot use stops the export before anything is written; a rate limit is retried", async () => {
    await seedExportSource()
    for (const status of [401, 500]) {
      const failing = workosStub({...WORKOS_USERS, user_01B: {status}})
      const err = await exportLegacyBrowserIdentities({apply: true, apiKey: "sk_test_export", fetch: failing.stub, retryDelayMs: 0}).then(
        () => null,
        (caught: unknown) => caught,
      )
      expect(err).toBeInstanceOf(ExportError)
      expect((err as Error).message).toContain(String(status))
      expect((err as Error).message).not.toContain("sk_test_export")
      expect((await rows()).map(row => row.workosUserId)).toEqual(["user_01F"])
    }

    let limited = 0
    const base = workosStub(WORKOS_USERS)
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (limited++ < 2) return Response.json({message: "rate limited"}, {status: 429, headers: {"retry-after": "0"}})
      return base.stub(input, init)
    }) as typeof fetch
    const report = await exportLegacyBrowserIdentities({apply: true, apiKey: "sk_test_export", fetch: flaky, retryDelayMs: 0})
    expect(report.counts).toMatchObject({inserted: 2})
  })

  test("the command line refuses an apply to a non-local database, and needs WORKOS_API_KEY", async () => {
    expect(parseExportArgs(["--target", "mongodb://127.0.0.1:27017/core"])).toEqual({
      target: "mongodb://127.0.0.1:27017/core",
      apply: false,
      allowRemote: false,
    })
    expect(() => parseExportArgs(["--target", "mongodb://mongo.example.invalid/core", "--apply"])).toThrow(ExportUsageError)
    expect(parseExportArgs(["--target", "mongodb://mongo.example.invalid/core", "--apply", "--i-understand-remote"])).toMatchObject({
      apply: true,
      allowRemote: true,
    })
    expect(() => parseExportArgs([])).toThrow(/--target/)
    expect(() => parseExportArgs(["--target", "not a url"])).toThrow(ExportUsageError)

    const run = async (args: string[], env: Record<string, string | undefined>) => {
      const proc = Bun.spawn([process.execPath, EXPORT_SCRIPT, ...args], {stdout: "pipe", stderr: "pipe", env: {...process.env, ...env}})
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return {stdout, stderr, exitCode}
    }
    // `.invalid` never resolves, so even a guard bug could not reach a real database.
    const remote = await run(["--target", "mongodb://mongo.example.invalid:27017/core", "--apply"], {WORKOS_API_KEY: "sk_test_export"})
    expect(remote.exitCode).toBe(2)
    expect(remote.stdout).toBe("")
    expect(remote.stderr).toContain("--i-understand-remote")
    const noKey = await run(["--target", databaseUrl], {WORKOS_API_KEY: ""})
    expect(noKey.exitCode).toBe(2)
    expect(noKey.stderr).toContain("WORKOS_API_KEY")
  })
})
