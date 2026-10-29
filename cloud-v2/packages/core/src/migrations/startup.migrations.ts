/**
 * Startup migrations that keep early Cloud V2 dev databases compatible with
 * current schemas. These are intentionally narrow and idempotent.
 */

import mongoose from "mongoose";
import { createLogger } from "@mentra/cloud-shared";
import { RefreshTokenModel } from "../models/refresh-token.model";
import { UserModel } from "../models/user.model";
import { BrowserSessionModel } from "../models/browser-session.model";
import { LoginTransactionModel } from "../models/login-transaction.model";
import { AuthRateLimitModel } from "../models/auth-rate-limit.model";
import { SigninIdentityModel } from "../models/signin-identity.model";
import { AccountEmailModel } from "../models/account-email.model";
import { ensureOidcCollections } from "../services/oidc/mongo-adapter";
import { OemModel } from "../models/oem.model";
import {TestHostStateModel} from "../models/test-host-state.model";
import {TestRerunModel} from "../models/test-rerun.model";
import {TestRequestModel} from "../models/test-request.model";
import {RoutineDefinitionModel} from "../models/routine-definition.model";
import {RoutinePreferenceModel} from "../models/routine-preference.model";
import {backfillTestSuiteStartedAt, TestSuiteModel} from "../models/test-suite.model";
import { reconcileTestRunIndexes, TestAssetModel, TestRunModel } from "../models/test-run.model";
import { TestDispatchModel } from "../models/test-dispatch.model";
import {ReportModel} from '../models/report.model';
import {ReportAssetModel, reconcileReportAssetIndexes} from '../models/report-asset.model';
import { AccessCredentialModel } from "../models/access-credential.model";
import { LicenseSeatModel } from "../models/license-seat.model";
import { LicenseModel } from "../models/license.model";
import { WorkspaceAuditCounterModel } from "../models/workspace-audit-counter.model";
import { WorkspaceAuditEventModel } from "../models/workspace-audit-event.model";
import { WorkspaceInvitationModel } from "../models/workspace-invitation.model";
import { WorkspaceMembershipModel } from "../models/workspace-membership.model";
import { WorkspaceModel } from "../models/workspace.model";
import { LegacyBrowserIdentityModel } from "../models/legacy-browser-identity.model";
import { convertLegacyAdminKeys } from "../services/workspaces/legacy-admin-keys";
import { TestHostLatestModel, TestHostSampleModel } from "../models/test-host-health.model";

const logger = createLogger("core").child({ component: "startup-migrations" });

const USERS_COLLECTION = "users";
const REFRESH_TOKENS_COLLECTION = "refreshTokens";
const LEGACY_USER_IDENTITY_INDEX = "oemId_1_oemUserId_1";

type DuplicateUserGroup = {
  _id: {
    tenantId: string;
    tenantUserId: string;
  };
  users: Array<{
    _id: mongoose.Types.ObjectId;
    mentraUserId: string;
    createdAt?: Date;
  }>;
  count: number;
};

export async function runStartupMigrations(): Promise<void> {
  await backfillLegacyUserIdentityFields();
  await backfillLegacyRefreshTokenTenant();
  await dropLegacyUserIdentityIndex();
  await dedupeUserIdentityRows();
  await UserModel.createIndexes();
  // Portal sign-in: session and transaction lookups are by unique hash, and
  // rows expire by TTL. Built before serving so a session is never duplicated.
  await BrowserSessionModel.createIndexes();
  await LoginTransactionModel.createIndexes();
  await AuthRateLimitModel.createIndexes();
  // Core's sign-in server: the provider's collections (TTL, grant, uid and
  // account indexes) and each person's sign-in identity.
  await ensureOidcCollections();
  await SigninIdentityModel.createIndexes();
  // Core's copy of each account's email: one row per account (unique), built
  // with its collection before the first lookup writes one.
  await AccountEmailModel.createIndexes();
  // prevTokenHash recovery-lookup index (OS-1703). Idempotent; sparse.
  await RefreshTokenModel.createIndexes();
  // Immutable run/asset insertion relies on these uniqueness constraints before serving requests.
  await TestHostStateModel.createIndexes();
  await TestRequestModel.createIndexes();
  // Batch successor claims must be unique before admitting any linked rerun.
  await TestRerunModel.createIndexes();
  // Existing definitions were ordinary enrollments. Candidate metadata is explicit from this rollout onward.
  await RoutineDefinitionModel.updateMany({ordinaryEnrolledAt: {$exists: false}, candidateBindings: {$exists: false}},
    [{$set: {ordinaryEnrolledAt: '$createdAt'}}]);
  await RoutineDefinitionModel.createIndexes();
  await RoutinePreferenceModel.createIndexes();
  await reconcileTestRunIndexes();
  await TestRunModel.createIndexes();
  await backfillTestSuiteStartedAt();
  await TestSuiteModel.createIndexes();
  await TestAssetModel.createIndexes();
  // Native incident creation and shared diagnostic references must dedupe before completion ACK.
  await ReportModel.createIndexes();
  await reconcileReportAssetIndexes();
  await ReportAssetModel.createIndexes();
  // No device execution grant is safe until request IDs are unique across all Core instances.
  // The send receipt must be unique before any admin can submit a device request.
  await TestDispatchModel.createIndexes();
  // A state repair operation may be sent once; its receipt must be unique first.
  // One compare-and-set row per host resource requires the unique key before any report.
  // Passive host observations require idempotent identity and indexed, expiring history before ingestion.
  await TestHostSampleModel.createIndexes();
  await TestHostLatestModel.createIndexes();
  // Workspaces rely on unique indexes (one active membership per person, one
  // pending invitation per address, unique ids). Build them, and their
  // collections, before serving: a request in the first moments after boot must
  // not create a collection inside a transaction. The membership claim's legacy
  // identities are among them: their collection is created here while it is
  // empty, so its unique index can be built on Azure Cosmos DB too. The change
  // feed's counter collection is new and built empty the same way, as are the
  // licenses and their seats (one seat per license and membership); the feed's
  // `seq` index on the already populated audit events is not unique, because
  // Cosmos DB cannot add a unique index to a populated collection. An index the
  // database refuses (some databases a Private Cloud uses support only part of
  // MongoDB's index options) is logged and does not stop Core: sign-in,
  // incidents and keys keep working.
  await Promise.all(
    [
      WorkspaceModel,
      WorkspaceMembershipModel,
      WorkspaceInvitationModel,
      AccessCredentialModel,
      WorkspaceAuditEventModel,
      WorkspaceAuditCounterModel,
      LegacyBrowserIdentityModel,
      LicenseModel,
      LicenseSeatModel,
    ].map(
      async (model) => {
        try {
          await model.createCollection();
          await model.createIndexes();
        } catch (error) {
          logger.error(
            { collection: model.collection.collectionName, error: (error as Error)?.message },
            "failed to create workspace collection indexes",
          );
        }
      },
    ),
  );
  // Allowlisted admin API keys keep working as operator keys, before any
  // request is served. A key that fails is logged and retried next start.
  await convertLegacyAdminKeys();
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
      {
        $group: {
          _id: { tenantId: "$tenantId", tenantUserId: "$tenantUserId" },
          users: { $push: { _id: "$_id", mentraUserId: "$mentraUserId", createdAt: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  let deletedCount = 0;
  let updatedRefreshTokenCount = 0;

  for (const group of duplicateGroups) {
    // Sort each duplicate group in-process. Cosmos DB's Mongo API rejects the
    // former collection-wide {createdAt,_id} aggregation sort unless customers
    // manually provision a composite index, even for a fresh empty database.
    const [keeper, ...duplicates] = [...group.users].sort((left, right) => {
      const createdAtDelta = (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0);
      return createdAtDelta || left._id.toString().localeCompare(right._id.toString());
    });
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
