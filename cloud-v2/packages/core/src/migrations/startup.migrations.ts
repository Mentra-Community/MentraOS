/**
 * Startup migrations that keep early Cloud V2 dev databases compatible with
 * current schemas. These are intentionally narrow and idempotent.
 */

import mongoose from "mongoose";
import { createLogger } from "@mentra/cloud-shared";
import { RefreshTokenModel } from "../models/refresh-token.model";
import { UserModel } from "../models/user.model";

const logger = createLogger("core").child({ component: "startup-migrations" });

const USERS_COLLECTION = "users";
const LEGACY_USER_IDENTITY_INDEX = "oemId_1_oemUserId_1";

type DuplicateUserGroup = {
  _id: {
    tenantId: string;
    tenantUserId: string;
  };
  users: Array<{
    _id: mongoose.Types.ObjectId;
    mentraUserId: string;
  }>;
  count: number;
};

export async function runStartupMigrations(): Promise<void> {
  await backfillLegacyUserIdentityFields();
  await dropLegacyUserIdentityIndex();
  await dedupeUserIdentityRows();
  await UserModel.createIndexes();
}

async function backfillLegacyUserIdentityFields(): Promise<void> {
  const collection = mongoose.connection.collection(USERS_COLLECTION);
  const result = await collection.updateMany(
    {
      tenantId: { $exists: false },
      tenantUserId: { $exists: false },
      oemId: { $type: "string" },
      oemUserId: { $type: "string" },
    },
    [
      {
        $set: {
          tenantId: "$oemId",
          tenantUserId: "$oemUserId",
        },
      },
    ],
  );

  if (result.modifiedCount > 0) {
    logger.info(
      { collection: USERS_COLLECTION, modifiedCount: result.modifiedCount },
      "backfilled legacy user identity fields",
    );
  }
}

async function dropLegacyUserIdentityIndex(): Promise<void> {
  const collection = mongoose.connection.collection(USERS_COLLECTION);
  const indexes = await collection.indexes();
  const hasLegacyIndex = indexes.some(
    (index) => index.name === LEGACY_USER_IDENTITY_INDEX,
  );

  if (!hasLegacyIndex) return;

  await collection.dropIndex(LEGACY_USER_IDENTITY_INDEX);
  logger.info(
    { collection: USERS_COLLECTION, index: LEGACY_USER_IDENTITY_INDEX },
    "dropped legacy user identity index",
  );
}

async function dedupeUserIdentityRows(): Promise<void> {
  const collection = mongoose.connection.collection(USERS_COLLECTION);
  const duplicateGroups = await collection
    .aggregate<DuplicateUserGroup>([
      {
        $match: {
          tenantId: { $type: "string" },
          tenantUserId: { $type: "string" },
        },
      },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: { tenantId: "$tenantId", tenantUserId: "$tenantUserId" },
          users: { $push: { _id: "$_id", mentraUserId: "$mentraUserId" } },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  let deletedCount = 0;
  let updatedRefreshTokenCount = 0;

  for (const group of duplicateGroups) {
    const [keeper, ...duplicates] = group.users;
    if (!keeper || duplicates.length === 0) continue;

    const duplicateUserIds = duplicates.map((user) => user.mentraUserId);
    const refreshUpdate = await RefreshTokenModel.updateMany(
      { mentraUserId: { $in: duplicateUserIds } },
      { $set: { mentraUserId: keeper.mentraUserId } },
    );
    updatedRefreshTokenCount += refreshUpdate.modifiedCount;

    const deleteResult = await collection.deleteMany({
      _id: { $in: duplicates.map((user) => user._id) },
    });
    deletedCount += deleteResult.deletedCount ?? 0;
  }

  if (duplicateGroups.length > 0) {
    logger.warn(
      {
        collection: USERS_COLLECTION,
        duplicateGroups: duplicateGroups.length,
        deletedCount,
        updatedRefreshTokenCount,
      },
      "deduped user identity rows before ensuring current unique index",
    );
  }
}
