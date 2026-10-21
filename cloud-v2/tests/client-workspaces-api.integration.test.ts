/**
 * @fileoverview `/api/client/workspaces` integration tests: the Mentra App's workspace calls.
 *
 * These run the real app, router, services, models and transactions against a local replica set. The only
 * thing faked is the phone's access-token verification (`verifyAccessToken`), as the phone's token is
 * Mentra's own session token; each person's verified email comes from an `account_emails` row (Core's copy of the account
 * directory's answer, null for an unverified one), as it does in production.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/client-workspaces-api.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from "bun:test"
import type {Model} from "mongoose"

import {createApp} from "../packages/core/src/api/app"
import {connectMongo, disconnectMongo, mongoReadinessCheck} from "../packages/core/src/connections/mongo.connection"
import {AuthRateLimitModel} from "../packages/core/src/models/auth-rate-limit.model"
import {AccountEmailModel} from "../packages/core/src/models/account-email.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import * as accountEmails from "../packages/core/src/services/account/account-email.service"
import * as session from "../packages/core/src/services/session.service"
import {createInvitation} from "../packages/core/src/services/workspaces/invitation.service"
import {
  createWorkspace,
  getActiveMembership,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"

const MODELS: Model<any>[] = [
  AuthRateLimitModel,
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  AccountEmailModel,
  UserModel,
]

const URL_TEMPLATE = "https://core.example.test/invite/{token}"

let databaseUrl: string
let verified = false
let app: ReturnType<typeof createApp>
const mocks: Array<{mockRestore(): void}> = []

type UserActor = Actor & {kind: "user"}

const owner: UserActor = {
  kind: "user",
  mentraUserId: "mu_owner",
  email: "owner@example.test",
  emailVerified: true,
  isOrganizationAdmin: false,
}

/**
 * A person who can sign in: a users row, and Core's copy of their verified email (null when unverified,
 * which is what the account directory answers for an email nobody has confirmed).
 */
async function person(mentraUserId: string, email: string | null, emailVerified = true) {
  await UserModel.create({mentraUserId, tenantId: "mentra", tenantUserId: `sb-${mentraUserId}`})
  await AccountEmailModel.create({
    mentraUserId,
    email: emailVerified ? email : null,
    checkedAt: new Date(),
  })
}

/** The phone is signed in as `mentraUserId` (its access token verifies to them). */
function signedInAs(mentraUserId: string) {
  mocks.push(
    spyOn(session, "verifyAccessToken").mockResolvedValue({
      mentraUserId,
      tenantId: "mentra",
      sessionId: "s",
      jti: "j",
      exp: Math.floor(Date.now() / 1000) + 600,
    } as never),
  )
}

function call(path: string, init: {method?: string; token?: string | null} = {}) {
  const headers: Record<string, string> = {}
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? "phone-token"}`
  return app.request(`/api/client/workspaces${path}`, {method: init.method ?? "GET", headers})
}

async function workspaceWithOwner(name = "Acme") {
  await person(owner.mentraUserId, owner.email)
  return (await createWorkspace(owner, {name})).workspaceId
}

async function inviteTo(workspaceId: string, email: string, role: "member" | "developer" | "admin" = "member") {
  return createInvitation(owner, workspaceId, {email, role})
}

async function addMember(workspaceId: string, mentraUserId: string, role: string) {
  await WorkspaceMembershipModel.create(
    membershipRow({
      membershipId: `wm_${mentraUserId}`,
      workspaceId,
      mentraUserId,
      email: `${mentraUserId}@example.test`,
      role,
      status: "active",
      startedAt: new Date(),
    }),
  )
}

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("client-workspaces")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
  app = createApp({readinessChecks: [mongoReadinessCheck]})
})

afterAll(async () => {
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

afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
})

describe("authentication", () => {
  test("no token, and a token Core rejects, are 401 on every route", async () => {
    expect((await call("/mine", {token: null})).status).toBe(401)
    mocks.push(spyOn(session, "verifyAccessToken").mockRejectedValue(new (await import("../packages/core/src/types/oauth.types")).InvalidGrant("expired")))
    for (const [path, method] of [
      ["/mine", "GET"],
      ["/invitations/mine", "GET"],
      ["/invitations/winv_x/accept", "POST"],
      ["/invitations/winv_x/decline", "POST"],
      ["/leave", "POST"],
    ] as const) {
      const res = await call(path, {method})
      expect({path, status: res.status}).toEqual({path, status: 401})
    }
  })

  test("a deleted account is 401, not an empty answer", async () => {
    await person("mu_gone", "gone@example.test")
    await UserModel.updateOne({mentraUserId: "mu_gone"}, {$set: {supportTelemetryDeletedAt: new Date()}})
    signedInAs("mu_gone")
    expect((await call("/mine")).status).toBe(401)
    expect((await call("/invitations/mine")).status).toBe(401)
  })

  test("when the account directory cannot say what the email is and Core has no copy, it is 503", async () => {
    await UserModel.create({mentraUserId: "mu_a", tenantId: "mentra", tenantUserId: "sb-mu_a"})
    signedInAs("mu_a")
    mocks.push(spyOn(accountEmails, "accountEmail").mockRejectedValue(new Error("directory down")))
    const res = await call("/mine")
    expect(res.status).toBe(503)
    expect(((await res.json()) as {error: string}).error).toBe("unavailable")
  })
})

describe("GET /mine", () => {
  test("a person in no workspace gets null", async () => {
    await person("mu_a", "a@example.test")
    signedInAs("mu_a")
    const res = await call("/mine")
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({workspace: null})
  })

  test("a member gets their workspace, their role and their membership", async () => {
    const ws = await workspaceWithOwner("Acme Corp")
    await person("mu_dev", "dev@example.test")
    await addMember(ws, "mu_dev", "developer")
    signedInAs("mu_dev")
    expect(await (await call("/mine")).json()).toEqual({
      workspace: {workspaceId: ws, name: "Acme Corp", role: "developer", membershipId: "wm_mu_dev"},
    })
  })

  test("a deleted workspace is not offered", async () => {
    const ws = await workspaceWithOwner()
    await WorkspaceModel.updateOne({workspaceId: ws}, {$set: {status: "deleted"}})
    signedInAs(owner.mentraUserId)
    expect(await (await call("/mine")).json()).toEqual({workspace: null})
  })
})

describe("invitations", () => {
  test("lists what is addressed to the verified email, with no token", async () => {
    const ws = await workspaceWithOwner("Acme")
    const created = await inviteTo(ws, "new@example.test", "developer")
    await person("mu_new", "New@Example.test")
    signedInAs("mu_new")
    const body = (await (await call("/invitations/mine")).json()) as {invitations: Array<Record<string, unknown>>}
    expect(body.invitations).toHaveLength(1)
    expect(body.invitations[0]).toMatchObject({workspaceName: "Acme", role: "developer"})
    expect(JSON.stringify(body)).not.toContain(created.inviteUrl.split("/").pop()!)
  })

  test("an unverified email is refused (403 email_unverified)", async () => {
    const ws = await workspaceWithOwner()
    await inviteTo(ws, "new@example.test")
    await person("mu_new", "new@example.test", false)
    signedInAs("mu_new")
    const res = await call("/invitations/mine")
    expect(res.status).toBe(403)
    expect(((await res.json()) as {error: string}).error).toBe("email_unverified")
  })

  test("accepting joins the workspace and returns it; the person's workspace is then that one", async () => {
    const ws = await workspaceWithOwner("Acme")
    const created = await inviteTo(ws, "new@example.test", "developer")
    await person("mu_new", "new@example.test")
    signedInAs("mu_new")

    const res = await call(`/invitations/${created.invitationId}/accept`, {method: "POST"})
    expect(res.status).toBe(200)
    const body = (await res.json()) as {workspace: {workspaceId: string; name: string; role: string}}
    expect(body.workspace).toMatchObject({workspaceId: ws, name: "Acme", role: "developer"})
    expect((await getActiveMembership(ws, "mu_new"))?.role).toBe("developer")
    expect(await (await call("/mine")).json()).toMatchObject({workspace: {workspaceId: ws}})
  })

  test("accepting while already in a workspace is 409 already_in_workspace and joins nothing", async () => {
    const first = await workspaceWithOwner("First")
    await person("mu_dev", "dev@example.test")
    await addMember(first, "mu_dev", "member")
    const secondOwner: UserActor = {...owner, mentraUserId: "mu_owner2", email: "owner2@example.test"}
    await person(secondOwner.mentraUserId, secondOwner.email)
    const second = (await createWorkspace(secondOwner, {name: "Second"})).workspaceId
    const created = await createInvitation(secondOwner, second, {email: "dev@example.test", role: "member"})
    signedInAs("mu_dev")

    const res = await call(`/invitations/${created.invitationId}/accept`, {method: "POST"})
    expect(res.status).toBe(409)
    expect(((await res.json()) as {error: string}).error).toBe("already_in_workspace")
    expect(await getActiveMembership(second, "mu_dev")).toBeNull()
    const row = await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean()
    expect(row?.status).toBe("pending")
  })

  test("accepting someone else's invitation is 403 email_mismatch", async () => {
    const ws = await workspaceWithOwner()
    const created = await inviteTo(ws, "new@example.test")
    await person("mu_other", "other@example.test")
    signedInAs("mu_other")
    const res = await call(`/invitations/${created.invitationId}/accept`, {method: "POST"})
    expect(res.status).toBe(403)
    expect(((await res.json()) as {error: string}).error).toBe("email_mismatch")
  })

  test("an unknown invitation is 404, an expired one 410", async () => {
    const ws = await workspaceWithOwner()
    const created = await inviteTo(ws, "new@example.test")
    await person("mu_new", "new@example.test")
    signedInAs("mu_new")
    expect((await call("/invitations/winv_missing/accept", {method: "POST"})).status).toBe(404)
    await WorkspaceInvitationModel.updateOne(
      {invitationId: created.invitationId},
      {$set: {expiresAt: new Date(Date.now() - 1000)}},
    )
    expect((await call(`/invitations/${created.invitationId}/accept`, {method: "POST"})).status).toBe(410)
  })

  describe("decline", () => {
    test("marks the invitation declined, joins nothing and records invitation.declined", async () => {
      const ws = await workspaceWithOwner()
      const created = await inviteTo(ws, "new@example.test")
      await person("mu_new", "new@example.test")
      signedInAs("mu_new")
      const membershipEventsBefore = await WorkspaceAuditEventModel.countDocuments({action: {$regex: "^membership\\."}})

      const res = await call(`/invitations/${created.invitationId}/decline`, {method: "POST"})
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({invitationId: created.invitationId, declined: true})
      expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())?.status).toBe("declined")
      expect(await getActiveMembership(ws, "mu_new")).toBeNull()
      const events = await WorkspaceAuditEventModel.find({action: "invitation.declined"}).lean()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({workspaceId: ws, target: {invitationId: created.invitationId, email: "new@example.test"}})
      // Declining opens and closes no membership interval, so the feed carries no membership event for it.
      expect(await WorkspaceAuditEventModel.countDocuments({action: {$regex: "^membership\\."}})).toBe(membershipEventsBefore)
      // It no longer lists, and cannot be accepted.
      expect(((await (await call("/invitations/mine")).json()) as {invitations: unknown[]}).invitations).toEqual([])
      expect((await call(`/invitations/${created.invitationId}/accept`, {method: "POST"})).status).toBe(404)
    })

    test("declining twice is idempotent and records one event", async () => {
      const ws = await workspaceWithOwner()
      const created = await inviteTo(ws, "new@example.test")
      await person("mu_new", "new@example.test")
      signedInAs("mu_new")
      for (let i = 0; i < 2; i++) {
        const res = await call(`/invitations/${created.invitationId}/decline`, {method: "POST"})
        expect(res.status).toBe(200)
      }
      expect(await WorkspaceAuditEventModel.countDocuments({action: "invitation.declined"})).toBe(1)
    })

    test("works on an expired invitation", async () => {
      const ws = await workspaceWithOwner()
      const created = await inviteTo(ws, "new@example.test")
      await WorkspaceInvitationModel.updateOne(
        {invitationId: created.invitationId},
        {$set: {expiresAt: new Date(Date.now() - 1000)}},
      )
      await person("mu_new", "new@example.test")
      signedInAs("mu_new")
      expect((await call(`/invitations/${created.invitationId}/decline`, {method: "POST"})).status).toBe(200)
    })

    test("is refused for someone else's invitation, and for an unverified email", async () => {
      const ws = await workspaceWithOwner()
      const created = await inviteTo(ws, "new@example.test")
      await person("mu_other", "other@example.test")
      signedInAs("mu_other")
      const other = await call(`/invitations/${created.invitationId}/decline`, {method: "POST"})
      expect(other.status).toBe(403)
      expect(((await other.json()) as {error: string}).error).toBe("email_mismatch")

      await person("mu_new", "new@example.test", false)
      mocks.splice(0).forEach(mock => mock.mockRestore())
      signedInAs("mu_new")
      expect((await call(`/invitations/${created.invitationId}/decline`, {method: "POST"})).status).toBe(403)
      expect((await WorkspaceInvitationModel.findOne({invitationId: created.invitationId}).lean())?.status).toBe("pending")
    })

    test("a revoked invitation is not found", async () => {
      const ws = await workspaceWithOwner()
      const created = await inviteTo(ws, "new@example.test")
      await WorkspaceInvitationModel.updateOne({invitationId: created.invitationId}, {$set: {status: "revoked"}})
      await person("mu_new", "new@example.test")
      signedInAs("mu_new")
      expect((await call(`/invitations/${created.invitationId}/decline`, {method: "POST"})).status).toBe(404)
    })

    test("after declining, the workspace can invite the same address again", async () => {
      const ws = await workspaceWithOwner()
      const first = await inviteTo(ws, "new@example.test")
      await person("mu_new", "new@example.test")
      signedInAs("mu_new")
      await call(`/invitations/${first.invitationId}/decline`, {method: "POST"})
      const second = await inviteTo(ws, "new@example.test")
      expect(second.invitationId).not.toBe(first.invitationId)
      expect(((await (await call("/invitations/mine")).json()) as {invitations: unknown[]}).invitations).toHaveLength(1)
    })
  })
})

describe("POST /leave", () => {
  test("a member leaves: 204, no workspace afterwards, the membership ends as left", async () => {
    const ws = await workspaceWithOwner()
    await person("mu_dev", "dev@example.test")
    await addMember(ws, "mu_dev", "developer")
    signedInAs("mu_dev")
    expect((await call("/leave", {method: "POST"})).status).toBe(204)
    expect(await (await call("/mine")).json()).toEqual({workspace: null})
    expect(await getActiveMembership(ws, "mu_dev")).toBeNull()
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.left"})).toBe(1)
  })

  test("the only Owner cannot leave (409 last_owner); another Owner can", async () => {
    const ws = await workspaceWithOwner()
    signedInAs(owner.mentraUserId)
    const refused = await call("/leave", {method: "POST"})
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as {error: string}).error).toBe("last_owner")
    expect(await getActiveMembership(ws, owner.mentraUserId)).not.toBeNull()

    await person("mu_co", "co@example.test")
    await addMember(ws, "mu_co", "owner")
    expect((await call("/leave", {method: "POST"})).status).toBe(204)
  })

  test("a person in no workspace gets 404", async () => {
    await person("mu_a", "a@example.test")
    signedInAs("mu_a")
    expect((await call("/leave", {method: "POST"})).status).toBe(404)
  })

  test("leaving, then accepting a new invitation, works", async () => {
    const first = await workspaceWithOwner("First")
    await person("mu_dev", "dev@example.test")
    await addMember(first, "mu_dev", "member")
    const secondOwner: UserActor = {...owner, mentraUserId: "mu_owner2", email: "owner2@example.test"}
    await person(secondOwner.mentraUserId, secondOwner.email)
    const second = (await createWorkspace(secondOwner, {name: "Second"})).workspaceId
    const created = await createInvitation(secondOwner, second, {email: "dev@example.test", role: "member"})
    signedInAs("mu_dev")
    expect((await call("/leave", {method: "POST"})).status).toBe(204)
    const accepted = await call(`/invitations/${created.invitationId}/accept`, {method: "POST"})
    expect(accepted.status).toBe(200)
    expect(await (await call("/mine")).json()).toMatchObject({workspace: {workspaceId: second, name: "Second"}})
  })
})
