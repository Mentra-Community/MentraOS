/**
 * Startup migrations that keep early Cloud V2 dev databases compatible with
 * current schemas. These are intentionally narrow and idempotent.
 */

import mongoose from "mongoose";
import { createLogger } from "@mentra/cloud-shared";
import { WorkOS } from "@workos-inc/node";
import { DeveloperOrgModel } from "../models/developer-org.model";
import { DeveloperOrgInvitationModel } from "../models/developer-org-invitation.model";
import { DeveloperOrgMembershipModel } from "../models/developer-org-membership.model";
import { RefreshTokenModel } from "../models/refresh-token.model";
import { UserModel } from "../models/user.model";
import { OemModel } from "../models/oem.model";

const logger = createLogger("core").child({ component: "startup-migrations" });

const USERS_COLLECTION = "users";
const REFRESH_TOKENS_COLLECTION = "refreshTokens";
const LEGACY_USER_IDENTITY_INDEX = "oemId_1_oemUserId_1";
const DEVELOPER_ORG_MEMBERSHIPS_COLLECTION = "developer_org_memberships";
const LEGACY_MEMBERSHIP_EMAIL_INDEX = "orgId_1_email_1";
const LEGACY_SINGLE_ORG_MEMBERSHIP_INDEX = "userId_1";
const DEVELOPER_ORGS_COLLECTION = "developer_orgs";
const DEVELOPER_ORG_INVITATIONS_COLLECTION = "developer_org_invitations";
const LEGACY_INVITATION_EMAIL_INDEX = "orgId_1_email_1";

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
  // prevTokenHash recovery-lookup index (OS-1703). Idempotent; sparse.
  await RefreshTokenModel.createIndexes();
  await dropLegacyMembershipEmailIndex();
  await dropLegacySingleOrgMembershipIndex();
  await dedupeDeveloperOrgMemberships();
  // Build the unique index BEFORE any upserts so concurrent Core startups can't
  // race in duplicate (orgId,userId) rows.
  await safeCreateMembershipIndexes();
  await safeCreateInvitationIndexes();
  await backfillDeveloperOrgOwners();
  await backfillMembersFromWorkos();
  await ensureMentraAccountOem();
}

// Mentra's first-party account backend (issue 019) signs subject tokens that
// are verified through the normal OEM path, which needs a `mentra` oems row
// carrying the account signing public key (static mode). Idempotent upsert;
// skipped (non-fatal) if the account key env var is not configured yet.
async function ensureMentraAccountOem(): Promise<void> {
  const pubB64 = process.env.MENTRA_ACCOUNT_JWT_PUBLIC_KEY?.trim();
  if (!pubB64) {
    logger.warn("MENTRA_ACCOUNT_JWT_PUBLIC_KEY not set; skipping mentra account OEM seed");
    return;
  }
  const publicKey = `-----BEGIN PUBLIC KEY-----\n${pubB64}\n-----END PUBLIC KEY-----`;
  await OemModel.updateOne(
    { tenantId: "mentra" },
    {
      $set: { displayName: "Mentra", publicKeyMode: "static", publicKey, disabled: false },
    },
    { upsert: true },
  );
  logger.info("ensured mentra account OEM row");
}

// The invitation collection's (orgId,email) index moved to a partial-unique
// ("one pending invite per email"). Drop any plain legacy index first so the
// unique one can be built, then create indexes. Non-fatal.
async function safeCreateInvitationIndexes(): Promise<void> {
  const collection = mongoose.connection.collection(DEVELOPER_ORG_INVITATIONS_COLLECTION);
  try {
    const indexes = await collection.indexes();
    const legacy = indexes.find(
      (index) => index.name === LEGACY_INVITATION_EMAIL_INDEX && !index.partialFilterExpression,
    );
    if (legacy) {
      await collection.dropIndex(LEGACY_INVITATION_EMAIL_INDEX);
      logger.info({ collection: DEVELOPER_ORG_INVITATIONS_COLLECTION }, "dropped legacy invitation email index");
    }
  } catch {
    // collection may not exist yet
  }
  try {
    await DeveloperOrgInvitationModel.createIndexes();
  } catch (error) {
    logger.error(
      { collection: DEVELOPER_ORG_INVITATIONS_COLLECTION, error: (error as Error)?.message },
      "failed to create invitation indexes",
    );
  }
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
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch {
    return; // collection does not exist yet (fresh database)
  }
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

// The first Console implementation limited each user to one developer org with
// a unique userId index. Organization switching requires memberships in more
// than one org, while (orgId,userId) remains the authorization boundary.
async function dropLegacySingleOrgMembershipIndex(): Promise<void> {
  const collection = mongoose.connection.collection(DEVELOPER_ORG_MEMBERSHIPS_COLLECTION);
  let indexes;
  try {
    indexes = await collection.indexes();
  } catch {
    return;
  }
  const legacy = indexes.find(
    index => index.name === LEGACY_SINGLE_ORG_MEMBERSHIP_INDEX && index.unique === true,
  );
  if (!legacy) return;
  await collection.dropIndex(LEGACY_SINGLE_ORG_MEMBERSHIP_INDEX);
  logger.info(
    { collection: DEVELOPER_ORG_MEMBERSHIPS_COLLECTION, index: LEGACY_SINGLE_ORG_MEMBERSHIP_INDEX },
    "dropped legacy single-organization membership index",
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
    // Force the role to owner: if the creator somehow already has a non-owner
    // row (so ownerCount was 0), upgrade it rather than leaving the org ownerless.
    await DeveloperOrgMembershipModel.updateOne(
      { orgId: org.orgId, userId: org.ownerUserId },
      { $set: { role: "owner" }, $setOnInsert: { orgId: org.orgId, userId: org.ownerUserId } },
      { upsert: true },
    );
    seeded += 1;
  }
  if (seeded > 0) {
    logger.info({ seeded }, "seeded developer-org creators as owners");
  }
}

// During the email -> userId rekey, a user invited under two emails could end up
// with two membership rows sharing one userId. Collapse each (orgId, userId) to a
// single row (highest role wins) BEFORE the new unique index is built, so the
// index build can't fail and crash boot.
async function dedupeDeveloperOrgMemberships(): Promise<void> {
  const collection = mongoose.connection.collection(DEVELOPER_ORG_MEMBERSHIPS_COLLECTION);
  let groups;
  try {
    groups = await collection
      .aggregate([
        { $match: { orgId: { $type: "string" }, userId: { $type: "string" } } },
        {
          $group: {
            _id: { orgId: "$orgId", userId: "$userId" },
            docs: { $push: { id: "$_id", role: "$role" } },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();
  } catch {
    return; // collection does not exist yet
  }

  const rank: Record<string, number> = { owner: 3, admin: 2, member: 1 };
  let removed = 0;
  for (const group of groups) {
    const docs = (group.docs ?? []) as Array<{ id: mongoose.Types.ObjectId; role: string }>;
    const losers = [...docs]
      .sort((a, b) => (rank[b.role] ?? 0) - (rank[a.role] ?? 0))
      .slice(1)
      .map((doc) => doc.id);
    if (!losers.length) continue;
    const result = await collection.deleteMany({ _id: { $in: losers } });
    removed += result.deletedCount ?? 0;
  }

  if (removed > 0) {
    logger.warn(
      { collection: DEVELOPER_ORG_MEMBERSHIPS_COLLECTION, removed },
      "deduped duplicate developer-org membership rows",
    );
  }
}

// Membership moved from WorkOS into our DB. Seed the roster once from the
// existing WorkOS memberships (userId + email/name), preserving any roles we
// already assigned. A `membersMigratedAt` marker on the org is set ONLY after
// every page succeeds, so a mid-pagination failure retries on the next boot
// instead of getting stuck partially migrated. Best-effort per org; never fails boot.
async function backfillMembersFromWorkos(): Promise<void> {
  const apiKey = process.env.WORKOS_API_KEY;
  if (!apiKey) return;
  const workos = new WorkOS(apiKey);
  const orgsCollection = mongoose.connection.collection(DEVELOPER_ORGS_COLLECTION);
  const orgs = await orgsCollection
    .find(
      { workosOrgId: { $type: "string" }, membersMigratedAt: { $exists: false } },
      { projection: { orgId: 1, workosOrgId: 1 } },
    )
    .toArray();

  let seeded = 0;
  for (const org of orgs) {
    const orgId = org.orgId as string;
    const workosOrgId = org.workosOrgId as string;
    try {
      let after: string | undefined;
      do {
        const page = await workos.userManagement.listOrganizationMemberships({
          organizationId: workosOrgId,
          statuses: ["active", "inactive"],
          limit: 100,
          after,
        });
        for (const membership of page.data) {
          let email: string | null = null;
          let name: string | null = null;
          try {
            const user = await workos.userManagement.getUser(membership.userId);
            email = user.email ?? null;
            name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || null;
          } catch {
            // profile fetch is best-effort
          }
          await DeveloperOrgMembershipModel.updateOne(
            { orgId, userId: membership.userId },
            {
              $set: { ...(email ? { email } : {}), ...(name ? { name } : {}) },
              $setOnInsert: { orgId, userId: membership.userId, role: "member" },
            },
            { upsert: true },
          );
          seeded += 1;
        }
        after = page.listMetadata?.after ?? undefined;
      } while (after);
      // All pages succeeded — mark done so we don't re-scan WorkOS every boot.
      await orgsCollection.updateOne({ orgId }, { $set: { membersMigratedAt: new Date() } });
    } catch (error) {
      logger.warn({ orgId, error: (error as Error)?.message }, "member backfill failed for org");
    }
  }
  if (seeded > 0) {
    logger.info({ seeded }, "backfilled developer-org members from WorkOS");
  }
}

// Build the (orgId, userId) unique index without letting an unexpected failure
// crash Core boot — log loudly and continue. dedupeDeveloperOrgMemberships above
// should prevent the only known failure mode (duplicate rows).
async function safeCreateMembershipIndexes(): Promise<void> {
  try {
    await DeveloperOrgMembershipModel.createIndexes();
  } catch (error) {
    logger.error(
      { collection: DEVELOPER_ORG_MEMBERSHIPS_COLLECTION, error: (error as Error)?.message },
      "failed to create developer-org membership indexes",
    );
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
