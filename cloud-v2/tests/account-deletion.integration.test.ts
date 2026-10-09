/**
 * @fileoverview What deleting a Mentra account does to workspaces (`confirmAccountDeletion` and
 * `removeDeletedUserFromWorkspaces`).
 *
 * Real rows on a local replica set: users, sessions, one-time codes, identity links, memberships,
 * credentials, invitations and audit events. Only GoTrue's user deletion is stubbed.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name,
 * ignores `MONGO_URL`) and asserts the live connection is on that database before any destructive
 * call. The database is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27031 bun test tests/account-deletion.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {AccountCodeModel} from "../packages/core/src/models/account-code.model"
import {IdentityLinkModel} from "../packages/core/src/models/identity-link.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {confirmAccountDeletion, gotrue, otc} from "../packages/core/src/services/account/account.service"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {removeDeletedUserFromWorkspaces} from "../packages/core/src/services/workspaces/account-deletion.service"
import {listChanges} from "../packages/core/src/services/workspaces/audit.service"
import {createWorkspaceCredential} from "../packages/core/src/services/workspaces/credential.service"
import {listMembershipHistory} from "../packages/core/src/services/workspaces/membership-history.service"
import {
  countActiveOwners,
  createWorkspace,
  getWorkspace,
  listWorkspacesForUser,
  recoverOwnership,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"

setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  AccountCodeModel,
  IdentityLinkModel,
  UserModel,
  WorkspaceAuditCounterModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

const ENV_KEYS = ["CLOUD_CORE_CREDENTIAL_ENVIRONMENTS", "CLOUD_CORE_ENVIRONMENT"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let databaseUrl: string
let verified = false
let deleteUser: ReturnType<typeof spyOn>

function actor(mentraUserId: string): Actor & {kind: "user"} {
  return {kind: "user", mentraUserId, email: `${mentraUserId}@example.test`, emailVerified: true, isOrganizationAdmin: false}
}

let counter = 0
async function addMember(workspaceId: string, fields: Record<string, unknown> & {role: string}) {
  const membershipId = `wm_acct_${counter++}`
  await WorkspaceMembershipModel.create(
    membershipRow({membershipId, workspaceId, status: "active", startedAt: new Date(), mentraUserId: null, ...fields}),
  )
  return membershipId
}

/**
 * A Mentra account (`mentra` tenant) linked from a WorkOS user, who is a developer with a key in
 * "Team", the only owner of "Solo", and has an unclaimed migrated membership in "Migrated" waiting
 * for that WorkOS user. "Team" also has another member, and "Solo" an invitation the user sent.
 */
async function scenario() {
  const tenantUserId = `sb-${counter++}`
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId})
  const workosSubject = `workos_${tenantUserId}`
  await IdentityLinkModel.create({provider: "workos", subject: workosSubject, mentraUserId, linkedVia: "verified_email"})

  const team = await createWorkspace(actor("mu_team_owner"), {name: "Team"})
  const teamMembershipId = await addMember(team.workspaceId, {mentraUserId, role: "developer"})
  const otherMembershipId = await addMember(team.workspaceId, {mentraUserId: "mu_other", role: "member"})
  const {credential} = await createWorkspaceCredential(actor(mentraUserId), team.workspaceId, {name: "CI"})

  const solo = await createWorkspace(actor(mentraUserId), {name: "Solo"})
  const soloMembershipId = (await WorkspaceMembershipModel.findOne({workspaceId: solo.workspaceId}).lean())!.membershipId
  await WorkspaceInvitationModel.create({
    invitationId: `winv_${counter++}`,
    workspaceId: solo.workspaceId,
    email: "invitee@example.test",
    role: "developer",
    tokenHash: `hash_${counter++}`,
    status: "pending",
    invitedByMembershipId: soloMembershipId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })

  const migrated = await createWorkspace(actor("mu_migrated_owner"), {name: "Migrated"})
  const pendingMembershipId = await addMember(migrated.workspaceId, {pendingWorkosUserId: workosSubject, role: "admin"})

  return {
    mentraUserId,
    tenantUserId,
    workosSubject,
    team,
    teamMembershipId,
    otherMembershipId,
    credentialId: credential.credentialId,
    solo,
    soloMembershipId,
    migrated,
    pendingMembershipId,
  }
}

async function deletionCode(tenantUserId: string): Promise<string> {
  return otc.issueEmailCode({purpose: "account_deletion", subject: tenantUserId, ttlSec: 900})
}

beforeAll(async () => {
  databaseUrl = localTestMongoUrl("account-deletion")
  await connectMongo(databaseUrl)
  assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
  verified = true
  await Promise.all(MODELS.map(model => model.init()))
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
  process.env.CLOUD_CORE_CREDENTIAL_ENVIRONMENTS = "test"
  process.env.CLOUD_CORE_ENVIRONMENT = "test"
  deleteUser = spyOn(gotrue, "deleteUser").mockResolvedValue(undefined)
})

afterEach(() => {
  deleteUser.mockRestore()
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

describe("confirmAccountDeletion", () => {
  test("ends every membership, revokes their keys, drops identity links and puts a tombstone on the feed", async () => {
    const s = await scenario()
    const revisions = await Promise.all([s.team, s.solo, s.migrated].map(async w => (await getWorkspace(w.workspaceId))!))
    const {events: before} = await listChanges(null, 500)

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    expect(deleteUser).toHaveBeenCalledWith(s.tenantUserId)
    // Every membership the user held, the pending one included, ended as account_deleted.
    for (const membershipId of [s.teamMembershipId, s.soloMembershipId, s.pendingMembershipId]) {
      const row = (await WorkspaceMembershipModel.findOne({membershipId}).lean())!
      expect({membershipId, status: row.status, endedReason: row.endedReason, ended: row.endedAt instanceof Date}).toEqual({
        membershipId,
        status: "ended",
        endedReason: "account_deleted",
        ended: true,
      })
    }
    expect(await listWorkspacesForUser(s.mentraUserId)).toEqual([])
    // Nobody else's membership changes.
    expect((await WorkspaceMembershipModel.findOne({membershipId: s.otherMembershipId}).lean())!.status).toBe("active")
    // The key the user's membership created is revoked; the identity link is gone.
    expect((await AccessCredentialModel.findOne({credentialId: s.credentialId}).lean())!.revokedAt).toBeInstanceOf(Date)
    expect(await IdentityLinkModel.countDocuments({mentraUserId: s.mentraUserId})).toBe(0)
    // Each workspace's revision moved on, so cached authorization is invalidated.
    for (const previous of revisions) {
      expect((await getWorkspace(previous.workspaceId))!.authorizationRevision).toBeGreaterThan(previous.authorizationRevision)
    }

    // The feed: one membership.removed per membership with the reason, then the tombstone.
    const {events: all} = await listChanges(null, 500)
    const added = all.slice(before.length)
    expect(added.map(event => event.action)).toEqual([
      "membership.removed",
      "membership.removed",
      "membership.removed",
      "user.deleted",
    ])
    const removed = added.slice(0, 3)
    expect(new Set(removed.map(event => event.target.membershipId))).toEqual(
      new Set([s.teamMembershipId, s.soloMembershipId, s.pendingMembershipId]),
    )
    for (const event of removed) {
      expect(event.workspaceId).toEqual(expect.stringMatching(/^ws_/))
      expect(event.after).toMatchObject({status: "ended", endedReason: "account_deleted"})
      expect(event.before).toMatchObject({status: "active"})
    }
    const teamRemoved = removed.find(event => event.target.membershipId === s.teamMembershipId)!
    expect(teamRemoved).toMatchObject({
      workspaceId: s.team.workspaceId,
      target: {mentraUserId: s.mentraUserId},
      before: {role: "developer"},
      after: {revokedCredentialIds: [s.credentialId]},
    })
    expect(added[3]).toMatchObject({
      workspaceId: null,
      action: "user.deleted",
      target: {mentraUserId: s.mentraUserId},
      before: null,
      after: null,
    })
    expect(added[3]!.seq).toBeGreaterThan(removed[2]!.seq)
  })

  test("the history shows the generation ended by account deletion", async () => {
    const s = await scenario()

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    const [generation] = await listMembershipHistory(s.team.workspaceId, s.mentraUserId, new Date(0))
    expect(generation).toMatchObject({membershipId: s.teamMembershipId, endedReason: "account_deleted"})
    expect(generation!.roles.at(-1)!.to).toBe(generation!.endedAt)
  })

  test("a last owner's deletion is not refused: the workspace is left without an owner for recovery", async () => {
    const s = await scenario()

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    expect((await getWorkspace(s.solo.workspaceId))!.status).toBe("active")
    expect(await countActiveOwners(s.solo.workspaceId)).toBe(0)
    await recoverOwnership({kind: "system"}, s.solo.workspaceId, "mu_new_owner")
    expect(await countActiveOwners(s.solo.workspaceId)).toBe(1)
  })

  test("pending invitations the user sent stay valid", async () => {
    const s = await scenario()

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    expect((await WorkspaceInvitationModel.findOne({workspaceId: s.solo.workspaceId}).lean())!.status).toBe("pending")
  })

  test("a wrong code changes nothing", async () => {
    const s = await scenario()
    await deletionCode(s.tenantUserId)

    await expect(confirmAccountDeletion(s.mentraUserId, s.tenantUserId, "000000x")).rejects.toThrow()

    expect((await WorkspaceMembershipModel.findOne({membershipId: s.teamMembershipId}).lean())!.status).toBe("active")
    expect(await IdentityLinkModel.countDocuments({mentraUserId: s.mentraUserId})).toBe(1)
    expect(deleteUser).not.toHaveBeenCalled()
  })

  test("workspace access is gone before GoTrue is asked to delete the user, so a failure there is retryable", async () => {
    const s = await scenario()
    deleteUser.mockRejectedValueOnce(new Error("gotrue down"))

    await expect(confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))).rejects.toThrow(
      "gotrue down",
    )
    expect(await listWorkspacesForUser(s.mentraUserId)).toEqual([])

    // The account still exists, so the person asks again and it completes.
    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))
    expect(deleteUser).toHaveBeenCalledTimes(2)
  })
})

describe("removeDeletedUserFromWorkspaces", () => {
  test("a second run ends nothing more and records another tombstone", async () => {
    const s = await scenario()

    expect((await removeDeletedUserFromWorkspaces(s.mentraUserId)).endedMembershipIds.sort()).toEqual(
      [s.teamMembershipId, s.soloMembershipId, s.pendingMembershipId].sort(),
    )
    expect(await removeDeletedUserFromWorkspaces(s.mentraUserId)).toEqual({endedMembershipIds: []})

    const tombstones = await WorkspaceAuditEventModel.find({action: "user.deleted"}).lean()
    expect(tombstones).toHaveLength(2)
    expect(tombstones.every(event => event.workspaceId === null)).toBe(true)
  })

  test("a user with no workspaces still gets a tombstone", async () => {
    const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-lonely"})

    expect(await removeDeletedUserFromWorkspaces(mentraUserId)).toEqual({endedMembershipIds: []})

    const {events} = await listChanges(null, 500)
    expect(events.map(event => [event.action, event.target])).toEqual([["user.deleted", {mentraUserId}]])
  })

  test("refuses a blank user id rather than matching unclaimed rows", async () => {
    await expect(removeDeletedUserFromWorkspaces("  ")).rejects.toThrow("mentraUserId is required")
  })
})
