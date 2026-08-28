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
  users: Array<{_id: mongoose.Types.ObjectId; mentraUserId: string}>
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
  const groups = await collection.aggregate<DuplicateUserGroup>([
    {$match: {tenantId: {$type: "string"}, tenantUserId: {$type: "string"}}},
    {$sort: {createdAt: 1, _id: 1}},
    {$group: {_id: {tenantId: "$tenantId", tenantUserId: "$tenantUserId"}, users: {$push: {_id: "$_id", mentraUserId: "$mentraUserId"}}, count: {$sum: 1}}},
    {$match: {count: {$gt: 1}}},
  ]).toArray()
  for (const group of groups) {
    const [keeper, ...duplicates] = group.users
    if (!keeper || !duplicates.length) continue
    await RefreshTokenModel.updateMany(
      {mentraUserId: {$in: duplicates.map(user => user.mentraUserId)}},
      {$set: {mentraUserId: keeper.mentraUserId}},
    )
    await collection.deleteMany({_id: {$in: duplicates.map(user => user._id)}})
  }
}
