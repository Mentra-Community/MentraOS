import mongoose from "mongoose"
import {createLogger} from "@mentra/cloud-shared"
import {OemModel} from "../models/oem.model"
import {RefreshTokenModel} from "../models/refresh-token.model"
import {UserModel} from "../models/user.model"

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
  await RefreshTokenModel.createIndexes()
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
