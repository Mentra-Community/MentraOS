import { MiniAppAssetModel } from "../../models/miniapp-asset.model";
import { MiniAppAccessInvitationModel } from "../../models/miniapp-access-invitation.model";
import { MiniAppBetaInvitationModel } from "../../models/miniapp-beta-invitation.model";
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
    const publicApprovedReleaseIds = await this.publicApprovedReleaseIds();
    const privateAuthorizedAppIds = await this.privateAuthorizedAppIds(input);
    const betaInvitationAppIds = await this.betaInvitationAuthorizedAppIds(input);
    const transitionAuthorizedBetaAppIds = new Set([...privateAuthorizedAppIds, ...betaInvitationAppIds]);
    const betaAuthorizedAppIds = await this.betaAuthorizedAppIds(input);
    const betaInstallAuthorizedAppIds = await this.betaAuthorizedAppIds(input, undefined, true);
    const betaEnrollmentAppIds = await this.betaEnrollmentAppIds(input, undefined, betaInstallAuthorizedAppIds);
    const betaSelections = await this.betaSelectedAppIds(input, publishedReleaseIds, betaInstallAuthorizedAppIds);
    const betaAppIds = await this.betaEligibleAppIds(
      betaSelections,
      publishedReleaseIds,
      publicApprovedReleaseIds,
      transitionAuthorizedBetaAppIds,
    );
    const betaOffers = await this.betaOfferAppIds(publishedReleaseIds, betaAuthorizedAppIds, betaAppIds);
    const betaOfferAppIds = await this.betaEligibleAppIds(
      betaOffers,
      publishedReleaseIds,
      publicApprovedReleaseIds,
      transitionAuthorizedBetaAppIds,
    );
    const betaDisplayAppIds = new Set([...betaAppIds, ...betaOfferAppIds]);
    const filter = this.catalogFilter(
      input,
      publishedReleaseIds,
      publicApprovedReleaseIds,
      privateAuthorizedAppIds,
      betaDisplayAppIds,
    );

    const total = await MiniAppModel.countDocuments(filter);
    const offset = (page - 1) * limit;
    const featuredFilter = this.featuredFilter(filter, betaDisplayAppIds, true);
    const featuredCount = await MiniAppModel.countDocuments(featuredFilter);
    const apps = await MiniAppModel.find(featuredFilter)
      .sort({ displayName: 1, packageName: 1 })
      .skip(Math.min(offset, featuredCount))
      .limit(limit)
      .lean();
    if (apps.length < limit) {
      const regularApps = await MiniAppModel.find(this.featuredFilter(filter, betaDisplayAppIds, false))
        .sort({ displayName: 1, packageName: 1 })
        .skip(Math.max(0, offset - featuredCount))
        .limit(limit - apps.length)
        .lean();
      apps.push(...regularApps);
    }
    const entries = await this.serializeApps(
      apps,
      input.baseUrl,
      betaAppIds,
      betaOfferAppIds,
      undefined,
      betaEnrollmentAppIds,
      betaAuthorizedAppIds,
      privateAuthorizedAppIds,
      transitionAuthorizedBetaAppIds,
    );
    return { apps: entries, page, limit, total, hasMore: page * limit < total };
  }

  async get(packageName: string, baseUrl: string, identity?: StoreCatalogIdentity) {
    const publishedReleaseIds = await this.publishedReleaseIds();
    const publicApprovedReleaseIds = await this.publicApprovedReleaseIds();
    const app = await MiniAppModel.findOne({ packageName, status: "active" }).lean();
    if (!app) throw new StoreCatalogError("not_found", "miniapp not found", 404);
    const privateAuthorizedAppIds = await this.privateAuthorizedAppIds(identity ?? {}, [app._id.toString()]);
    const betaInvitationAppIds = await this.betaInvitationAuthorizedAppIds(identity ?? {}, [app._id.toString()]);
    const transitionAuthorizedBetaAppIds = new Set([...privateAuthorizedAppIds, ...betaInvitationAppIds]);
    if (app.visibility === "private" && !privateAuthorizedAppIds.has(app._id.toString())) {
      throw new StoreCatalogError("not_found", "miniapp not found", 404);
    }
    const betaAuthorizedAppIds = await this.betaAuthorizedAppIds(identity ?? {}, [app._id.toString()]);
    const betaInstallAuthorizedAppIds = await this.betaAuthorizedAppIds(
      identity ?? {},
      [app._id.toString()],
      true,
    );
    const betaEnrollmentAppIds = identity
      ? await this.betaEnrollmentAppIds(identity, [app._id.toString()], betaInstallAuthorizedAppIds)
      : new Set<string>();
    const betaSelections = identity
      ? await this.betaSelectedAppIds(
          identity,
          publishedReleaseIds,
          betaInstallAuthorizedAppIds,
          [app._id.toString()],
        )
      : new Set<string>();
    const betaAppIds = await this.betaEligibleAppIds(
      betaSelections,
      publishedReleaseIds,
      publicApprovedReleaseIds,
      transitionAuthorizedBetaAppIds,
    );
    const betaOffers = await this.betaOfferAppIds(publishedReleaseIds, betaAuthorizedAppIds, betaAppIds, [
      app._id.toString(),
    ]);
    const betaOfferAppIds = await this.betaEligibleAppIds(
      betaOffers,
      publishedReleaseIds,
      publicApprovedReleaseIds,
      transitionAuthorizedBetaAppIds,
    );
    const [serialized] = await this.serializeApps(
      [app],
      baseUrl,
      betaAppIds,
      betaOfferAppIds,
      publishedReleaseIds,
      betaEnrollmentAppIds,
      betaAuthorizedAppIds,
      privateAuthorizedAppIds,
      transitionAuthorizedBetaAppIds,
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
    const appId = app._id.toString();
    if (app.visibility === "private" && !(await this.privateAuthorizedAppIds(identity, [appId])).has(appId)) {
      throw new StoreCatalogError("not_found", "miniapp not found", 404);
    }

    if (releaseTrack === "beta") {
      if (!app.activeBetaReleaseId || !app.publishedBetaStoreListing) {
        throw new StoreCatalogError("beta_unavailable", "this miniapp has no published beta release", 409);
      }
      const published = await MiniAppReleaseModel.findOne({
        _id: app.activeBetaReleaseId,
        status: "published",
      }).lean();
      if (!published) throw new StoreCatalogError("beta_unavailable", "this miniapp has no published beta release", 409);
      if (
        app.visibility !== "private" &&
        app.betaAccessMode === "public" &&
        !published.publicStoreApprovedAt &&
        !(await this.claimPrivateAccess(identity, appId)) &&
        !(await this.claimBetaAccess(identity, appId))
      ) {
        throw new StoreCatalogError("beta_unavailable", "this beta is awaiting public Store approval", 409);
      }
      const authorized = await this.betaAuthorizedAppIds(identity, [app._id.toString()]);
      if (!authorized.has(app._id.toString())) {
        throw new StoreCatalogError("beta_invitation_required", "this private beta requires a developer invitation", 403);
      }
      if (app.betaAccessMode !== "public") {
        const claimedInvitation = await MiniAppBetaInvitationModel.findOneAndUpdate(
          {
            miniAppId: app._id.toString(),
            mentraUserId: identity.mentraUserId,
            $or: [
              { status: "accepted" },
              { status: "pending", expiresAt: { $gt: new Date() } },
            ],
          },
          { $set: { status: "accepted", acceptedAt: new Date() } },
          { new: true },
        );
        if (!claimedInvitation) {
          throw new StoreCatalogError("beta_invitation_required", "this private beta requires a developer invitation", 403);
        }
      }
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
      const stillAuthorized = await this.betaAuthorizedAppIds(identity, [app._id.toString()], true);
      if (!stillAuthorized.has(app._id.toString())) {
        await MiniAppTrackEnrollmentModel.deleteOne({
          mentraUserId: identity.mentraUserId,
          miniAppId: app._id.toString(),
        });
        throw new StoreCatalogError("beta_invitation_required", "this private beta requires a developer invitation", 403);
      }
    } else {
      // For a beta-only miniapp, choosing stable means leaving the beta. The
      // catalog remains discoverable as a non-installable offer afterward.
      await MiniAppTrackEnrollmentModel.deleteOne({
        mentraUserId: identity.mentraUserId,
        miniAppId: app._id.toString(),
      });
    }

    return this.get(packageName, baseUrl, identity);
  }

  async getAsset(assetId: string, identity?: StoreCatalogIdentity) {
    if (!/^[a-f0-9]{24}$/i.test(assetId)) throw new StoreCatalogError("not_found", "asset not found", 404);
    const asset = await MiniAppAssetModel.findOne({
      _id: assetId,
      role: { $in: ["store_icon", "store_cover", "gallery_screenshot", "promo_video"] },
    }).lean();
    if (!asset) throw new StoreCatalogError("not_found", "asset not found", 404);
    const app = await MiniAppModel.findOne({ _id: asset.miniAppId, status: "active" }).lean();
    if (!app) throw new StoreCatalogError("not_found", "asset not found", 404);
    const activeReleaseIds = [app.activeReleaseId, app.activeBetaReleaseId].filter(
      (releaseId): releaseId is string => typeof releaseId === "string",
    );
    const referencedBy = (listing: typeof app.publishedStoreListing) =>
      [listing?.iconAssetId, listing?.coverAssetId, ...(listing?.screenshotAssetIds ?? [])].includes(assetId);
    const activeReleases = await MiniAppReleaseModel.find({
      _id: { $in: activeReleaseIds },
      status: "published",
    }).lean();
    const releaseById = new Map(activeReleases.map(release => [release._id.toString(), release]));
    const appInvitationAuthorized = Boolean(
      identity && (await this.privateAuthorizedAppIds(identity, [app._id.toString()])).has(app._id.toString()),
    );
    const betaInvitationAuthorized = Boolean(
      identity && (await this.betaInvitationAuthorizedAppIds(identity, [app._id.toString()])).has(app._id.toString()),
    );
    const stableRelease = app.activeReleaseId ? releaseById.get(app.activeReleaseId) : null;
    const betaRelease = app.activeBetaReleaseId ? releaseById.get(app.activeBetaReleaseId) : null;
    const referencedByStable = Boolean(
      stableRelease &&
        (stableRelease.publicStoreApprovedAt || appInvitationAuthorized) &&
        referencedBy(app.publishedStoreListing),
    );
    const betaDistributionAuthorized =
      app.visibility === "private"
        ? appInvitationAuthorized
        : app.betaAccessMode === "public"
          ? Boolean(betaRelease?.publicStoreApprovedAt) || appInvitationAuthorized || betaInvitationAuthorized
          : betaInvitationAuthorized;
    const referencedByBeta =
      Boolean(betaRelease) && betaDistributionAuthorized && referencedBy(app.publishedBetaStoreListing);
    if (!referencedByStable && !referencedByBeta) {
      throw new StoreCatalogError("not_found", "asset not found", 404);
    }
    return {
      ...asset,
      cacheControl:
        app.visibility !== "private" && referencedByStable && Boolean(stableRelease?.publicStoreApprovedAt)
          ? "public, max-age=31536000, immutable"
          : "private, no-store",
    };
  }

  /** Anonymous artwork lookup retained for public Store and regression callers. */
  async getPublicAsset(assetId: string) {
    return this.getAsset(assetId);
  }

  /** Resolve a Store bundle while re-checking the user's current track access. */
  async getBundleAsset(assetId: string, identity: StoreCatalogIdentity) {
    if (!/^[a-f0-9]{24}$/i.test(assetId)) throw new StoreCatalogError("not_found", "bundle not found", 404);
    const asset = await MiniAppAssetModel.findOne({ _id: assetId, role: "release_bundle" }).lean();
    if (!asset) throw new StoreCatalogError("not_found", "bundle not found", 404);
    const release = await MiniAppReleaseModel.findOne({
      releaseBundleAssetId: assetId,
      status: "published",
    }).lean();
    if (!release) throw new StoreCatalogError("not_found", "bundle not found", 404);
    const app = await MiniAppModel.findOne({ _id: release.miniAppId, status: "active" }).lean();
    if (!app) throw new StoreCatalogError("not_found", "bundle not found", 404);
    const appId = app._id.toString();
    const appInvitationAuthorized = await this.claimPrivateAccess(identity, appId);
    if (app.visibility === "private" && !appInvitationAuthorized) {
      throw new StoreCatalogError("not_found", "bundle not found", 404);
    }

    if (release.releaseTrack === "beta") {
      const betaInvitationAuthorized = (
        await this.betaInvitationAuthorizedAppIds(identity, [appId], true)
      ).has(appId);
      const betaDistributionAuthorized =
        app.visibility === "private"
          ? appInvitationAuthorized
          : app.betaAccessMode === "public"
            ? Boolean(release.publicStoreApprovedAt) || appInvitationAuthorized || betaInvitationAuthorized
            : betaInvitationAuthorized;
      if (
        app.activeBetaReleaseId !== release._id.toString() ||
        !app.publishedBetaStoreListing ||
        !betaDistributionAuthorized ||
        !(await this.betaEnrollmentAppIds(identity, [appId])).has(appId)
      ) {
        throw new StoreCatalogError("not_found", "bundle not found", 404);
      }
    } else if (
      app.activeReleaseId !== release._id.toString() ||
      !app.publishedStoreListing ||
      (!release.publicStoreApprovedAt && !appInvitationAuthorized)
    ) {
      throw new StoreCatalogError("not_found", "bundle not found", 404);
    }
    return asset;
  }

  private async publishedReleaseIds(): Promise<string[]> {
    return (await MiniAppReleaseModel.distinct("_id", { status: "published" })).map(String);
  }

  private async publicApprovedReleaseIds(): Promise<string[]> {
    return (
      await MiniAppReleaseModel.distinct("_id", { status: "published", publicStoreApprovedAt: { $ne: null } })
    ).map(String);
  }

  private async betaSelectedAppIds(
    identity: Pick<StoreCatalogQuery, "mentraUserId" | "tenantId">,
    publishedReleaseIds: string[],
    authorizedAppIds: Set<string>,
    restrictToAppIds?: string[],
  ): Promise<Set<string>> {
    if (!identity.mentraUserId || !identity.tenantId || authorizedAppIds.size === 0) return new Set();
    const eligibleAppIds = restrictToAppIds
      ? restrictToAppIds.filter(id => authorizedAppIds.has(id))
      : [...authorizedAppIds];
    if (eligibleAppIds.length === 0) return new Set();
    const enrollmentFilter: Record<string, unknown> = {
      mentraUserId: identity.mentraUserId,
      tenantId: identity.tenantId,
      releaseTrack: "beta",
      miniAppId: { $in: eligibleAppIds },
    };
    const enrolledAppIds = await MiniAppTrackEnrollmentModel.distinct("miniAppId", enrollmentFilter);
    const selected = await MiniAppModel.distinct("_id", {
      _id: { $in: enrolledAppIds },
      status: "active",
      activeBetaReleaseId: { $in: publishedReleaseIds },
      publishedBetaStoreListing: { $ne: null },
    });
    return new Set(selected.map(String));
  }

  /** Beta-only listings remain discoverable, but carry no install capability until enrollment. */
  private async betaOfferAppIds(
    publishedReleaseIds: string[],
    authorizedAppIds: Set<string>,
    selectedAppIds: Set<string>,
    restrictToAppIds?: string[],
  ): Promise<Set<string>> {
    const eligibleAppIds = restrictToAppIds
      ? restrictToAppIds.filter(id => authorizedAppIds.has(id) && !selectedAppIds.has(id))
      : [...authorizedAppIds].filter(id => !selectedAppIds.has(id));
    if (eligibleAppIds.length === 0) return new Set();
    const offers = await MiniAppModel.distinct("_id", {
      _id: { $in: eligibleAppIds },
      status: "active",
      activeBetaReleaseId: { $in: publishedReleaseIds },
      publishedBetaStoreListing: { $ne: null },
      $or: [{ activeReleaseId: { $nin: publishedReleaseIds } }, { publishedStoreListing: null }],
    });
    return new Set(offers.map(String));
  }

  private async betaEnrollmentAppIds(
    identity: Pick<StoreCatalogQuery, "mentraUserId" | "tenantId">,
    restrictToAppIds?: string[],
    authorizedAppIds?: Set<string>,
  ): Promise<Set<string>> {
    if (!identity.mentraUserId || !identity.tenantId) return new Set();
    const filter: Record<string, unknown> = {
      mentraUserId: identity.mentraUserId,
      tenantId: identity.tenantId,
      releaseTrack: "beta",
    };
    const eligibleIds = restrictToAppIds
      ? authorizedAppIds
        ? restrictToAppIds.filter(id => authorizedAppIds.has(id))
        : restrictToAppIds
      : authorizedAppIds
        ? [...authorizedAppIds]
        : undefined;
    if (eligibleIds) filter.miniAppId = { $in: eligibleIds };
    return new Set((await MiniAppTrackEnrollmentModel.distinct("miniAppId", filter)).map(String));
  }

  private async betaAuthorizedAppIds(
    identity: Pick<StoreCatalogQuery, "mentraUserId" | "tenantId">,
    restrictToAppIds?: string[],
    acceptedOnly = false,
  ): Promise<Set<string>> {
    const appFilter: Record<string, unknown> = { status: "active", betaAccessMode: "public" };
    if (restrictToAppIds) appFilter._id = { $in: restrictToAppIds };
    const authorized = new Set((await MiniAppModel.distinct("_id", appFilter)).map(String));
    if (!identity.mentraUserId || !identity.tenantId) return authorized;

    const invitationFilter: Record<string, unknown> = {
      mentraUserId: identity.mentraUserId,
      ...(acceptedOnly
        ? { status: "accepted" }
        : {
            $or: [
              { status: "accepted" },
              { status: "pending", expiresAt: { $gt: new Date() } },
            ],
          }),
    };
    if (restrictToAppIds) invitationFilter.miniAppId = { $in: restrictToAppIds };
    for (const id of await MiniAppBetaInvitationModel.distinct("miniAppId", invitationFilter)) {
      authorized.add(String(id));
    }
    return authorized;
  }

  private async betaInvitationAuthorizedAppIds(
    identity: Pick<StoreCatalogQuery, "mentraUserId" | "tenantId">,
    restrictToAppIds?: string[],
    acceptedOnly = false,
  ): Promise<Set<string>> {
    if (!identity.mentraUserId || !identity.tenantId) return new Set();
    const invitationFilter: Record<string, unknown> = {
      mentraUserId: identity.mentraUserId,
      ...(acceptedOnly
        ? { status: "accepted" }
        : { $or: [{ status: "accepted" }, { status: "pending", expiresAt: { $gt: new Date() } }] }),
    };
    if (restrictToAppIds) invitationFilter.miniAppId = { $in: restrictToAppIds };
    return new Set((await MiniAppBetaInvitationModel.distinct("miniAppId", invitationFilter)).map(String));
  }

  private async privateAuthorizedAppIds(
    identity: Pick<StoreCatalogQuery, "mentraUserId" | "tenantId">,
    restrictToAppIds?: string[],
    acceptedOnly = false,
  ): Promise<Set<string>> {
    if (!identity.mentraUserId || !identity.tenantId) return new Set();
    const filter: Record<string, unknown> = {
      mentraUserId: identity.mentraUserId,
      ...(acceptedOnly
        ? { status: "accepted" }
        : { $or: [{ status: "accepted" }, { status: "pending", expiresAt: { $gt: new Date() } }] }),
    };
    if (restrictToAppIds) filter.miniAppId = { $in: restrictToAppIds };
    return new Set((await MiniAppAccessInvitationModel.distinct("miniAppId", filter)).map(String));
  }

  private async claimPrivateAccess(identity: StoreCatalogIdentity, miniAppId: string): Promise<boolean> {
    return Boolean(
      await MiniAppAccessInvitationModel.findOneAndUpdate(
        {
          miniAppId,
          mentraUserId: identity.mentraUserId,
          $or: [{ status: "accepted" }, { status: "pending", expiresAt: { $gt: new Date() } }],
        },
        { $set: { status: "accepted", acceptedAt: new Date() } },
        { new: true },
      ).lean(),
    );
  }

  private async claimBetaAccess(identity: StoreCatalogIdentity, miniAppId: string): Promise<boolean> {
    return Boolean(
      await MiniAppBetaInvitationModel.findOneAndUpdate(
        {
          miniAppId,
          mentraUserId: identity.mentraUserId,
          $or: [{ status: "accepted" }, { status: "pending", expiresAt: { $gt: new Date() } }],
        },
        { $set: { status: "accepted", acceptedAt: new Date() } },
        { new: true },
      ).lean(),
    );
  }

  private async betaEligibleAppIds(
    candidateIds: Set<string>,
    publishedReleaseIds: string[],
    publicApprovedReleaseIds: string[],
    transitionAuthorizedAppIds: Set<string> = new Set(),
  ): Promise<Set<string>> {
    if (candidateIds.size === 0) return new Set();
    const ids = await MiniAppModel.distinct("_id", {
      _id: { $in: [...candidateIds] },
      status: "active",
      publishedBetaStoreListing: { $ne: null },
      $or: [
        { visibility: "private", activeBetaReleaseId: { $in: publishedReleaseIds } },
        { visibility: { $ne: "private" }, betaAccessMode: "private", activeBetaReleaseId: { $in: publishedReleaseIds } },
        { visibility: { $ne: "private" }, betaAccessMode: "public", activeBetaReleaseId: { $in: publicApprovedReleaseIds } },
        {
          _id: { $in: [...transitionAuthorizedAppIds] },
          visibility: { $ne: "private" },
          betaAccessMode: "public",
          activeBetaReleaseId: { $in: publishedReleaseIds },
        },
      ],
    });
    return new Set(ids.map(String));
  }

  private catalogFilter(
    input: StoreCatalogQuery,
    publishedReleaseIds: string[],
    publicApprovedReleaseIds: string[],
    privateAuthorizedAppIds: Set<string>,
    betaAppIds: Set<string>,
  ) {
    const selectedBetaIds = [...betaAppIds];
    const betaClause = this.selectionClause(
      {
        _id: { $in: selectedBetaIds },
        publishedBetaStoreListing: { $ne: null },
        $or: [
          {
            visibility: "private",
            _id: { $in: [...privateAuthorizedAppIds] },
            activeBetaReleaseId: { $in: publishedReleaseIds },
          },
          {
            visibility: { $ne: "private" },
            betaAccessMode: "private",
            activeBetaReleaseId: { $in: publishedReleaseIds },
          },
          {
            visibility: { $ne: "private" },
            betaAccessMode: "public",
            activeBetaReleaseId: { $in: publicApprovedReleaseIds },
          },
        ],
      },
      "publishedBetaStoreListing",
      input,
    );
    const stableClause = this.selectionClause(
      {
        ...(selectedBetaIds.length > 0 ? { _id: { $nin: selectedBetaIds } } : {}),
        publishedStoreListing: { $ne: null },
        $or: [
          {
            visibility: "private",
            _id: { $in: [...privateAuthorizedAppIds] },
            activeReleaseId: { $in: publishedReleaseIds },
          },
          { visibility: { $ne: "private" }, activeReleaseId: { $in: publicApprovedReleaseIds } },
          {
            visibility: { $ne: "private" },
            _id: { $in: [...privateAuthorizedAppIds] },
            activeReleaseId: { $in: publishedReleaseIds },
          },
        ],
      },
      "publishedStoreListing",
      input,
    );
    return {
      status: "active",
      $and: [
        {
          $or: [
            { visibility: { $ne: "private" } },
            { visibility: "private", _id: { $in: [...privateAuthorizedAppIds] } },
          ],
        },
      ],
      $or: selectedBetaIds.length > 0 ? [betaClause, stableClause] : [stableClause],
    };
  }

  private featuredFilter(filter: Record<string, unknown>, betaAppIds: Set<string>, featured: boolean) {
    const selectedBetaIds = [...betaAppIds];
    const expected = featured ? true : { $ne: true };
    const clauses: Record<string, unknown>[] = [];
    if (selectedBetaIds.length > 0) {
      clauses.push({ _id: { $in: selectedBetaIds }, "publishedBetaStoreListing.featured": expected });
    }
    clauses.push({
      ...(selectedBetaIds.length > 0 ? { _id: { $nin: selectedBetaIds } } : {}),
      "publishedStoreListing.featured": expected,
    });
    return { $and: [filter, { $or: clauses }] };
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
    betaOfferAppIds: Set<string>,
    knownPublishedReleaseIds?: string[],
    betaEnrollmentAppIds: Set<string> = betaAppIds,
    betaAuthorizedAppIds: Set<string> = betaAppIds,
    privateAuthorizedAppIds: Set<string> = new Set(),
    transitionAuthorizedBetaAppIds: Set<string> = new Set(),
  ) {
    const betaDisplayAppIds = new Set([...betaAppIds, ...betaOfferAppIds]);
    const releaseIds = apps.flatMap(app => [app.activeReleaseId, app.activeBetaReleaseId]).filter(Boolean);
    const releases = await MiniAppReleaseModel.find({ _id: { $in: releaseIds }, status: "published" }).lean();
    const releasesById = new Map(releases.map(release => [release._id.toString(), release]));
    const publishedIds = new Set(knownPublishedReleaseIds ?? (await this.publishedReleaseIds()));
    const normalizedBase = baseUrl.replace(/\/$/, "");
    return apps.flatMap(app => {
      const appId = app._id.toString();
      const selectedTrack: StoreReleaseTrack = betaDisplayAppIds.has(appId) ? "beta" : "stable";
      const installable = !betaOfferAppIds.has(appId);
      const releaseId = selectedTrack === "beta" ? app.activeBetaReleaseId : app.activeReleaseId;
      const release = releasesById.get(releaseId ?? "");
      if (!release?.releaseBundleAssetId || !release.bundleSha256) return [];
      const privateDistribution =
        app.visibility === "private" ||
        (selectedTrack === "stable" && privateAuthorizedAppIds.has(appId)) ||
        (selectedTrack === "beta" &&
          (app.betaAccessMode !== "public" || transitionAuthorizedBetaAppIds.has(appId)));
      if (!privateDistribution && !release.publicStoreApprovedAt) return [];
      const listing = selectedTrack === "beta" ? app.publishedBetaStoreListing : app.publishedStoreListing;
      if (!listing) return [];
      const stableRelease = releasesById.get(String(app.activeReleaseId ?? ""));
      const betaRelease = releasesById.get(String(app.activeBetaReleaseId ?? ""));
      const hasPublishedBeta = Boolean(
        app.publishedBetaStoreListing &&
          app.activeBetaReleaseId &&
          publishedIds.has(String(app.activeBetaReleaseId)) &&
          (app.visibility === "private" ||
            app.betaAccessMode !== "public" ||
            betaRelease?.publicStoreApprovedAt ||
            transitionAuthorizedBetaAppIds.has(appId)),
      );
      const canAccessBeta = hasPublishedBeta && betaAuthorizedAppIds.has(app._id.toString());
      const hasPublishedStable = Boolean(
        app.publishedStoreListing &&
          app.activeReleaseId &&
          publishedIds.has(String(app.activeReleaseId)) &&
          (app.visibility === "private" ||
            stableRelease?.publicStoreApprovedAt ||
            privateAuthorizedAppIds.has(appId)),
      );
      const publicArtworkListing =
        app.visibility !== "private" && selectedTrack === "beta" && app.betaAccessMode !== "public"
          ? hasPublishedStable
            ? app.publishedStoreListing
            : null
          : listing;
      const assetUrl = (id?: string | null) => (id ? `${normalizedBase}/api/store/assets/${id}` : null);
      const manifest = (release.manifest ?? {}) as Record<string, unknown>;
      return [
        {
          packageName: app.packageName,
          visibility: app.visibility === "private" ? "private" : "public",
          name: app.displayName,
          subtitle: listing.subtitle ?? app.description ?? null,
          description: listing.longDescription ?? app.description ?? null,
          categories: listing.categories ?? [],
          privacyPolicyUrl: listing.privacyPolicyUrl ?? null,
          supportUrl: listing.supportUrl ?? null,
          websiteUrl: listing.websiteUrl ?? null,
          reviewTier: listing.reviewTier ?? "community",
          featured: listing.featured === true,
          iconUrl: assetUrl(publicArtworkListing?.iconAssetId),
          coverUrl: assetUrl(publicArtworkListing?.coverAssetId),
          screenshotUrls: (publicArtworkListing?.screenshotAssetIds ?? []).map((id: string) => assetUrl(id)),
          selectedTrack,
          preferredTrack: betaEnrollmentAppIds.has(appId) ? "beta" : "stable",
          betaAccess: canAccessBeta ? (app.betaAccessMode === "public" ? "public" : "invited") : null,
          availableTracks: [
            ...(hasPublishedStable ? ["stable"] : []),
            ...(canAccessBeta ? ["beta"] : []),
          ],
          release: {
            id: release._id.toString(),
            version: release.version,
            track: selectedTrack,
            installable,
            bundleUrl: installable
              ? `${normalizedBase}/api/store/bundles/${release.releaseBundleAssetId}/download`
              : null,
            bundleSha256: installable ? release.bundleSha256 : null,
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
