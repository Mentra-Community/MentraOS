/**
 * Startup migrations that keep early Cloud V2 dev databases compatible with
 * current schemas. These are intentionally narrow and idempotent.
 */

import mongoose from "mongoose";
import { createLogger } from "@mentra/cloud-shared";
import { DeveloperOrgModel } from "../models/developer-org.model";
import { DeveloperOrgMembershipModel } from "../models/developer-org-membership.model";
import { RefreshTokenModel } from "../models/refresh-token.model";
import { UserModel } from "../models/user.model";

const logger = createLogger("core").child({ component: "startup-migrations" });

const USERS_COLLECTION = "users";
const REFRESH_TOKENS_COLLECTION = "refreshTokens";
const LEGACY_USER_IDENTITY_INDEX = "oemId_1_oemUserId_1";
const DEVELOPER_ORG_MEMBERSHIPS_COLLECTION = "developer_org_memberships";
const LEGACY_MEMBERSHIP_EMAIL_INDEX = "orgId_1_email_1";

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
  await backfillLegacyRefreshTokenTenant();
  await dropLegacyUserIdentityIndex();
  await dedupeUserIdentityRows();
  await UserModel.createIndexes();
  await dropLegacyMembershipEmailIndex();
  await backfillDeveloperOrgOwners();
  await DeveloperOrgMembershipModel.createIndexes();
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

// Refresh tokens minted before the oemId -> tenantId rename still carry `oemId`
// and no `tenantId`. refreshSession requires `tenantId` (and now resolves the
// tenant against OEM/enterprise records), so without this backfill those
// sessions fail to refresh with "incomplete identity" until the client
// re-exchanges. Mirrors backfillLegacyUserIdentityFields and is idempotent.
async function backfillLegacyRefreshTokenTenant(): Promise<void> {
  const collection = mongoose.connection.collection(REFRESH_TOKENS_COLLECTION);
  const result = await collection.updateMany(
    {
      tenantId: { $exists: false },
      oemId: { $type: "string" },
    },
    [{ $set: { tenantId: "$oemId" } }],
  );

  if (result.modifiedCount > 0) {
    logger.info(
      { collection: REFRESH_TOKENS_COLLECTION, modifiedCount: result.modifiedCount },
      "backfilled legacy refresh token tenant id",
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

// Developer-org memberships were briefly keyed by (orgId, email) in early Cloud
// V2 dev; they are now keyed by (orgId, userId). Drop the stale unique index so
// the new one can take its place.
async function dropLegacyMembershipEmailIndex(): Promise<void> {
  const collection = mongoose.connection.collection(DEVELOPER_ORG_MEMBERSHIPS_COLLECTION);
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch {
    return; // collection does not exist yet
  }
  if (!indexes.some((index) => index.name === LEGACY_MEMBERSHIP_EMAIL_INDEX)) return;
  await collection.dropIndex(LEGACY_MEMBERSHIP_EMAIL_INDEX);
  logger.info(
    { collection: DEVELOPER_ORG_MEMBERSHIPS_COLLECTION, index: LEGACY_MEMBERSHIP_EMAIL_INDEX },
    "dropped legacy membership email index",
  );
}

// Ownership is a membership role now, not the DeveloperOrg.ownerUserId scalar.
// Seed each org's creator as an owner so existing orgs keep at least one owner
// once the scalar stops granting the role. Idempotent; skips orgs that already
// have an owner.
async function backfillDeveloperOrgOwners(): Promise<void> {
  const orgs = await DeveloperOrgModel.find({}, { orgId: 1, ownerUserId: 1 }).lean();
  let seeded = 0;
  for (const org of orgs) {
    if (!org.orgId || !org.ownerUserId) continue;
    const ownerCount = await DeveloperOrgMembershipModel.countDocuments({ orgId: org.orgId, role: "owner" });
    if (ownerCount > 0) continue;
    await DeveloperOrgMembershipModel.updateOne(
      { orgId: org.orgId, userId: org.ownerUserId },
      { $setOnInsert: { orgId: org.orgId, userId: org.ownerUserId, role: "owner" } },
      { upsert: true },
    );
    seeded += 1;
  }
  if (seeded > 0) {
    logger.info({ seeded }, "seeded developer-org creators as owners");
  }
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
