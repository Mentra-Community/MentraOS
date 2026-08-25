import { MiniAppAssetModel } from "../../models/miniapp-asset.model";
import { MiniAppModel } from "../../models/miniapp.model";
import { MiniAppReleaseModel } from "../../models/miniapp-release.model";
import { MiniAppTrackEnrollmentModel } from "../../models/miniapp-track-enrollment.model";

export type StoreReleaseTrack = "stable" | "beta";

export interface StoreCatalogIdentity {
  mentraUserId: string;
  tenantId: string;
}

export interface StoreCatalogQuery {
  mentraUserId?: string;
  tenantId?: string;
  baseUrl: string;
  query?: string;
  category?: string;
  page?: number;
  limit?: number;
}

export class StoreCatalogService {
  async list(input: StoreCatalogQuery) {
    const limit = Math.min(Math.max(input.limit ?? 24, 1), 50);
    const page = Math.max(input.page ?? 1, 1);
    const publishedReleaseIds = await this.publishedReleaseIds();
    const betaEnrollmentAppIds = await this.betaEnrollmentAppIds(input);
    const betaAppIds = await this.betaSelectedAppIds(input, publishedReleaseIds);
    const filter = this.catalogFilter(input, publishedReleaseIds, betaAppIds);

    const total = await MiniAppModel.countDocuments(filter);
    const apps = await MiniAppModel.find(filter)
      .sort({ "publishedStoreListing.featured": -1, "displayName": 1, "packageName": 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const entries = await this.serializeApps(apps, input.baseUrl, betaAppIds, undefined, betaEnrollmentAppIds);
    return { apps: entries, page, limit, total, hasMore: page * limit < total };
  }

  async get(packageName: string, baseUrl: string, identity?: StoreCatalogIdentity) {
    const publishedReleaseIds = await this.publishedReleaseIds();
    const app = await MiniAppModel.findOne({ packageName, status: "active" }).lean();
    if (!app) throw new StoreCatalogError("not_found", "miniapp not found", 404);
    const betaEnrollmentAppIds = identity
      ? await this.betaEnrollmentAppIds(identity, [app._id.toString()])
      : new Set<string>();
    const betaAppIds = identity
      ? await this.betaSelectedAppIds(identity, publishedReleaseIds, [app._id.toString()])
      : new Set<string>();
    const [serialized] = await this.serializeApps(
      [app],
      baseUrl,
      betaAppIds,
      publishedReleaseIds,
      betaEnrollmentAppIds,
    );
    if (!serialized) throw new StoreCatalogError("not_found", "miniapp not found", 404);
    return serialized;
  }

  async setReleaseTrack(
    packageName: string,
    releaseTrack: StoreReleaseTrack,
    identity: StoreCatalogIdentity,
    baseUrl: string,
  ) {
    const app = await MiniAppModel.findOne({ packageName, status: "active" }).lean();
    if (!app) throw new StoreCatalogError("not_found", "miniapp not found", 404);

    if (releaseTrack === "beta") {
      if (!app.activeBetaReleaseId) {
        throw new StoreCatalogError("beta_unavailable", "this miniapp has no published beta release", 409);
      }
      const published = await MiniAppReleaseModel.exists({ _id: app.activeBetaReleaseId, status: "published" });
      if (!published) throw new StoreCatalogError("beta_unavailable", "this miniapp has no published beta release", 409);
      await MiniAppTrackEnrollmentModel.updateOne(
        { mentraUserId: identity.mentraUserId, miniAppId: app._id.toString() },
        {
          $set: {
            tenantId: identity.tenantId,
            packageName: app.packageName,
            releaseTrack: "beta",
          },
          $setOnInsert: { mentraUserId: identity.mentraUserId, miniAppId: app._id.toString() },
        },
        { upsert: true },
      );
    } else {
      await MiniAppTrackEnrollmentModel.deleteOne({
        mentraUserId: identity.mentraUserId,
        miniAppId: app._id.toString(),
      });
    }

    return this.get(packageName, baseUrl, identity);
  }

  async getPublicAsset(assetId: string) {
    if (!/^[a-f0-9]{24}$/i.test(assetId)) throw new StoreCatalogError("not_found", "asset not found", 404);
    const asset = await MiniAppAssetModel.findOne({
      _id: assetId,
      role: { $in: ["store_icon", "store_cover", "gallery_screenshot", "promo_video"] },
    }).lean();
    if (!asset) throw new StoreCatalogError("not_found", "asset not found", 404);
    const app = await MiniAppModel.findOne({ _id: asset.miniAppId, status: "active" }).lean();
    if (!app) throw new StoreCatalogError("not_found", "asset not found", 404);
    const activeReleaseIds = [app.activeReleaseId, app.activeBetaReleaseId].filter(Boolean);
    const publishedRelease = await MiniAppReleaseModel.exists({ _id: { $in: activeReleaseIds }, status: "published" });
    if (!publishedRelease) throw new StoreCatalogError("not_found", "asset not found", 404);
    const referenced = [app.publishedStoreListing, app.publishedBetaStoreListing].some(listing =>
      [listing?.iconAssetId, listing?.coverAssetId, ...(listing?.screenshotAssetIds ?? [])].includes(assetId),
    );
    if (!referenced) throw new StoreCatalogError("not_found", "asset not found", 404);
    return asset;
  }

  private async publishedReleaseIds(): Promise<string[]> {
    return (await MiniAppReleaseModel.distinct("_id", { status: "published" })).map(String);
  }

  private async betaSelectedAppIds(
    identity: Pick<StoreCatalogQuery, "mentraUserId" | "tenantId">,
    publishedReleaseIds: string[],
    restrictToAppIds?: string[],
  ): Promise<Set<string>> {
    if (!identity.mentraUserId || !identity.tenantId) return new Set();
    const enrollmentFilter: Record<string, unknown> = {
      mentraUserId: identity.mentraUserId,
      tenantId: identity.tenantId,
      releaseTrack: "beta",
    };
    if (restrictToAppIds) enrollmentFilter.miniAppId = { $in: restrictToAppIds };
    const enrolledAppIds = await MiniAppTrackEnrollmentModel.distinct("miniAppId", enrollmentFilter);
    if (enrolledAppIds.length === 0) return new Set();
    const selected = await MiniAppModel.distinct("_id", {
      _id: { $in: enrolledAppIds },
      status: "active",
      activeBetaReleaseId: { $in: publishedReleaseIds },
    });
    return new Set(selected.map(String));
  }

  private async betaEnrollmentAppIds(
    identity: Pick<StoreCatalogQuery, "mentraUserId" | "tenantId">,
    restrictToAppIds?: string[],
  ): Promise<Set<string>> {
    if (!identity.mentraUserId || !identity.tenantId) return new Set();
    const filter: Record<string, unknown> = {
      mentraUserId: identity.mentraUserId,
      tenantId: identity.tenantId,
      releaseTrack: "beta",
    };
    if (restrictToAppIds) filter.miniAppId = { $in: restrictToAppIds };
    return new Set((await MiniAppTrackEnrollmentModel.distinct("miniAppId", filter)).map(String));
  }

  private catalogFilter(input: StoreCatalogQuery, publishedReleaseIds: string[], betaAppIds: Set<string>) {
    const selectedBetaIds = [...betaAppIds];
    const betaClause = this.selectionClause(
      { _id: { $in: selectedBetaIds }, activeBetaReleaseId: { $in: publishedReleaseIds } },
      "publishedBetaStoreListing",
      input,
    );
    const stableClause = this.selectionClause(
      {
        ...(selectedBetaIds.length > 0 ? { _id: { $nin: selectedBetaIds } } : {}),
        activeReleaseId: { $in: publishedReleaseIds },
      },
      "publishedStoreListing",
      input,
    );
    return {
      status: "active",
      $or: selectedBetaIds.length > 0 ? [betaClause, stableClause] : [stableClause],
    };
  }

  private selectionClause(
    availability: Record<string, unknown>,
    listingField: "publishedStoreListing" | "publishedBetaStoreListing",
    input: Pick<StoreCatalogQuery, "query" | "category">,
  ) {
    const conditions: Record<string, unknown>[] = [availability];
    const query = input.query?.trim();
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      conditions.push({
        $or: [
          { displayName: { $regex: escaped, $options: "i" } },
          { packageName: { $regex: escaped, $options: "i" } },
          { description: { $regex: escaped, $options: "i" } },
          { [`${listingField}.subtitle`]: { $regex: escaped, $options: "i" } },
        ],
      });
    }
    if (input.category?.trim()) {
      conditions.push({ [`${listingField}.categories`]: input.category.trim().toLowerCase() });
    }
    return conditions.length === 1 ? availability : { $and: conditions };
  }

  private async serializeApps(
    apps: Array<any>,
    baseUrl: string,
    betaAppIds: Set<string>,
    knownPublishedReleaseIds?: string[],
    betaEnrollmentAppIds: Set<string> = betaAppIds,
  ) {
    const releaseIds = apps
      .map(app => (betaAppIds.has(app._id.toString()) ? app.activeBetaReleaseId : app.activeReleaseId))
      .filter(Boolean);
    const releases = await MiniAppReleaseModel.find({ _id: { $in: releaseIds }, status: "published" }).lean();
    const releasesById = new Map(releases.map(release => [release._id.toString(), release]));
    const publishedIds = new Set(knownPublishedReleaseIds ?? (await this.publishedReleaseIds()));
    const normalizedBase = baseUrl.replace(/\/$/, "");
    return apps.flatMap(app => {
      const selectedTrack: StoreReleaseTrack = betaAppIds.has(app._id.toString()) ? "beta" : "stable";
      const releaseId = selectedTrack === "beta" ? app.activeBetaReleaseId : app.activeReleaseId;
      const release = releasesById.get(releaseId ?? "");
      if (!release?.releaseBundleAssetId || !release.bundleSha256) return [];
      const listing = selectedTrack === "beta" ? app.publishedBetaStoreListing ?? {} : app.publishedStoreListing ?? {};
      const hasPublishedBeta = Boolean(app.activeBetaReleaseId && publishedIds.has(String(app.activeBetaReleaseId)));
      const hasPublishedStable = Boolean(app.activeReleaseId && publishedIds.has(String(app.activeReleaseId)));
      const assetUrl = (id?: string | null) => (id ? `${normalizedBase}/api/store/assets/${id}` : null);
      const manifest = (release.manifest ?? {}) as Record<string, unknown>;
      return [
        {
          packageName: app.packageName,
          name: app.displayName,
          subtitle: listing.subtitle ?? app.description ?? null,
          description: listing.longDescription ?? app.description ?? null,
          categories: listing.categories ?? [],
          privacyPolicyUrl: listing.privacyPolicyUrl ?? null,
          supportUrl: listing.supportUrl ?? null,
          websiteUrl: listing.websiteUrl ?? null,
          reviewTier: listing.reviewTier ?? "community",
          featured: listing.featured === true,
          iconUrl: assetUrl(listing.iconAssetId),
          coverUrl: assetUrl(listing.coverAssetId),
          screenshotUrls: (listing.screenshotAssetIds ?? []).map((id: string) => assetUrl(id)),
          selectedTrack,
          preferredTrack: betaEnrollmentAppIds.has(app._id.toString()) ? "beta" : "stable",
          availableTracks: [
            ...(hasPublishedStable ? ["stable"] : []),
            ...(hasPublishedBeta ? ["beta"] : []),
          ],
          release: {
            id: release._id.toString(),
            version: release.version,
            track: selectedTrack,
            bundleUrl: `${normalizedBase}/api/client/miniapps/bundles/${release.releaseBundleAssetId}/download`,
            bundleSha256: release.bundleSha256,
            manifestSha256: release.manifestSha256 ?? null,
            publishedAt: release.publishedAt?.toISOString() ?? null,
            permissions: manifest.permissions ?? [],
            hardwareRequirements: manifest.hardwareRequirements ?? [],
            minHostVersion: manifest.minHostVersion ?? null,
            sdkVersion: manifest.sdkVersion ?? null,
          },
        },
      ];
    });
  }
}

export class StoreCatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "StoreCatalogError";
  }
}
