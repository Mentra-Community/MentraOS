import mongoose from "mongoose"
import {createLogger} from "@mentra/cloud-shared"
import {OemModel} from "../models/oem.model"
import {RefreshTokenModel} from "../models/refresh-token.model"
import {UserModel} from "../models/user.model"
import {TestHostStateModel} from "../models/test-host-state.model"
import {TestRerunModel} from "../models/test-rerun.model"
import {TestRequestModel} from "../models/test-request.model"
import {RoutineDefinitionModel} from "../models/routine-definition.model"
import {RoutinePreferenceModel} from "../models/routine-preference.model"
import {backfillTestSuiteStartedAt, TestSuiteModel} from "../models/test-suite.model"
import {reconcileTestRunIndexes, TestAssetModel, TestRunModel} from "../models/test-run.model"
import {TestDispatchModel} from "../models/test-dispatch.model"
import {TestHostLatestModel, TestHostSampleModel} from "../models/test-host-health.model"
import {ReportModel} from "../models/report.model"
import {ReportAssetModel} from "../models/report-asset.model"
import {AccessCredentialModel} from "../models/access-credential.model"
import {IdentityLinkModel} from "../models/identity-link.model"
import {WorkspaceAuditCounterModel} from "../models/workspace-audit-counter.model"
import {WorkspaceAuditEventModel} from "../models/workspace-audit-event.model"
import {WorkspaceInvitationModel} from "../models/workspace-invitation.model"
import {WorkspaceMembershipModel} from "../models/workspace-membership.model"
import {WorkspaceModel} from "../models/workspace.model"
import {convertLegacyAdminKeys} from "../services/workspaces/legacy-admin-keys"

const logger = createLogger("core").child({component: "startup-migrations"})
const USERS = "users"
const REFRESH_TOKENS = "refreshTokens"

type DuplicateUserGroup = {
  _id: {tenantId: string; tenantUserId: string}
  users: Array<{_id: mongoose.Types.ObjectId; mentraUserId: string; createdAt?: Date}>
  count: number
}

export async function runStartupMigrations(): Promise<void> {
  await backfillLegacyUserIdentityFields()
  await backfillLegacyRefreshTokenTenant()
  await dropLegacyUserIdentityIndex()
  await dedupeUserIdentityRows()
  await UserModel.createIndexes()
  // prevTokenHash recovery-lookup index (OS-1703). Idempotent; sparse.
  await RefreshTokenModel.createIndexes()
  // Immutable run/asset insertion relies on these uniqueness constraints before serving requests.
  await TestHostStateModel.createIndexes()
  await TestRequestModel.createIndexes()
  // Batch successor claims must be unique before admitting any linked rerun.
  await TestRerunModel.createIndexes()
  // Existing definitions were ordinary enrollments. Candidate metadata is explicit from this rollout onward.
  await RoutineDefinitionModel.updateMany({ordinaryEnrolledAt: {$exists: false}, candidateBindings: {$exists: false}},
    [{$set: {ordinaryEnrolledAt: "$createdAt"}}])
  await RoutineDefinitionModel.createIndexes()
  await RoutinePreferenceModel.createIndexes()
  await reconcileTestRunIndexes()
  await TestRunModel.createIndexes()
  await backfillTestSuiteStartedAt()
  await TestSuiteModel.createIndexes()
  await TestAssetModel.createIndexes()
  // Native incident creation and shared diagnostic references must dedupe before completion ACK.
  await ReportModel.createIndexes()
  await ReportAssetModel.createIndexes()
  // No device execution grant is safe until request IDs are unique across all Core instances.
  // The send receipt must be unique before any admin can submit a device request.
  await TestDispatchModel.createIndexes()
  // Passive host observations require idempotent identity and indexed, expiring history before ingestion.
  await TestHostSampleModel.createIndexes()
  await TestHostLatestModel.createIndexes()
  // Workspaces rely on unique indexes (one active membership per person, one identity link per
  // account, gap-free audit sequence numbers). Build them, and their collections, before serving:
  // autoIndex runs in the background and a failed build would only be logged, and a request in the
  // first moments after boot must not create a collection inside a transaction.
  await Promise.all(
    [
      WorkspaceModel,
      WorkspaceMembershipModel,
      WorkspaceInvitationModel,
      AccessCredentialModel,
      WorkspaceAuditEventModel,
      WorkspaceAuditCounterModel,
      IdentityLinkModel,
    ].map(async model => {
      await model.createCollection()
      await model.createIndexes()
    }),
  )
  // Allowlisted admin API keys keep working as operator keys, before any request is served.
  await convertLegacyAdminKeys()
  await ensureMentraAccountOem()
}

async function ensureMentraAccountOem(): Promise<void> {
  const pubB64 = process.env.MENTRA_ACCOUNT_JWT_PUBLIC_KEY?.trim()
  if (!pubB64) {
    logger.warn("MENTRA_ACCOUNT_JWT_PUBLIC_KEY not set; skipping mentra account OEM seed")
    return
  }
  await OemModel.updateOne(
    {tenantId: "mentra"},
    {$set: {displayName: "Mentra", publicKeyMode: "static", publicKey: `-----BEGIN PUBLIC KEY-----\n${pubB64}\n-----END PUBLIC KEY-----`, disabled: false}},
    {upsert: true},
  )
}

async function backfillLegacyUserIdentityFields(): Promise<void> {
  const result = await mongoose.connection.collection(USERS).updateMany(
    {tenantId: {$exists: false}, tenantUserId: {$exists: false}, oemId: {$type: "string"}, oemUserId: {$type: "string"}},
    [{$set: {tenantId: "$oemId", tenantUserId: "$oemUserId"}}],
  )
  if (result.modifiedCount) logger.info({modifiedCount: result.modifiedCount}, "backfilled legacy user identities")
}

async function backfillLegacyRefreshTokenTenant(): Promise<void> {
  const result = await mongoose.connection.collection(REFRESH_TOKENS).updateMany(
    {tenantId: {$exists: false}, oemId: {$type: "string"}},
    [{$set: {tenantId: "$oemId"}}],
  )
  if (result.modifiedCount) logger.info({modifiedCount: result.modifiedCount}, "backfilled legacy refresh-token tenants")
}

async function dropLegacyUserIdentityIndex(): Promise<void> {
  const collection = mongoose.connection.collection(USERS)
  try {
    if ((await collection.indexes()).some(index => index.name === "oemId_1_oemUserId_1")) {
      await collection.dropIndex("oemId_1_oemUserId_1")
    }
  } catch {
    // Fresh databases do not have the collection yet.
  }
}

async function dedupeUserIdentityRows(): Promise<void> {
  const collection = mongoose.connection.collection(USERS)
  const duplicateGroups = await collection
    .aggregate<DuplicateUserGroup>([
      {$match: {tenantId: {$type: "string"}, tenantUserId: {$type: "string"}}},
      {
        $group: {
          _id: {tenantId: "$tenantId", tenantUserId: "$tenantUserId"},
          users: {$push: {_id: "$_id", mentraUserId: "$mentraUserId", createdAt: "$createdAt"}},
          count: {$sum: 1},
        },
      },
      {$match: {count: {$gt: 1}}},
    ])
    .toArray()

  let deletedCount = 0
  let updatedRefreshTokenCount = 0

  for (const group of duplicateGroups) {
    // Sort each duplicate group in-process. Cosmos DB's Mongo API rejects the
    // former collection-wide {createdAt,_id} aggregation sort unless customers
    // manually provision a composite index, even for a fresh empty database.
    const [keeper, ...duplicates] = [...group.users].sort((left, right) => {
      const createdAtDelta = (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0)
      return createdAtDelta || left._id.toString().localeCompare(right._id.toString())
    })
    if (!keeper || duplicates.length === 0) continue

    const duplicateUserIds = duplicates.map(user => user.mentraUserId)
    const refreshUpdate = await RefreshTokenModel.updateMany(
      {mentraUserId: {$in: duplicateUserIds}},
      {$set: {mentraUserId: keeper.mentraUserId}},
    )
    updatedRefreshTokenCount += refreshUpdate.modifiedCount

    const deleteResult = await collection.deleteMany({_id: {$in: duplicates.map(user => user._id)}})
    deletedCount += deleteResult.deletedCount ?? 0
  }

  if (duplicateGroups.length > 0) {
    logger.warn(
      {collection: USERS, duplicateGroups: duplicateGroups.length, deletedCount, updatedRefreshTokenCount},
      "deduped user identity rows before ensuring current unique index",
    )
  }
}
