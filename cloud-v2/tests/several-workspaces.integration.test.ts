/**
 * @fileoverview A person in several workspaces, and the one workspace that manages their device, against a real
 * replica set.
 *
 * Pinned here:
 *  - joining never asks the person to leave: create, accept and ownership recovery each add a membership beside
 *    the ones they hold, under concurrency too, while an empty automatic workspace of theirs still gives way;
 *  - the managing workspace (`managing-workspace.service`): the earliest-joined membership in a workspace that is
 *    not their own automatic one, else their own automatic one; a later join never takes it over, leaving it
 *    passes it on, and someone else's automatic workspace is a real one;
 *  - a miniapp token names the managing workspace when several of the person's workspaces assign the miniapp,
 *    and any one that assigns it otherwise;
 *  - the startup step that removes the one-workspace guards an earlier release wrote.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name, ignores
 * `MONGO_URL`) and asserts the live connection is on that database before any destructive call.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/several-workspaces.integration.test.ts`
 */

import {afterAll, beforeAll, beforeEach, describe, expect, test} from "bun:test"
import type {Model} from "mongoose"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {removeOneWorkspaceGuards} from "../packages/core/src/migrations/startup.migrations"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAssignedPackagesModel} from "../packages/core/src/models/workspace-assigned-packages.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {assigningWorkspace, replaceAssignedPackages} from "../packages/core/src/services/workspaces/assigned-packages.service"
import {ensureWorkspace} from "../packages/core/src/services/workspaces/automatic-workspace.service"
import {acceptInvitation, createInvitation} from "../packages/core/src/services/workspaces/invitation.service"
import {managingWorkspaceOf, pickManaging} from "../packages/core/src/services/workspaces/managing-workspace.service"
import {
  createWorkspace,
  leaveWorkspace,
  listMembers,
  listWorkspacesForUser,
  recoverOwnership,
  WorkspaceError,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"

const MODELS: Model<any>[] = [
  UserModel,
  WorkspaceModel,
  WorkspaceMembershipModel,
  WorkspaceInvitationModel,
  WorkspaceAssignedPackagesModel,
  AccessCredentialModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
]

const URL_TEMPLATE = "https://core.example.test/invite/{token}"
const URL_PREFIX = "https://core.example.test/invite/"

let databaseUrl: string
let verified = false
const savedTemplate = process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
const savedAdminEmails = process.env.CLOUD_CORE_ADMIN_EMAILS

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

let counter = 0
const nextId = () => `${Date.now().toString(36)}${(counter++).toString(36)}`

async function accountOf(mentraUserId: string) {
  await UserModel.create({mentraUserId, tenantId: "mentra", tenantUserId: `sb-${mentraUserId}`})
}

/** The person's automatic workspace, as the portal's first sign-in makes it: its id. */
async function automaticFor(mentraUserId: string): Promise<string> {
  if (!(await UserModel.exists({mentraUserId}))) await accountOf(mentraUserId)
  return (await ensureWorkspace(user(mentraUserId))).workspace.workspaceId
}

/** A workspace owned by `ownerId` (made if not given), and an invitation of `email` into it: the invitation's token. */
async function invitationInto(ownerId: string, email: string, workspaceId?: string) {
  const id = workspaceId ?? (await createWorkspace(user(ownerId), {name: `W ${nextId()}`})).workspaceId
  const created = await createInvitation(user(ownerId), id, {email, role: "member"})
  return {workspaceId: id, token: created.inviteUrl.slice(URL_PREFIX.length)}
}

/** `person` joins `ownerId`'s new workspace by invitation: the workspace's id. */
async function join(person: string, ownerId: string): Promise<string> {
  const email = `${person}@example.test`
  const into = await invitationInto(ownerId, email)
  await acceptInvitation(user(person), into.token)
  return into.workspaceId
}

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

const activeCount = (mentraUserId: string) => WorkspaceMembershipModel.countDocuments({mentraUserId, status: "active"})
const managingId = async (mentraUserId: string) => (await managingWorkspaceOf(mentraUserId))?.workspace.workspaceId ?? null
/** Wait past the clock's millisecond, so two joins have distinct `startedAt`. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("several-workspaces")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  if (savedTemplate === undefined) delete process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE
  else process.env.CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE = savedTemplate
  if (savedAdminEmails === undefined) delete process.env.CLOUD_CORE_ADMIN_EMAILS
  else process.env.CLOUD_CORE_ADMIN_EMAILS = savedAdminEmails
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
  process.env.CLOUD_CORE_ADMIN_EMAILS = orgAdmin.email!
  await accountOf(orgAdmin.mentraUserId)
})

describe("joining beside the workspaces a person holds", () => {
  test("a person in a workspace can create another and accept an invitation into a third", async () => {
    const mine = (await createWorkspace(user("mu_a"), {name: "Mine"})).workspaceId
    const second = (await createWorkspace(user("mu_a"), {name: "Second"})).workspaceId
    const into = await invitationInto("mu_b", "mu_a@example.test")

    await acceptInvitation(user("mu_a"), into.token)

    expect(await activeCount("mu_a")).toBe(3)
    expect((await listWorkspacesForUser("mu_a")).map(entry => entry.workspaceId).sort()).toEqual(
      [mine, second, into.workspaceId].sort(),
    )
  })

  test("a member of the invited workspace who accepts again still gets already_member", async () => {
    const into = await invitationInto("mu_b", "b@example.test")
    await acceptInvitation(user("mu_c", {email: "b@example.test"}), into.token)
    const again = await createInvitation(user("mu_b"), into.workspaceId, {email: "c@example.test", role: "member"})
    await expectError(
      () => acceptInvitation(user("mu_c", {email: "c@example.test"}), again.inviteUrl.slice(URL_PREFIX.length)),
      "already_member",
      409,
    )
  })

  test("ownership recovery for someone in another workspace adds an Owner membership beside it", async () => {
    await accountOf("mu_busy")
    const ws = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    const busy = (await createWorkspace(user("mu_busy"), {name: "Busy"})).workspaceId

    await recoverOwnership(orgAdmin, ws, "mu_busy")

    const held = await listWorkspacesForUser("mu_busy")
    expect(held.map(entry => [entry.workspaceId, entry.membership.role]).sort()).toEqual(
      [
        [busy, "owner"],
        [ws, "owner"],
      ].sort(),
    )
  })

  test("an empty automatic workspace still gives way to a join; one that holds something stays", async () => {
    const empty = await automaticFor("mu_empty")
    await join("mu_empty", "mu_owner1")
    expect(await WorkspaceModel.findOne({workspaceId: empty}).lean()).toMatchObject({status: "deleted"})
    expect(await activeCount("mu_empty")).toBe(1)

    const kept = await automaticFor("mu_kept")
    // A second member: the workspace now holds something, so it is the person's to keep.
    const invite = await invitationInto("mu_kept", "friend@example.test", kept)
    await acceptInvitation(user("mu_friend", {email: "friend@example.test"}), invite.token)
    await join("mu_kept", "mu_owner2")
    expect(await WorkspaceModel.findOne({workspaceId: kept}).lean()).toMatchObject({status: "active"})
    expect(await activeCount("mu_kept")).toBe(2)
  })
})

describe("under concurrency", () => {
  test("two accepts of two invitations by one person: both join", async () => {
    for (let round = 0; round < 6; round++) {
      const email = `racer${round}@example.test`
      const one = await invitationInto(`mu_o1_${round}`, email)
      const two = await invitationInto(`mu_o2_${round}`, email)

      const results = await Promise.allSettled([
        acceptInvitation(user(`mu_racer${round}`, {email}), one.token),
        acceptInvitation(user(`mu_racer${round}`, {email}), two.token),
      ])

      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2)
      expect(await activeCount(`mu_racer${round}`)).toBe(2)
    }
  })

  test("two accepts of the same invitation: exactly one membership", async () => {
    for (let round = 0; round < 6; round++) {
      const email = `same${round}@example.test`
      const into = await invitationInto(`mu_so_${round}`, email)

      const results = await Promise.allSettled([
        acceptInvitation(user(`mu_same${round}`, {email}), into.token),
        acceptInvitation(user(`mu_same${round}`, {email}), into.token),
      ])

      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      expect(await activeCount(`mu_same${round}`)).toBe(1)
      expect((await listMembers(into.workspaceId)).filter(member => member.mentraUserId === `mu_same${round}`)).toHaveLength(1)
    }
  })
})

describe("the managing workspace", () => {
  test("is none for a person in no workspace, and their own automatic workspace while it is all they have", async () => {
    expect(await managingWorkspaceOf("mu_nobody")).toBeNull()
    const automatic = await automaticFor("mu_a")
    expect(await managingWorkspaceOf("mu_a")).toMatchObject({
      workspace: {workspaceId: automatic},
      membership: {role: "owner"},
      automatic: true,
    })
  })

  test("moves from the person's automatic workspace to the first real one they join, which keeps it", async () => {
    const automatic = await automaticFor("mu_a")
    // Holding a second member keeps the automatic workspace from giving way.
    const invite = await invitationInto("mu_a", "friend@example.test", automatic)
    await acceptInvitation(user("mu_friend", {email: "friend@example.test"}), invite.token)

    await tick()
    const company = await join("mu_a", "mu_company_owner")
    expect(await managingWorkspaceOf("mu_a")).toMatchObject({workspace: {workspaceId: company}, automatic: false})

    await tick()
    await join("mu_a", "mu_hobby_owner")
    expect(await managingId("mu_a")).toBe(company)

    await tick()
    await createWorkspace(user("mu_a"), {name: "Side project"})
    expect(await managingId("mu_a")).toBe(company)
  })

  test("leaving it passes it to the next real workspace, then back to the automatic one", async () => {
    const automatic = await automaticFor("mu_a")
    const invite = await invitationInto("mu_a", "friend@example.test", automatic)
    await acceptInvitation(user("mu_friend", {email: "friend@example.test"}), invite.token)
    await tick()
    const first = await join("mu_a", "mu_first_owner")
    await tick()
    const second = await join("mu_a", "mu_second_owner")

    await leaveWorkspace(user("mu_a"), first)
    expect(await managingId("mu_a")).toBe(second)

    await leaveWorkspace(user("mu_a"), second)
    expect(await managingWorkspaceOf("mu_a")).toMatchObject({workspace: {workspaceId: automatic}, automatic: true})
  })

  test("someone else's automatic workspace is a real workspace to its members", async () => {
    const theirs = await automaticFor("mu_host")
    const mine = await join("mu_guest", "mu_other_owner")
    await tick()
    const invite = await invitationInto("mu_host", "mu_guest@example.test", theirs)
    await acceptInvitation(user("mu_guest"), invite.token)

    // The guest's first workspace is real and came first, so it keeps managing; the host's automatic workspace is
    // not "automatic" to the guest.
    expect(await managingWorkspaceOf("mu_guest")).toMatchObject({workspace: {workspaceId: mine}, automatic: false})
    await leaveWorkspace(user("mu_guest"), mine)
    expect(await managingWorkspaceOf("mu_guest")).toMatchObject({workspace: {workspaceId: theirs}, automatic: false})
  })

  test("an imported membership counts from its claim, not from when the Store recorded it", async () => {
    const joined = await join("mu_a", "mu_team_owner")
    const imported = (await createWorkspace(user("mu_studio_owner"), {name: "Studio"})).workspaceId
    // The Store had mu_a in Studio long ago; they only took it up (claimed it) after joining the team.
    await WorkspaceMembershipModel.create(
      membershipRow({
        membershipId: `wm_imported_${nextId()}`,
        workspaceId: imported,
        mentraUserId: "mu_a",
        email: "mu_a@example.test",
        role: "member",
        status: "active",
        startedAt: new Date(Date.now() - 365 * 86_400_000),
        claimedAt: new Date(Date.now() + 60_000),
      }),
    )
    expect(await managingId("mu_a")).toBe(joined)
  })

  test("pickManaging orders by join, then membership id, and puts the person's own automatic workspace last", () => {
    const at = (ms: number) => new Date(ms)
    const own = {automatic: true, createdByMentraUserId: "mu_a"}
    const real = {automatic: false, createdByMentraUserId: "mu_x"}
    const pick = (candidates: Parameters<typeof pickManaging>[1]) => pickManaging("mu_a", candidates)?.membership.membershipId

    expect(
      pick([
        {membership: {workspaceId: "ws_1", membershipId: "wm_1", role: "owner", startedAt: at(1)}, workspace: own},
        {membership: {workspaceId: "ws_2", membershipId: "wm_2", role: "member", startedAt: at(3)}, workspace: real},
        {membership: {workspaceId: "ws_3", membershipId: "wm_3", role: "admin", startedAt: at(2)}, workspace: real},
      ]),
    ).toBe("wm_3")
    expect(
      pick([
        {membership: {workspaceId: "ws_2", membershipId: "wm_b", role: "member", startedAt: at(2)}, workspace: real},
        {membership: {workspaceId: "ws_3", membershipId: "wm_a", role: "member", startedAt: at(2)}, workspace: real},
      ]),
    ).toBe("wm_a")
    expect(pick([{membership: {workspaceId: "ws_1", membershipId: "wm_1", role: "owner", startedAt: at(9)}, workspace: own}])).toBe(
      "wm_1",
    )
    expect(pick([])).toBeUndefined()
  })
})

describe("miniapp tokens", () => {
  test("name the managing workspace when several of the person's workspaces assign the miniapp, any assigning one otherwise", async () => {
    const company = await join("mu_a", "mu_company_owner")
    await tick()
    const hobby = await join("mu_a", "mu_hobby_owner")
    await replaceAssignedPackages(hobby, {packageNames: ["com.example.shared", "com.example.hobby"], revision: 1})
    await replaceAssignedPackages(company, {packageNames: ["com.example.shared"], revision: 1})

    expect(await managingId("mu_a")).toBe(company)
    expect(await assigningWorkspace("mu_a", "com.example.shared")).toBe(company)
    // A workspace that does not manage the device still names itself for its own miniapps.
    expect(await assigningWorkspace("mu_a", "com.example.hobby")).toBe(hobby)
    expect(await assigningWorkspace("mu_a", "com.example.none")).toBeNull()
  })
})

describe("the guards an earlier release wrote", () => {
  test("are removed at startup, and nothing else is", async () => {
    const ws = (await createWorkspace(user("mu_a"), {name: "A"})).workspaceId
    await WorkspaceMembershipModel.collection.insertOne({
      _id: "ows:mu_a",
      membershipId: "ows:mu_a",
      kind: "one_workspace_guard",
      guardedUserId: "mu_a",
      guardedWorkspaceId: ws,
      guardedMembershipId: "wm_gone",
      createdAt: new Date(),
    } as any)
    const before = await WorkspaceMembershipModel.collection.countDocuments({})

    expect(await removeOneWorkspaceGuards()).toBe(1)
    expect(await WorkspaceMembershipModel.collection.countDocuments({})).toBe(before - 1)
    expect(await activeCount("mu_a")).toBe(1)
    expect(await removeOneWorkspaceGuards()).toBe(0)
  })
})
