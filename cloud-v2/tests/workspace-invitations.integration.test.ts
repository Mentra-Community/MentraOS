/**
 * @fileoverview Workspace invitation integration tests.
 *
 * These run the real invitation service, models and transactions against a
 * local replica set. The only thing faked is the network: the invitation email
 * goes through the real `sendEmail`, whose HTTP call is intercepted at
 * `globalThis.fetch`, and the API cases sign people in through the fake
 * identity provider (`tests/support/fake-idp.ts`), whose GoTrue account
 * decides whether an email is verified.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/workspace-invitations.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {createHash} from "node:crypto"
import type {Model} from "mongoose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {listWorkspaceAudit} from "../packages/core/src/services/workspaces/audit.service"
import {
  acceptInvitation,
  acceptInvitationById,
  createInvitation,
  listInvitationsForPerson,
  listPendingInvitations,
  peekInvitation,
  revokeInvitation,
} from "../packages/core/src/services/workspaces/invitation.service"
import {
  changeRole,
  createWorkspace,
  removeMember,
  deleteWorkspace,
  getActiveMembership,
  getWorkspace,
  leaveWorkspace,
  listWorkspacesForUser,
  WorkspaceError,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {
  applyEnv,
  HOSTED_ENV,
  PORTAL_ORIGIN,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

const MODELS: Model<any>[] = [
  AuthRateLimitModel,
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
]

const URL_TEMPLATE = "https://core.example.test/invite/{token}"
const URL_PREFIX = "https://core.example.test/invite/"
const DAY_MS = 86_400_000

let databaseUrl: string
// Set only once the live connection is confirmed to be our random database;
// every destructive call is gated on it.
let verified = false

type UserActor = Actor & {kind: "user"}

function user(id: string, overrides: Partial<UserActor> = {}): UserActor {
  return {
    kind: "user",
    mentraUserId: id,
    email: `${id}@example.test`,
    emailVerified: true,
    isOrganizationAdmin: false,
    ...overrides,
  }
}

const orgAdmin = user("mu_org_admin", {isOrganizationAdmin: true})
const system: Actor = {kind: "system"}
const service: Actor = {kind: "service", service: "store", email: null}

let counter = 0
const nextId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

/** Add an active membership directly. */
async function addMember(workspaceId: string, mentraUserId: string, role: string) {
  const membershipId = `wm_${nextId()}`
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId,
      workspaceId,
      mentraUserId,
      email: `${mentraUserId}@example.test`,
      role,
      status: "active",
      startedAt: new Date(),
    }),
  )
  return membershipId
}

/** A workspace owned by `mu_owner`, with an admin `mu_admin`. */
async function newWorkspace(name = "Acme") {
  const summary = await createWorkspace(user("mu_owner"), {name})
  await addMember(summary.workspaceId, "mu_admin", "admin")
  return summary.workspaceId
}

/** A Core users row for `mentraUserId`, as signing in creates one. */
async function account(mentraUserId: string) {
  await UserModel.create({mentraUserId, tenantId: "mentra", tenantUserId: `sb-${mentraUserId}`})
}

async function revisionOf(workspaceId: string): Promise<number> {
  const row = await getWorkspace(workspaceId)
  if (!row) throw new Error(`no workspace ${workspaceId}`)
  return row.authorizationRevision
}

function tokenOf(inviteUrl: string): string {
  expect(inviteUrl.startsWith(URL_PREFIX)).toBe(true)
  return inviteUrl.slice(URL_PREFIX.length)
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

async function thrown(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error("expected the call to throw")
}

async function expectError(fn: () => Promise<unknown>, code: string, status: number) {
  const err = await thrown(fn)
  expect(err).toBeInstanceOf(WorkspaceError)
  expect({code: err.code, status: err.status}).toEqual({code, status})
}

/** Invite `email` as `role` on behalf of the owner and return the token and id. */
async function invite(
  workspaceId: string,
  email: string,
  role: "member" | "developer" | "admin" | "owner" = "developer",
) {
  const created = await createInvitation(user("mu_owner"), workspaceId, {email, role})
  return {...created, token: tokenOf(created.inviteUrl)}
}

async function expire(invitationId: string) {
  await WorkspaceInvitationModel.updateOne({invitationId}, {$set: {expiresAt: new Date(Date.now() - 1000)}})
}

const ENV_KEYS = [
  "CLOUD_CORE_ADMIN_EMAILS",
  "CLOUD_CORE_ADMIN_EMAIL_DOMAINS",
  "CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE",
  "CLOUD_CORE_ENTERPRISE_PORTAL_URL",
  "RESEND_API_KEY",
] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  databaseUrl = localTestMongoUrl("workspace-invitations")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  // Startup migrations are not run here, so create the collections and their indexes (the partial
  // unique index on pending invitations is what the concurrent-invite case leans on).
  for (const model of [...MODELS, UserModel]) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  await Promise.all([...MODELS, UserModel].map(model => model.deleteMany({})))
  process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = URL_TEMPLATE
  // `orgAdmin` is an Organization Admin by this allowlist, and has an account.
  process.env.CLOUD_CORE_ADMIN_EMAILS = orgAdmin.email!
  delete process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS
  delete process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL
  delete process.env.RESEND_API_KEY
  await account(orgAdmin.mentraUserId)
})

describe("createInvitation", () => {
  test("an admin invites a developer: only the token hash is stored, the revision is untouched", async () => {
    const ws = await newWorkspace()
    const adminMembership = (await getActiveMembership(ws, "mu_admin"))!.membershipId
    // Backdate the workspace document: inviting must write it (that is what makes
    // it conflict with the workspace's other mutations) without bumping the revision.
    await WorkspaceModel.collection.updateOne({workspaceId: ws}, {$set: {updatedAt: new Date(0)}})
    const before = Date.now()

    const created = await createInvitation(user("mu_admin"), ws, {email: "dev@example.test", role: "developer"})

    expect(created.invitationId).toMatch(/^winv_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(created.inviteUrl).toMatch(/^https:\/\/core\.example\.test\/invite\/[A-Za-z0-9_-]{43}$/)
    const ttl = created.expiresAt.getTime() - before
    expect(ttl).toBeGreaterThan(14 * DAY_MS - 5000)
    expect(ttl).toBeLessThan(14 * DAY_MS + 5000)

    const token = tokenOf(created.inviteUrl)
    const row = (await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!
    expect(row).toMatchObject({
      workspaceId: ws,
      email: "dev@example.test",
      role: "developer",
      status: "pending",
      invitedByAuthority: "membership",
      invitedByMembershipId: adminMembership,
      invitedByMentraUserId: "mu_admin",
      invitedByEmail: null,
      tokenHash: sha256(token),
      acceptedMembershipId: null,
    })
    expect(row.expiresAt.getTime()).toBe(created.expiresAt.getTime())
    expect(JSON.stringify(row)).not.toContain(token)

    // Inviting does not change anyone's membership, so the revision stays.
    expect(await revisionOf(ws)).toBe(0)
    expect((await WorkspaceModel.findOne({workspaceId: ws}).lean())!.updatedAt.getTime()).toBeGreaterThanOrEqual(before)

    const events = await listWorkspaceAudit(ws, {limit: 10})
    expect(events[0]).toMatchObject({
      action: "invitation.created",
      actor: {kind: "user", mentraUserId: "mu_admin"},
      target: {invitationId: created.invitationId, email: "dev@example.test"},
      after: {email: "dev@example.test", role: "developer"},
    })
    expect(JSON.stringify(events)).not.toContain(token)
    expect(JSON.stringify(events)).not.toContain(row.tokenHash)
  })

  test("the token is stored nowhere, and its stored hash is not itself a working token", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test")
    const row = (await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!

    // No document in any collection holds the token: the link carries the only copy.
    const collections = await WorkspaceModel.db.db!.listCollections().toArray()
    expect(collections.length).toBeGreaterThan(0)
    for (const {name} of collections) {
      const documents = await WorkspaceModel.db.db!.collection(name).find({}).toArray()
      expect({name, leaked: JSON.stringify(documents).includes(created.token)}).toEqual({name, leaked: false})
    }

    // Someone who can read the database learns the hash, which opens nothing.
    expect(await peekInvitation(row.tokenHash)).toBeNull()
    await expectError(
      () => acceptInvitation(user("mu_dev", {email: "dev@example.test"}), row.tokenHash),
      "invitation_not_found",
      404,
    )
    expect(await peekInvitation(created.token)).not.toBeNull()
  })

  test("inviting an admin or owner needs an owner; lower roles cannot invite at all", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_dev", "developer")
    await addMember(ws, "mu_member", "member")
    const admin = user("mu_admin")

    await expectError(() => createInvitation(admin, ws, {email: "a@example.test", role: "admin"}), "forbidden", 403)
    await expectError(() => createInvitation(admin, ws, {email: "o@example.test", role: "owner"}), "forbidden", 403)
    for (const actor of [user("mu_dev"), user("mu_member"), user("mu_stranger"), service]) {
      await expectError(() => createInvitation(actor, ws, {email: "m@example.test", role: "member"}), "forbidden", 403)
    }
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "invitation.created"})).toBe(0)

    // The admin can invite the lower roles.
    await createInvitation(admin, ws, {email: "m@example.test", role: "member"})
    await createInvitation(admin, ws, {email: "d@example.test", role: "developer"})
    // The owner, an organization admin and the system can invite privileged roles.
    await createInvitation(user("mu_owner"), ws, {email: "a@example.test", role: "admin"})
    await createInvitation(orgAdmin, ws, {email: "o@example.test", role: "owner"})
    await createInvitation(system, ws, {email: "o2@example.test", role: "admin"})
    expect(await WorkspaceInvitationModel.countDocuments({status: "pending"})).toBe(5)
    // Organization admins and the system hold no membership of their own; each invitation records its authority.
    expect(await WorkspaceInvitationModel.findOne({email: "o@example.test"}).lean()).toMatchObject({
      invitedByAuthority: "organization_admin",
      invitedByMembershipId: null,
      invitedByMentraUserId: orgAdmin.mentraUserId,
      invitedByEmail: orgAdmin.email,
    })
    expect(await WorkspaceInvitationModel.findOne({email: "o2@example.test"}).lean()).toMatchObject({
      invitedByAuthority: "system",
      invitedByMembershipId: null,
      invitedByMentraUserId: null,
      invitedByEmail: null,
    })
  })

  test("an inviter whose own email is unverified is 403 email_unverified, and nothing is written", async () => {
    const ws = await newWorkspace()
    const unverified = [
      user("mu_owner", {emailVerified: false}),
      user("mu_admin", {emailVerified: false}),
      // Anything but a real `true` is not verified.
      user("mu_owner", {emailVerified: "true" as unknown as boolean}),
      user("mu_org_admin", {isOrganizationAdmin: true, emailVerified: false}),
    ]
    for (const actor of unverified) {
      await expectError(
        () => createInvitation(actor, ws, {email: "dev@example.test", role: "member"}),
        "email_unverified",
        403,
      )
    }
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "invitation.created"})).toBe(0)

    // Who may not invite at all hears that first, whatever their email.
    await expectError(
      () => createInvitation(user("mu_stranger", {emailVerified: false}), ws, {email: "x@example.test", role: "member"}),
      "forbidden",
      403,
    )
  })

  test("the role must be a workspace role (400 invalid_role)", async () => {
    const ws = await newWorkspace()
    for (const role of ["root", "", undefined, 3]) {
      await expectError(
        () => createInvitation(user("mu_owner"), ws, {email: "x@example.test", role: role as never}),
        "invalid_role",
        400,
      )
    }
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(0)
  })

  test("emails are trimmed and lowercased; unusable ones are rejected (400 invalid_request)", async () => {
    const ws = await newWorkspace()
    const created = await createInvitation(user("mu_owner"), ws, {email: "  Dev.Name@Example.TEST \n", role: "member"})
    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.email).toBe(
      "dev.name@example.test",
    )

    const tooLong = `${"a".repeat(250)}@b.co`
    for (const email of [
      "",
      "   ",
      "no-at-sign",
      "a@b@c.test",
      "@example.test",
      "a@",
      "a b@example.test",
      tooLong,
      7,
      null,
    ]) {
      await expectError(
        () => createInvitation(user("mu_owner"), ws, {email: email as never, role: "member"}),
        "invalid_request",
        400,
      )
    }
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(1)
    // The longest allowed address (254 characters) is accepted.
    const longest = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`
    expect(longest).toHaveLength(254)
    await createInvitation(user("mu_owner"), ws, {email: longest, role: "member"})
  })

  test("an unknown or deleted workspace is 404 not_found / 410 workspace_deleted", async () => {
    await expectError(
      () => createInvitation(user("mu_owner"), "ws_missing", {email: "x@example.test", role: "member"}),
      "not_found",
      404,
    )
    const ws = await newWorkspace()
    await deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme"})
    await expectError(
      () => createInvitation(user("mu_owner"), ws, {email: "x@example.test", role: "member"}),
      "workspace_deleted",
      410,
    )
  })

  test("CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE must contain {token}: invitations_unavailable at first use, nothing written", async () => {
    const ws = await newWorkspace()
    const bad = [
      undefined,
      "",
      "   ",
      "https://core.example.test/invite",
      "/invite/{token}",
      "ftp://core.example.test/{token}",
    ]
    for (const template of bad) {
      if (template === undefined) delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
      else process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = template
      const err = await thrown(() => createInvitation(user("mu_owner"), ws, {email: "x@example.test", role: "member"}))
      expect(err).toBeInstanceOf(WorkspaceError)
      expect({code: err.code, status: err.status}).toEqual({code: "invitations_unavailable", status: 503})
    }
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "invitation.created"})).toBe(0)

    // The token can sit anywhere in the template, and every occurrence is replaced.
    process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = "https://core.example.test/join?code={token}&again={token}#x"
    const created = await createInvitation(user("mu_owner"), ws, {email: "x@example.test", role: "member"})
    const token = new URL(created.inviteUrl).searchParams.get("code")!
    expect(token).toHaveLength(43)
    expect(created.inviteUrl).toBe(`https://core.example.test/join?code=${token}&again=${token}#x`)
  })

  test("without a template the link is the workspace portal's accept page, at the portal URL's origin", async () => {
    const ws = await newWorkspace()
    delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
    // Only the origin counts: a path, query or fragment on the configured URL is not carried over.
    process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL = "https://portal.example.test:8443/some/path?tab=1#top"

    const created = await createInvitation(user("mu_owner"), ws, {email: "dev@example.test", role: "developer"})

    const link = new URL(created.inviteUrl)
    expect(`${link.origin}${link.pathname}`).toBe("https://portal.example.test:8443/")
    expect([...link.searchParams.keys()]).toEqual(["workspaceInvite"])
    const token = link.searchParams.get("workspaceInvite")!
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(created.inviteUrl).toBe(`https://portal.example.test:8443/?workspaceInvite=${token}`)
    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.tokenHash).toBe(
      sha256(token),
    )
    expect(await peekInvitation(token)).toMatchObject({workspaceName: "Acme", email: "dev@example.test", role: "developer"})

    // A blank template counts as unset.
    process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = "   "
    const blank = await createInvitation(user("mu_owner"), ws, {email: "other@example.test", role: "member"})
    expect(blank.inviteUrl).toStartWith("https://portal.example.test:8443/?workspaceInvite=")

    // A configured template wins over the portal, and an unusable one is not quietly replaced by it.
    process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = URL_TEMPLATE
    expect((await createInvitation(user("mu_owner"), ws, {email: "third@example.test", role: "member"})).inviteUrl).toStartWith(
      URL_PREFIX,
    )
    process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = "https://core.example.test/invite"
    const err = await thrown(() => createInvitation(user("mu_owner"), ws, {email: "fourth@example.test", role: "member"}))
    expect(err).toBeInstanceOf(WorkspaceError)
    expect({code: err.code, status: err.status}).toEqual({code: "invitations_unavailable", status: 503})
    expect(await WorkspaceInvitationModel.countDocuments({email: "fourth@example.test"})).toBe(0)
  })

  test("with neither a template nor a usable portal URL, inviting is invitations_unavailable before anything is written", async () => {
    const ws = await newWorkspace()
    delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
    const revision = await revisionOf(ws)
    const events = await WorkspaceAuditEventModel.countDocuments({})
    // Backdate the workspace document: a refused invitation must not have touched it either.
    await WorkspaceModel.collection.updateOne({workspaceId: ws}, {$set: {updatedAt: new Date(0)}})

    for (const portal of [undefined, "", "   ", "not a url", "portal.example.test"]) {
      if (portal === undefined) delete process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL
      else process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL = portal
      const err = await thrown(() => createInvitation(user("mu_owner"), ws, {email: "dev@example.test", role: "member"}))
      expect(err).toBeInstanceOf(WorkspaceError)
      expect({code: err.code, status: err.status}).toEqual({code: "invitations_unavailable", status: 503})
    }

    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)
    expect(await revisionOf(ws)).toBe(revision)
    expect((await WorkspaceModel.findOne({workspaceId: ws}).lean())!.updatedAt.getTime()).toBe(0)
  })

  test("an unusable template never hides who may not invite: unauthorized callers get 403/404/410, not the configuration error", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_dev", "developer")
    const deleted = await newWorkspace("Gone")
    await deleteWorkspace(user("mu_owner"), deleted, {confirmName: "Gone"})
    delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
    const input = {email: "x@example.test", role: "member"} as const

    await expectError(() => createInvitation(user("mu_stranger"), ws, input), "forbidden", 403)
    await expectError(() => createInvitation(user("mu_dev"), ws, input), "forbidden", 403)
    await expectError(
      () => createInvitation(user("mu_admin"), ws, {email: "o@example.test", role: "owner"}),
      "forbidden",
      403,
    )
    await expectError(() => createInvitation(user("mu_owner"), "ws_missing", input), "not_found", 404)
    await expectError(() => createInvitation(user("mu_owner"), deleted, input), "workspace_deleted", 410)
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(0)

    // An authorized caller still gets the configuration error, with nothing written.
    await expectError(() => createInvitation(user("mu_admin"), ws, input), "invitations_unavailable", 503)
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "invitation.created"})).toBe(0)
  })

  test("re-inviting the same email revokes the previous token", async () => {
    const ws = await newWorkspace()
    const first = await invite(ws, "dev@example.test", "member")
    const second = await invite(ws, "DEV@example.test", "developer")

    expect(second.invitationId).not.toBe(first.invitationId)
    expect(second.token).not.toBe(first.token)
    expect(await peekInvitation(first.token)).toBeNull()
    expect(await peekInvitation(second.token)).toMatchObject({email: "dev@example.test", role: "developer"})
    await expectError(
      () => acceptInvitation(user("mu_dev", {email: "dev@example.test"}), first.token),
      "invitation_not_found",
      404,
    )

    const rows = await WorkspaceInvitationModel.find({workspaceId: ws}).sort({_id: 1}).lean()
    expect(rows.map(row => [row.invitationId, row.status])).toEqual([
      [first.invitationId, "revoked"],
      [second.invitationId, "pending"],
    ])
    const revoked = (await listWorkspaceAudit(ws, {limit: 10})).filter(event => event.action === "invitation.revoked")
    expect(revoked).toHaveLength(1)
    expect(revoked[0]).toMatchObject({
      // Whose invitation it was, so the audit log can say so.
      target: {invitationId: first.invitationId, email: "dev@example.test"},
      before: {status: "pending", role: "member"},
      after: {status: "revoked", reason: "superseded", supersededBy: second.invitationId},
    })

    // The new token works.
    const accepted = await acceptInvitation(user("mu_dev", {email: "dev@example.test"}), second.token)
    expect((await getActiveMembership(ws, "mu_dev"))!.role).toBe("developer")
    expect(accepted.workspaceId).toBe(ws)
  })

  test("a different workspace or email is not superseded", async () => {
    const ws = await newWorkspace()
    const other = (await createWorkspace(user("mu_owner"), {name: "Other"})).workspaceId
    const a = await invite(ws, "a@example.test")
    const b = await invite(ws, "b@example.test")
    const elsewhere = await invite(other, "a@example.test")

    expect(await peekInvitation(a.token)).not.toBeNull()
    expect(await peekInvitation(b.token)).not.toBeNull()
    expect(await peekInvitation(elsewhere.token)).not.toBeNull()
  })

  test("two concurrent invitations to one email leave exactly one usable token", async () => {
    for (let round = 0; round < 5; round++) {
      const ws = (await createWorkspace(user("mu_owner"), {name: `Race ${round}`})).workspaceId
      const results = await Promise.all([
        createInvitation(user("mu_owner"), ws, {email: "dev@example.test", role: "member"}),
        createInvitation(user("mu_owner"), ws, {email: "dev@example.test", role: "developer"}),
      ])
      expect(await WorkspaceInvitationModel.countDocuments({workspaceId: ws, status: "pending"})).toBe(1)
      const usable = await Promise.all(results.map(result => peekInvitation(tokenOf(result.inviteUrl))))
      expect(usable.filter(Boolean)).toHaveLength(1)
    }
  })
})

describe("an invitation carries its inviter's authority", () => {
  test("it is revoked when the inviter's membership ends", async () => {
    const ws = await newWorkspace()
    const created = await createInvitation(user("mu_admin"), ws, {email: "dev@example.test", role: "developer"})
    const adminMembership = (await getActiveMembership(ws, "mu_admin"))!.membershipId

    await removeMember(user("mu_owner"), ws, adminMembership, await revisionOf(ws))

    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.status).toBe("revoked")
    const removed = (await listWorkspaceAudit(ws, {limit: 10})).find(event => event.action === "membership.removed")!
    expect((removed.after as {revokedInvitationIds: string[]}).revokedInvitationIds).toEqual([created.invitationId])
    await expectError(
      () => acceptInvitation(user("mu_dev", {email: "dev@example.test"}), tokenOf(created.inviteUrl)),
      "invitation_not_found",
      404,
    )
  })

  test("acceptance is refused once the inviter's role no longer grants the invited role", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_owner2", "owner")
    const created = await createInvitation(user("mu_owner2"), ws, {email: "boss@example.test", role: "owner"})
    const ownerTwo = (await getActiveMembership(ws, "mu_owner2"))!.membershipId
    await changeRole(user("mu_owner"), ws, ownerTwo, "admin", await revisionOf(ws))

    await expectError(
      () => acceptInvitation(user("mu_boss", {email: "boss@example.test"}), tokenOf(created.inviteUrl)),
      "invitation_not_found",
      404,
    )
    expect(await getActiveMembership(ws, "mu_boss")).toBeNull()

    // An invitation the demoted inviter may still send is unaffected.
    const member = await createInvitation(user("mu_owner2"), ws, {email: "member@example.test", role: "member"})
    await acceptInvitation(user("mu_member", {email: "member@example.test"}), tokenOf(member.inviteUrl))
    expect((await getActiveMembership(ws, "mu_member"))?.role).toBe("member")
  })

  test("an Organization Admin's invitation does not depend on a membership", async () => {
    const ws = await newWorkspace()
    // A plain member who is also an Organization Admin invites an owner on the strength of the latter.
    await addMember(ws, orgAdmin.mentraUserId, "member")
    const created = await createInvitation(orgAdmin, ws, {email: "heir@example.test", role: "owner"})
    expect(await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean()).toMatchObject({
      invitedByAuthority: "organization_admin",
      invitedByMembershipId: null,
    })

    await acceptInvitation(user("mu_heir", {email: "heir@example.test"}), tokenOf(created.inviteUrl))
    expect((await getActiveMembership(ws, "mu_heir"))?.role).toBe("owner")
  })

  test("an Organization Admin whose own membership grants the role invites on that membership", async () => {
    const ws = await newWorkspace()
    const membershipId = await addMember(ws, orgAdmin.mentraUserId, "owner")
    const created = await createInvitation(orgAdmin, ws, {email: "heir@example.test", role: "owner"})
    expect(await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean()).toMatchObject({
      invitedByAuthority: "membership",
      invitedByMembershipId: membershipId,
      invitedByMentraUserId: orgAdmin.mentraUserId,
      invitedByEmail: null,
    })
    // Leaving the allowlist does not matter to an invitation the membership sent.
    process.env.CLOUD_CORE_ADMIN_EMAILS = "someone-else@example.test"
    await acceptInvitation(user("mu_heir", {email: "heir@example.test"}), tokenOf(created.inviteUrl))
    expect((await getActiveMembership(ws, "mu_heir"))?.role).toBe("owner")
  })

  test("an Organization Admin's invitation stops working when they leave the admin allowlist, and works again if they return", async () => {
    const ws = await newWorkspace()
    const created = await createInvitation(orgAdmin, ws, {email: "heir@example.test", role: "owner"})
    const token = tokenOf(created.inviteUrl)
    const heir = user("mu_heir", {email: "heir@example.test"})

    process.env.CLOUD_CORE_ADMIN_EMAILS = "someone-else@example.test"
    expect(await peekInvitation(token)).toBeNull()
    await expectError(() => acceptInvitation(heir, token), "invitation_not_found", 404)
    expect(await getActiveMembership(ws, "mu_heir")).toBeNull()
    // Nothing was revoked: the allowlist decides, as it does for operator keys.
    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.status).toBe("pending")

    // A listed domain counts as well.
    process.env.CLOUD_CORE_ADMIN_EMAIL_DOMAINS = "example.test"
    expect(await peekInvitation(token)).not.toBeNull()
    await acceptInvitation(heir, token)
    expect((await getActiveMembership(ws, "mu_heir"))?.role).toBe("owner")
  })

  test("an Organization Admin's invitation stops working once their account is deleted or gone", async () => {
    const ws = await newWorkspace()
    const created = await createInvitation(orgAdmin, ws, {email: "heir@example.test", role: "owner"})
    const token = tokenOf(created.inviteUrl)
    const heir = user("mu_heir", {email: "heir@example.test"})

    // Account deletion sets the tombstone before anything else about workspaces happens.
    await UserModel.updateOne({mentraUserId: orgAdmin.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
    expect(await peekInvitation(token)).toBeNull()
    await expectError(() => acceptInvitation(heir, token), "invitation_not_found", 404)

    await UserModel.deleteOne({mentraUserId: orgAdmin.mentraUserId})
    await expectError(() => acceptInvitation(heir, token), "invitation_not_found", 404)
    expect(await getActiveMembership(ws, "mu_heir")).toBeNull()
  })

  test("an Organization Admin whose email does not make them one cannot invite on the organization's authority", async () => {
    const ws = await newWorkspace()
    // A principal flagged as an Organization Admin, but by an address the allowlist does not hold: an
    // invitation recorded with it could never be accepted, so none is sent.
    const mislabelled = user("mu_mislabelled", {isOrganizationAdmin: true})
    await expectError(
      () => createInvitation(mislabelled, ws, {email: "heir@example.test", role: "owner"}),
      "forbidden",
      403,
    )
    expect(await WorkspaceInvitationModel.countDocuments({email: "heir@example.test"})).toBe(0)
  })
})

describe("deleted accounts", () => {
  test("a deleted account cannot accept an invitation (account_deleted), even to its own address", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "gone@example.test", "developer")
    await account("mu_gone")
    // What account deletion does first: the users row becomes a tombstone.
    await UserModel.updateOne({mentraUserId: "mu_gone"}, {$set: {supportTelemetryDeletedAt: new Date()}})

    await expectError(
      () => acceptInvitation(user("mu_gone", {email: "gone@example.test"}), created.token),
      "account_deleted",
      403,
    )
    expect(await getActiveMembership(ws, "mu_gone")).toBeNull()
    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.status).toBe("pending")
  })
})

describe("invitation limits", () => {
  test("a person may send 100 invitations an hour", async () => {
    const ws = await newWorkspace()
    for (let i = 0; i < 100; i++) {
      await createInvitation(user("mu_owner"), ws, {email: `bulk-${i}@example.test`, role: "member"})
    }
    await expectError(
      () => createInvitation(user("mu_owner"), ws, {email: "one-more@example.test", role: "member"}),
      "rate_limited",
      429,
    )
    expect(await WorkspaceInvitationModel.countDocuments({email: "one-more@example.test"})).toBe(0)
    // Another person is not held back.
    await createInvitation(user("mu_admin"), ws, {email: "from-admin@example.test", role: "member"})
  })

  test("a workspace holds at most 200 pending invitations", async () => {
    const ws = await newWorkspace()
    const expiresAt = new Date(Date.now() + DAY_MS)
    await WorkspaceInvitationModel.insertMany(
      Array.from({length: 200}, (_, i) => ({
        invitationId: `winv_seed_${i}`,
        workspaceId: ws,
        email: `seed-${i}@example.test`,
        role: "member",
        tokenHash: sha256(`seed-${i}`),
        status: "pending",
        invitedByAuthority: "system",
        expiresAt,
      })),
    )
    await expectError(
      () => createInvitation(user("mu_owner"), ws, {email: "overflow@example.test", role: "member"}),
      "rate_limited",
      429,
    )
    await revokeInvitation(user("mu_owner"), ws, "winv_seed_0")
    await createInvitation(user("mu_owner"), ws, {email: "overflow@example.test", role: "member"})
  })

  test("at the limit, re-inviting an address that already has a pending invitation replaces it", async () => {
    const ws = await newWorkspace()
    const expiresAt = new Date(Date.now() + DAY_MS)
    await WorkspaceInvitationModel.insertMany(
      Array.from({length: 200}, (_, i) => ({
        invitationId: `winv_seed_${i}`,
        workspaceId: ws,
        email: `seed-${i}@example.test`,
        role: "member",
        tokenHash: sha256(`seed-${i}`),
        status: "pending",
        invitedByAuthority: "system",
        expiresAt,
      })),
    )

    const replacement = await createInvitation(user("mu_owner"), ws, {email: "seed-7@example.test", role: "developer"})

    expect(await WorkspaceInvitationModel.countDocuments({workspaceId: ws, status: "pending"})).toBe(200)
    expect((await WorkspaceInvitationModel.findOne({invitationId: "winv_seed_7"}).lean())!.status).toBe("revoked")
    expect(await WorkspaceInvitationModel.findOne({invitationId: replacement.invitationId}).lean()).toMatchObject({
      email: "seed-7@example.test",
      role: "developer",
      status: "pending",
    })
    // A new address is still refused.
    await expectError(
      () => createInvitation(user("mu_owner"), ws, {email: "overflow@example.test", role: "member"}),
      "rate_limited",
      429,
    )
  })

  test("a workspace name with a line break or other control character is refused", async () => {
    for (const name of ["Acme\nSubject: reset your password", "Ac\rme", "Ac\u0007me", "Ac\u0085me"]) {
      await expectError(() => createWorkspace(user("mu_owner"), {name}), "invalid_request", 400)
    }
  })
})

describe("createInvitation racing other mutations", () => {
  test("a concurrent invitation and workspace deletion leave no pending invitation behind", async () => {
    for (let round = 0; round < 8; round++) {
      const ws = (await createWorkspace(user("mu_owner"), {name: `Race ${round}`})).workspaceId

      const [created] = await Promise.allSettled([
        createInvitation(user("mu_owner"), ws, {email: "dev@example.test", role: "member"}),
        deleteWorkspace(user("mu_owner"), ws, {confirmName: `Race ${round}`}),
      ])

      expect((await getWorkspace(ws))!.status).toBe("deleted")
      expect(await WorkspaceInvitationModel.countDocuments({workspaceId: ws, status: "pending"})).toBe(0)
      if (created.status === "rejected") expect(created.reason).toMatchObject({code: "workspace_deleted", status: 410})
    }
  })

  test("a concurrent invitation and role change both complete without losing either", async () => {
    const ws = await newWorkspace()
    const memberId = await addMember(ws, "mu_member", "member")

    const [created, changed] = await Promise.allSettled([
      createInvitation(user("mu_owner"), ws, {email: "dev@example.test", role: "member"}),
      changeRole(user("mu_owner"), ws, memberId, "developer", await revisionOf(ws)),
    ])

    expect(created.status).toBe("fulfilled")
    expect(changed.status).toBe("fulfilled")
    expect((await getActiveMembership(ws, "mu_member"))!.role).toBe("developer")
    expect(await listPendingInvitations(ws)).toHaveLength(1)
  })
})

describe("invitation email", () => {
  let fetchSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    fetchSpy?.mockRestore()
  })

  test("is sent after the transaction commits, with the link, and without a RESEND_API_KEY it is skipped", async () => {
    const ws = await newWorkspace("Acme <Labs>")
    const committedWhenSent: boolean[] = []
    const sent: Array<{to: string[]; subject: string; html: string; text: string}> = []
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      sent.push(body)
      // Read without a session: only committed data is visible.
      committedWhenSent.push(
        (await WorkspaceInvitationModel.countDocuments({
          workspaceId: ws,
          email: "dev@example.test",
          status: "pending",
        })) === 1,
      )
      return new Response("{}", {status: 200})
    }) as unknown as typeof fetch)

    // No API key: no request at all, and the invite still succeeds.
    await invite(ws, "skip@example.test")
    expect(fetchSpy).not.toHaveBeenCalled()

    process.env.RESEND_API_KEY = "re_test_key"
    const created = await createInvitation(user("mu_owner"), ws, {email: "Dev@Example.test", role: "developer"})

    expect(sent).toHaveLength(1)
    expect(committedWhenSent).toEqual([true])
    expect(sent[0]!.to).toEqual(["dev@example.test"])
    expect(sent[0]!.subject).toBe("You're invited to join Acme <Labs> on Mentra")
    expect(sent[0]!.html).toContain(created.inviteUrl)
    // It says who invited them, as what, with a plain-text version alongside the HTML.
    expect(sent[0]!.html).toContain("mu_owner@example.test")
    expect(sent[0]!.text).toContain("mu_owner@example.test invited you to join Acme <Labs> on Mentra as a Developer.")
    expect(sent[0]!.text).toContain(created.inviteUrl)
    // The workspace name is user-controlled text and must not reach the HTML unescaped.
    expect(sent[0]!.html).toContain("Acme &lt;Labs&gt;")
    expect(sent[0]!.html).not.toContain("<Labs>")
  })

  test("carries the default portal link when no template is configured", async () => {
    const ws = await newWorkspace()
    delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
    process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL = "https://portal.example.test/"
    process.env.RESEND_API_KEY = "re_test_key"
    const sent: Array<{html: string}> = []
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      return new Response("{}", {status: 200})
    }) as unknown as typeof fetch)

    const created = await createInvitation(user("mu_owner"), ws, {email: "dev@example.test", role: "member"})

    expect(created.inviteUrl).toStartWith("https://portal.example.test/?workspaceInvite=")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.html).toContain(created.inviteUrl)
  })

  test("a failing send does not fail the invitation", async () => {
    const ws = await newWorkspace()
    process.env.RESEND_API_KEY = "re_test_key"
    for (const failure of [
      async () => new Response("nope", {status: 500}),
      async () => {
        throw new Error("network down")
      },
    ]) {
      fetchSpy?.mockRestore()
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(failure as unknown as typeof fetch)
      const created = await invite(ws, `fail-${nextId()}@example.test`)
      expect(await peekInvitation(created.token)).not.toBeNull()
    }
  })

  test("a rejected invitation sends nothing", async () => {
    const ws = await newWorkspace()
    process.env.RESEND_API_KEY = "re_test_key"
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("{}")) as unknown as typeof fetch,
    )

    await expectError(
      () => createInvitation(user("mu_admin"), ws, {email: "x@example.test", role: "admin"}),
      "forbidden",
      403,
    )
    await expectError(
      () => createInvitation(user("mu_owner"), ws, {email: "bad", role: "member"}),
      "invalid_request",
      400,
    )
    delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
    await thrown(() => createInvitation(user("mu_owner"), ws, {email: "x@example.test", role: "member"}))
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("listPendingInvitations", () => {
  test("never returns the token hash and lists only the workspace's live pending invitations", async () => {
    const ws = await newWorkspace()
    const other = (await createWorkspace(user("mu_owner"), {name: "Other"})).workspaceId
    const pending = await invite(ws, "pending@example.test", "member")
    const second = await invite(ws, "second@example.test", "developer")
    const accepted = await invite(ws, "accepted@example.test")
    const revoked = await invite(ws, "revoked@example.test")
    const expired = await invite(ws, "expired@example.test")
    await invite(other, "elsewhere@example.test")
    await acceptInvitation(user("mu_accepted", {email: "accepted@example.test"}), accepted.token)
    await revokeInvitation(user("mu_owner"), ws, revoked.invitationId)
    await expire(expired.invitationId)

    const rows = await listPendingInvitations(ws)

    expect(rows.map(row => row.invitationId)).toEqual([pending.invitationId, second.invitationId])
    expect(rows[0]).toEqual({
      invitationId: pending.invitationId,
      workspaceId: ws,
      email: "pending@example.test",
      role: "member",
      status: "pending",
      invitedByMembershipId: expect.stringMatching(/^wm_/),
      expiresAt: pending.expiresAt,
      acceptedMembershipId: null,
      createdAt: expect.any(Date),
    })
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain("tokenHash")
    for (const row of await WorkspaceInvitationModel.find({}).lean()) expect(serialized).not.toContain(row.tokenHash)
    for (const token of [pending.token, second.token]) expect(serialized).not.toContain(token)
    for (const row of rows) expect(Object.keys(row)).not.toContain("tokenHash")

    expect(await listPendingInvitations("ws_missing")).toEqual([])
  })
})

describe("revokeInvitation", () => {
  test("an admin revokes a developer invitation; the token stops working and the revocation is audited", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test")

    await revokeInvitation(user("mu_admin"), ws, created.invitationId)

    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.status).toBe(
      "revoked",
    )
    expect(await peekInvitation(created.token)).toBeNull()
    await expectError(
      () => acceptInvitation(user("mu_dev", {email: "dev@example.test"}), created.token),
      "invitation_not_found",
      404,
    )
    expect(await revisionOf(ws)).toBe(0)
    expect((await listWorkspaceAudit(ws, {limit: 1}))[0]).toMatchObject({
      action: "invitation.revoked",
      actor: {kind: "user", mentraUserId: "mu_admin"},
      target: {invitationId: created.invitationId, email: "dev@example.test"},
      before: {status: "pending"},
      after: {status: "revoked"},
    })

    // Revoking frees the (workspace, email) slot for a new invitation.
    await invite(ws, "dev@example.test")
    // A revoked (or unknown) invitation cannot be revoked again.
    await expectError(() => revokeInvitation(user("mu_admin"), ws, created.invitationId), "invitation_not_found", 404)
    await expectError(() => revokeInvitation(user("mu_admin"), ws, "winv_missing"), "invitation_not_found", 404)
  })

  test("the same owner-only rule as inviting applies, and only managers may revoke", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_dev", "developer")
    const adminInvite = await invite(ws, "admin@example.test", "admin")
    const memberInvite = await invite(ws, "member@example.test", "member")

    await expectError(() => revokeInvitation(user("mu_admin"), ws, adminInvite.invitationId), "forbidden", 403)
    await expectError(() => revokeInvitation(user("mu_dev"), ws, memberInvite.invitationId), "forbidden", 403)
    await expectError(() => revokeInvitation(user("mu_stranger"), ws, memberInvite.invitationId), "forbidden", 403)
    await expectError(() => revokeInvitation(service, ws, memberInvite.invitationId), "forbidden", 403)
    expect(await listPendingInvitations(ws)).toHaveLength(2)

    await revokeInvitation(user("mu_owner"), ws, adminInvite.invitationId)
    await revokeInvitation(orgAdmin, ws, memberInvite.invitationId)
    expect(await listPendingInvitations(ws)).toHaveLength(0)
  })

  test("an invitation of another workspace is not found; a deleted workspace is 410", async () => {
    const ws = await newWorkspace()
    const other = (await createWorkspace(user("mu_owner"), {name: "Other"})).workspaceId
    const elsewhere = await invite(other, "dev@example.test")

    await expectError(() => revokeInvitation(user("mu_owner"), ws, elsewhere.invitationId), "invitation_not_found", 404)
    await expectError(() => revokeInvitation(user("mu_owner"), "ws_missing", elsewhere.invitationId), "not_found", 404)
    expect(await peekInvitation(elsewhere.token)).not.toBeNull()

    await deleteWorkspace(user("mu_owner"), other, {confirmName: "Other"})
    await expectError(() => revokeInvitation(user("mu_owner"), other, elsewhere.invitationId), "workspace_deleted", 410)
  })
})

describe("peekInvitation", () => {
  test("shows what the invite is for without changing anything", async () => {
    const ws = await newWorkspace("Acme Labs")
    const created = await invite(ws, "dev@example.test", "developer")
    const before = await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean()

    expect(await peekInvitation(created.token)).toEqual({
      invitationId: created.invitationId,
      workspaceId: ws,
      workspaceName: "Acme Labs",
      email: "dev@example.test",
      role: "developer",
      // Who sent it: the address their membership records.
      invitedByEmail: "mu_owner@example.test",
      expiresAt: created.expiresAt.toISOString(),
    })
    expect(await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean()).toEqual(before)
  })

  test("is null for unknown, malformed, expired, accepted, revoked and deleted-workspace invitations", async () => {
    const ws = await newWorkspace()
    const live = await invite(ws, "live@example.test")
    const expired = await invite(ws, "expired@example.test")
    const accepted = await invite(ws, "accepted@example.test")
    const revoked = await invite(ws, "revoked@example.test")
    await expire(expired.invitationId)
    await acceptInvitation(user("mu_accepted", {email: "accepted@example.test"}), accepted.token)
    await revokeInvitation(user("mu_owner"), ws, revoked.invitationId)

    expect(await peekInvitation(live.token)).not.toBeNull()
    for (const token of [
      expired.token,
      accepted.token,
      revoked.token,
      "unknown",
      "",
      "x".repeat(10_000),
      undefined,
      7,
      null,
    ]) {
      expect(await peekInvitation(token as never)).toBeNull()
    }
    // Peeking never marks anything: the expired row is still pending in the database.
    expect((await WorkspaceInvitationModel.findOne({invitationId: expired.invitationId}).lean())!.status).toBe(
      "pending",
    )

    await deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme"})
    expect(await peekInvitation(live.token)).toBeNull()
  })
})

describe("acceptInvitation", () => {
  test("adds a new membership with the invited role, bumps the revision once and audits it", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test", "developer")
    const before = await revisionOf(ws)
    const beforeMembers = await WorkspaceMembershipModel.countDocuments({workspaceId: ws})

    // Matching ignores case and surrounding whitespace on the verified address.
    const result = await acceptInvitation(user("mu_dev", {email: " Dev@Example.TEST "}), created.token)

    expect(result.workspaceId).toBe(ws)
    expect(result.membershipId).toMatch(/^wm_[0-9A-HJKMNP-TV-Z]{26}$/)
    const membership = (await WorkspaceMembershipModel.findOne({membershipId: result.membershipId}).lean())!
    expect(membership).toMatchObject({
      workspaceId: ws,
      mentraUserId: "mu_dev",
      email: "Dev@Example.TEST",
      role: "developer",
      status: "active",
      endedAt: null,
    })
    // A membership carries no display name: the email is the display field.
    expect(Object.keys(membership)).not.toContain("name")
    expect(membership.startedAt).toBeInstanceOf(Date)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws})).toBe(beforeMembers + 1)
    expect(await revisionOf(ws)).toBe(before + 1)
    // The role history starts with the invited role, from the start, at the revision the accept produced.
    expect(membership.roleHistory as unknown).toEqual([
      {role: "developer", from: membership.startedAt, authorizationRevision: before + 1},
    ])

    const row = (await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!
    expect(row).toMatchObject({status: "accepted", acceptedMembershipId: result.membershipId})

    const events = await listWorkspaceAudit(ws, {limit: 10})
    const added = events.find(event => event.action === "membership.added")!
    const acceptedEvent = events.find(event => event.action === "invitation.accepted")!
    expect(added).toMatchObject({
      actor: {kind: "user", mentraUserId: "mu_dev"},
      // The member's address as their membership records it (the verified address, trimmed).
      target: {membershipId: result.membershipId, mentraUserId: "mu_dev", email: "Dev@Example.TEST"},
      before: {role: null},
      after: {role: "developer"},
    })
    expect(acceptedEvent).toMatchObject({
      actor: {kind: "user", mentraUserId: "mu_dev"},
      target: {invitationId: created.invitationId, membershipId: result.membershipId, email: "dev@example.test"},
      before: {status: "pending"},
      after: {status: "accepted"},
    })
    expect(JSON.stringify(events)).not.toContain(created.token)
    expect(JSON.stringify(events)).not.toContain(row.tokenHash)

    const mine = await listWorkspacesForUser("mu_dev")
    expect(mine.map(workspace => [workspace.workspaceId, workspace.membership.role])).toEqual([[ws, "developer"]])
  })

  test("a different, missing or unverified email is 403 email_mismatch and leaves the invitation pending", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test")
    const before = await revisionOf(ws)
    const members = await WorkspaceMembershipModel.countDocuments({workspaceId: ws})
    const events = await WorkspaceAuditEventModel.countDocuments({})

    const actors = [
      user("mu_other", {email: "someone-else@example.test"}),
      user("mu_dev", {email: "dev@example.test", emailVerified: false}),
      user("mu_dev", {email: null}),
      user("mu_dev", {email: "", emailVerified: true}),
      user("mu_dev", {email: "xdev@example.test"}),
      user("mu_dev", {email: "dev@example.test.evil"}),
      // Anything but a real `true` is not verified.
      user("mu_dev", {email: "dev@example.test", emailVerified: "true" as unknown as boolean}),
      user("mu_dev", {email: "dev@example.test", emailVerified: undefined as unknown as boolean}),
      // Being an Organization Admin does not stand in for owning the invited address.
      user("mu_org_admin", {email: "dev@example.test", emailVerified: false, isOrganizationAdmin: true}),
      user("mu_org_admin", {email: "org-admin@example.test", isOrganizationAdmin: true}),
    ]
    for (const actor of actors) await expectError(() => acceptInvitation(actor, created.token), "email_mismatch", 403)

    expect(await peekInvitation(created.token)).not.toBeNull()
    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.status).toBe(
      "pending",
    )
    expect(await revisionOf(ws)).toBe(before)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws})).toBe(members)
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)

    // The rightful invitee can still accept.
    await acceptInvitation(user("mu_dev", {email: "dev@example.test"}), created.token)
  })

  test("an expired invitation is 410 invitation_expired and stays unclaimed", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test")
    await expire(created.invitationId)
    const before = await revisionOf(ws)

    await expectError(
      () => acceptInvitation(user("mu_dev", {email: "dev@example.test"}), created.token),
      "invitation_expired",
      410,
    )
    // A link that is dead is dead for everybody, not only for the invitee.
    await expectError(
      () => acceptInvitation(user("mu_other", {email: "other@example.test"}), created.token),
      "invitation_expired",
      410,
    )

    expect(await getActiveMembership(ws, "mu_dev")).toBeNull()
    expect(await revisionOf(ws)).toBe(before)
    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.status).toBe(
      "pending",
    )
  })

  test("an invitation is single-use: the second attempt is 404 invitation_not_found", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test")
    const first = await acceptInvitation(user("mu_dev", {email: "dev@example.test"}), created.token)

    await expectError(
      () => acceptInvitation(user("mu_dev", {email: "dev@example.test"}), created.token),
      "invitation_not_found",
      404,
    )
    await expectError(
      () => acceptInvitation(user("mu_dev2", {email: "dev@example.test"}), created.token),
      "invitation_not_found",
      404,
    )

    const members = await WorkspaceMembershipModel.find({
      workspaceId: ws,
      mentraUserId: {$in: ["mu_dev", "mu_dev2"]},
    }).lean()
    expect(members.map(member => member.membershipId)).toEqual([first.membershipId])
  })

  test("unknown, malformed, revoked and deleted-workspace tokens are 404 invitation_not_found", async () => {
    const ws = await newWorkspace()
    const revoked = await invite(ws, "revoked@example.test")
    const live = await invite(ws, "live@example.test")
    await revokeInvitation(user("mu_owner"), ws, revoked.invitationId)

    for (const token of ["unknown", "", "x".repeat(10_000), undefined, 7, null, revoked.token]) {
      await expectError(
        () => acceptInvitation(user("mu_dev", {email: "revoked@example.test"}), token as never),
        "invitation_not_found",
        404,
      )
    }

    await deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme"})
    await expectError(
      () => acceptInvitation(user("mu_live", {email: "live@example.test"}), live.token),
      "invitation_not_found",
      404,
    )
    expect(await WorkspaceMembershipModel.countDocuments({mentraUserId: {$in: ["mu_dev", "mu_live"]}})).toBe(0)
  })

  test("an existing active member is 409 already_member and the invitation stays pending", async () => {
    const ws = await newWorkspace()
    await addMember(ws, "mu_dev", "member")
    const created = await invite(ws, "dev@example.test", "admin")
    const before = await revisionOf(ws)

    await expectError(
      () => acceptInvitation(user("mu_dev", {email: "dev@example.test"}), created.token),
      "already_member",
      409,
    )

    expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!.status).toBe(
      "pending",
    )
    expect((await getActiveMembership(ws, "mu_dev"))!.role).toBe("member")
    expect(await revisionOf(ws)).toBe(before)
    expect(await peekInvitation(created.token)).not.toBeNull()

    // After leaving, the same invitation brings them back as a new membership row.
    const oldMembershipId = (await getActiveMembership(ws, "mu_dev"))!.membershipId
    await leaveWorkspace(user("mu_dev"), ws)
    const rejoined = await acceptInvitation(user("mu_dev", {email: "dev@example.test"}), created.token)
    expect(rejoined.membershipId).not.toBe(oldMembershipId)
    expect(await getActiveMembership(ws, "mu_dev")).toMatchObject({membershipId: rejoined.membershipId, role: "admin"})
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws, mentraUserId: "mu_dev"})).toBe(2)
  })

  test("accepting adds a membership without touching the person's other workspaces", async () => {
    const ws = await newWorkspace()
    const mine = (await createWorkspace(user("mu_dev"), {name: "Mine"})).workspaceId
    const created = await invite(ws, "dev@example.test", "member")
    const myRevision = await revisionOf(mine)

    await acceptInvitation(user("mu_dev", {email: "dev@example.test"}), created.token)

    expect(
      (await listWorkspacesForUser("mu_dev"))
        .map(workspace => [workspace.workspaceId, workspace.membership.role])
        .sort(),
    ).toEqual(
      [
        [mine, "owner"],
        [ws, "member"],
      ].sort(),
    )
    expect(await revisionOf(mine)).toBe(myRevision)
  })

  test("an actor without a usable user id cannot accept (403 forbidden)", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test")
    const actors = [
      user("", {email: "dev@example.test"}),
      user("   ", {email: "dev@example.test"}),
      {...user("mu_x", {email: "dev@example.test"}), mentraUserId: undefined as unknown as string},
      system as unknown as UserActor,
      service as unknown as UserActor,
    ]
    for (const actor of actors) await expectError(() => acceptInvitation(actor, created.token), "forbidden", 403)
    expect(await peekInvitation(created.token)).not.toBeNull()
  })

  test("concurrent accepts of one token by two accounts with the same email: exactly one wins", async () => {
    for (let round = 0; round < 5; round++) {
      const ws = (await createWorkspace(user("mu_owner"), {name: `Race ${round}`})).workspaceId
      const created = await invite(ws, "dev@example.test", "member")
      const before = await revisionOf(ws)

      const results = await Promise.allSettled([
        acceptInvitation(user(`mu_a${round}`, {email: "dev@example.test"}), created.token),
        acceptInvitation(user(`mu_b${round}`, {email: "dev@example.test"}), created.token),
      ])

      const fulfilled = results.filter(result => result.status === "fulfilled")
      expect(fulfilled).toHaveLength(1)
      const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult
      expect(rejected.reason).toMatchObject({code: "invitation_not_found", status: 404})
      expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws, role: "member"})).toBe(1)
      expect(await revisionOf(ws)).toBe(before + 1)
    }
  })

  test("a concurrent accept and revoke end consistently: either the person is a member or the invite is revoked", async () => {
    for (let round = 0; round < 5; round++) {
      const ws = (await createWorkspace(user("mu_owner"), {name: `Race ${round}`})).workspaceId
      const created = await invite(ws, "dev@example.test", "member")

      const [accepted, revoked] = await Promise.allSettled([
        acceptInvitation(user(`mu_dev${round}`, {email: "dev@example.test"}), created.token),
        revokeInvitation(user("mu_owner"), ws, created.invitationId),
      ])

      expect([accepted.status, revoked.status].filter(status => status === "fulfilled")).toHaveLength(1)
      const row = (await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!
      const member = await getActiveMembership(ws, `mu_dev${round}`)
      if (accepted.status === "fulfilled") {
        expect(row.status).toBe("accepted")
        expect(member).not.toBeNull()
      } else {
        expect(row.status).toBe("revoked")
        expect(member).toBeNull()
      }
    }
  })

  test("a concurrent accept and workspace deletion end consistently", async () => {
    for (let round = 0; round < 5; round++) {
      const ws = (await createWorkspace(user("mu_owner"), {name: `Race ${round}`})).workspaceId
      const created = await invite(ws, "dev@example.test", "member")

      const [accepted] = await Promise.allSettled([
        acceptInvitation(user(`mu_dev${round}`, {email: "dev@example.test"}), created.token),
        deleteWorkspace(user("mu_owner"), ws, {confirmName: `Race ${round}`}),
      ])

      // Whatever the order, no active membership survives in a deleted workspace.
      expect((await getWorkspace(ws))!.status).toBe("deleted")
      expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws, status: "active"})).toBe(0)
      expect(await WorkspaceInvitationModel.countDocuments({workspaceId: ws, status: "pending"})).toBe(0)
      if (accepted.status === "rejected") expect(accepted.reason).toBeInstanceOf(WorkspaceError)
    }
  })
})

describe("listInvitationsForPerson", () => {
  test("lists what the person can accept now, matched on their verified email, newest first, never a token", async () => {
    const acme = await newWorkspace("Acme")
    const beta = (await createWorkspace(user("mu_owner"), {name: "Beta"})).workspaceId
    const gamma = (await createWorkspace(orgAdmin, {name: "Gamma"})).workspaceId
    const fromAcme = await invite(acme, "dev@example.test", "developer")
    // Sent by an Organization Admin on the organization's authority, outside any membership.
    const fromAdmin = await createInvitation(orgAdmin, beta, {email: "DEV@example.test", role: "admin"})
    const fromSystem = await createInvitation(system, gamma, {email: "dev@example.test", role: "member"})
    await invite(acme, "someone-else@example.test")

    // The person signs in with a differently cased address: it matches all the same.
    const items = await listInvitationsForPerson(user("mu_dev", {email: " Dev@Example.TEST "}))

    expect(items.map(item => item.invitationId)).toEqual([
      fromSystem.invitationId,
      fromAdmin.invitationId,
      fromAcme.invitationId,
    ])
    expect(items[2]).toEqual({
      invitationId: fromAcme.invitationId,
      workspaceId: acme,
      workspaceName: "Acme",
      email: "dev@example.test",
      role: "developer",
      invitedByEmail: "mu_owner@example.test",
      expiresAt: fromAcme.expiresAt.toISOString(),
    })
    expect(items.map(item => [item.workspaceName, item.role, item.invitedByEmail])).toEqual([
      ["Gamma", "member", null],
      ["Beta", "admin", orgAdmin.email],
      ["Acme", "developer", "mu_owner@example.test"],
    ])
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain(fromAcme.token)
    for (const row of await WorkspaceInvitationModel.find({}).lean()) expect(serialized).not.toContain(row.tokenHash)
  })

  test("leaves out what cannot be accepted: expired, used, revoked, a deleted workspace, a lapsed inviter, a workspace they are in", async () => {
    const live = await newWorkspace("Live")
    const expiredWs = await newWorkspace("Expired")
    const acceptedWs = await newWorkspace("Accepted")
    const revokedWs = await newWorkspace("Revoked")
    const deletedWs = await newWorkspace("Deleted")
    const lapsedWs = await newWorkspace("Lapsed")
    const joinedWs = await newWorkspace("Joined")
    const kept = await invite(live, "dev@example.test")
    await expire((await invite(expiredWs, "dev@example.test")).invitationId)
    const accepted = await invite(acceptedWs, "dev@example.test")
    await acceptInvitation(user("mu_other", {email: "dev@example.test"}), accepted.token)
    await revokeInvitation(user("mu_owner"), revokedWs, (await invite(revokedWs, "dev@example.test")).invitationId)
    await invite(deletedWs, "dev@example.test")
    await deleteWorkspace(user("mu_owner"), deletedWs, {confirmName: "Deleted"})
    // Sent by the admin, whose membership then ends: the invitation goes with it.
    await createInvitation(user("mu_admin"), lapsedWs, {email: "dev@example.test", role: "member"})
    const adminMembership = (await getActiveMembership(lapsedWs, "mu_admin"))!.membershipId
    await removeMember(user("mu_owner"), lapsedWs, adminMembership, await revisionOf(lapsedWs))
    // Already a member: accepting would be refused (already_member), so it is not offered.
    await invite(joinedWs, "dev@example.test")
    await addMember(joinedWs, "mu_dev", "member")

    const items = await listInvitationsForPerson(user("mu_dev", {email: "dev@example.test"}))

    expect(items.map(item => item.invitationId)).toEqual([kept.invitationId])
  })

  test("an inviter whose role no longer grants the invited role is left out, as peek and accept refuse it", async () => {
    const ws = await newWorkspace()
    const adminMembership = (await getActiveMembership(ws, "mu_admin"))!.membershipId
    await createInvitation(user("mu_admin"), ws, {email: "dev@example.test", role: "developer"})
    expect(await listInvitationsForPerson(user("mu_dev", {email: "dev@example.test"}))).toHaveLength(1)

    await changeRole(user("mu_owner"), ws, adminMembership, "member", await revisionOf(ws))

    expect(await listInvitationsForPerson(user("mu_dev", {email: "dev@example.test"}))).toEqual([])
  })

  test("is refused for an unverified or missing email, a deleted account and anyone who is not a person", async () => {
    const ws = await newWorkspace()
    await invite(ws, "dev@example.test")
    for (const actor of [
      user("mu_dev", {email: "dev@example.test", emailVerified: false}),
      user("mu_dev", {email: "dev@example.test", emailVerified: "true" as unknown as boolean}),
      user("mu_dev", {email: null}),
      user("mu_dev", {email: "   "}),
    ]) {
      await expectError(() => listInvitationsForPerson(actor), "email_unverified", 403)
    }
    await account("mu_gone")
    await UserModel.updateOne({mentraUserId: "mu_gone"}, {$set: {supportTelemetryDeletedAt: new Date()}})
    await expectError(
      () => listInvitationsForPerson(user("mu_gone", {email: "dev@example.test"})),
      "account_deleted",
      403,
    )
    for (const actor of [system, service, user("", {email: "dev@example.test"})]) {
      await expectError(() => listInvitationsForPerson(actor as UserActor), "forbidden", 403)
    }
  })
})

describe("acceptInvitationById", () => {
  test("accepts like the token does: a membership with the invited role, one revision bump, the same audit events", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test", "developer")
    const before = await revisionOf(ws)
    const [listed] = await listInvitationsForPerson(user("mu_dev", {email: "dev@example.test"}))

    const result = await acceptInvitationById(user("mu_dev", {email: "Dev@Example.test"}), listed!.invitationId)

    expect(result.workspaceId).toBe(ws)
    expect(await getActiveMembership(ws, "mu_dev")).toMatchObject({membershipId: result.membershipId, role: "developer"})
    expect(await revisionOf(ws)).toBe(before + 1)
    expect(await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean()).toMatchObject({
      status: "accepted",
      acceptedMembershipId: result.membershipId,
    })
    const actions = (await listWorkspaceAudit(ws, {limit: 2})).map(event => event.action).sort()
    expect(actions).toEqual(["invitation.accepted", "membership.added"])
    // Used up: the token and the id are both spent.
    await expectError(() => acceptInvitationById(user("mu_dev"), created.invitationId), "invitation_not_found", 404)
    await expectError(() => acceptInvitation(user("mu_dev"), created.token), "invitation_not_found", 404)
    expect(await listInvitationsForPerson(user("mu_dev", {email: "dev@example.test"}))).toEqual([])
  })

  test("refuses exactly what accepting by token refuses", async () => {
    const ws = await newWorkspace()
    const forOther = await invite(ws, "other@example.test")
    const expired = await invite(ws, "expired@example.test")
    await expire(expired.invitationId)
    const revoked = await invite(ws, "revoked@example.test")
    await revokeInvitation(user("mu_owner"), ws, revoked.invitationId)
    const joined = await invite(ws, "joined@example.test")
    await addMember(ws, "mu_joined", "member")
    const gone = await invite(ws, "gone@example.test")
    await account("mu_gone")
    await UserModel.updateOne({mentraUserId: "mu_gone"}, {$set: {supportTelemetryDeletedAt: new Date()}})

    await expectError(() => acceptInvitationById(user("mu_dev"), "winv_missing"), "invitation_not_found", 404)
    for (const id of ["", "  ", undefined, 7]) {
      await expectError(() => acceptInvitationById(user("mu_dev"), id as never), "invitation_not_found", 404)
    }
    // Someone else's invitation, or one to their address they have not verified.
    await expectError(
      () => acceptInvitationById(user("mu_dev", {email: "dev@example.test"}), forOther.invitationId),
      "email_mismatch",
      403,
    )
    await expectError(
      () => acceptInvitationById(user("mu_other", {email: "other@example.test", emailVerified: false}), forOther.invitationId),
      "email_mismatch",
      403,
    )
    await expectError(
      () => acceptInvitationById(user("mu_expired", {email: "expired@example.test"}), expired.invitationId),
      "invitation_expired",
      410,
    )
    await expectError(
      () => acceptInvitationById(user("mu_revoked", {email: "revoked@example.test"}), revoked.invitationId),
      "invitation_not_found",
      404,
    )
    await expectError(
      () => acceptInvitationById(user("mu_joined", {email: "joined@example.test"}), joined.invitationId),
      "already_member",
      409,
    )
    await expectError(
      () => acceptInvitationById(user("mu_gone", {email: "gone@example.test"}), gone.invitationId),
      "account_deleted",
      403,
    )
    for (const actor of [system, service]) {
      await expectError(() => acceptInvitationById(actor as UserActor, forOther.invitationId), "forbidden", 403)
    }
    // Nothing was accepted along the way.
    expect(await WorkspaceInvitationModel.countDocuments({workspaceId: ws, status: "accepted"})).toBe(0)

    // An inviter whose authority has lapsed, and a deleted workspace, are refused too.
    const adminMembership = (await getActiveMembership(ws, "mu_admin"))!.membershipId
    const fromAdmin = await createInvitation(user("mu_admin"), ws, {email: "late@example.test", role: "member"})
    await changeRole(user("mu_owner"), ws, adminMembership, "member", await revisionOf(ws))
    await expectError(
      () => acceptInvitationById(user("mu_late", {email: "late@example.test"}), fromAdmin.invitationId),
      "invitation_not_found",
      404,
    )
    const live = await invite(ws, "live@example.test")
    await deleteWorkspace(user("mu_owner"), ws, {confirmName: "Acme"})
    await WorkspaceInvitationModel.updateOne({invitationId: live.invitationId}, {$set: {status: "pending"}})
    await expectError(
      () => acceptInvitationById(user("mu_live", {email: "live@example.test"}), live.invitationId),
      "workspace_deleted",
      410,
    )
  })
})

describe("through the workspace API, signed in with the fake identity provider", () => {
  let app: ReturnType<typeof createApp>
  let idp: FakeIdp
  let restoreEnv: () => void = () => {}

  beforeAll(() => {
    app = createApp({readinessChecks: [mongoReadinessCheck]})
  })

  beforeEach(async () => {
    restoreEnv = applyEnv({...HOSTED_ENV, CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: undefined, RESEND_API_KEY: undefined})
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

  const bearer = async (sub: string, email: string, claims: Record<string, unknown> = {}) => ({
    authorization: `Bearer ${await idp.mint({sub, aud: "authenticated", client_id: "console-client", email, ...claims})}`,
    "content-type": "application/json",
  })
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    app.request(`${PORTAL_ORIGIN}${path}`, {method: "POST", headers, body: JSON.stringify(body)})

  /** An owner signs in, creates a workspace and invites `invitee@example.test` through the API. */
  async function invitedThroughApi() {
    idp.registerUser({sub: "supa-owner", email: "owner@example.test", emailConfirmed: true})
    const owner = await bearer("supa-owner", "owner@example.test")
    const created = await post("/api/workspaces", owner, {name: "Acme"})
    expect(created.status).toBe(201)
    const {workspaceId} = (await created.json()) as {workspaceId: string}
    const invited = await post(`/api/workspaces/${workspaceId}/invitations`, owner, {
      email: "Invitee@Example.test",
      role: "developer",
    })
    expect(invited.status).toBe(201)
    expect(invited.headers.get("cache-control")).toBe("no-store")
    const {inviteUrl} = (await invited.json()) as {inviteUrl: string}
    return {workspaceId, inviteUrl}
  }

  test("the default link is the workspace portal's accept page, and only a verified invitee can accept it", async () => {
    const {workspaceId, inviteUrl} = await invitedThroughApi()
    // HOSTED_ENV configures the workspace portal at PORTAL_ORIGIN and no template.
    expect(inviteUrl).toMatch(/^https:\/\/portal\.test\/\?workspaceInvite=[A-Za-z0-9_-]{43}$/)
    const token = new URL(inviteUrl).searchParams.get("workspaceInvite")!
    expect((await WorkspaceInvitationModel.findOne({workspaceId}).lean())!.tokenHash).toBe(sha256(token))

    // The invitee's GoTrue account has not confirmed the address. The token's own claims cannot vouch
    // for it: verification comes only from the account.
    idp.registerUser({sub: "supa-invitee", email: "invitee@example.test", emailConfirmed: false})
    const unverified = await bearer("supa-invitee", "invitee@example.test", {email_verified: true})
    const peeked = await post("/api/workspaces/invitations/peek", unverified, {token})
    expect(peeked.status).toBe(200)
    expect(await peeked.json()).toEqual({
      invitationId: expect.stringMatching(/^winv_/),
      workspaceId,
      workspaceName: "Acme",
      email: "invitee@example.test",
      role: "developer",
      invitedByEmail: "owner@example.test",
      expiresAt: expect.any(String),
    })
    const refused = await post("/api/workspaces/invitations/accept", unverified, {token})
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({error: "email_mismatch"})
    expect((await WorkspaceInvitationModel.findOne({workspaceId}).lean())!.status).toBe("pending")

    // Once the account confirms the address, the same token is accepted.
    idp.registerUser({sub: "supa-invitee", email: "invitee@example.test", emailConfirmed: true})
    resetIdpTokenCaches()
    const accepted = await post(
      "/api/workspaces/invitations/accept",
      await bearer("supa-invitee", "invitee@example.test"),
      {token},
    )
    expect(accepted.status).toBe(200)
    const result = (await accepted.json()) as {workspaceId: string; membershipId: string}
    expect(result.workspaceId).toBe(workspaceId)
    const invitee = await findOrCreateUser({tenantId: "mentra", tenantUserId: "supa-invitee"})
    expect(await getActiveMembership(workspaceId, invitee.mentraUserId)).toMatchObject({
      membershipId: result.membershipId,
      role: "developer",
      email: "invitee@example.test",
    })
  })

  test("a verified account with another email is refused, and the invitation stays usable for the invitee", async () => {
    const {workspaceId, inviteUrl} = await invitedThroughApi()
    const token = new URL(inviteUrl).searchParams.get("workspaceInvite")!

    // The token's email claim says the invited address, but the account's confirmed email is another one.
    idp.registerUser({sub: "supa-other", email: "other@example.test", emailConfirmed: true})
    const other = await bearer("supa-other", "invitee@example.test")
    const refused = await post("/api/workspaces/invitations/accept", other, {token})
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({error: "email_mismatch"})

    idp.registerUser({sub: "supa-invitee", email: "invitee@example.test", emailConfirmed: true})
    const accepted = await post(
      "/api/workspaces/invitations/accept",
      await bearer("supa-invitee", "invitee@example.test"),
      {token},
    )
    expect(accepted.status).toBe(200)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId, status: "active"})).toBe(2)
  })

  test("GET /invitations/mine lists the verified invitee's invitations, and accept takes their invitationId", async () => {
    const {workspaceId} = await invitedThroughApi()
    const get = (path: string, headers: Record<string, string>) =>
      app.request(`${PORTAL_ORIGIN}${path}`, {method: "GET", headers})

    // Unverified: refused, as accepting is.
    idp.registerUser({sub: "supa-invitee", email: "invitee@example.test", emailConfirmed: false})
    const unverified = await get("/api/workspaces/invitations/mine", await bearer("supa-invitee", "invitee@example.test"))
    expect(unverified.status).toBe(403)
    expect(await unverified.json()).toMatchObject({error: "email_unverified"})

    idp.registerUser({sub: "supa-invitee", email: "invitee@example.test", emailConfirmed: true})
    resetIdpTokenCaches()
    const invitee = await bearer("supa-invitee", "invitee@example.test")
    const listed = await get("/api/workspaces/invitations/mine", invitee)
    expect(listed.status).toBe(200)
    expect(listed.headers.get("cache-control")).toBe("no-store")
    const {items} = (await listed.json()) as {items: Array<Record<string, unknown>>}
    expect(items).toEqual([
      {
        invitationId: expect.stringMatching(/^winv_/),
        workspaceId,
        workspaceName: "Acme",
        email: "invitee@example.test",
        role: "developer",
        invitedByEmail: "owner@example.test",
        expiresAt: expect.any(String),
      },
    ])
    // The same list is under the workspace portal's route group.
    const portal = await get("/api/portal/workspaces/invitations/mine", invitee)
    expect(portal.status).toBe(200)

    // Someone else sees none of it.
    idp.registerUser({sub: "supa-other", email: "other@example.test", emailConfirmed: true})
    const other = await bearer("supa-other", "other@example.test")
    expect(((await (await get("/api/workspaces/invitations/mine", other)).json()) as {items: unknown[]}).items).toEqual([])
    const stolen = await post("/api/workspaces/invitations/accept", other, {invitationId: items[0]!.invitationId})
    expect(stolen.status).toBe(403)
    expect(await stolen.json()).toMatchObject({error: "email_mismatch"})

    // Exactly one of token and invitationId.
    for (const body of [{}, {token: "x", invitationId: items[0]!.invitationId}, {invitationId: ""}, {invitationId: 7}]) {
      const reply = await post("/api/workspaces/invitations/accept", invitee, body)
      expect({body, status: reply.status}).toEqual({body, status: 400})
    }

    const accepted = await post("/api/workspaces/invitations/accept", invitee, {invitationId: items[0]!.invitationId})
    expect(accepted.status).toBe(200)
    expect(((await accepted.json()) as {workspaceId: string}).workspaceId).toBe(workspaceId)
    expect(((await (await get("/api/workspaces/invitations/mine", invitee)).json()) as {items: unknown[]}).items).toEqual([])
  })

  test("GET /invitations/mine refuses a key and an anonymous caller", async () => {
    const {workspaceId} = await invitedThroughApi()
    const owner = await bearer("supa-owner", "owner@example.test")
    const minted = await post(`/api/workspaces/${workspaceId}/credentials`, owner, {name: "CI"})
    expect(minted.status).toBe(201)
    const {token} = (await minted.json()) as {token: string}

    const withKey = await app.request(`${PORTAL_ORIGIN}/api/workspaces/invitations/mine`, {
      headers: {authorization: `Bearer ${token}`},
    })
    expect(withKey.status).toBe(403)
    const anonymous = await app.request(`${PORTAL_ORIGIN}/api/workspaces/invitations/mine`)
    expect(anonymous.status).toBe(401)
  })

  test("with neither a template nor a portal URL, the invitation route answers 503 invitations_unavailable and writes nothing", async () => {
    idp.registerUser({sub: "supa-owner", email: "owner@example.test", emailConfirmed: true})
    const owner = await bearer("supa-owner", "owner@example.test")
    const {workspaceId} = (await (await post("/api/workspaces", owner, {name: "Acme"})).json()) as {workspaceId: string}
    delete process.env.CLOUD_CORE_ENTERPRISE_PORTAL_URL

    const response = await post(`/api/workspaces/${workspaceId}/invitations`, owner, {
      email: "invitee@example.test",
      role: "member",
    })

    // The operator's configuration problem is logged; the caller learns only that invitations are unavailable.
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: "invitations_unavailable",
      error_description: "invitations are not configured on this deployment",
    })
    expect(await WorkspaceInvitationModel.countDocuments({})).toBe(0)
  })
})
