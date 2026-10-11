/**
 * @fileoverview What deleting a Mentra account does to workspaces (`confirmAccountDeletion` and
 * `removeDeletedUserFromWorkspaces`).
 *
 * Deleting an account ends every workspace membership the person holds and revokes the keys those
 * memberships created, in one transaction, before the account itself is deleted. Nothing else about
 * workspaces changes: other people's memberships and keys, service keys, and invitations stay.
 *
 * Real rows on a local replica set: users, one-time codes, memberships, credentials, invitations and
 * audit events. The account directory (GoTrue's admin API, where the account is deleted) is a fake
 * identity provider (`support/fake-idp.ts`) that this process's `fetch` reaches.
 *
 * Safety: the test connects through `localTestMongoUrl` (loopback only, random database name,
 * ignores `MONGO_URL`) and asserts the live connection is on that database before any destructive
 * call. The database is dropped in `afterAll`, only if the check passed.
 *
 * Run: `CLOUD_V2_TEST_MONGO_URL=mongodb://127.0.0.1:27017 bun test tests/account-deletion.integration.test.ts`
 */

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, setDefaultTimeout, spyOn, test} from "bun:test"

import {connectMongo, disconnectMongo} from "../packages/core/src/connections/mongo.connection"
import {AccessCredentialModel} from "../packages/core/src/models/access-credential.model"
import {AccountCodeModel} from "../packages/core/src/models/account-code.model"
import {BrowserSessionModel} from "../packages/core/src/models/browser-session.model"
import {RefreshTokenModel} from "../packages/core/src/models/refresh-token.model"
import {SupportProfileModel} from "../packages/core/src/models/support-profile.model"
import {UserModel} from "../packages/core/src/models/user.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {confirmAccountDeletion, gotrue, otc} from "../packages/core/src/services/account/account.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {removeDeletedUserFromWorkspaces} from "../packages/core/src/services/workspaces/account-deletion.service"
import {
  createOperatorKey,
  createWorkspaceCredential,
  mintServiceCredential,
  validateCredentialToken,
} from "../packages/core/src/services/workspaces/credential.service"
import {
  countActiveOwners,
  createWorkspace,
  getWorkspace,
  leaveWorkspace,
  listWorkspacesForUser,
  recoverOwnership,
  type Actor,
} from "../packages/core/src/services/workspaces/workspace.service"
import {installFakeIdp, type FakeIdp} from "./support/fake-idp"
import {assertConnectedTo, localTestMongoUrl} from "./support/local-mongo"
import {membershipRow} from "./support/membership-row"
import {
  applyEnv,
  HOSTED_ENV,
  SUPABASE_ISSUER,
  SUPABASE_JWKS,
  SUPABASE_PROJECT,
  SUPABASE_SECRET,
} from "./support/signin-harness"

setDefaultTimeout(30_000)

const MODELS = [
  AccessCredentialModel,
  AccountCodeModel,
  BrowserSessionModel,
  RefreshTokenModel,
  SupportProfileModel,
  UserModel,
  WorkspaceAuditEventModel,
  WorkspaceInvitationModel,
  WorkspaceMembershipModel,
  WorkspaceModel,
]

let databaseUrl: string
let verified = false
let idp: FakeIdp
let restoreEnv: () => void = () => {}

function actor(mentraUserId: string): Actor & {kind: "user"} {
  return {kind: "user", mentraUserId, email: `${mentraUserId}@example.test`, emailVerified: true, isOrganizationAdmin: false}
}

let counter = 0
async function addMember(workspaceId: string, fields: Record<string, unknown> & {mentraUserId: string; role: string}) {
  const membershipId = `wm_acct_${counter++}`
  await WorkspaceMembershipModel.create(
    membershipRow({membershipId, workspaceId, status: "active", startedAt: new Date(), ...fields}),
  )
  return membershipId
}

async function invite(workspaceId: string, email: string, invitedByMembershipId: string | null) {
  const invitationId = `winv_${counter++}`
  await WorkspaceInvitationModel.create({
    invitationId,
    workspaceId,
    email,
    role: "developer",
    tokenHash: `hash_${counter++}`,
    status: "pending",
    invitedByMembershipId,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return invitationId
}

/** Whether the fake account directory still has the account. */
async function accountExists(tenantUserId: string): Promise<boolean> {
  return (await gotrue.getUserById(tenantUserId)) !== null
}

/**
 * A Mentra account (`mentra` tenant, an account in the directory) that is a developer with a key in
 * "Team" and the only owner of "Solo", with a key there too and an invitation it sent. "Team" also
 * has another developer with a key of their own and a key the Store issued. Someone has invited the
 * account's email to "Elsewhere".
 */
async function scenario() {
  const tenantUserId = `sb-${counter++}`
  const email = `${tenantUserId}@example.test`
  idp.registerUser({sub: tenantUserId, email, emailConfirmed: true})
  const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId})
  const self = {...actor(mentraUserId), email}

  const team = await createWorkspace(actor("mu_team_owner"), {name: "Team"})
  const teamMembershipId = await addMember(team.workspaceId, {mentraUserId, email, role: "developer"})
  const otherMembershipId = await addMember(team.workspaceId, {mentraUserId: "mu_other", role: "developer"})
  const teamKey = await createWorkspaceCredential(self, team.workspaceId, {name: "CI"})
  const othersKey = await createWorkspaceCredential(actor("mu_other"), team.workspaceId, {name: "Their CI"})
  const storeKey = await mintServiceCredential("store", {
    workspaceId: team.workspaceId,
    name: "Store package key",
    packageNames: ["com.team.app"],
    actorEmail: email,
  })

  const solo = await createWorkspace(self, {name: "Solo"})
  const soloMembershipId = (await WorkspaceMembershipModel.findOne({workspaceId: solo.workspaceId}).lean())!.membershipId
  const soloKey = await createWorkspaceCredential(self, solo.workspaceId, {name: "Solo CI"})
  const sentInvitationId = await invite(solo.workspaceId, "invitee@example.test", soloMembershipId)

  const elsewhere = await createWorkspace(actor("mu_elsewhere_owner"), {name: "Elsewhere"})
  const receivedInvitationId = await invite(elsewhere.workspaceId, email, null)

  return {
    mentraUserId,
    tenantUserId,
    email,
    team,
    teamMembershipId,
    otherMembershipId,
    teamKey,
    othersKey,
    storeKey,
    solo,
    soloMembershipId,
    soloKey,
    sentInvitationId,
    elsewhere,
    receivedInvitationId,
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
  for (const model of MODELS) {
    await model.createCollection()
    await model.syncIndexes()
  }
})

afterAll(async () => {
  if (verified && WorkspaceModel.db.readyState === 1) {
    assertConnectedTo(databaseUrl, WorkspaceModel.db.name)
    await WorkspaceModel.db.dropDatabase()
  }
  await disconnectMongo()
})

beforeEach(async () => {
  restoreEnv = applyEnv({
    ...HOSTED_ENV,
    CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: "test",
    CLOUD_CORE_ENVIRONMENT: "test",
    CLOUD_CORE_WORKSPACE_CREATION: undefined,
  })
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

describe("confirmAccountDeletion", () => {
  test("ends every membership and revokes the keys those memberships created, then deletes the account", async () => {
    const s = await scenario()
    const revisions = await Promise.all([s.team, s.solo].map(async w => (await getWorkspace(w.workspaceId))!))
    expect(await accountExists(s.tenantUserId)).toBe(true)
    const eventsBefore = new Set((await WorkspaceAuditEventModel.find({}).lean()).map(event => event.eventId))

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    expect(await accountExists(s.tenantUserId)).toBe(false)
    // Every membership the user held ended as account_deleted.
    for (const membershipId of [s.teamMembershipId, s.soloMembershipId]) {
      const row = (await WorkspaceMembershipModel.findOne({membershipId}).lean())!
      expect({membershipId, status: row.status, endedReason: row.endedReason, ended: row.endedAt instanceof Date}).toEqual({
        membershipId,
        status: "ended",
        endedReason: "account_deleted",
        ended: true,
      })
    }
    // Ending closes the generation at `endedAt`; its role history gains nothing.
    const team = (await WorkspaceMembershipModel.findOne({membershipId: s.teamMembershipId}).lean())!
    expect(team.roleHistory.map(entry => entry.role)).toEqual(["developer"])
    expect(await listWorkspacesForUser(s.mentraUserId)).toEqual([])
    // Nobody else's membership changes.
    expect((await WorkspaceMembershipModel.findOne({membershipId: s.otherMembershipId}).lean())!.status).toBe("active")

    // The keys the user's memberships created are revoked and no longer validate.
    for (const key of [s.teamKey, s.soloKey]) {
      const row = (await AccessCredentialModel.findOne({credentialId: key.credential.credentialId}).lean())!
      expect(row.revokedAt).toBeInstanceOf(Date)
      expect(await validateCredentialToken(key.token)).toBeNull()
    }
    // Another member's key and the Store's key for the workspace are not the user's to lose.
    for (const key of [s.othersKey, s.storeKey]) {
      expect((await AccessCredentialModel.findOne({credentialId: key.credential.credentialId}).lean())!.revokedAt).toBeNull()
      expect(await validateCredentialToken(key.token)).toMatchObject({credentialId: key.credential.credentialId})
    }

    // Each workspace's revision moved on, so cached authorization is invalidated.
    for (const previous of revisions) {
      expect((await getWorkspace(previous.workspaceId))!.authorizationRevision).toBeGreaterThan(previous.authorizationRevision)
    }

    // The audit trail: one membership.removed per membership, in its workspace, and nothing else.
    const added = (await WorkspaceAuditEventModel.find({}).lean()).filter(event => !eventsBefore.has(event.eventId))
    expect(added.map(event => event.action)).toEqual(["membership.removed", "membership.removed"])
    const byMembership = new Map(added.map(event => [(event.target as {membershipId: string}).membershipId, event]))
    expect(byMembership.get(s.teamMembershipId)).toMatchObject({
      workspaceId: s.team.workspaceId,
      actor: {kind: "user", mentraUserId: s.mentraUserId},
      target: {membershipId: s.teamMembershipId, mentraUserId: s.mentraUserId},
      before: {role: "developer", status: "active"},
      after: {status: "ended", endedReason: "account_deleted", revokedCredentialIds: [s.teamKey.credential.credentialId]},
    })
    expect(byMembership.get(s.soloMembershipId)).toMatchObject({
      workspaceId: s.solo.workspaceId,
      before: {role: "owner", status: "active"},
      after: {status: "ended", endedReason: "account_deleted", revokedCredentialIds: [s.soloKey.credential.credentialId]},
    })
    // No organization-level record of the person is kept.
    expect(await WorkspaceAuditEventModel.countDocuments({workspaceId: null})).toBe(0)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "user.deleted"})).toBe(0)
  })

  test("a last owner's deletion is not refused: the workspace is left without an owner for recovery", async () => {
    const s = await scenario()

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    expect((await getWorkspace(s.solo.workspaceId))!.status).toBe("active")
    expect(await countActiveOwners(s.solo.workspaceId)).toBe(0)
    await recoverOwnership({kind: "system"}, s.solo.workspaceId, "mu_new_owner")
    expect(await countActiveOwners(s.solo.workspaceId)).toBe(1)
  })

  test("invitations the user sent end with their membership; invitations to the user's email stay valid", async () => {
    const s = await scenario()

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    expect((await WorkspaceInvitationModel.findOne({invitationId: s.sentInvitationId}).lean())!.status).toBe("revoked")
    expect((await WorkspaceInvitationModel.findOne({invitationId: s.receivedInvitationId}).lean())!.status).toBe("pending")
    const removed = await WorkspaceAuditEventModel.find({action: "membership.removed"}).lean()
    expect(removed.flatMap(event => (event.after as {revokedInvitationIds?: string[]}).revokedInvitationIds ?? [])).toEqual([
      s.sentInvitationId,
    ])
  })

  test("the person's operator keys are revoked and their email is cleared from their membership rows", async () => {
    const s = await scenario()
    const operatorKey = await createOperatorKey(
      {kind: "user", mentraUserId: s.mentraUserId, email: "ops-admin@example.test", emailVerified: true, isOrganizationAdmin: true},
      {name: "Incident fetcher", scopes: ["organization.incidents.read"]},
    )
    const othersOperatorKey = await createOperatorKey(
      {kind: "user", mentraUserId: "mu_other_admin", email: "other-admin@example.test", emailVerified: true, isOrganizationAdmin: true},
      {name: "Another fetcher", scopes: ["organization.incidents.read"]},
    )
    const memberships = await WorkspaceMembershipModel.find({mentraUserId: s.mentraUserId}).lean()
    expect(memberships.some(row => row.email)).toBe(true)

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    const revoked = (await AccessCredentialModel.findOne({credentialId: operatorKey.credential.credentialId}).lean())!
    expect(revoked.revokedAt).toBeInstanceOf(Date)
    const kept = (await AccessCredentialModel.findOne({credentialId: othersOperatorKey.credential.credentialId}).lean())!
    expect(kept.revokedAt).toBeNull()
    expect(
      await WorkspaceAuditEventModel.countDocuments({action: "credential.revoked", "target.credentialId": operatorKey.credential.credentialId}),
    ).toBe(1)
    const after = await WorkspaceMembershipModel.find({mentraUserId: s.mentraUserId}).lean()
    expect(after.map(row => row.email)).toEqual(after.map(() => null))
  })

  test("a wrong code changes nothing", async () => {
    const s = await scenario()
    await deletionCode(s.tenantUserId)
    const eventsBefore = await WorkspaceAuditEventModel.countDocuments({})

    await expect(confirmAccountDeletion(s.mentraUserId, s.tenantUserId, "000000x")).rejects.toThrow()

    for (const membershipId of [s.teamMembershipId, s.soloMembershipId]) {
      expect((await WorkspaceMembershipModel.findOne({membershipId}).lean())!.status).toBe("active")
    }
    expect(await validateCredentialToken(s.teamKey.token)).toMatchObject({credentialId: s.teamKey.credential.credentialId})
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(eventsBefore)
    expect(await accountExists(s.tenantUserId)).toBe(true)
  })

  test("workspace access is gone before the account directory is asked to delete the account, so a failure there is retryable", async () => {
    const s = await scenario()
    idp.outage = true

    await expect(confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))).rejects.toThrow()

    expect(await listWorkspacesForUser(s.mentraUserId)).toEqual([])
    expect(await validateCredentialToken(s.teamKey.token)).toBeNull()

    // The account still exists, so the person asks again and it completes.
    idp.outage = false
    expect(await accountExists(s.tenantUserId)).toBe(true)
    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))
    expect(await accountExists(s.tenantUserId)).toBe(false)
    // Nothing was ended twice.
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.removed"})).toBe(2)
  })
})

describe("removeDeletedUserFromWorkspaces", () => {
  test("a second run ends nothing more and records nothing", async () => {
    const s = await scenario()

    expect((await removeDeletedUserFromWorkspaces(s.mentraUserId)).endedMembershipIds.sort()).toEqual(
      [s.teamMembershipId, s.soloMembershipId].sort(),
    )
    const eventsAfterFirst = await WorkspaceAuditEventModel.countDocuments({})
    const revisions = await Promise.all([s.team, s.solo].map(async w => (await getWorkspace(w.workspaceId))!))

    expect(await removeDeletedUserFromWorkspaces(s.mentraUserId)).toEqual({endedMembershipIds: [], revokedOperatorKeyIds: []})

    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(eventsAfterFirst)
    for (const previous of revisions) {
      expect((await getWorkspace(previous.workspaceId))!.authorizationRevision).toBe(previous.authorizationRevision)
    }
  })

  test("a person with no active membership needs no transaction and changes no workspace", async () => {
    const {mentraUserId: lonely} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-lonely"})
    const {mentraUserId: former} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-former"})
    const team = await createWorkspace(actor("mu_owner"), {name: "Team"})
    await addMember(team.workspaceId, {mentraUserId: former, role: "member"})
    await leaveWorkspace(actor(former), team.workspaceId)
    const revision = (await getWorkspace(team.workspaceId))!.authorizationRevision
    const eventsBefore = await WorkspaceAuditEventModel.countDocuments({})
    const startSession = spyOn(WorkspaceModel.db, "startSession")
    try {
      for (const mentraUserId of [lonely, former, "mu_never_seen"]) {
        expect({mentraUserId, result: await removeDeletedUserFromWorkspaces(mentraUserId)}).toEqual({
          mentraUserId,
          result: {endedMembershipIds: [], revokedOperatorKeyIds: []},
        })
      }
      expect(startSession).not.toHaveBeenCalled()

      // Someone with a membership does go through a transaction.
      const {mentraUserId: member} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-member"})
      const membershipId = await addMember(team.workspaceId, {mentraUserId: member, role: "member"})
      expect(await removeDeletedUserFromWorkspaces(member)).toEqual({endedMembershipIds: [membershipId], revokedOperatorKeyIds: []})
      expect(startSession).toHaveBeenCalledTimes(1)
    } finally {
      startSession.mockRestore()
    }
    // Only the member's removal changed anything.
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(eventsBefore + 1)
    expect((await getWorkspace(team.workspaceId))!.authorizationRevision).toBe(revision + 1)
  })

  test("an active membership left in a deleted workspace still ends", async () => {
    const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-stray"})
    const gone = await createWorkspace(actor("mu_owner"), {name: "Gone"})
    const membershipId = await addMember(gone.workspaceId, {mentraUserId, role: "developer"})
    await WorkspaceModel.updateOne({workspaceId: gone.workspaceId}, {$set: {status: "deleted", deletedAt: new Date()}})

    expect(await removeDeletedUserFromWorkspaces(mentraUserId)).toEqual({endedMembershipIds: [membershipId], revokedOperatorKeyIds: []})

    expect(await WorkspaceMembershipModel.findOne({membershipId}).lean()).toMatchObject({
      status: "ended",
      endedReason: "account_deleted",
    })
  })

  test("refuses a blank user id rather than matching rows by a missing id", async () => {
    for (const blank of ["", "  "]) {
      await expect(removeDeletedUserFromWorkspaces(blank)).rejects.toThrow("mentraUserId is required")
    }
  })
})
