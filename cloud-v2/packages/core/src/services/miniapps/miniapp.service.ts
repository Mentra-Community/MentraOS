import { createLogger } from "@mentra/cloud-shared";
import { ulid } from "ulid";
import { MiniAppAssetModel } from "../../models/miniapp-asset.model";
import { MiniAppModel } from "../../models/miniapp.model";
import { MiniAppReleaseModel } from "../../models/miniapp-release.model";
import { createStorageService, sha256Hex } from "../storage/storage.service";
import type { SignedBundleMetadata } from "./developer-signing.service";
import { notifyMiniAppSubmissionSlack } from "./miniapp-slack.service";

const logger = createLogger("core").child({ service: "miniapp.service" });

export interface DeveloperIdentity {
  developerId: string;
  email?: string;
  orgId: string;
  packagePrefix: string;
}

export interface CreateMiniAppInput {
  packageName: string;
  displayName: string;
  description?: string | null;
}

export interface CreateReleaseInput {
  packageName: string;
  version: string;
  manifest: Record<string, unknown>;
  bundle: Uint8Array;
  fileName?: string;
  signedBundle?: SignedBundleMetadata;
}

export interface AdminReleaseDecisionInput {
  releaseId: string;
  adminId: string;
  notes?: string | null;
}

const storage = createStorageService();

export class MiniAppService {
  async listMiniApps(developer: DeveloperIdentity) {
    const apps = await MiniAppModel.find({ orgId: developer.orgId, status: { $ne: "archived" } })
      .sort({ createdAt: -1 })
      .lean();

    const appIds = apps.map(app => app._id.toString());
    const releases = await MiniAppReleaseModel.find({ miniAppId: { $in: appIds } })
      .sort({ createdAt: -1 })
      .lean();

    return apps.map(app => {
      const appReleases = releases.filter(release => release.miniAppId === app._id.toString());
      const activeRelease = app.activeReleaseId
        ? appReleases.find(release => release._id.toString() === app.activeReleaseId)
        : null;
      const latestRelease = appReleases[0] ?? null;
      return {
        id: app._id.toString(),
        packageName: app.packageName,
        name: app.displayName,
        description: app.description ?? null,
        status: app.status,
        activeRelease: activeRelease ? serializeRelease(activeRelease) : null,
        latestRelease: latestRelease ? serializeRelease(latestRelease) : null,
        releaseCount: appReleases.length,
        createdAt: app.createdAt?.toISOString() ?? null,
        updatedAt: app.updatedAt?.toISOString() ?? null,
      };
    });
  }

  async createMiniApp(developer: DeveloperIdentity, input: CreateMiniAppInput) {
    const packageName = normalizePackageName(input.packageName);
    assertPackagePrefix(developer, packageName);

    const existing = await MiniAppModel.findOne({ packageName });
    if (existing) {
      if (existing.orgId !== developer.orgId || existing.status === "archived") {
        throw new MiniAppServiceError("package_taken", "package name is already claimed", 409);
      }
      return this.getMiniAppByPackageName(developer, packageName);
    }

    const created = await MiniAppModel.create({
      orgId: developer.orgId,
      packageName,
      displayName: input.displayName,
      description: input.description ?? null,
      status: "active",
      createdBy: developer.developerId,
    });

    return this.getMiniAppById(developer, created._id.toString());
  }

  async deleteMiniApp(developer: DeveloperIdentity, packageName: string) {
    const app = await MiniAppModel.findOne({ orgId: developer.orgId, packageName: normalizePackageName(packageName) });
    if (!app || app.status === "archived") {
      throw new MiniAppServiceError("not_found", "miniapp not found", 404);
    }
    app.status = "archived";
    await app.save();
    return { ok: true };
  }

  async listReleases(developer: DeveloperIdentity, packageName: string) {
    const app = await this.requireMiniApp(developer, normalizePackageName(packageName));
    const releases = await MiniAppReleaseModel.find({ miniAppId: app._id.toString() })
      .sort({ createdAt: -1 })
      .lean();
    return releases.map(serializeRelease);
  }

  async submitRelease(developer: DeveloperIdentity, packageName: string, releaseId: string) {
    const app = await this.requireMiniApp(developer, normalizePackageName(packageName));
    const release = await MiniAppReleaseModel.findOne({
      _id: releaseId,
      orgId: developer.orgId,
      miniAppId: app._id.toString(),
    });
    if (!release) throw new MiniAppServiceError("not_found", "release not found", 404);
    if (!release.releaseBundleAssetId || !release.bundleSha256) {
      throw new MiniAppServiceError("missing_bundle", "release must have a bundle before it can be submitted", 409);
    }
    if (!["draft", "rejected"].includes(release.status)) {
      throw new MiniAppServiceError("invalid_release_state", "only draft or rejected releases can be submitted", 409);
    }

    release.status = "submitted";
    release.submittedAt = new Date();
    release.reviewNotes = null;
    await release.save();

    // Fire-and-forget: a Slack failure can never delay or fail the submit
    // response, and an unset webhook env var is a silent skip.
    notifyMiniAppSubmissionSlack({
      releaseId: release._id.toString(),
      packageName: release.packageName,
      version: release.version,
      appName: app.displayName,
      description: app.description ?? null,
      developerEmail: developer.email ?? null,
      orgId: developer.orgId,
      manifest: release.manifest as Record<string, unknown> | null,
    }).catch(() => {});

    return serializeRelease(release.toObject());
  }

  async listAdminSubmissions() {
    const releases = await MiniAppReleaseModel.find({
      releaseBundleAssetId: { $ne: null },
      status: { $in: ["submitted", "in_review", "accepted", "rejected", "published"] },
    })
      .sort({ submittedAt: -1, createdAt: -1 })
      .lean();
    const appIds = [...new Set(releases.map(release => release.miniAppId))];
    const apps = await MiniAppModel.find({ _id: { $in: appIds } }).lean();
    const appsById = new Map(apps.map(app => [app._id.toString(), app]));

    return releases.map(release => {
      const app = appsById.get(release.miniAppId);
      return {
        ...serializeRelease(release),
        miniAppId: release.miniAppId,
        packageName: release.packageName,
        displayName: app?.displayName ?? release.packageName,
        description: app?.description ?? null,
        submittedAt: release.submittedAt?.toISOString() ?? null,
        reviewedAt: release.reviewedAt?.toISOString() ?? null,
        publishedAt: release.publishedAt?.toISOString() ?? null,
        reviewedBy: release.reviewedBy ?? null,
        reviewNotes: release.reviewNotes ?? null,
      };
    });
  }

  async approveRelease(input: AdminReleaseDecisionInput) {
    const release = await MiniAppReleaseModel.findOne({ _id: input.releaseId });
    if (!release) throw new MiniAppServiceError("not_found", "release not found", 404);
    if (!["submitted", "in_review", "rejected"].includes(release.status)) {
      throw new MiniAppServiceError("invalid_release_state", "release is not awaiting review", 409);
    }
    release.status = "accepted";
    release.reviewedAt = new Date();
    release.reviewedBy = input.adminId;
    release.reviewNotes = input.notes?.trim() || null;
    await release.save();
    return serializeRelease(release.toObject());
  }

  async rejectRelease(input: AdminReleaseDecisionInput) {
    const release = await MiniAppReleaseModel.findOne({ _id: input.releaseId });
    if (!release) throw new MiniAppServiceError("not_found", "release not found", 404);
    if (!["submitted", "in_review", "accepted"].includes(release.status)) {
      throw new MiniAppServiceError("invalid_release_state", "release is not awaiting review", 409);
    }
    release.status = "rejected";
    release.reviewedAt = new Date();
    release.reviewedBy = input.adminId;
    release.reviewNotes = input.notes?.trim() || "Rejected by admin review.";
    await release.save();
    return serializeRelease(release.toObject());
  }

  async publishRelease(input: AdminReleaseDecisionInput) {
    const release = await MiniAppReleaseModel.findOne({ _id: input.releaseId });
    if (!release) throw new MiniAppServiceError("not_found", "release not found", 404);
    if (!["accepted", "published"].includes(release.status)) {
      throw new MiniAppServiceError("invalid_release_state", "only accepted releases can be published", 409);
    }

    const app = await MiniAppModel.findOne({ _id: release.miniAppId });
    if (!app || app.status === "archived") throw new MiniAppServiceError("not_found", "miniapp not found", 404);

    release.status = "published";
    release.publishedAt = release.publishedAt ?? new Date();
    release.reviewedBy = input.adminId;
    if (input.notes?.trim()) release.reviewNotes = input.notes.trim();
    app.activeReleaseId = release._id.toString();

    await Promise.all([release.save(), app.save()]);
    return serializeRelease(release.toObject());
  }

  async createRelease(developer: DeveloperIdentity, input: CreateReleaseInput) {
    const packageName = normalizePackageName(input.packageName);
    assertPackagePrefix(developer, packageName);
    const app = await this.requireMiniApp(developer, packageName);
    const existing = await MiniAppReleaseModel.findOne({
      miniAppId: app._id.toString(),
      version: input.version,
    });
    if (existing) {
      throw new MiniAppServiceError("release_exists", "release version already exists", 409);
    }

    const release = await MiniAppReleaseModel.create({
      orgId: developer.orgId,
      miniAppId: app._id.toString(),
      packageName,
      version: input.version,
      status: "draft",
      manifest: input.manifest,
      manifestSha256: input.signedBundle?.payload.manifestSha256 ?? null,
      signedBundlePayload: input.signedBundle?.payload ?? null,
      signingKeyId: input.signedBundle?.signingKeyId ?? null,
      bundleSignature: input.signedBundle?.signature ?? null,
      signedAt: input.signedBundle?.payload.createdAt ? new Date(input.signedBundle.payload.createdAt) : null,
      createdBy: developer.developerId,
    });

    // Store the bundle and link it to the release. If any step fails, roll back
    // everything created here (release row, asset row, and stored blob) so a
    // retry with the same package/version is not permanently blocked by the
    // `release_exists` check above and no orphaned storage is left behind.
    let storedKey: string | undefined;
    let assetId: string | undefined;
    try {
      const storageKey = [
        "miniapps",
        packageName,
        "releases",
        input.version,
        `${ulid()}-bundle.zip`,
      ].join("/");
      const stored = await storage.putObject({
        key: storageKey,
        body: input.bundle,
        contentType: "application/zip",
      });
      storedKey = storageKey;
      const expectedSha = sha256Hex(input.bundle);
      if (stored.sha256 !== expectedSha) {
        throw new MiniAppServiceError("hash_mismatch", "stored bundle hash mismatch", 500);
      }

      const asset = await MiniAppAssetModel.create({
        orgId: developer.orgId,
        miniAppId: app._id.toString(),
        releaseId: release._id.toString(),
        role: "release_bundle",
        storageKey,
        fileName: input.fileName ?? "bundle.zip",
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        createdBy: developer.developerId,
      });
      assetId = asset._id.toString();

      release.releaseBundleAssetId = asset._id.toString();
      release.bundleSha256 = stored.sha256;
      release.bundleSizeBytes = stored.sizeBytes;
      await release.save();

      return serializeRelease(release.toObject());
    } catch (error) {
      const releaseId = release._id.toString();
      // Best-effort compensation. Log each failure with context so blocked
      // retries or orphaned artifacts stay diagnosable rather than silent.
      await MiniAppReleaseModel.deleteOne({ _id: release._id }).catch(cleanupError => {
        logger.error({ cleanupError, releaseId, packageName, version: input.version }, "failed to roll back release row after createRelease failure");
      });
      if (assetId) {
        await MiniAppAssetModel.deleteOne({ _id: assetId }).catch(cleanupError => {
          logger.error({ cleanupError, releaseId, assetId }, "failed to roll back asset row after createRelease failure");
        });
      }
      if (storedKey) {
        await storage.deleteObject(storedKey).catch(cleanupError => {
          logger.error({ cleanupError, releaseId, storageKey: storedKey }, "failed to delete stored bundle after createRelease failure");
        });
      }
      throw error;
    }
  }

  private async getMiniAppById(developer: DeveloperIdentity, id: string) {
    const app = await MiniAppModel.findOne({ _id: id, orgId: developer.orgId }).lean();
    if (!app) throw new MiniAppServiceError("not_found", "miniapp not found", 404);
    return {
      id: app._id.toString(),
      packageName: app.packageName,
      name: app.displayName,
      description: app.description ?? null,
      status: app.status,
      activeRelease: null,
      latestRelease: null,
      releaseCount: 0,
      createdAt: app.createdAt?.toISOString() ?? null,
      updatedAt: app.updatedAt?.toISOString() ?? null,
    };
  }

  private async getMiniAppByPackageName(developer: DeveloperIdentity, packageName: string) {
    const app = await MiniAppModel.findOne({ packageName: normalizePackageName(packageName), orgId: developer.orgId }).lean();
    if (!app) throw new MiniAppServiceError("not_found", "miniapp not found", 404);
    return {
      id: app._id.toString(),
      packageName: app.packageName,
      name: app.displayName,
      description: app.description ?? null,
      status: app.status,
      activeRelease: null,
      latestRelease: null,
      releaseCount: 0,
      createdAt: app.createdAt?.toISOString() ?? null,
      updatedAt: app.updatedAt?.toISOString() ?? null,
    };
  }

  private async requireMiniApp(developer: DeveloperIdentity, packageName: string) {
    const app = await MiniAppModel.findOne({ orgId: developer.orgId, packageName: normalizePackageName(packageName) });
    if (!app || app.status === "archived") {
      throw new MiniAppServiceError("not_found", "miniapp not found", 404);
    }
    return app;
  }
}

export class MiniAppServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MiniAppServiceError";
  }
}

function normalizePackageName(packageName: string): string {
  const normalized = packageName.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(normalized)) {
    throw new MiniAppServiceError(
      "invalid_package_name",
      "package name must be lowercase reverse-DNS text, for example com.mentra.myapp",
      400,
    );
  }
  return normalized;
}

function assertPackagePrefix(developer: DeveloperIdentity, packageName: string): void {
  const prefix = developer.packagePrefix.replace(/\.+$/, "").toLowerCase();
  if (!packageName.startsWith(`${prefix}.`)) {
    throw new MiniAppServiceError(
      "invalid_package_prefix",
      `package name must start with ${prefix}. for this developer org`,
      400,
    );
  }
}

function serializeRelease(release: {
  _id: unknown;
  version: string;
  status: string;
  releaseBundleAssetId?: string | null;
  bundleSha256?: string | null;
  bundleSizeBytes?: number | null;
  manifestSha256?: string | null;
  signingKeyId?: string | null;
  signedAt?: Date | null;
  reviewedBy?: string | null;
  reviewNotes?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: String(release._id),
    version: release.version,
    status: release.status,
    releaseBundleAssetId: release.releaseBundleAssetId ?? null,
    bundleSha256: release.bundleSha256 ?? null,
    bundleSizeBytes: release.bundleSizeBytes ?? null,
    manifestSha256: release.manifestSha256 ?? null,
    signingKeyId: release.signingKeyId ?? null,
    signedAt: release.signedAt?.toISOString() ?? null,
    reviewedBy: release.reviewedBy ?? null,
    reviewNotes: release.reviewNotes ?? null,
    createdAt: release.createdAt?.toISOString() ?? null,
    updatedAt: release.updatedAt?.toISOString() ?? null,
  };
}
