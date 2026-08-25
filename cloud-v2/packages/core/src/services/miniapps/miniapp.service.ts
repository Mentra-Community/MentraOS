import { createLogger } from "@mentra/cloud-shared";
import { ulid } from "ulid";
import { MiniAppAssetModel } from "../../models/miniapp-asset.model";
import { MiniAppModel } from "../../models/miniapp.model";
import { MiniAppReleaseModel } from "../../models/miniapp-release.model";
import { createStorageService, sha256Hex } from "../storage/storage.service";
import { BundleManifestError, parseCanonicalBundleManifest } from "./bundle-manifest";
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
  releaseTrack?: "stable" | "beta";
}

export interface UpdateStoreListingInput {
  subtitle?: string | null;
  longDescription?: string | null;
  categories?: string[];
  privacyPolicyUrl?: string | null;
  supportUrl?: string | null;
  websiteUrl?: string | null;
}

export interface CreateStoreAssetInput {
  role: "store_icon" | "store_cover" | "gallery_screenshot";
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

const MAX_STORE_ASSET_BYTES = 10 * 1024 * 1024;
const STORE_ASSET_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);
const STORE_LISTING_LEASE_MS = 5 * 60_000;
const STORE_LISTING_LEASE_RENEW_MS = 30_000;
const STORE_LISTING_LEASE_WAIT_MS = 10_000;

export interface AdminReleaseDecisionInput {
  releaseId: string;
  adminId: string;
  notes?: string | null;
}

export interface AdminStoreModerationInput {
  packageName: string;
  reviewTier?: "community" | "verified";
  featured?: boolean;
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
      const activeBetaRelease = app.activeBetaReleaseId
        ? appReleases.find(release => release._id.toString() === app.activeBetaReleaseId)
        : null;
      const latestRelease = appReleases[0] ?? null;
      return {
        id: app._id.toString(),
        packageName: app.packageName,
        name: app.displayName,
        description: app.description ?? null,
        storeListing: serializeStoreListing(app.storeListing),
        status: app.status,
        activeRelease: activeRelease ? serializeRelease(activeRelease) : null,
        activeBetaRelease: activeBetaRelease ? serializeRelease(activeBetaRelease) : null,
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
    const releases = await MiniAppReleaseModel.find({ miniAppId: app._id.toString() }).sort({ createdAt: -1 }).lean();
    return releases.map(serializeRelease);
  }

  async submitRelease(developer: DeveloperIdentity, packageName: string, releaseId: string) {
    const authorizedApp = await this.requireMiniApp(developer, normalizePackageName(packageName));
    return withStoreListingLease(authorizedApp._id.toString(), async lease => {
      // Re-read after acquiring the cross-process lease. A deletion that won
      // the lease first may have removed an artwork reference from the draft.
      const app = await MiniAppModel.findOne({
        _id: authorizedApp._id,
        orgId: developer.orgId,
        status: { $ne: "archived" },
      });
      if (!app) throw new MiniAppServiceError("not_found", "miniapp not found", 404);
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
      // Freeze the content entering review. Approval and publication must never
      // pick up developer edits made after this transition.
      release.submittedStoreListing = serializeStoreListing(app.storeListing);
      release.reviewedStoreListing = null;
      await lease.assertHeld();
      await release.save();

      // Fire-and-forget: a Slack failure can never delay or fail the submit
      // response, and an unset webhook env var is a silent skip.
      notifyMiniAppSubmissionSlack({
        releaseId: release._id.toString(),
        packageName: release.packageName,
        version: release.version,
        releaseTrack: release.releaseTrack === "beta" ? "beta" : "stable",
        appName: app.displayName,
        description: app.description ?? null,
        developerEmail: developer.email ?? null,
        orgId: developer.orgId,
        manifest: release.manifest as Record<string, unknown> | null,
      }).catch(() => {});

      return serializeRelease(release.toObject());
    });
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
    const storeAssets = await MiniAppAssetModel.find({
      miniAppId: { $in: appIds },
      role: { $in: ["store_icon", "store_cover", "gallery_screenshot"] },
    })
      .sort({ role: 1, sortOrder: 1, createdAt: 1 })
      .lean();
    const assetsByAppId = new Map<string, typeof storeAssets>();
    for (const asset of storeAssets) {
      const assets = assetsByAppId.get(asset.miniAppId) ?? [];
      assets.push(asset);
      assetsByAppId.set(asset.miniAppId, assets);
    }

    return releases.map(release => {
      const app = appsById.get(release.miniAppId);
      const assets = assetsByAppId.get(release.miniAppId) ?? [];
      const listingSource =
        release.status === "published"
          ? release.reviewedStoreListing
          : release.status === "accepted"
            ? release.reviewedStoreListing
            : ["submitted", "in_review"].includes(release.status)
              ? release.submittedStoreListing
              : app?.storeListing;
      const listing = serializeStoreListing(listingSource);
      const referencedAssetIds = storeListingAssetIds(listing);
      const listingAssets = assets.filter(asset => referencedAssetIds.has(String(asset._id)));
      const activeReleaseId = release.releaseTrack === "beta" ? app?.activeBetaReleaseId : app?.activeReleaseId;
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
        isActiveRelease: activeReleaseId === release._id.toString(),
        storeListing: listing,
        storeAssets: listingAssets.map(serializeStoreAsset),
        listingReadiness: storeListingReadiness(
          { description: app?.description, storeListing: listingSource },
          listingAssets,
        ),
      };
    });
  }

  async approveRelease(input: AdminReleaseDecisionInput) {
    const requestedRelease = await MiniAppReleaseModel.findOne({ _id: input.releaseId }).select("miniAppId").lean();
    if (!requestedRelease) throw new MiniAppServiceError("not_found", "release not found", 404);
    return withStoreListingLease(requestedRelease.miniAppId, async lease => {
      const release = await MiniAppReleaseModel.findOne({ _id: input.releaseId });
      if (!release) throw new MiniAppServiceError("not_found", "release not found", 404);
      if (!["submitted", "in_review"].includes(release.status)) {
        throw new MiniAppServiceError("invalid_release_state", "release is not awaiting review", 409);
      }
      const app = await MiniAppModel.findOne({ _id: release.miniAppId });
      if (!app || app.status === "archived") throw new MiniAppServiceError("not_found", "miniapp not found", 404);
      if (!release.submittedStoreListing || typeof release.submittedStoreListing !== "object") {
        throw new MiniAppServiceError(
          "listing_not_submitted",
          "Release must be submitted again before its Store listing can be approved",
          409,
        );
      }
      release.status = "accepted";
      release.reviewedAt = new Date();
      release.reviewedBy = input.adminId;
      release.reviewNotes = input.notes?.trim() || null;
      release.reviewedStoreListing = serializeStoreListing(release.submittedStoreListing);
      await lease.assertHeld();
      await release.save();
      return serializeRelease(release.toObject());
    });
  }

  async rejectRelease(input: AdminReleaseDecisionInput) {
    const requestedRelease = await MiniAppReleaseModel.findOne({ _id: input.releaseId }).select("miniAppId").lean();
    if (!requestedRelease) throw new MiniAppServiceError("not_found", "release not found", 404);
    return withStoreListingLease(requestedRelease.miniAppId, async lease => {
      const release = await MiniAppReleaseModel.findOne({ _id: input.releaseId });
      if (!release) throw new MiniAppServiceError("not_found", "release not found", 404);
      if (!["submitted", "in_review", "accepted"].includes(release.status)) {
        throw new MiniAppServiceError("invalid_release_state", "release is not awaiting review", 409);
      }
      const app = await MiniAppModel.findOne({ _id: release.miniAppId });
      if (!app || app.status === "archived") throw new MiniAppServiceError("not_found", "miniapp not found", 404);
      release.status = "rejected";
      release.reviewedAt = new Date();
      release.reviewedBy = input.adminId;
      release.reviewNotes = input.notes?.trim() || "Rejected by admin review.";
      // A rejected snapshot is no longer approvable. The developer must submit
      // again, which freezes a new listing revision and its artwork references.
      release.submittedStoreListing = null;
      release.reviewedStoreListing = null;

      await lease.assertHeld();
      await release.save();
      return serializeRelease(release.toObject());
    });
  }

  async publishRelease(input: AdminReleaseDecisionInput) {
    const requestedRelease = await MiniAppReleaseModel.findOne({ _id: input.releaseId }).lean();
    if (!requestedRelease) throw new MiniAppServiceError("not_found", "release not found", 404);
    return withStoreListingLease(requestedRelease.miniAppId, async lease => {
      const release = await MiniAppReleaseModel.findOne({ _id: input.releaseId });
      if (!release) throw new MiniAppServiceError("not_found", "release not found", 404);
      if (!["accepted", "published"].includes(release.status)) {
        throw new MiniAppServiceError("invalid_release_state", "only accepted releases can be published", 409);
      }

      const app = await MiniAppModel.findOne({ _id: release.miniAppId });
      if (!app || app.status === "archived") throw new MiniAppServiceError("not_found", "miniapp not found", 404);
      const releaseTrack = release.releaseTrack === "beta" ? "beta" : "stable";
      const activeReleaseId = releaseTrack === "beta" ? app.activeBetaReleaseId : app.activeReleaseId;
      if (release.status === "published") {
        if (activeReleaseId === release._id.toString()) return serializeRelease(release.toObject());
        throw new MiniAppServiceError(
          "invalid_release_state",
          "a historical published release cannot replace the active release",
          409,
        );
      }
      const assets = await MiniAppAssetModel.find({
        miniAppId: app._id.toString(),
        role: { $in: ["store_icon", "store_cover", "gallery_screenshot"] },
      }).lean();
      if (!release.reviewedStoreListing || typeof release.reviewedStoreListing !== "object") {
        throw new MiniAppServiceError(
          "listing_not_reviewed",
          "Store listing must be approved again before this release can be published",
          409,
        );
      }
      const reviewedStoreListing = {
        ...serializeStoreListing(release.reviewedStoreListing),
        // These fields are admin-only and may be adjusted safely after approval.
        reviewTier: app.storeListing?.reviewTier ?? "community",
        featured: app.storeListing?.featured === true,
      };
      const readiness = storeListingReadiness(
        { description: app.description, storeListing: reviewedStoreListing },
        assets,
      );
      if (!readiness.ready) {
        throw new MiniAppServiceError(
          "store_listing_incomplete",
          `Store listing is incomplete: ${readiness.missing.join(", ")}`,
          409,
        );
      }

      release.status = "published";
      // Persist the complete publication revision on the release itself so
      // historical admin rows do not drift when a newer release on this track
      // replaces the app-level active snapshot.
      release.reviewedStoreListing = reviewedStoreListing;
      release.publishedAt = release.publishedAt ?? new Date();
      release.reviewedBy = input.adminId;
      if (input.notes?.trim()) release.reviewNotes = input.notes.trim();
      // Journal the candidate without disturbing the currently active release.
      // Once the release status is durable, the journal can be promoted by
      // this request or recovered by the next lease holder after a crash.
      const staged = await MiniAppModel.updateOne(
        {
          _id: app._id,
          "storeListingOperationLease.token": lease.token,
          "storeListingOperationLease.expiresAt": { $gt: new Date() },
          pendingStorePublication: null,
        },
        {
          $set: {
            pendingStorePublication: {
              releaseId: release._id.toString(),
              releaseTrack,
              storeListing: reviewedStoreListing,
            },
          },
        },
      );
      if (staged.matchedCount !== 1) {
        throw new MiniAppServiceError("store_listing_lease_lost", "Store listing operation lease was lost", 409);
      }
      await lease.assertHeld();
      await release.save();
      const promoted = await promotePendingStorePublication({
        miniAppId: app._id.toString(),
        lease,
        releaseId: release._id.toString(),
        releaseTrack,
        storeListing: reviewedStoreListing,
      });
      if (!promoted) {
        throw new MiniAppServiceError("store_listing_lease_lost", "Store listing operation lease was lost", 409);
      }
      return serializeRelease(release.toObject());
    });
  }

  async updateStoreModeration(input: AdminStoreModerationInput) {
    const packageName = normalizePackageName(input.packageName);
    const updates: Record<string, unknown> = {};
    const publishedUpdates: Record<string, unknown> = {};
    if (input.reviewTier !== undefined) {
      updates["storeListing.reviewTier"] = input.reviewTier;
      publishedUpdates["publishedStoreListing.reviewTier"] = input.reviewTier;
    }
    if (input.featured !== undefined) {
      updates["storeListing.featured"] = input.featured;
      publishedUpdates["publishedStoreListing.featured"] = input.featured;
    }
    if (Object.keys(updates).length === 0) {
      throw new MiniAppServiceError("invalid_request", "reviewTier or featured is required", 400);
    }
    const target = await MiniAppModel.findOne({ packageName, status: { $ne: "archived" } }).select("_id").lean();
    if (!target) throw new MiniAppServiceError("not_found", "miniapp not found", 404);
    return withStoreListingLease(target._id.toString(), async lease => {
      const app = await MiniAppModel.findOneAndUpdate(
        { _id: target._id, status: { $ne: "archived" } },
        { $set: updates },
        { new: true },
      ).lean();
      if (!app) throw new MiniAppServiceError("not_found", "miniapp not found", 404);
      if (app.publishedStoreListing && Object.keys(publishedUpdates).length > 0) {
        await MiniAppModel.updateOne({ _id: app._id }, { $set: publishedUpdates });
      }
      if (app.publishedBetaStoreListing && Object.keys(publishedUpdates).length > 0) {
        const betaUpdates = Object.fromEntries(
          Object.entries(publishedUpdates).map(([key, value]) => [
            key.replace("publishedStoreListing", "publishedBetaStoreListing"),
            value,
          ]),
        );
        await MiniAppModel.updateOne({ _id: app._id }, { $set: betaUpdates });
      }
      const activeReleaseIds = [app.activeReleaseId, app.activeBetaReleaseId].filter(
        (releaseId): releaseId is string => typeof releaseId === "string" && releaseId.length > 0,
      );
      if (activeReleaseIds.length > 0) {
        const releaseUpdates = Object.fromEntries(
          Object.entries(updates).map(([key, value]) => [key.replace("storeListing", "reviewedStoreListing"), value]),
        );
        await lease.assertHeld();
        await MiniAppReleaseModel.updateMany(
          { _id: { $in: activeReleaseIds }, status: "published" },
          { $set: releaseUpdates },
        );
      }
      return {
        packageName: app.packageName,
        reviewTier: app.storeListing?.reviewTier ?? "community",
        featured: app.storeListing?.featured === true,
      };
    });
  }

  async createRelease(developer: DeveloperIdentity, input: CreateReleaseInput) {
    const packageName = normalizePackageName(input.packageName);
    assertPackagePrefix(developer, packageName);
    let canonical;
    try {
      canonical = await parseCanonicalBundleManifest(input.bundle, input.manifest);
    } catch (error) {
      if (error instanceof BundleManifestError) {
        throw new MiniAppServiceError(error.code, error.message, 400);
      }
      throw error;
    }
    if (canonical.packageName !== packageName) {
      throw new MiniAppServiceError(
        "bundle_package_mismatch",
        "bundle miniapp.json packageName does not match the release package",
        400,
      );
    }
    if (canonical.version !== input.version) {
      throw new MiniAppServiceError(
        "bundle_version_mismatch",
        "bundle miniapp.json version does not match the release version",
        400,
      );
    }
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
      releaseTrack: input.releaseTrack ?? "stable",
      status: "draft",
      manifest: canonical.manifest,
      manifestSha256: canonical.manifestSha256,
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
      const storageKey = ["miniapps", packageName, "releases", input.version, `${ulid()}-bundle.zip`].join("/");
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
        logger.error(
          { cleanupError, releaseId, packageName, version: input.version },
          "failed to roll back release row after createRelease failure",
        );
      });
      if (assetId) {
        await MiniAppAssetModel.deleteOne({ _id: assetId }).catch(cleanupError => {
          logger.error(
            { cleanupError, releaseId, assetId },
            "failed to roll back asset row after createRelease failure",
          );
        });
      }
      if (storedKey) {
        await storage.deleteObject(storedKey).catch(cleanupError => {
          logger.error(
            { cleanupError, releaseId, storageKey: storedKey },
            "failed to delete stored bundle after createRelease failure",
          );
        });
      }
      throw error;
    }
  }

  async getStoreListing(developer: DeveloperIdentity, packageName: string) {
    const app = await this.requireMiniApp(developer, normalizePackageName(packageName));
    const assets = await MiniAppAssetModel.find({
      miniAppId: app._id.toString(),
      role: { $in: ["store_icon", "store_cover", "gallery_screenshot"] },
    })
      .sort({ role: 1, sortOrder: 1, createdAt: 1 })
      .lean();
    return {
      ...serializeStoreListing(app.storeListing),
      assets: assets.map(serializeStoreAsset),
    };
  }

  async updateStoreListing(developer: DeveloperIdentity, packageName: string, input: UpdateStoreListingInput) {
    const app = await this.requireMiniApp(developer, normalizePackageName(packageName));
    const categories = input.categories?.map(category => category.trim().toLowerCase()).filter(Boolean);
    if (categories && (categories.length > 5 || categories.some(category => category.length > 40))) {
      throw new MiniAppServiceError("invalid_categories", "use at most five categories of 40 characters", 400);
    }
    const normalizeUrl = (value: string | null | undefined) => {
      if (value === undefined) return undefined;
      if (value === null || !value.trim()) return null;
      let url: URL;
      try {
        url = new URL(value.trim());
      } catch {
        throw new MiniAppServiceError("invalid_url", "listing links must be valid HTTPS URLs", 400);
      }
      if (url.protocol !== "https:") {
        throw new MiniAppServiceError("invalid_url", "listing links must use HTTPS", 400);
      }
      return url.toString();
    };
    const updates: Record<string, unknown> = {};
    if (input.subtitle !== undefined) updates["storeListing.subtitle"] = cleanText(input.subtitle, 120);
    if (input.longDescription !== undefined) {
      updates["storeListing.longDescription"] = cleanText(input.longDescription, 10_000);
    }
    if (categories !== undefined) updates["storeListing.categories"] = [...new Set(categories)];
    const privacyPolicyUrl = normalizeUrl(input.privacyPolicyUrl);
    const supportUrl = normalizeUrl(input.supportUrl);
    const websiteUrl = normalizeUrl(input.websiteUrl);
    if (privacyPolicyUrl !== undefined) updates["storeListing.privacyPolicyUrl"] = privacyPolicyUrl;
    if (supportUrl !== undefined) updates["storeListing.supportUrl"] = supportUrl;
    if (websiteUrl !== undefined) updates["storeListing.websiteUrl"] = websiteUrl;
    if (Object.keys(updates).length > 0) {
      await MiniAppModel.updateOne({ _id: app._id, orgId: developer.orgId }, { $set: updates });
    }
    return this.getStoreListing(developer, packageName);
  }

  async createStoreAsset(developer: DeveloperIdentity, packageName: string, input: CreateStoreAssetInput) {
    const app = await this.requireMiniApp(developer, normalizePackageName(packageName));
    if (!STORE_ASSET_CONTENT_TYPES.has(input.contentType)) {
      throw new MiniAppServiceError("invalid_asset_type", "Store assets must be PNG, JPEG, WebP, or AVIF images", 400);
    }
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_STORE_ASSET_BYTES) {
      throw new MiniAppServiceError("invalid_asset_size", "Store assets must be between 1 byte and 10 MB", 400);
    }
    if (!matchesImageSignature(input.bytes, input.contentType)) {
      throw new MiniAppServiceError(
        "invalid_asset_content",
        "Store asset bytes do not match the declared image content type",
        400,
      );
    }
    if (input.role === "gallery_screenshot" && (app.storeListing?.screenshotAssetIds?.length ?? 0) >= 10) {
      throw new MiniAppServiceError("too_many_screenshots", "Store listings can have at most 10 screenshots", 400);
    }
    const safeFileName = input.fileName.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "asset";
    const storageKey = ["miniapps", app.packageName, "store", `${ulid()}-${safeFileName}`].join("/");
    const stored = await storage.putObject({ key: storageKey, body: input.bytes, contentType: input.contentType });
    let asset;
    try {
      const sortOrder =
        input.role === "gallery_screenshot"
          ? await MiniAppAssetModel.countDocuments({ miniAppId: app._id.toString(), role: input.role })
          : null;
      asset = await MiniAppAssetModel.create({
        orgId: developer.orgId,
        miniAppId: app._id.toString(),
        releaseId: null,
        role: input.role,
        storageKey,
        fileName: safeFileName,
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        sortOrder,
        createdBy: developer.developerId,
      });
      const assetId = asset._id.toString();
      if (input.role === "store_icon") {
        await MiniAppModel.updateOne({ _id: app._id }, { $set: { "storeListing.iconAssetId": assetId } });
      }
      if (input.role === "store_cover") {
        await MiniAppModel.updateOne({ _id: app._id }, { $set: { "storeListing.coverAssetId": assetId } });
      }
      if (input.role === "gallery_screenshot") {
        const updated = await MiniAppModel.findOneAndUpdate(
          {
            _id: app._id,
            $expr: {
              $lt: [{ $size: { $ifNull: ["$storeListing.screenshotAssetIds", []] } }, 10],
            },
          },
          { $push: { "storeListing.screenshotAssetIds": assetId } },
          { new: true },
        );
        if (!updated) {
          throw new MiniAppServiceError("too_many_screenshots", "Store listings can have at most 10 screenshots", 400);
        }
      }
      return serializeStoreAsset(asset.toObject());
    } catch (error) {
      await storage.deleteObject(storageKey).catch(() => {});
      if (asset) await MiniAppAssetModel.deleteOne({ _id: asset._id }).catch(() => {});
      throw error;
    }
  }

  async getStoreAsset(developer: DeveloperIdentity, packageName: string, assetId: string) {
    const app = await this.requireMiniApp(developer, normalizePackageName(packageName));
    const asset = await MiniAppAssetModel.findOne({
      _id: assetId,
      orgId: developer.orgId,
      miniAppId: app._id.toString(),
      role: { $in: ["store_icon", "store_cover", "gallery_screenshot"] },
    }).lean();
    if (!asset) throw new MiniAppServiceError("not_found", "Store asset not found", 404);
    return { asset, bytes: await storage.getObject(asset.storageKey) };
  }

  async deleteStoreAsset(developer: DeveloperIdentity, packageName: string, assetId: string) {
    const authorizedApp = await this.requireMiniApp(developer, normalizePackageName(packageName));
    return withStoreListingLease(authorizedApp._id.toString(), async lease => {
      const app = await MiniAppModel.findOne({
        _id: authorizedApp._id,
        orgId: developer.orgId,
        status: { $ne: "archived" },
      });
      if (!app) throw new MiniAppServiceError("not_found", "miniapp not found", 404);
      const asset = await MiniAppAssetModel.findOne({
        _id: assetId,
        orgId: developer.orgId,
        miniAppId: app._id.toString(),
        role: { $in: ["store_icon", "store_cover", "gallery_screenshot"] },
      });
      if (!asset) throw new MiniAppServiceError("not_found", "Store asset not found", 404);
      const publishedAssetIds = new Set([
        app.publishedStoreListing?.iconAssetId,
        app.publishedStoreListing?.coverAssetId,
        ...(app.publishedStoreListing?.screenshotAssetIds ?? []),
        app.publishedBetaStoreListing?.iconAssetId,
        app.publishedBetaStoreListing?.coverAssetId,
        ...(app.publishedBetaStoreListing?.screenshotAssetIds ?? []),
      ]);
      if (publishedAssetIds.has(assetId)) {
        throw new MiniAppServiceError(
          "published_asset",
          "Published Store artwork cannot be deleted until a replacement listing is published",
          409,
        );
      }
      const reviewSnapshot = await MiniAppReleaseModel.exists({
        miniAppId: app._id.toString(),
        status: { $in: ["submitted", "in_review", "accepted", "published"] },
        $or: [
          { "submittedStoreListing.iconAssetId": assetId },
          { "submittedStoreListing.coverAssetId": assetId },
          { "submittedStoreListing.screenshotAssetIds": assetId },
          { "reviewedStoreListing.iconAssetId": assetId },
          { "reviewedStoreListing.coverAssetId": assetId },
          { "reviewedStoreListing.screenshotAssetIds": assetId },
        ],
      });
      if (reviewSnapshot) {
        throw new MiniAppServiceError(
          "reviewed_asset",
          "Store artwork in a frozen review or publication revision cannot be deleted",
          409,
        );
      }
      // Fence the destructive object-store write by detaching every draft
      // reference in the same database write that proves this lease is still
      // ours. Even if this process pauses past the lease expiry while S3 is
      // deleting the object, a later submission can no longer freeze a
      // snapshot that references it.
      const detached = await MiniAppModel.updateOne(
        {
          _id: app._id,
          "storeListingOperationLease.token": lease.token,
          "storeListingOperationLease.expiresAt": { $gt: new Date() },
        },
        [
          {
            $set: {
            "storeListing.iconAssetId": {
              $cond: [{ $eq: ["$storeListing.iconAssetId", assetId] }, null, "$storeListing.iconAssetId"],
            },
            "storeListing.coverAssetId": {
              $cond: [{ $eq: ["$storeListing.coverAssetId", assetId] }, null, "$storeListing.coverAssetId"],
            },
            "storeListing.screenshotAssetIds": {
              $filter: {
                input: { $ifNull: ["$storeListing.screenshotAssetIds", []] },
                as: "screenshotAssetId",
                cond: { $ne: ["$$screenshotAssetId", assetId] },
              },
            },
            },
          },
        ],
      );
      if (detached.matchedCount !== 1) {
        throw new MiniAppServiceError("store_listing_lease_lost", "Store listing operation lease was lost", 409);
      }
      await storage.deleteObject(asset.storageKey);
      await asset.deleteOne();
      return { ok: true };
    });
  }

  private async getMiniAppById(developer: DeveloperIdentity, id: string) {
    const app = await MiniAppModel.findOne({ _id: id, orgId: developer.orgId }).lean();
    if (!app) throw new MiniAppServiceError("not_found", "miniapp not found", 404);
    return {
      id: app._id.toString(),
      packageName: app.packageName,
      name: app.displayName,
      description: app.description ?? null,
      storeListing: serializeStoreListing(app.storeListing),
      status: app.status,
      activeRelease: null,
      activeBetaRelease: null,
      latestRelease: null,
      releaseCount: 0,
      createdAt: app.createdAt?.toISOString() ?? null,
      updatedAt: app.updatedAt?.toISOString() ?? null,
    };
  }

  private async getMiniAppByPackageName(developer: DeveloperIdentity, packageName: string) {
    const app = await MiniAppModel.findOne({
      packageName: normalizePackageName(packageName),
      orgId: developer.orgId,
    }).lean();
    if (!app) throw new MiniAppServiceError("not_found", "miniapp not found", 404);
    return {
      id: app._id.toString(),
      packageName: app.packageName,
      name: app.displayName,
      description: app.description ?? null,
      storeListing: serializeStoreListing(app.storeListing),
      status: app.status,
      activeRelease: null,
      activeBetaRelease: null,
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
  releaseTrack?: string | null;
  status: string;
  releaseBundleAssetId?: string | null;
  bundleSha256?: string | null;
  bundleSizeBytes?: number | null;
  manifestSha256?: string | null;
  manifest?: unknown;
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
    releaseTrack: release.releaseTrack === "beta" ? "beta" : "stable",
    status: release.status,
    releaseBundleAssetId: release.releaseBundleAssetId ?? null,
    bundleSha256: release.bundleSha256 ?? null,
    bundleSizeBytes: release.bundleSizeBytes ?? null,
    manifestSha256: release.manifestSha256 ?? null,
    manifest: release.manifest ?? null,
    signingKeyId: release.signingKeyId ?? null,
    signedAt: release.signedAt?.toISOString() ?? null,
    reviewedBy: release.reviewedBy ?? null,
    reviewNotes: release.reviewNotes ?? null,
    createdAt: release.createdAt?.toISOString() ?? null,
    updatedAt: release.updatedAt?.toISOString() ?? null,
  };
}

function cleanText(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const cleaned = value.trim();
  if (cleaned.length > maxLength) {
    throw new MiniAppServiceError("text_too_long", `listing text cannot exceed ${maxLength} characters`, 400);
  }
  return cleaned || null;
}

interface StoreListingLease {
  token: string;
  assertHeld(): Promise<void>;
}

async function withStoreListingLease<T>(
  miniAppId: string,
  operation: (lease: StoreListingLease) => Promise<T>,
): Promise<T> {
  const token = ulid();
  const waitDeadline = Date.now() + STORE_LISTING_LEASE_WAIT_MS;
  while (Date.now() < waitDeadline) {
    const now = new Date();
    const locked = await MiniAppModel.findOneAndUpdate(
      {
        _id: miniAppId,
        $or: [
          { storeListingOperationLease: null },
          { storeListingOperationLease: { $exists: false } },
          { "storeListingOperationLease.expiresAt": { $lte: now } },
        ],
      },
      {
        $set: {
          storeListingOperationLease: {
            token,
            expiresAt: new Date(now.getTime() + STORE_LISTING_LEASE_MS),
          },
        },
      },
      { new: true },
    );
    if (locked) {
      let leaseLost = false;
      let renewalPending = false;
      const renew = async () => {
        if (renewalPending || leaseLost) return;
        renewalPending = true;
        try {
          const renewed = await MiniAppModel.updateOne(
            { _id: miniAppId, "storeListingOperationLease.token": token },
            { $set: { "storeListingOperationLease.expiresAt": new Date(Date.now() + STORE_LISTING_LEASE_MS) } },
          );
          if (renewed.matchedCount !== 1) leaseLost = true;
        } catch (error) {
          leaseLost = true;
          logger.error({ error, miniAppId }, "failed to renew Store listing operation lease");
        } finally {
          renewalPending = false;
        }
      };
      const renewalTimer = setInterval(() => void renew(), STORE_LISTING_LEASE_RENEW_MS);
      renewalTimer.unref?.();
      const lease: StoreListingLease = {
        token,
        async assertHeld() {
          if (leaseLost) {
            throw new MiniAppServiceError("store_listing_lease_lost", "Store listing operation lease was lost", 409);
          }
          const held = await MiniAppModel.exists({
            _id: miniAppId,
            "storeListingOperationLease.token": token,
            "storeListingOperationLease.expiresAt": { $gt: new Date() },
          });
          if (!held) {
            leaseLost = true;
            throw new MiniAppServiceError("store_listing_lease_lost", "Store listing operation lease was lost", 409);
          }
        },
      };
      try {
        await reconcilePendingStorePublication(miniAppId, lease);
        return await operation(lease);
      } finally {
        clearInterval(renewalTimer);
        await MiniAppModel.updateOne(
          { _id: miniAppId, "storeListingOperationLease.token": token },
          { $set: { storeListingOperationLease: null } },
        ).catch(error => logger.error({ error, miniAppId }, "failed to release Store listing operation lease"));
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new MiniAppServiceError(
    "store_listing_busy",
    "Store listing is busy; retry the operation",
    409,
  );
}

async function reconcilePendingStorePublication(miniAppId: string, lease: StoreListingLease): Promise<void> {
  const app = await MiniAppModel.findById(miniAppId).lean();
  const pending = app?.pendingStorePublication;
  if (!app || !pending) return;
  const release = await MiniAppReleaseModel.findById(pending.releaseId).lean();
  if (release?.status === "published") {
    const promoted = await promotePendingStorePublication({
      miniAppId,
      lease,
      releaseId: pending.releaseId,
      releaseTrack: pending.releaseTrack === "beta" ? "beta" : "stable",
      storeListing: serializeStoreListing(pending.storeListing),
    });
    if (!promoted) {
      throw new MiniAppServiceError("store_listing_lease_lost", "Store listing operation lease was lost", 409);
    }
    return;
  }
  const discarded = await MiniAppModel.updateOne(
    {
      _id: miniAppId,
      "storeListingOperationLease.token": lease.token,
      "storeListingOperationLease.expiresAt": { $gt: new Date() },
      "pendingStorePublication.releaseId": pending.releaseId,
    },
    { $set: { pendingStorePublication: null } },
  );
  if (discarded.matchedCount !== 1) {
    throw new MiniAppServiceError("store_listing_lease_lost", "Store listing operation lease was lost", 409);
  }
}

async function promotePendingStorePublication(input: {
  miniAppId: string;
  lease: StoreListingLease;
  releaseId: string;
  releaseTrack: "stable" | "beta";
  storeListing: ReturnType<typeof serializeStoreListing>;
}): Promise<boolean> {
  const activeField = input.releaseTrack === "beta" ? "activeBetaReleaseId" : "activeReleaseId";
  const listingField = input.releaseTrack === "beta" ? "publishedBetaStoreListing" : "publishedStoreListing";
  const promoted = await MiniAppModel.updateOne(
    {
      _id: input.miniAppId,
      "storeListingOperationLease.token": input.lease.token,
      "storeListingOperationLease.expiresAt": { $gt: new Date() },
      "pendingStorePublication.releaseId": input.releaseId,
      "pendingStorePublication.releaseTrack": input.releaseTrack,
    },
    {
      $set: {
        [activeField]: input.releaseId,
        [listingField]: input.storeListing,
        pendingStorePublication: null,
      },
    },
  );
  return promoted.matchedCount === 1;
}

function serializeStoreListing(listing: any) {
  return {
    subtitle: listing?.subtitle ?? null,
    longDescription: listing?.longDescription ?? null,
    categories: listing?.categories ?? [],
    privacyPolicyUrl: listing?.privacyPolicyUrl ?? null,
    supportUrl: listing?.supportUrl ?? null,
    websiteUrl: listing?.websiteUrl ?? null,
    reviewTier: listing?.reviewTier ?? "community",
    featured: listing?.featured === true,
    iconAssetId: listing?.iconAssetId ?? null,
    coverAssetId: listing?.coverAssetId ?? null,
    screenshotAssetIds: listing?.screenshotAssetIds ?? [],
  };
}

function storeListingAssetIds(listing: ReturnType<typeof serializeStoreListing>): Set<string> {
  return new Set(
    [listing.iconAssetId, listing.coverAssetId, ...listing.screenshotAssetIds]
      .filter((assetId): assetId is string => typeof assetId === "string" && assetId.length > 0),
  );
}

function storeListingReadiness(
  app: { description?: string | null; storeListing?: any } | null | undefined,
  assets: Array<{ _id: unknown; role: string }>,
): { ready: boolean; missing: string[] } {
  const listing = serializeStoreListing(app?.storeListing);
  const assetIds = new Set(assets.map(asset => String(asset._id)));
  const missing: string[] = [];
  if (!listing.iconAssetId || !assetIds.has(listing.iconAssetId)) missing.push("icon");
  if (!listing.longDescription?.trim()) missing.push("description");
  if (!listing.privacyPolicyUrl) missing.push("privacy policy URL");
  if (!listing.supportUrl) missing.push("support URL");
  return { ready: missing.length === 0, missing };
}

function serializeStoreAsset(asset: any) {
  return {
    id: String(asset._id),
    role: asset.role,
    fileName: asset.fileName,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    sortOrder: asset.sortOrder ?? null,
    createdAt: asset.createdAt?.toISOString() ?? null,
  };
}

function matchesImageSignature(bytes: Uint8Array, contentType: string): boolean {
  const startsWith = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (contentType === "image/png") return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (contentType === "image/jpeg") return startsWith(0xff, 0xd8, 0xff);
  if (contentType === "image/webp") {
    return (
      startsWith(0x52, 0x49, 0x46, 0x46) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  if (contentType === "image/avif") {
    if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return false;
    const header = Buffer.from(bytes.subarray(8, Math.min(bytes.length, 40))).toString("ascii");
    return header.includes("avif") || header.includes("avis");
  }
  return false;
}
