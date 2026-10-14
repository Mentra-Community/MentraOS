/**
 * @fileoverview What deleting a Mentra account does to workspaces (`confirmAccountDeletion` and
 * `removeDeletedUserFromWorkspaces`).
 *
 * Deleting an account ends every workspace membership the person holds, revokes the keys those
 * memberships created and every invitation the person sent, in one transaction, before the account
 * itself is deleted; then their operator keys are revoked and their identity is cleared from the rows
 * that stay. Nothing else about workspaces changes: other people's memberships and keys, service keys,
 * and invitations addressed to the person stay. The last write of that transaction is the
 * `user.deleted` tombstone on the change feed, which tells a service keeping data keyed by the
 * person to delete it.
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
import {WorkspaceAuditCounterModel} from "../packages/core/src/models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../packages/core/src/models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../packages/core/src/models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../packages/core/src/models/workspace-membership.model"
import {WorkspaceModel} from "../packages/core/src/models/workspace.model"
import {
  confirmAccountDeletion,
  finishPendingAccountDeletions,
  gotrue,
  otc,
} from "../packages/core/src/services/account/account.service"
import {resetIdpTokenCaches} from "../packages/core/src/services/signin/idp-tokens"
import {findOrCreateUser} from "../packages/core/src/services/user.service"
import {removeDeletedUserFromWorkspaces} from "../packages/core/src/services/workspaces/account-deletion.service"
import {listChanges} from "../packages/core/src/services/workspaces/audit.service"
import {
  createOperatorKey,
  createWorkspaceCredential,
  mintServiceCredential,
  validateCredentialToken,
} from "../packages/core/src/services/workspaces/credential.service"
import {
  acceptInvitation,
  createInvitation,
  peekInvitation,
} from "../packages/core/src/services/workspaces/invitation.service"
import {
  countActiveOwners,
  createWorkspace,
  getWorkspace,
  leaveWorkspace,
  listWorkspacesForUser,
  recoverOwnership,
  WorkspaceError,
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
  WorkspaceAuditCounterModel,
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

/** A pending invitation sent by a member (`by`), or by the system. */
async function invite(workspaceId: string, email: string, by: {membershipId: string; mentraUserId: string} | "system") {
  const invitationId = `winv_${counter++}`
  await WorkspaceInvitationModel.create({
    invitationId,
    workspaceId,
    email,
    role: "developer",
    tokenHash: `hash_${counter++}`,
    status: "pending",
    ...(by === "system"
      ? {invitedByAuthority: "system"}
      : {invitedByAuthority: "membership", invitedByMembershipId: by.membershipId, invitedByMentraUserId: by.mentraUserId}),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  })
  return invitationId
}

const OPS_ADMIN_EMAIL = "ops-admin@example.test"
const INVITE_URL_PREFIX = "https://core.example.test/invite/"

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
  const sentInvitationId = await invite(solo.workspaceId, "invitee@example.test", {
    membershipId: soloMembershipId,
    mentraUserId,
  })

  const elsewhere = await createWorkspace(actor("mu_elsewhere_owner"), {name: "Elsewhere"})
  const receivedInvitationId = await invite(elsewhere.workspaceId, email, "system")

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
    CLOUD_CORE_ADMIN_EMAILS: OPS_ADMIN_EMAIL,
    CLOUD_CORE_ADMIN_EMAIL_DOMAINS: undefined,
    CLOUD_CORE_CREDENTIAL_ENVIRONMENTS: "test",
    CLOUD_CORE_ENVIRONMENT: "test",
    CLOUD_CORE_WORKSPACE_CREATION: undefined,
    CLOUD_CORE_WORKSPACE_INVITE_URL_TEMPLATE: `${INVITE_URL_PREFIX}{token}`,
    RESEND_API_KEY: undefined,
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

    // The audit trail: one membership.removed per membership, in its workspace, then the tombstone.
    const added = (await WorkspaceAuditEventModel.find({}).sort({seq: 1}).lean()).filter(
      event => !eventsBefore.has(event.eventId),
    )
    expect(added.map(event => event.action)).toEqual(["membership.removed", "membership.removed", "user.deleted"])
    const byMembership = new Map(added.map(event => [(event.target as {membershipId: string}).membershipId, event]))
    expect(byMembership.get(s.teamMembershipId)).toMatchObject({
      workspaceId: s.team.workspaceId,
      actor: {kind: "user", mentraUserId: s.mentraUserId},
      // The audit trail keeps the address the membership recorded; the membership row itself loses it.
      target: {membershipId: s.teamMembershipId, mentraUserId: s.mentraUserId, email: s.email},
      before: {role: "developer", status: "active"},
      after: {status: "ended", endedReason: "account_deleted", revokedCredentialIds: [s.teamKey.credential.credentialId]},
    })
    expect(byMembership.get(s.soloMembershipId)).toMatchObject({
      workspaceId: s.solo.workspaceId,
      before: {role: "owner", status: "active"},
      after: {status: "ended", endedReason: "account_deleted", revokedCredentialIds: [s.soloKey.credential.credentialId]},
    })
    // The only organization-level record of the person is the tombstone, and it names the opaque id alone.
    const organizational = await WorkspaceAuditEventModel.find({workspaceId: null}).lean()
    expect(organizational.map(event => event.action)).toEqual(["user.deleted"])
    expect(organizational[0]).toMatchObject({target: {mentraUserId: s.mentraUserId}})
    expect(JSON.stringify(organizational[0])).not.toContain(s.email)
  })

  test("a last owner's deletion is not refused: the workspace is left without an owner for recovery", async () => {
    const s = await scenario()

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    expect((await getWorkspace(s.solo.workspaceId))!.status).toBe("active")
    expect(await countActiveOwners(s.solo.workspaceId)).toBe(0)
    // The deleted account's tombstone cannot be made an owner again: nobody could sign in as it.
    const refused = await recoverOwnership({kind: "system"}, s.solo.workspaceId, s.mentraUserId).catch(err => err)
    expect(refused).toBeInstanceOf(WorkspaceError)
    expect({code: refused.code, status: refused.status}).toEqual({code: "user_not_found", status: 404})
    expect(await countActiveOwners(s.solo.workspaceId)).toBe(0)

    const {mentraUserId: heir} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-heir"})
    await recoverOwnership({kind: "system"}, s.solo.workspaceId, heir)
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

  test("invitations the user sent as an Organization Admin are revoked too, and stop working at once", async () => {
    const s = await scenario()
    const asOrganizationAdmin: Actor & {kind: "user"} = {
      kind: "user",
      mentraUserId: s.mentraUserId,
      email: OPS_ADMIN_EMAIL,
      emailVerified: true,
      isOrganizationAdmin: true,
    }
    // Not a member of "Elsewhere": the invitation rests on the organization's authority alone.
    const sent = await createInvitation(asOrganizationAdmin, s.elsewhere.workspaceId, {email: "heir@example.test", role: "owner"})
    const token = sent.inviteUrl.slice(INVITE_URL_PREFIX.length)
    expect(await WorkspaceInvitationModel.findOne({invitationId: sent.invitationId}).lean()).toMatchObject({
      invitedByAuthority: "organization_admin",
      invitedByMembershipId: null,
      invitedByMentraUserId: s.mentraUserId,
      invitedByEmail: OPS_ADMIN_EMAIL,
    })
    expect(await peekInvitation(token)).not.toBeNull()

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    const row = (await WorkspaceInvitationModel.findOne({invitationId: sent.invitationId}).lean())!
    expect(row).toMatchObject({status: "revoked", invitedByMentraUserId: null, invitedByEmail: null})
    const revocation = await WorkspaceAuditEventModel.findOne({
      action: "invitation.revoked",
      "target.invitationId": sent.invitationId,
    }).lean()
    expect(revocation).toMatchObject({
      workspaceId: s.elsewhere.workspaceId,
      actor: {kind: "user", mentraUserId: s.mentraUserId},
      target: {invitationId: sent.invitationId, email: "heir@example.test"},
      after: {status: "revoked", reason: "inviter_account_deleted"},
    })
    expect(await peekInvitation(token)).toBeNull()
    const refused = await acceptInvitation(
      {kind: "user", mentraUserId: "mu_heir", email: "heir@example.test", emailVerified: true, isOrganizationAdmin: false},
      token,
    ).catch(err => err)
    expect({code: refused.code, status: refused.status}).toEqual({code: "invitation_not_found", status: 404})
    // The membership-sent invitation and the one to the person's own address behave as before.
    expect((await WorkspaceInvitationModel.findOne({invitationId: s.sentInvitationId}).lean())!.status).toBe("revoked")
    expect((await WorkspaceInvitationModel.findOne({invitationId: s.receivedInvitationId}).lean())!.status).toBe("pending")
  })

  test("the person's identity is cleared from every credential they created or had a service issue", async () => {
    const s = await scenario()
    const operatorKey = await createOperatorKey(
      {kind: "user", mentraUserId: s.mentraUserId, email: OPS_ADMIN_EMAIL, emailVerified: true, isOrganizationAdmin: true},
      {name: "Incident fetcher", scopes: ["organization.incidents.read"]},
    )
    const mine = [s.teamKey, s.soloKey, operatorKey].map(key => key.credential.credentialId)
    expect(
      await AccessCredentialModel.countDocuments({credentialId: {$in: mine}, createdByMentraUserId: s.mentraUserId}),
    ).toBe(3)

    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    for (const credentialId of mine) {
      const row = (await AccessCredentialModel.findOne({credentialId}).lean())!
      expect({credentialId, revoked: row.revokedAt instanceof Date, by: row.createdByMentraUserId, email: row.createdByEmail}).toEqual({
        credentialId,
        revoked: true,
        by: null,
        email: null,
      })
    }
    // The Store's key stays the workspace's and keeps working, without the person's address.
    const storeKey = (await AccessCredentialModel.findOne({credentialId: s.storeKey.credential.credentialId}).lean())!
    expect({revokedAt: storeKey.revokedAt, email: storeKey.createdByEmail, service: storeKey.issuedByService}).toEqual({
      revokedAt: null,
      email: null,
      service: "store",
    })
    expect(await validateCredentialToken(s.storeKey.token)).toMatchObject({credentialId: s.storeKey.credential.credentialId})
    // Another member's key keeps its creator.
    expect(await AccessCredentialModel.findOne({credentialId: s.othersKey.credential.credentialId}).lean()).toMatchObject({
      createdByMentraUserId: "mu_other",
      createdByEmail: "mu_other@example.test",
    })
    // No credential row holds the person's address any more; the audit trail keeps what it recorded.
    const rows = await AccessCredentialModel.find({}).lean()
    expect(JSON.stringify(rows)).not.toContain(s.email)
    expect(JSON.stringify(rows)).not.toContain(s.mentraUserId)
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

  test("workspace access is gone before the account directory is asked; with the directory down, Core finishes the deletion later", async () => {
    const s = await scenario()
    idp.outage = true

    // Accepted: the deletion is recorded, and the person never has to come back.
    await confirmAccountDeletion(s.mentraUserId, s.tenantUserId, await deletionCode(s.tenantUserId))

    expect(await listWorkspacesForUser(s.mentraUserId)).toEqual([])
    expect(await validateCredentialToken(s.teamKey.token)).toBeNull()
    expect((await UserModel.findOne({mentraUserId: s.mentraUserId}).lean())?.accountDeletionCompletedAt).toBeNull()
    expect(await finishPendingAccountDeletions()).toEqual({completed: [], failed: [s.mentraUserId]})

    // The directory answers again: the next sweep deletes the account there and records completion.
    idp.outage = false
    expect(await accountExists(s.tenantUserId)).toBe(true)
    expect(await finishPendingAccountDeletions()).toEqual({completed: [s.mentraUserId], failed: []})
    expect(await accountExists(s.tenantUserId)).toBe(false)
    expect((await UserModel.findOne({mentraUserId: s.mentraUserId}).lean())?.accountDeletionCompletedAt).toBeInstanceOf(Date)
    // Nothing was ended twice.
    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.removed"})).toBe(2)
  })

  test("two concurrent confirmations and the sweep finish the deletion once", async () => {
    const s = await scenario()
    const [first, second] = [await deletionCode(s.tenantUserId), await deletionCode(s.tenantUserId)]

    const results = await Promise.allSettled([
      confirmAccountDeletion(s.mentraUserId, s.tenantUserId, first),
      confirmAccountDeletion(s.mentraUserId, s.tenantUserId, second),
      finishPendingAccountDeletions(),
    ])

    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
    expect(await accountExists(s.tenantUserId)).toBe(false)
    const user = (await UserModel.findOne({mentraUserId: s.mentraUserId}).lean())!
    expect(user.supportTelemetryDeletedAt).toBeInstanceOf(Date)
    expect(user.accountDeletionCompletedAt).toBeInstanceOf(Date)
    // Each membership ended once, and each of its keys was revoked once.
    const removed = await WorkspaceAuditEventModel.find({action: "membership.removed"}).lean()
    expect(removed).toHaveLength(2)
    expect(removed.flatMap(event => (event.after as {revokedCredentialIds: string[]}).revokedCredentialIds).sort()).toEqual(
      [s.teamKey.credential.credentialId, s.soloKey.credential.credentialId].sort(),
    )
    for (const key of [s.teamKey, s.soloKey]) expect(await validateCredentialToken(key.token)).toBeNull()
    expect((await WorkspaceInvitationModel.findOne({invitationId: s.sentInvitationId}).lean())!.status).toBe("revoked")
    expect(await finishPendingAccountDeletions()).toEqual({completed: [], failed: []})
  })

  test("a deleted account's membership left behind by an interrupted deletion is ended by the sweep", async () => {
    const s = await scenario()
    // A confirmation that stopped right after setting the tombstone.
    await UserModel.updateOne({mentraUserId: s.mentraUserId}, {$set: {supportTelemetryDeletedAt: new Date()}})
    expect(await countActiveOwners(s.solo.workspaceId)).toBe(0)
    expect((await WorkspaceMembershipModel.findOne({membershipId: s.soloMembershipId}).lean())!.status).toBe("active")

    expect(await finishPendingAccountDeletions()).toEqual({completed: [s.mentraUserId], failed: []})

    for (const membershipId of [s.teamMembershipId, s.soloMembershipId]) {
      expect((await WorkspaceMembershipModel.findOne({membershipId}).lean())).toMatchObject({
        status: "ended",
        endedReason: "account_deleted",
      })
    }
    expect(await accountExists(s.tenantUserId)).toBe(false)
  })
})

describe("removeDeletedUserFromWorkspaces", () => {
  test("a second run ends nothing more and records nothing, the tombstone included", async () => {
    const s = await scenario()

    expect((await removeDeletedUserFromWorkspaces(s.mentraUserId)).endedMembershipIds.sort()).toEqual(
      [s.teamMembershipId, s.soloMembershipId].sort(),
    )
    const eventsAfterFirst = await WorkspaceAuditEventModel.countDocuments({})
    const revisions = await Promise.all([s.team, s.solo].map(async w => (await getWorkspace(w.workspaceId))!))

    expect(await removeDeletedUserFromWorkspaces(s.mentraUserId)).toEqual({
      endedMembershipIds: [],
      revokedInvitationIds: [],
      revokedOperatorKeyIds: [],
    })

    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(eventsAfterFirst)
    for (const previous of revisions) {
      expect((await getWorkspace(previous.workspaceId))!.authorizationRevision).toBe(previous.authorizationRevision)
    }
  })

  test("a person with no active membership changes no workspace and records only the tombstone", async () => {
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
          result: {endedMembershipIds: [], revokedInvitationIds: [], revokedOperatorKeyIds: []},
        })
      }
      // Each has a tombstone to record, which takes a transaction of its own.
      expect(startSession).toHaveBeenCalledTimes(3)

      // Someone with a membership goes through one transaction, tombstone included.
      startSession.mockClear()
      const {mentraUserId: member} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-member"})
      const membershipId = await addMember(team.workspaceId, {mentraUserId: member, role: "member"})
      expect(await removeDeletedUserFromWorkspaces(member)).toEqual({
        endedMembershipIds: [membershipId],
        revokedInvitationIds: [],
        revokedOperatorKeyIds: [],
      })
      expect(startSession).toHaveBeenCalledTimes(1)

      // Running it again changes nothing, and does not even open a transaction.
      startSession.mockClear()
      for (const mentraUserId of [lonely, former, "mu_never_seen", member]) await removeDeletedUserFromWorkspaces(mentraUserId)
      expect(startSession).not.toHaveBeenCalled()
    } finally {
      startSession.mockRestore()
    }
    // The three tombstones, the member's removal and the member's tombstone: nothing else was recorded.
    const added = await WorkspaceAuditEventModel.find({}).sort({seq: 1}).lean()
    expect(added.slice(eventsBefore).map(event => event.action)).toEqual([
      "user.deleted",
      "user.deleted",
      "user.deleted",
      "membership.removed",
      "user.deleted",
    ])
    expect((await getWorkspace(team.workspaceId))!.authorizationRevision).toBe(revision + 1)
  })

  test("an active membership left in a deleted workspace still ends", async () => {
    const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-stray"})
    const gone = await createWorkspace(actor("mu_owner"), {name: "Gone"})
    const membershipId = await addMember(gone.workspaceId, {mentraUserId, role: "developer"})
    await WorkspaceModel.updateOne({workspaceId: gone.workspaceId}, {$set: {status: "deleted", deletedAt: new Date()}})

    expect(await removeDeletedUserFromWorkspaces(mentraUserId)).toEqual({
      endedMembershipIds: [membershipId],
      revokedInvitationIds: [],
      revokedOperatorKeyIds: [],
    })

    expect(await WorkspaceMembershipModel.findOne({membershipId}).lean()).toMatchObject({
      status: "ended",
      endedReason: "account_deleted",
    })
  })

  test("records user.deleted last, after the membership.removed events of the same deletion, on the change feed", async () => {
    const s = await scenario()
    const {events: before} = await listChanges({})

    await removeDeletedUserFromWorkspaces(s.mentraUserId)

    const {events, next} = await listChanges({after: String(before.at(-1)!.seq)})
    expect(events.map(event => event.action)).toEqual(["membership.removed", "membership.removed", "user.deleted"])
    expect(events.slice(0, 2).map(event => event.workspaceId).sort()).toEqual(
      [s.team.workspaceId, s.solo.workspaceId].sort(),
    )
    // Strictly increasing: the tombstone follows both removals in the feed's own order.
    expect(events[0]!.seq).toBeLessThan(events[1]!.seq)
    expect(events[1]!.seq).toBeLessThan(events[2]!.seq)
    expect(events.at(-1)).toMatchObject({
      workspaceId: null,
      action: "user.deleted",
      target: {mentraUserId: s.mentraUserId},
      before: null,
      after: null,
    })
    expect(next).toBeNull()
    const tombstone = (await WorkspaceAuditEventModel.findOne({action: "user.deleted"}).lean())!
    expect(tombstone.actor).toMatchObject({kind: "user", mentraUserId: s.mentraUserId})
  })

  test("a person in no workspace still gets a tombstone, and only one however often or at once it runs", async () => {
    const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-nobody"})

    await Promise.all([removeDeletedUserFromWorkspaces(mentraUserId), removeDeletedUserFromWorkspaces(mentraUserId)])
    await removeDeletedUserFromWorkspaces(mentraUserId)

    const {events} = await listChanges({})
    expect(events.map(event => [event.action, event.workspaceId, event.target])).toEqual([
      ["user.deleted", null, {mentraUserId}],
    ])
  })

  test("concurrent runs for a person in workspaces end each membership once and record one tombstone", async () => {
    const s = await scenario()

    await Promise.all([removeDeletedUserFromWorkspaces(s.mentraUserId), removeDeletedUserFromWorkspaces(s.mentraUserId)])

    expect(await WorkspaceAuditEventModel.countDocuments({action: "membership.removed"})).toBe(2)
    expect(await WorkspaceAuditEventModel.countDocuments({action: "user.deleted"})).toBe(1)
  })

  test("the tombstone is the deletion's last write, in its transaction: if it cannot be written, nothing is ended", async () => {
    const s = await scenario()
    const events = await WorkspaceAuditEventModel.countDocuments({})
    const create = WorkspaceAuditEventModel.create.bind(WorkspaceAuditEventModel) as (...args: any[]) => Promise<unknown>
    const failing = spyOn(WorkspaceAuditEventModel, "create").mockImplementation(((docs: any, options: any) => {
      if (docs?.[0]?.action === "user.deleted") return Promise.reject(new Error("tombstone write failed"))
      return create(docs, options)
    }) as any)
    try {
      await expect(removeDeletedUserFromWorkspaces(s.mentraUserId)).rejects.toThrow("tombstone write failed")
    } finally {
      failing.mockRestore()
    }

    // The failure rolled back the memberships it had ended before it, and their events.
    for (const membershipId of [s.teamMembershipId, s.soloMembershipId]) {
      expect((await WorkspaceMembershipModel.findOne({membershipId}).lean())!.status).toBe("active")
    }
    expect((await WorkspaceInvitationModel.findOne({invitationId: s.sentInvitationId}).lean())!.status).toBe("pending")
    expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)
    const counter = await WorkspaceAuditCounterModel.findOne({}).lean()
    expect((await listChanges({limit: 500})).events.at(-1)?.seq).toBe(counter?.seq)
  })

  /**
   * The driver and the Mongoose class that carries queries, taken from the connection under test (`mongoose`
   * itself is not a dependency of this folder).
   */
  const mongoose = WorkspaceModel.base
  const driver = mongoose.mongo

  /**
   * Make a command a session sends fail with `error`, as the server answers a command of a transaction: the
   * driver's real `withTransaction` aborts and rethrows it, and Core's rewraps what it recognizes. By default
   * the first command fails; with `model`, the commands on that model's collection do (the earlier ones run).
   * Returns how many commands failed.
   */
  function failFirstTransactionCommand(error: Error, model?: unknown) {
    const exec = mongoose.Query.prototype.exec
    let failed = 0
    const spy = spyOn(mongoose.Query.prototype, "exec").mockImplementation(function (this: any, ...args: any[]) {
      if (!this.getOptions().session || (model !== undefined && this.model !== model)) return exec.apply(this, args)
      failed += 1
      return Promise.reject(error)
    } as any)
    return {sent: () => failed, restore: () => spy.mockRestore()}
  }

  /**
   * What Azure Cosmos DB for MongoDB (RU, API 4.2) answers the write that touches a transaction's second
   * collection (probed on the CI account): code 2, no error labels, and this text (the tail after the
   * message body is abbreviated).
   */
  const cosmosSecondCollection = (overrides: Record<string, unknown> = {}) =>
    new driver.MongoServerError({
      message:
        "Error=2, Details='Response status code does not indicate success: BadRequest (400); Substatus: 1101; " +
        'ActivityId: 0b9d3a52-6a38-4f0e-9c1d-5c0e3f8a7e21; Reason: (Message: {"Errors":["Transaction is not active"]}\r\n' +
        "ActivityId: 0b9d3a52-6a38-4f0e-9c1d-5c0e3f8a7e21, Request URI: /apps/.../partitions/..., RequestStats: ...)'",
      code: 2,
      errorLabels: [],
      ...overrides,
    })

  /** A standalone mongod's answer to the first command of a transaction (code 20, `IllegalOperation`). */
  const standaloneMongod = () =>
    new driver.MongoServerError({
      message: "Transaction numbers are only allowed on a replica set member or mongos",
      code: 20,
      codeName: "IllegalOperation",
    })

  describe("on a database that cannot run transactions", () => {
    test("a standalone mongod: a person with no workspace state still gets a tombstone, written without one", async () => {
      const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-no-transactions"})
      const failing = failFirstTransactionCommand(standaloneMongod())
      try {
        expect(await removeDeletedUserFromWorkspaces(mentraUserId)).toEqual({
          endedMembershipIds: [],
          revokedInvitationIds: [],
          revokedOperatorKeyIds: [],
        })
        // A second run finds the first one's tombstone and has no transaction to attempt.
        await removeDeletedUserFromWorkspaces(mentraUserId)
        expect(failing.sent()).toBe(1)
      } finally {
        failing.restore()
      }

      const {events} = await listChanges({})
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({seq: 1, workspaceId: null, action: "user.deleted", target: {mentraUserId}})
    })

    test("Azure Cosmos DB for MongoDB: the second collection's write fails, and the tombstone is written without a transaction", async () => {
      const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-cosmos"})
      // The transaction's read of the audit events (one collection) runs; the counter's write (the second) fails.
      const failing = failFirstTransactionCommand(cosmosSecondCollection(), WorkspaceAuditCounterModel)
      try {
        expect(await removeDeletedUserFromWorkspaces(mentraUserId)).toEqual({
          endedMembershipIds: [],
          revokedInvitationIds: [],
          revokedOperatorKeyIds: [],
        })
        await removeDeletedUserFromWorkspaces(mentraUserId)
        expect(failing.sent()).toBe(1)
      } finally {
        failing.restore()
      }

      const {events} = await listChanges({})
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({seq: 1, workspaceId: null, action: "user.deleted", target: {mentraUserId}})
    })

    test("the recognized path is routine, so it is logged at info without the database's error, never as a warning", async () => {
      // The logger is the service's own, so the deletions run in a process of their own, with the real logger
      // writing JSON, against this test's database. In it the transactions fail as they do on each kind of
      // database that cannot run them (the first command of a standalone mongod, the counter's write on Cosmos).
      const root = new URL("..", import.meta.url).pathname
      const script = `
        import {connectMongo, disconnectMongo} from ${JSON.stringify(`${root}packages/core/src/connections/mongo.connection`)}
        import {WorkspaceAuditCounterModel} from ${JSON.stringify(`${root}packages/core/src/models/workspace-audit-counter.model`)}
        import {removeDeletedUserFromWorkspaces} from ${JSON.stringify(`${root}packages/core/src/services/workspaces/account-deletion.service`)}
        const mongoose = WorkspaceAuditCounterModel.base
        const failures = [
          [null, new mongoose.mongo.MongoServerError({message: "Transaction numbers are only allowed on a replica set member or mongos", code: 20})],
          [WorkspaceAuditCounterModel, new mongoose.mongo.MongoServerError({
            message: "Error=2, Details='Response status code does not indicate success: BadRequest (400); Substatus: 1101; Reason: (Message: {\\"Errors\\":[\\"Transaction is not active\\"]})'",
            code: 2,
            errorLabels: [],
          })],
        ]
        await connectMongo(${JSON.stringify(databaseUrl)})
        const exec = mongoose.Query.prototype.exec
        for (const [index, [model, error]] of failures.entries()) {
          mongoose.Query.prototype.exec = function (...args) {
            if (!this.getOptions().session || (model && this.model !== model)) return exec.apply(this, args)
            return Promise.reject(error)
          }
          await removeDeletedUserFromWorkspaces("mu_log_check_" + index)
        }
        mongoose.Query.prototype.exec = exec
        await disconnectMongo()
      `
      const child = Bun.spawn([process.execPath, "-e", script], {
        env: {...process.env, LOG_STDOUT_JSON: "true", LOG_LEVEL: "debug"},
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect([code, stderr]).toEqual([0, ""])

      const lines = stdout
        .split("\n")
        .filter(line => line.startsWith("{"))
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(line => line.service === "account-deletion")
      expect(lines.map(line => [line.level, line.mentraUserId, line.reason])).toEqual([
        ["info", "mu_log_check_0", "transactions_unsupported"],
        ["info", "mu_log_check_1", "cross_collection_transaction_unsupported"],
      ])
      // The database's own error text is not repeated on every deletion.
      expect(lines.every(line => !("err" in line))).toBe(true)
      // Both tombstones were written.
      expect(await WorkspaceAuditEventModel.countDocuments({action: "user.deleted"})).toBe(2)
    })

    test("Azure Cosmos DB for MongoDB: a person with workspace state is not ended half way either", async () => {
      const s = await scenario()
      const events = await WorkspaceAuditEventModel.countDocuments({})
      const failing = failFirstTransactionCommand(cosmosSecondCollection(), WorkspaceAuditCounterModel)
      try {
        const err = await removeDeletedUserFromWorkspaces(s.mentraUserId).then(
          () => null,
          (caught: unknown) => caught,
        )
        expect(err).toBeInstanceOf(driver.MongoServerError)
      } finally {
        failing.restore()
      }

      expect((await WorkspaceMembershipModel.findOne({membershipId: s.teamMembershipId}).lean())!.status).toBe("active")
      expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)
      expect(await WorkspaceAuditEventModel.countDocuments({action: "user.deleted"})).toBe(0)
    })

    test("a topology without sessions is recognized before any command is sent", async () => {
      const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: "sb-no-sessions"})
      const startSession = spyOn(WorkspaceModel.db, "startSession").mockRejectedValue(
        new driver.MongoCompatibilityError("Current topology does not support sessions"),
      )
      try {
        await removeDeletedUserFromWorkspaces(mentraUserId)
      } finally {
        startSession.mockRestore()
      }

      expect((await listChanges({})).events.map(event => [event.seq, event.action])).toEqual([[1, "user.deleted"]])
    })

    test("a person with workspace state is not ended half way: the deletion fails and nothing changes", async () => {
      const s = await scenario()
      const events = await WorkspaceAuditEventModel.countDocuments({})
      const failing = failFirstTransactionCommand(standaloneMongod())
      try {
        const err = await removeDeletedUserFromWorkspaces(s.mentraUserId).then(
          () => null,
          (caught: unknown) => caught as Error,
        )
        expect(err?.message).toMatch(/replica set/i)
      } finally {
        failing.restore()
      }

      expect((await WorkspaceMembershipModel.findOne({membershipId: s.teamMembershipId}).lean())!.status).toBe("active")
      expect(await WorkspaceAuditEventModel.countDocuments({})).toBe(events)
      expect(await WorkspaceAuditEventModel.countDocuments({action: "user.deleted"})).toBe(0)
    })
  })

  describe("on a replica set, a transaction that fails for any other reason", () => {
    // What is left once `withTransaction` has used its retries (it retries labeled transient errors for two
    // minutes): a time limit, a failover with no primary, a dropped connection.
    const failures = () => [
      ["a time limit", new driver.MongoServerError({message: "operation exceeded time limit", code: 50, codeName: "MaxTimeMSExpired"})],
      ["no server to select", new driver.MongoServerSelectionError("Server selection timed out after 30000 ms", {} as any)],
      ["a dropped connection", new driver.MongoNetworkError("connection 3 to 127.0.0.1:27017 closed")],
      ["a look-alike without the standalone code", Object.assign(new Error("Transaction numbers are only allowed on a replica set member or mongos"), {code: 11000})],
      // Code 2 without the whole Cosmos signature is any other server error, not "transactions unsupported".
      ["code 2 with another message", new driver.MongoServerError({message: "BadValue: unknown operator", code: 2})],
      ["code 2 with only Transaction is not active", cosmosSecondCollection({message: "Error=2, Details='Transaction is not active'"})],
      ["code 2 with only Substatus 1101", cosmosSecondCollection({message: "Error=2, Details='BadRequest (400); Substatus: 1101'"})],
      ["the Cosmos text under another code", cosmosSecondCollection({code: 112})],
      ["the Cosmos text on a plain Error", Object.assign(new Error(cosmosSecondCollection().message), {code: 2})],
    ] as const

    test("propagates, and writes no tombstone outside the transaction, so a poller cannot pass it", async () => {
      for (const [reason, error] of failures()) {
        const {mentraUserId} = await findOrCreateUser({tenantId: "mentra", tenantUserId: `sb-transient-${counter++}`})
        const eventsBefore = await WorkspaceAuditEventModel.countDocuments({})
        const counterBefore = (await WorkspaceAuditCounterModel.findOne({}).lean())?.seq ?? 0
        const failing = failFirstTransactionCommand(error)
        try {
          const thrown = await removeDeletedUserFromWorkspaces(mentraUserId).then(
            () => null,
            (caught: unknown) => caught,
          )
          expect({reason, thrown}).toEqual({reason, thrown: error})
          expect(failing.sent()).toBe(1)
        } finally {
          failing.restore()
        }

        // No event, and the counter did not move: nothing was written, in or out of a transaction.
        expect({reason, events: await WorkspaceAuditEventModel.countDocuments({})}).toEqual({reason, events: eventsBefore})
        expect({reason, seq: (await WorkspaceAuditCounterModel.findOne({}).lean())?.seq ?? 0}).toEqual({
          reason,
          seq: counterBefore,
        })

        // The sweep's retry then records it, in a transaction, with the next number.
        await removeDeletedUserFromWorkspaces(mentraUserId)
        const tombstones = await WorkspaceAuditEventModel.find({action: "user.deleted", "target.mentraUserId": mentraUserId}).lean()
        expect({reason, seqs: tombstones.map(event => event.seq)}).toEqual({reason, seqs: [counterBefore + 1]})
      }
    })
  })

  test("refuses a blank user id rather than matching rows by a missing id", async () => {
    for (const blank of ["", "  "]) {
      await expect(removeDeletedUserFromWorkspaces(blank)).rejects.toThrow("mentraUserId is required")
    }
  })
})
