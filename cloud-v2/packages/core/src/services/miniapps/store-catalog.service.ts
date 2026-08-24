import { MiniAppAssetModel } from "../../models/miniapp-asset.model";
import { MiniAppModel } from "../../models/miniapp.model";
import { MiniAppReleaseModel } from "../../models/miniapp-release.model";

export interface StoreCatalogQuery {
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
    const publishedReleaseIds = (await MiniAppReleaseModel.distinct("_id", { status: "published" })).map(String);
    const filter: Record<string, unknown> = {
      status: "active",
      activeReleaseId: { $in: publishedReleaseIds },
    };
    const query = input.query?.trim();
    if (query) {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { displayName: { $regex: escaped, $options: "i" } },
        { packageName: { $regex: escaped, $options: "i" } },
        { description: { $regex: escaped, $options: "i" } },
        { "storeListing.subtitle": { $regex: escaped, $options: "i" } },
      ];
    }
    if (input.category?.trim()) filter["storeListing.categories"] = input.category.trim().toLowerCase();

    const total = await MiniAppModel.countDocuments(filter);
    const apps = await MiniAppModel.find(filter)
      .sort({ "storeListing.featured": -1, "displayName": 1, "packageName": 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    const entries = await this.serializeApps(apps, input.baseUrl);
    return { apps: entries, page, limit, total, hasMore: page * limit < total };
  }

  async get(packageName: string, baseUrl: string) {
    const app = await MiniAppModel.findOne({ packageName, status: "active", activeReleaseId: { $ne: null } }).lean();
    if (!app) throw new StoreCatalogError("not_found", "miniapp not found", 404);
    const [serialized] = await this.serializeApps([app], baseUrl);
    if (!serialized) throw new StoreCatalogError("not_found", "miniapp not found", 404);
    return serialized;
  }

  async getPublicAsset(assetId: string) {
    if (!/^[a-f0-9]{24}$/i.test(assetId)) throw new StoreCatalogError("not_found", "asset not found", 404);
    const asset = await MiniAppAssetModel.findOne({
      _id: assetId,
      role: { $in: ["store_icon", "store_cover", "gallery_screenshot", "promo_video"] },
    }).lean();
    if (!asset) throw new StoreCatalogError("not_found", "asset not found", 404);
    const app = await MiniAppModel.findOne({ _id: asset.miniAppId, status: "active" }).lean();
    if (!app?.activeReleaseId) throw new StoreCatalogError("not_found", "asset not found", 404);
    const publishedRelease = await MiniAppReleaseModel.exists({ _id: app.activeReleaseId, status: "published" });
    if (!publishedRelease) throw new StoreCatalogError("not_found", "asset not found", 404);
    const referenced = [
      app.storeListing?.iconAssetId,
      app.storeListing?.coverAssetId,
      ...(app.storeListing?.screenshotAssetIds ?? []),
    ].includes(assetId);
    if (!referenced) throw new StoreCatalogError("not_found", "asset not found", 404);
    return asset;
  }

  private async serializeApps(apps: Array<any>, baseUrl: string) {
    const releaseIds = apps.map(app => app.activeReleaseId).filter(Boolean);
    const releases = await MiniAppReleaseModel.find({ _id: { $in: releaseIds }, status: "published" }).lean();
    const releasesById = new Map(releases.map(release => [release._id.toString(), release]));
    const normalizedBase = baseUrl.replace(/\/$/, "");
    return apps.flatMap(app => {
      const release = releasesById.get(app.activeReleaseId ?? "");
      if (!release?.releaseBundleAssetId || !release.bundleSha256) return [];
      const listing = app.storeListing ?? {};
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
          release: {
            id: release._id.toString(),
            version: release.version,
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
