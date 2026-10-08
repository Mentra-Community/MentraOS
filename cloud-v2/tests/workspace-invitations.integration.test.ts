/**
 * @fileoverview Workspace invitation integration tests.
 *
 * These run the real invitation service, models and transactions against a
 * local replica set. The only thing faked is the network: the invitation email
 * goes through the real `sendEmail`, whose HTTP call is intercepted at
 * `globalThis.fetch`.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random
 * database name, ignores `MONGO_URL`) and asserts the live connection is on
 * that database before any destructive call. The database is dropped in
 * `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/workspace-invitations.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {createHash} from "node:crypto"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {listWorkspaceAudit} from "../packages/core/src/services/workspaces/audit.service"
import {
  acceptInvitation,
  createInvitation,
  listPendingInvitations,
  peekInvitation,
  revokeInvitation,
} from "../packages/core/src/services/workspaces/invitation.service"
import {
  changeRole,
  createWorkspace,
  deleteWorkspace,
  getActiveMembership,
  getWorkspace,
  leaveWorkspace,
  listWorkspacesForUser,
  WorkspaceError,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"

const MODELS = [
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  AccessCredentialModel,
  WorkspaceAuditEventModel,
  WorkspaceAuditCounterModel,
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
  await WorkspaceMembershipModel.create({
    membershipId,
    workspaceId,
    mentraUserId,
    email: `${mentraUserId}@example.test`,
    role,
    status: "active",
    startedAt: new Date(),
  })
  return membershipId
}

/** A workspace owned by `mu_owner`, with an admin `mu_admin`. */
async function newWorkspace(name = "Acme") {
  const summary = await createWorkspace(user("mu_owner"), {name})
  await addMember(summary.workspaceId, "mu_admin", "admin")
  return summary.workspaceId
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

const ENV_KEYS = ["CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE", "RESEND_API_KEY"] as const
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  databaseUrl = localTestMongoUrl("workspace-invitations")
  await connectMongo(databaseUrl)
  // `connectMongo` ignores a second connect, so a connection leaked by another
  // test file would silently win. Fail before touching any data in that case.
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.init()))
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
  await Promise.all(MODELS.map(model => model.deleteMany({})))
  process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = URL_TEMPLATE
  delete process.env.RESEND_API_KEY
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
      invitedByMembershipId: adminMembership,
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
      target: {invitationId: created.invitationId},
      after: {email: "dev@example.test", role: "developer"},
    })
    expect(JSON.stringify(events)).not.toContain(token)
    expect(JSON.stringify(events)).not.toContain(row.tokenHash)
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
    // Organization admins and the system hold no membership of their own.
    const byOrgAdmin = await WorkspaceInvitationModel.findOne({email: "o@example.test"}).lean()
    expect(byOrgAdmin!.invitedByMembershipId).toBeNull()
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

  test("CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE must contain {token}: a clear error at first use, nothing written", async () => {
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
      expect(err).not.toBeInstanceOf(WorkspaceError)
      expect(err.message).toContain("CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE")
      expect(err.message).toContain("{token}")
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
    const err = await thrown(() => createInvitation(user("mu_admin"), ws, input))
    expect(err).not.toBeInstanceOf(WorkspaceError)
    expect(err.message).toContain("CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE")
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
      target: {invitationId: first.invitationId},
      after: {status: "revoked", reason: "superseded"},
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
    const sent: Array<{to: string[]; subject: string; html: string}> = []
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
    expect(sent[0]!.subject).toContain("Acme <Labs>")
    expect(sent[0]!.html).toContain(created.inviteUrl)
    // The workspace name is user-controlled text and must not reach the HTML unescaped.
    expect(sent[0]!.html).toContain("Acme &lt;Labs&gt;")
    expect(sent[0]!.html).not.toContain("<Labs>")
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
      target: {invitationId: created.invitationId},
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
      workspaceName: "Acme Labs",
      email: "dev@example.test",
      role: "developer",
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
      name: null,
      role: "developer",
      status: "active",
      endedAt: null,
    })
    expect(membership.startedAt).toBeInstanceOf(Date)
    expect(await WorkspaceMembershipModel.countDocuments({workspaceId: ws})).toBe(beforeMembers + 1)
    expect(await revisionOf(ws)).toBe(before + 1)

    const row = (await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())!
    expect(row).toMatchObject({status: "accepted", acceptedMembershipId: result.membershipId})

    const events = await listWorkspaceAudit(ws, {limit: 10})
    const added = events.find(event => event.action === "membership.added")!
    const acceptedEvent = events.find(event => event.action === "invitation.accepted")!
    expect(added).toMatchObject({
      actor: {kind: "user", mentraUserId: "mu_dev"},
      target: {membershipId: result.membershipId, mentraUserId: "mu_dev"},
      before: {role: null},
      after: {role: "developer"},
    })
    expect(acceptedEvent).toMatchObject({
      actor: {kind: "user", mentraUserId: "mu_dev"},
      target: {invitationId: created.invitationId, membershipId: result.membershipId},
      before: {status: "pending"},
      after: {status: "accepted"},
    })
    expect(JSON.stringify(events)).not.toContain(created.token)
    expect(JSON.stringify(events)).not.toContain(row.tokenHash)

    const mine = await listWorkspacesForUser("mu_dev")
    expect(mine.map(workspace => [workspace.workspaceId, workspace.membership.role])).toEqual([[ws, "developer"]])
  })

  test("the actor's display name is recorded when given", async () => {
    const ws = await newWorkspace()
    const created = await invite(ws, "dev@example.test")
    const {membershipId} = await acceptInvitation(
      user("mu_dev", {email: "dev@example.test", name: "Dev Eloper"}),
      created.token,
    )
    expect((await WorkspaceMembershipModel.findOne({membershipId}).lean())!.name).toBe("Dev Eloper")
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
