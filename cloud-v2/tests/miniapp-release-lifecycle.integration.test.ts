/**
 * @fileoverview Miniapp release lifecycle integration tests.
 *
 * Exercises the developer-facing release flow and the admin review/publish
 * flow without relying on a WorkOS browser session. A running local Mongo is
 * required; the test uses its own database and wipes only the involved
 * collections.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.CLOUD_CORE_LOCAL_STORAGE_DIR = join(tmpdir(), `mentra-miniapp-release-test-${process.pid}`);

import { connectMongo, disconnectMongo } from "../packages/core/src/connections/mongo.connection";
import { MiniAppAssetModel } from "../packages/core/src/models/miniapp-asset.model";
import { MiniAppAccessInvitationModel } from "../packages/core/src/models/miniapp-access-invitation.model";
import { MiniAppBetaInvitationModel } from "../packages/core/src/models/miniapp-beta-invitation.model";
import { MiniAppModel } from "../packages/core/src/models/miniapp.model";
import { MiniAppReleaseModel } from "../packages/core/src/models/miniapp-release.model";
import { MiniAppTrackEnrollmentModel } from "../packages/core/src/models/miniapp-track-enrollment.model";
import { DeveloperSigningKeyModel } from "../packages/core/src/models/developer-signing-key.model";
import { PreinstalledRegistryModel } from "../packages/core/src/models/preinstalled-registry.model";
import { PreinstalledRegistryRevisionModel } from "../packages/core/src/models/preinstalled-registry-revision.model";
import type { PreinstalledRegistryService } from "../packages/core/src/services/miniapps/preinstalled-registry.service";
import type { MiniAppService } from "../packages/core/src/services/miniapps/miniapp.service";
import type { MiniAppBetaService } from "../packages/core/src/services/miniapps/miniapp-beta.service";
import type { MiniAppAccessService } from "../packages/core/src/services/miniapps/miniapp-access.service";
import { StoreCatalogService } from "../packages/core/src/services/miniapps/store-catalog.service";
import type {
  DeveloperJwk,
  DeveloperSigningService,
} from "../packages/core/src/services/miniapps/developer-signing.service";

const developer = {
  developerId: "dev_test_user",
  email: "dev@example.com",
  orgId: "org_release_lifecycle",
  packagePrefix: "com.example",
};
const storeUser = { mentraUserId: "mu_store_user", tenantId: "mentra" };

let miniapps: MiniAppService;
let miniappBetas: MiniAppBetaService;
let miniappAccess: MiniAppAccessService;
let registries: PreinstalledRegistryService;
let signing: DeveloperSigningService;

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2-test");
  await Promise.all([
    MiniAppModel.syncIndexes(),
    MiniAppAccessInvitationModel.syncIndexes(),
    MiniAppBetaInvitationModel.syncIndexes(),
    MiniAppReleaseModel.syncIndexes(),
    MiniAppTrackEnrollmentModel.syncIndexes(),
    DeveloperSigningKeyModel.syncIndexes(),
    MiniAppAssetModel.syncIndexes(),
    PreinstalledRegistryModel.syncIndexes(),
    PreinstalledRegistryRevisionModel.syncIndexes(),
  ]);
  const { MiniAppService } = await import("../packages/core/src/services/miniapps/miniapp.service");
  const { MiniAppBetaService } = await import("../packages/core/src/services/miniapps/miniapp-beta.service");
  const { MiniAppAccessService } = await import("../packages/core/src/services/miniapps/miniapp-access.service");
  const { PreinstalledRegistryService } = await import(
    "../packages/core/src/services/miniapps/preinstalled-registry.service"
  );
  const { DeveloperSigningService } = await import("../packages/core/src/services/miniapps/developer-signing.service");
  miniapps = new MiniAppService();
  miniappBetas = new MiniAppBetaService(async email =>
    email === "tester@example.com" ? storeUser.mentraUserId : email === "other@example.com" ? "mu_store_other" : null,
  );
  miniappAccess = new MiniAppAccessService(async email =>
    email === "tester@example.com" ? storeUser.mentraUserId : email === "other@example.com" ? "mu_store_other" : null,
  );
  registries = new PreinstalledRegistryService();
  signing = new DeveloperSigningService();
});

afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await Promise.all([
    MiniAppModel.deleteMany({ orgId: developer.orgId }),
    MiniAppAccessInvitationModel.deleteMany({ orgId: developer.orgId }),
    MiniAppBetaInvitationModel.deleteMany({ orgId: developer.orgId }),
    MiniAppReleaseModel.deleteMany({ orgId: developer.orgId }),
    MiniAppTrackEnrollmentModel.deleteMany({ mentraUserId: /^mu_store_/ }),
    DeveloperSigningKeyModel.deleteMany({ orgId: developer.orgId }),
    MiniAppAssetModel.deleteMany({ orgId: developer.orgId }),
    PreinstalledRegistryModel.deleteMany({ createdBy: "admin@mentraglass.com" }),
    PreinstalledRegistryRevisionModel.deleteMany({ createdBy: "admin@mentraglass.com" }),
  ]);
});

describe("miniapp release lifecycle", () => {
  test("developer submits a bundle, admin accepts it, then publishes it", async () => {
    const app = await miniapps.createMiniApp(developer, {
      packageName: "com.example.weather",
      displayName: "Weather",
      description: "Test miniapp",
    });
    expect(app.packageName).toBe("com.example.weather");

    const release = await miniapps.createRelease(developer, {
      packageName: "com.example.weather",
      version: "1.0.0",
      manifest: {
        packageName: "com.example.weather",
        name: "Weather",
        version: "1.0.0",
      },
      bundle: await releaseBundle({ packageName: "com.example.weather", name: "Weather", version: "1.0.0" }),
      fileName: "bundle.zip",
    });
    expect(release.status).toBe("draft");
    expect(release.releaseBundleAssetId).toBeTruthy();
    expect(release.bundleSha256).toMatch(/^[a-f0-9]{64}$/);

    const submitted = await miniapps.submitRelease(developer, "com.example.weather", release.id);
    expect(submitted.status).toBe("submitted");

    const adminRows = await miniapps.listAdminSubmissions();
    expect(adminRows.map(row => row.id)).toContain(release.id);

    const accepted = await miniapps.approveRelease({
      releaseId: release.id,
      adminId: "admin@mentraglass.com",
      notes: "Looks good.",
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.reviewedBy).toBe("admin@mentraglass.com");

    await expect(
      miniapps.publishRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" }),
    ).rejects.toMatchObject({ code: "store_listing_incomplete" });
    await configurePublishableListing("com.example.weather");
    await expect(
      miniapps.publishRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" }),
    ).rejects.toMatchObject({ code: "store_listing_incomplete" });
    await miniapps.rejectRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    await expect(
      miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" }),
    ).rejects.toMatchObject({ code: "invalid_release_state", status: 409 });
    const rejectedRelease = await MiniAppReleaseModel.findById(release.id).lean();
    expect(rejectedRelease?.submittedStoreListing).toBeNull();
    expect(rejectedRelease?.reviewedStoreListing).toBeNull();
    await miniapps.submitRelease(developer, "com.example.weather", release.id);
    await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });

    const published = await miniapps.publishRelease({
      releaseId: release.id,
      adminId: "admin@mentraglass.com",
    });
    expect(published.status).toBe("published");

    const savedApp = await MiniAppModel.findOne({
      packageName: "com.example.weather",
    }).lean();
    expect(savedApp?.activeReleaseId).toBe(release.id);
  });

  test("preinstall bundle downloads require an active registry assignment for the user's tenant", async () => {
    await miniapps.createMiniApp(developer, {
      packageName: "com.example.secret",
      displayName: "Secret",
      description: "unpublished",
    });
    const release = await miniapps.createRelease(developer, {
      packageName: "com.example.secret",
      version: "1.0.0",
      manifest: { packageName: "com.example.secret", name: "Secret", version: "1.0.0" },
      bundle: await releaseBundle({ packageName: "com.example.secret", name: "Secret", version: "1.0.0" }),
      fileName: "bundle.zip",
    });
    const assetId = release.releaseBundleAssetId!;

    // A draft (unreviewed) bundle must not be downloadable by asset id.
    await expect(registries.getBundleAsset(assetId, { tenantId: "mentra" })).rejects.toMatchObject({ status: 404 });

    // Review alone does not distribute the bundle.
    await miniapps.submitRelease(developer, "com.example.secret", release.id);
    await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    await expect(registries.getBundleAsset(assetId, { tenantId: "mentra" })).rejects.toMatchObject({ status: 404 });

    const registry = await registries.ensureRegistry(
      { adminId: "admin@mentraglass.com" },
      { environment: "dev", tenantId: "mentra" },
    );
    const revision = await registries.createRevision({ adminId: "admin@mentraglass.com" }, registry.id, {
      entries: [{ releaseId: release.id }],
    });
    await registries.promoteRevision({ adminId: "admin@mentraglass.com" }, registry.id, revision.id);
    const asset = await registries.getBundleAsset(assetId, { tenantId: "mentra" });
    expect(asset._id.toString()).toBe(assetId);
    await expect(registries.getBundleAsset(assetId, { tenantId: "other-tenant" })).rejects.toMatchObject({
      status: 404,
    });
  });

  test("developer signing key authorizes dev attestation only for owned package", async () => {
    await miniapps.createMiniApp(developer, {
      packageName: "com.example.devtool",
      displayName: "Dev Tool",
    });

    const pair = crypto.generateKeyPairSync("ed25519");
    const privateKeyJwk = pair.privateKey.export({ format: "jwk" }) as DeveloperJwk;
    const publicKeyJwk = pair.publicKey.export({ format: "jwk" }) as DeveloperJwk;
    const { id: signingKeyId } = await signing.registerKey(developer, { publicKeyJwk });
    const payload = {
      packageName: "com.example.devtool",
      devServerUrl: "http://127.0.0.1:3000",
      nonce: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signingKeyId,
    };
    const privateKey = crypto.createPrivateKey({ key: privateKeyJwk as crypto.JsonWebKeyInput, format: "jwk" });
    const signature = crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64url");

    await expect(
      signing.verifyDevAttestation("com.example.devtool", { ...payload, signature }),
    ).resolves.toBeUndefined();
    await expect(signing.verifyDevAttestation("com.example.other", { ...payload, signature })).rejects.toThrow(
      "attestation packageName does not match request",
    );
  });

  test("accepted releases can be promoted into the client preinstall registry", async () => {
    await miniapps.createMiniApp(developer, {
      packageName: "com.example.captions",
      displayName: "Captions",
    });
    const release = await miniapps.createRelease(developer, {
      packageName: "com.example.captions",
      version: "2.0.0",
      manifest: {
        packageName: "com.example.captions",
        name: "Captions",
        version: "2.0.0",
      },
      bundle: await releaseBundle({ packageName: "com.example.captions", name: "Captions", version: "2.0.0" }),
      fileName: "bundle.zip",
    });
    await miniapps.submitRelease(developer, "com.example.captions", release.id);
    await miniapps.approveRelease({
      releaseId: release.id,
      adminId: "admin@mentraglass.com",
    });

    const publishable = await registries.listPublishableReleases();
    expect(publishable.map(row => row.id)).toContain(release.id);

    const registry = await registries.ensureRegistry({ adminId: "admin@mentraglass.com" }, { environment: "dev" });
    const revision = await registries.createRevision({ adminId: "admin@mentraglass.com" }, registry.id, {
      reason: "test preinstall",
      entries: [
        {
          releaseId: release.id,
          installPolicy: "keep_updated",
          required: true,
        },
      ],
    });
    await registries.promoteRevision({ adminId: "admin@mentraglass.com" }, registry.id, revision.id);

    const clientRegistry = await registries.clientRegistry({
      environment: "dev",
      baseUrl: "https://core.dev.example",
    });
    expect(clientRegistry.entries).toHaveLength(1);
    expect(clientRegistry.entries[0]).toMatchObject({
      packageName: "com.example.captions",
      version: "2.0.0",
      required: true,
      installPolicy: "keep_updated",
      channel: "dev",
      bundleSha256: release.bundleSha256,
    });
    expect(clientRegistry.entries[0]?.bundleUrl).toContain("https://core.dev.example/api/client/miniapps/bundles/");
  });

  test("preinstall registry rejects multiple releases for the same miniapp", async () => {
    await miniapps.createMiniApp(developer, {
      packageName: "com.example.duplicate",
      displayName: "Duplicate",
    });
    const first = await miniapps.createRelease(developer, {
      packageName: "com.example.duplicate",
      version: "1.0.0",
      manifest: {
        packageName: "com.example.duplicate",
        name: "Duplicate",
        version: "1.0.0",
      },
      bundle: await releaseBundle({ packageName: "com.example.duplicate", name: "Duplicate", version: "1.0.0" }),
      fileName: "first.zip",
    });
    const second = await miniapps.createRelease(developer, {
      packageName: "com.example.duplicate",
      version: "1.0.1",
      manifest: {
        packageName: "com.example.duplicate",
        name: "Duplicate",
        version: "1.0.1",
      },
      bundle: await releaseBundle({ packageName: "com.example.duplicate", name: "Duplicate", version: "1.0.1" }),
      fileName: "second.zip",
    });
    await miniapps.submitRelease(developer, "com.example.duplicate", first.id);
    await miniapps.submitRelease(developer, "com.example.duplicate", second.id);
    await miniapps.approveRelease({
      releaseId: first.id,
      adminId: "admin@mentraglass.com",
    });
    await miniapps.approveRelease({
      releaseId: second.id,
      adminId: "admin@mentraglass.com",
    });

    const registry = await registries.ensureRegistry({ adminId: "admin@mentraglass.com" }, { environment: "dev" });
    await expect(
      registries.createRevision({ adminId: "admin@mentraglass.com" }, registry.id, {
        entries: [{ releaseId: first.id }, { releaseId: second.id }],
      }),
    ).rejects.toThrow("can only include one release per miniapp");
  });

  test("published releases appear in the Store catalog with immutable install metadata", async () => {
    await miniapps.createMiniApp(developer, {
      packageName: "com.example.catalog",
      displayName: "Catalog App",
      description: "Short description",
    });
    await miniapps.updateStoreListing(developer, "com.example.catalog", {
      subtitle: "A useful miniapp",
      longDescription: "Long Store description",
      categories: ["Productivity"],
      privacyPolicyUrl: "https://example.com/privacy",
    });
    await Promise.all([
      miniapps.updateStoreListing(developer, "com.example.catalog", { supportUrl: "https://example.com/support" }),
      miniapps.updateStoreListing(developer, "com.example.catalog", { websiteUrl: "https://example.com" }),
    ]);
    await miniapps.updateStoreModeration({
      packageName: "com.example.catalog",
      reviewTier: "verified",
      featured: true,
    });
    await miniapps.createStoreAsset(developer, "com.example.catalog", {
      role: "store_icon",
      fileName: "icon.png",
      contentType: "image/png",
      bytes: tinyPng(),
    });
    const manifest = {
      packageName: "com.example.catalog",
      name: "Catalog App",
      version: "1.2.3",
      permissions: [{ type: "MICROPHONE", required: false }],
      hardwareRequirements: [{ type: "DISPLAY", level: "OPTIONAL" }],
    };
    const release = await miniapps.createRelease(developer, {
      packageName: manifest.packageName,
      version: manifest.version,
      manifest,
      bundle: await releaseBundle(manifest),
    });
    await miniapps.submitRelease(developer, manifest.packageName, release.id);
    await miniapps.updateStoreListing(developer, manifest.packageName, {
      subtitle: "Unreviewed post-submission text",
    });
    const [submittedForReview] = await miniapps.listAdminSubmissions();
    expect(submittedForReview?.storeListing.subtitle).toBe("A useful miniapp");
    expect(submittedForReview?.listingReadiness.ready).toBe(true);
    await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    await miniapps.updateStoreModeration({
      packageName: manifest.packageName,
      reviewTier: "community",
      featured: false,
    });
    const acceptedRows = await miniapps.listAdminSubmissions();
    expect(acceptedRows.find(row => row.id === release.id)?.storeListing).toMatchObject({
      subtitle: "A useful miniapp",
      reviewTier: "community",
      featured: false,
    });
    await miniapps.updateStoreModeration({
      packageName: manifest.packageName,
      reviewTier: "verified",
      featured: true,
    });
    await miniapps.publishRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });

    const catalog = await new StoreCatalogService().list({ baseUrl: "https://core.example.test", ...storeUser });
    expect(catalog.total).toBe(1);
    expect(catalog.apps[0]).toMatchObject({
      packageName: manifest.packageName,
      subtitle: "A useful miniapp",
      categories: ["productivity"],
      reviewTier: "verified",
      featured: true,
      supportUrl: "https://example.com/support",
      websiteUrl: "https://example.com/",
      release: {
        id: release.id,
        version: "1.2.3",
        bundleSha256: release.bundleSha256,
        permissions: manifest.permissions,
      },
    });
    expect(catalog.apps[0]?.subtitle).not.toBe("Unreviewed post-submission text");
    expect(catalog.apps[0]?.release.bundleUrl).toContain("/api/store/bundles/");

    await miniapps.updateStoreModeration({
      packageName: manifest.packageName,
      reviewTier: "community",
      featured: false,
    });
    const moderatedRows = await miniapps.listAdminSubmissions();
    expect(moderatedRows.find(row => row.id === release.id)?.storeListing).toMatchObject({
      reviewTier: "community",
      featured: false,
    });
    const moderatedCatalog = await new StoreCatalogService().get(
      manifest.packageName,
      "https://core.example.test",
      storeUser,
    );
    expect(moderatedCatalog).toMatchObject({ reviewTier: "community", featured: false });

    // An active published release ID alone is not a Store publication gate.
    // Legacy/preinstall rows without a moderated listing snapshot stay private.
    await MiniAppModel.updateOne(
      { packageName: manifest.packageName },
      { $set: { publishedStoreListing: null } },
    );
    const hiddenWithoutListing = await new StoreCatalogService().list({
      baseUrl: "https://core.example.test",
      ...storeUser,
    });
    expect(hiddenWithoutListing.total).toBe(0);
    await expect(
      new StoreCatalogService().get(manifest.packageName, "https://core.example.test", storeUser),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("Store artwork is type-checked and only referenced assets are public", async () => {
    await miniapps.createMiniApp(developer, {
      packageName: "com.example.artwork",
      displayName: "Artwork",
      description: "Artwork description",
    });
    await expect(
      miniapps.createStoreAsset(developer, "com.example.artwork", {
        role: "store_icon",
        fileName: "not-really.png",
        contentType: "image/png",
        bytes: new TextEncoder().encode("not an image"),
      }),
    ).rejects.toMatchObject({ code: "invalid_asset_content" });

    const icon = await miniapps.createStoreAsset(developer, "com.example.artwork", {
      role: "store_icon",
      fileName: "icon.png",
      contentType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    });
    const catalogService = new StoreCatalogService();
    await expect(catalogService.getPublicAsset(icon.id)).rejects.toMatchObject({ status: 404 });

    const screenshots = await Promise.allSettled(
      Array.from({ length: 11 }, (_, index) =>
        miniapps.createStoreAsset(developer, "com.example.artwork", {
          role: "gallery_screenshot",
          fileName: `screenshot-${index}.png`,
          contentType: "image/png",
          bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, index]),
        }),
      ),
    );
    expect(screenshots.filter(result => result.status === "fulfilled")).toHaveLength(10);
    expect(screenshots.filter(result => result.status === "rejected")).toHaveLength(1);
    const release = await miniapps.createRelease(developer, {
      packageName: "com.example.artwork",
      version: "1.0.0",
      manifest: { packageName: "com.example.artwork", name: "Artwork", version: "1.0.0" },
      bundle: await releaseBundle({ packageName: "com.example.artwork", name: "Artwork", version: "1.0.0" }),
    });
    await miniapps.updateStoreListing(developer, "com.example.artwork", {
      longDescription: "Artwork Store description",
      privacyPolicyUrl: "https://example.com/privacy",
      supportUrl: "https://example.com/support",
    });
    await miniapps.submitRelease(developer, "com.example.artwork", release.id);
    const postSubmissionReplacement = await miniapps.createStoreAsset(developer, "com.example.artwork", {
      role: "store_icon",
      fileName: "post-submission.png",
      contentType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]),
    });
    const submittedRows = await miniapps.listAdminSubmissions();
    const submittedArtwork = submittedRows.find(row => row.id === release.id);
    expect(submittedArtwork?.storeAssets.some(asset => asset.id === icon.id)).toBe(true);
    expect(submittedArtwork?.storeAssets.some(asset => asset.id === postSubmissionReplacement.id)).toBe(false);
    await expect(miniapps.deleteStoreAsset(developer, "com.example.artwork", icon.id)).rejects.toMatchObject({
      code: "reviewed_asset",
      status: 409,
    });
    await miniapps.deleteStoreAsset(developer, "com.example.artwork", postSubmissionReplacement.id);
    await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    await miniapps.publishRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });

    const publicAsset = await catalogService.getPublicAsset(icon.id);
    expect(publicAsset.contentType).toBe("image/png");
    expect(publicAsset.cacheControl).toBe("public, max-age=31536000, immutable");
    const replacement = await miniapps.createStoreAsset(developer, "com.example.artwork", {
      role: "store_icon",
      fileName: "replacement.png",
      contentType: "image/png",
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
    });
    await miniapps.updateStoreListing(developer, "com.example.artwork", { subtitle: "Unreviewed replacement" });
    const catalog = await catalogService.list({ baseUrl: "https://core.example.test", ...storeUser });
    expect(catalog.apps[0]?.iconUrl).toContain(icon.id);
    expect(catalog.apps[0]?.subtitle).not.toBe("Unreviewed replacement");
    await expect(catalogService.getPublicAsset(replacement.id)).rejects.toMatchObject({ status: 404 });
    await expect(miniapps.deleteStoreAsset(developer, "com.example.artwork", icon.id)).rejects.toMatchObject({
      code: "published_asset",
      status: 409,
    });
    await miniapps.deleteStoreAsset(developer, "com.example.artwork", replacement.id);
  });

  test("private beta-only artwork stays off the unauthenticated asset route", async () => {
    const packageName = "com.example.privateartwork";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Private Artwork",
      description: "Private beta artwork test",
    });
    await configurePublishableListing(packageName);
    const app = await MiniAppModel.findOne({ packageName }).lean();
    const iconAssetId = app?.storeListing?.iconAssetId;
    expect(iconAssetId).toBeTruthy();

    const release = await miniapps.createRelease(developer, {
      packageName,
      version: "1.0.0-beta.1",
      releaseTrack: "beta",
      manifest: { packageName, name: "Private Artwork", version: "1.0.0-beta.1" },
      bundle: await releaseBundle({ packageName, name: "Private Artwork", version: "1.0.0-beta.1" }),
    });
    await miniapps.submitRelease(developer, packageName, release.id);
    await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    await miniapps.publishRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });

    const catalog = new StoreCatalogService();
    await miniappBetas.invite(developer, packageName, "tester@example.com");
    expect(await catalog.get(packageName, "https://core.example.test", storeUser)).toMatchObject({
      betaAccess: "invited",
      iconUrl: null,
    });
    await expect(catalog.getPublicAsset(iconAssetId!)).rejects.toMatchObject({ status: 404 });

    await miniappBetas.setAccessMode(developer, packageName, "public");
    expect(await catalog.get(packageName, "https://core.example.test")).toMatchObject({
      betaAccess: "public",
      iconUrl: `https://core.example.test/api/store/assets/${iconAssetId}`,
    });
    const publicBetaAsset = await catalog.getPublicAsset(iconAssetId!);
    expect(publicBetaAsset._id.toString()).toBe(iconAssetId);
    expect(publicBetaAsset.cacheControl).toBe("private, no-store");
  });

  test("submission and artwork deletion serialize without producing a dangling snapshot", async () => {
    const packageName = "com.example.artworkrace";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Artwork Race",
      description: "Artwork race test",
    });
    const icon = await miniapps.createStoreAsset(developer, packageName, {
      role: "store_icon",
      fileName: "icon.png",
      contentType: "image/png",
      bytes: tinyPng(),
    });
    const release = await miniapps.createRelease(developer, {
      packageName,
      version: "1.0.0",
      manifest: { packageName, name: "Artwork Race", version: "1.0.0" },
      bundle: await releaseBundle({ packageName, name: "Artwork Race", version: "1.0.0" }),
    });

    const [submission, deletion] = await Promise.allSettled([
      miniapps.submitRelease(developer, packageName, release.id),
      miniapps.deleteStoreAsset(developer, packageName, icon.id),
    ]);
    expect(submission.status).toBe("fulfilled");

    const savedRelease = await MiniAppReleaseModel.findById(release.id).lean();
    const assetStillExists = Boolean(await MiniAppAssetModel.exists({ _id: icon.id }));
    const snapshotReferencesIcon = savedRelease?.submittedStoreListing?.iconAssetId === icon.id;
    expect(snapshotReferencesIcon).toBe(assetStillExists);
    if (deletion.status === "rejected") {
      expect(deletion.reason).toMatchObject({ code: "reviewed_asset", status: 409 });
    } else {
      expect(snapshotReferencesIcon).toBe(false);
    }
  });

  test("draft listing and artwork writes cannot complete through a submission snapshot", async () => {
    const packageName = "com.example.draftwriterace";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Draft Write Race",
      description: "Draft write serialization test",
    });
    await miniapps.updateStoreListing(developer, packageName, { subtitle: "Original subtitle" });
    const originalIcon = await miniapps.createStoreAsset(developer, packageName, {
      role: "store_icon",
      fileName: "original.png",
      contentType: "image/png",
      bytes: tinyPng(),
    });
    const release = await miniapps.createRelease(developer, {
      packageName,
      version: "1.0.0",
      manifest: { packageName, name: "Draft Write Race", version: "1.0.0" },
      bundle: await releaseBundle({ packageName, name: "Draft Write Race", version: "1.0.0" }),
    });

    const originalFindOneAndUpdate = MiniAppReleaseModel.findOneAndUpdate;
    let markTransitionReached!: () => void;
    let resumeTransition!: () => void;
    const transitionReached = new Promise<void>(resolve => {
      markTransitionReached = resolve;
    });
    const transitionGate = new Promise<void>(resolve => {
      resumeTransition = resolve;
    });
    MiniAppReleaseModel.findOneAndUpdate = (async (...args: unknown[]) => {
      const filter = args[0] as { _id?: unknown } | undefined;
      const update = args[1] as { $set?: { status?: string } } | undefined;
      if (String(filter?._id) === release.id && update?.$set?.status === "submitted") {
        markTransitionReached();
        await transitionGate;
      }
      return (originalFindOneAndUpdate as unknown as (...callArgs: unknown[]) => unknown).apply(
        MiniAppReleaseModel,
        args,
      );
    }) as typeof MiniAppReleaseModel.findOneAndUpdate;

    const completionOrder: string[] = [];
    try {
      const submission = miniapps.submitRelease(developer, packageName, release.id).then(result => {
        completionOrder.push("submission");
        return result;
      });
      await transitionReached;
      const listingWrite = miniapps
        .updateStoreListing(developer, packageName, { subtitle: "Replacement subtitle" })
        .then(result => {
          completionOrder.push("listing");
          return result;
        });
      const artworkWrite = miniapps
        .createStoreAsset(developer, packageName, {
          role: "store_icon",
          fileName: "replacement.png",
          contentType: "image/png",
          bytes: tinyPng(),
        })
        .then(result => {
          completionOrder.push("artwork");
          return result;
        });

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(completionOrder).toEqual([]);
      resumeTransition();
      const [, , replacementIcon] = await Promise.all([submission, listingWrite, artworkWrite]);

      expect(completionOrder[0]).toBe("submission");
      const [savedRelease, savedApp] = await Promise.all([
        MiniAppReleaseModel.findById(release.id).lean(),
        MiniAppModel.findOne({ packageName }).lean(),
      ]);
      expect(savedRelease?.submittedStoreListing).toMatchObject({
        subtitle: "Original subtitle",
        iconAssetId: originalIcon.id,
      });
      expect(savedApp?.storeListing).toMatchObject({
        subtitle: "Replacement subtitle",
        iconAssetId: replacementIcon.id,
      });
    } finally {
      resumeTransition();
      MiniAppReleaseModel.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });

  test("an expired submission cannot commit after a newer draft write", async () => {
    const packageName = "com.example.expiredsubmission";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Expired Submission",
      description: "Expired submission fencing test",
    });
    await miniapps.updateStoreListing(developer, packageName, { subtitle: "Original subtitle" });
    const release = await miniapps.createRelease(developer, {
      packageName,
      version: "1.0.0",
      manifest: { packageName, name: "Expired Submission", version: "1.0.0" },
      bundle: await releaseBundle({ packageName, name: "Expired Submission", version: "1.0.0" }),
    });

    const originalFindOneAndUpdate = MiniAppReleaseModel.findOneAndUpdate;
    let markTransitionReached!: () => void;
    let resumeTransition!: () => void;
    const transitionReached = new Promise<void>(resolve => {
      markTransitionReached = resolve;
    });
    const transitionGate = new Promise<void>(resolve => {
      resumeTransition = resolve;
    });
    MiniAppReleaseModel.findOneAndUpdate = (async (...args: unknown[]) => {
      const filter = args[0] as { _id?: unknown } | undefined;
      const update = args[1] as { $set?: { status?: string } } | undefined;
      if (String(filter?._id) === release.id && update?.$set?.status === "submitted") {
        markTransitionReached();
        await transitionGate;
      }
      return (originalFindOneAndUpdate as unknown as (...callArgs: unknown[]) => unknown).apply(
        MiniAppReleaseModel,
        args,
      );
    }) as typeof MiniAppReleaseModel.findOneAndUpdate;

    try {
      const submission = miniapps.submitRelease(developer, packageName, release.id);
      await transitionReached;
      const [appDocument, releaseDocument] = await Promise.all([
        MiniAppModel.findOne({ packageName }).select("_id").lean(),
        MiniAppReleaseModel.findById(release.id).select("_id").lean(),
      ]);
      expect(appDocument).toBeTruthy();
      expect(releaseDocument).toBeTruthy();
      await Promise.all([
        MiniAppModel.collection.updateOne(
          { _id: appDocument!._id },
          { $set: { "storeListingOperationLease.expiresAt": new Date(0) } },
        ),
        MiniAppReleaseModel.collection.updateOne(
          { _id: releaseDocument!._id },
          { $set: { "storeListingSubmissionLease.expiresAt": new Date(0) } },
        ),
      ]);

      await miniapps.updateStoreListing(developer, packageName, { subtitle: "Replacement subtitle" });
      resumeTransition();
      await expect(submission).rejects.toMatchObject({ code: "store_listing_lease_lost", status: 409 });

      const [savedRelease, savedApp] = await Promise.all([
        MiniAppReleaseModel.findById(release.id).lean(),
        MiniAppModel.findOne({ packageName }).lean(),
      ]);
      expect(savedRelease).toMatchObject({ status: "draft", submittedStoreListing: null });
      expect(savedRelease?.storeListingSubmissionLease).toBeNull();
      expect(savedApp?.storeListing?.subtitle).toBe("Replacement subtitle");
    } finally {
      resumeTransition();
      MiniAppReleaseModel.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });

  test("a fast Core clock cannot steal a MongoDB-live submission lease", async () => {
    const packageName = "com.example.clockskew";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Clock Skew",
      description: "MongoDB lease clock test",
    });
    await miniapps.updateStoreListing(developer, packageName, { subtitle: "Original subtitle" });
    const release = await miniapps.createRelease(developer, {
      packageName,
      version: "1.0.0",
      manifest: { packageName, name: "Clock Skew", version: "1.0.0" },
      bundle: await releaseBundle({ packageName, name: "Clock Skew", version: "1.0.0" }),
    });

    const originalFindOneAndUpdate = MiniAppReleaseModel.findOneAndUpdate;
    const NativeDate = Date;
    let markTransitionReached!: () => void;
    let resumeTransition!: () => void;
    const transitionReached = new Promise<void>(resolve => {
      markTransitionReached = resolve;
    });
    const transitionGate = new Promise<void>(resolve => {
      resumeTransition = resolve;
    });
    MiniAppReleaseModel.findOneAndUpdate = (async (...args: unknown[]) => {
      const filter = args[0] as { _id?: unknown } | undefined;
      const update = args[1] as { $set?: { status?: string } } | undefined;
      if (String(filter?._id) === release.id && update?.$set?.status === "submitted") {
        markTransitionReached();
        await transitionGate;
      }
      return (originalFindOneAndUpdate as unknown as (...callArgs: unknown[]) => unknown).apply(
        MiniAppReleaseModel,
        args,
      );
    }) as typeof MiniAppReleaseModel.findOneAndUpdate;

    const completionOrder: string[] = [];
    try {
      const submission = miniapps.submitRelease(developer, packageName, release.id).then(result => {
        completionOrder.push("submission");
        return result;
      });
      await transitionReached;

      const FastDate = new Proxy(NativeDate, {
        construct(target, args) {
          return Reflect.construct(target, args.length === 0 ? [NativeDate.now() + 10 * 60_000] : args, target);
        },
        get(target, property, receiver) {
          if (property === "now") return () => NativeDate.now() + 10 * 60_000;
          return Reflect.get(target, property, receiver);
        },
      });
      globalThis.Date = FastDate as DateConstructor;
      const listingWrite = miniapps
        .updateStoreListing(developer, packageName, { subtitle: "Replacement subtitle" })
        .then(result => {
          completionOrder.push("listing");
          return result;
        });

      await new Promise(resolve => setTimeout(resolve, 50));
      expect(completionOrder).toEqual([]);
      resumeTransition();
      await Promise.all([submission, listingWrite]);
      expect(completionOrder[0]).toBe("submission");

      const [savedRelease, savedApp] = await Promise.all([
        MiniAppReleaseModel.findById(release.id).lean(),
        MiniAppModel.findOne({ packageName }).lean(),
      ]);
      expect(savedRelease?.submittedStoreListing?.subtitle).toBe("Original subtitle");
      expect(savedApp?.storeListing?.subtitle).toBe("Replacement subtitle");
    } finally {
      resumeTransition();
      globalThis.Date = NativeDate;
      MiniAppReleaseModel.findOneAndUpdate = originalFindOneAndUpdate;
    }
  });

  test("publish and reject decisions serialize to one consistent outcome", async () => {
    const packageName = "com.example.decisionrace";
    const release = await createAcceptedStoreRelease(packageName);

    const decisions = await Promise.allSettled([
      miniapps.publishRelease({ releaseId: release.id, adminId: "publisher@mentraglass.com" }),
      miniapps.rejectRelease({ releaseId: release.id, adminId: "reviewer@mentraglass.com" }),
    ]);
    expect(decisions.filter(decision => decision.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter(decision => decision.status === "rejected")).toHaveLength(1);

    const [savedRelease, savedApp] = await Promise.all([
      MiniAppReleaseModel.findById(release.id).lean(),
      MiniAppModel.findOne({ packageName }).lean(),
    ]);
    const catalog = await new StoreCatalogService().list({
      baseUrl: "https://core.example.test",
      ...storeUser,
    });
    if (savedRelease?.status === "published") {
      expect(savedApp?.activeReleaseId).toBe(release.id);
      expect(catalog.apps.map(app => app.packageName)).toContain(packageName);
    } else {
      expect(savedRelease?.status).toBe("rejected");
      expect(savedApp?.activeReleaseId).toBeNull();
      expect(catalog.apps.map(app => app.packageName)).not.toContain(packageName);
    }
  });

  test("publication retries promote a journaled commit without replacing the active release early", async () => {
    const packageName = "com.example.publishretry";
    const activeRelease = await createAcceptedStoreRelease(packageName);
    await miniapps.publishRelease({ releaseId: activeRelease.id, adminId: "admin@mentraglass.com" });
    const replacement = await miniapps.createRelease(developer, {
      packageName,
      version: "1.1.0",
      manifest: { packageName, name: "Store decision test", version: "1.1.0" },
      bundle: await releaseBundle({ packageName, name: "Store decision test", version: "1.1.0" }),
    });
    await miniapps.submitRelease(developer, packageName, replacement.id);
    await miniapps.approveRelease({ releaseId: replacement.id, adminId: "admin@mentraglass.com" });
    const acceptedReplacement = await MiniAppReleaseModel.findById(replacement.id).lean();
    await MiniAppReleaseModel.updateOne(
      { _id: replacement.id },
      { $set: { status: "published", publishedAt: new Date() } },
    );
    await MiniAppModel.updateOne(
      { packageName },
      {
        $set: {
          pendingStorePublication: {
            releaseId: replacement.id,
            releaseTrack: "stable",
            storeListing: acceptedReplacement?.reviewedStoreListing,
          },
        },
      },
    );

    const catalogDuringPartial = await new StoreCatalogService().list({
      baseUrl: "https://core.example.test",
      ...storeUser,
    });
    expect(catalogDuringPartial.apps.find(app => app.packageName === packageName)?.release.id).toBe(activeRelease.id);

    const published = await miniapps.publishRelease({
      releaseId: replacement.id,
      adminId: "admin@mentraglass.com",
    });
    expect(published.status).toBe("published");
    const visibleAfterRetry = await new StoreCatalogService().list({
      baseUrl: "https://core.example.test",
      ...storeUser,
    });
    expect(visibleAfterRetry.apps.find(app => app.packageName === packageName)?.release.id).toBe(replacement.id);
  });

  test("a new lease fences a stale publisher before discarding its accepted journal", async () => {
    const packageName = "com.example.publishfence";
    const release = await createAcceptedStoreRelease(packageName);
    const accepted = await MiniAppReleaseModel.findById(release.id).lean();
    expect(accepted?.status).toBe("accepted");
    await MiniAppModel.updateOne(
      { packageName },
      {
        $set: {
          pendingStorePublication: {
            releaseId: release.id,
            releaseTrack: "stable",
            storeListing: accepted?.reviewedStoreListing,
          },
        },
      },
    );

    const staleUpdatedAt = accepted!.updatedAt;
    await miniapps.updateStoreListing(developer, packageName, { subtitle: "A later draft" });
    const staleTransition = await MiniAppReleaseModel.findOneAndUpdate(
      { _id: release.id, status: "accepted", updatedAt: staleUpdatedAt },
      { $set: { status: "published", publishedAt: new Date() } },
      { new: true },
    );
    expect(staleTransition).toBeNull();
    expect((await MiniAppModel.findOne({ packageName }).lean())?.pendingStorePublication).toBeNull();

    const published = await miniapps.publishRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    expect(published.status).toBe("published");
    expect((await MiniAppModel.findOne({ packageName }).lean())?.activeReleaseId).toBe(release.id);
  });

  test("stable and beta publish independently and Core selects beta only for the enrolled user", async () => {
    const packageName = "com.example.tracks";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Track Test",
      description: "Track selection",
    });
    await miniappBetas.setAccessMode(developer, packageName, "public");
    await configurePublishableListing(packageName);
    await miniapps.updateStoreListing(developer, packageName, { subtitle: "Stable listing" });

    const stable = await miniapps.createRelease(developer, {
      packageName,
      version: "1.0.0",
      releaseTrack: "stable",
      manifest: { packageName, name: "Track Test", version: "1.0.0" },
      bundle: await releaseBundle({ packageName, name: "Track Test", version: "1.0.0" }),
    });
    await miniapps.submitRelease(developer, packageName, stable.id);
    await miniapps.approveRelease({ releaseId: stable.id, adminId: "admin@mentraglass.com" });
    await miniapps.publishRelease({ releaseId: stable.id, adminId: "admin@mentraglass.com" });

    await miniapps.updateStoreListing(developer, packageName, { subtitle: "Beta listing" });
    const beta = await miniapps.createRelease(developer, {
      packageName,
      version: "1.1.0-beta.1",
      releaseTrack: "beta",
      manifest: { packageName, name: "Track Test", version: "1.1.0-beta.1" },
      bundle: await releaseBundle({ packageName, name: "Track Test", version: "1.1.0-beta.1" }),
    });
    await miniapps.submitRelease(developer, packageName, beta.id);
    await miniapps.approveRelease({ releaseId: beta.id, adminId: "admin@mentraglass.com" });
    await miniapps.publishRelease({ releaseId: beta.id, adminId: "admin@mentraglass.com" });

    const savedApp = await MiniAppModel.findOne({ packageName }).lean();
    expect(savedApp?.activeReleaseId).toBe(stable.id);
    expect(savedApp?.activeBetaReleaseId).toBe(beta.id);

    const catalog = new StoreCatalogService();
    const defaultResult = await catalog.list({ baseUrl: "https://core.example.test", ...storeUser });
    expect(defaultResult.apps[0]).toMatchObject({
      selectedTrack: "stable",
      betaAccess: "public",
      availableTracks: ["stable", "beta"],
      subtitle: "Stable listing",
      release: { id: stable.id, version: "1.0.0", track: "stable" },
    });
    const anonymousResult = await catalog.list({ baseUrl: "https://core.example.test" });
    expect(anonymousResult.apps[0]?.release.id).toBe(stable.id);

    const selected = await catalog.setReleaseTrack(packageName, "beta", storeUser, "https://core.example.test");
    expect(selected).toMatchObject({
      selectedTrack: "beta",
      preferredTrack: "beta",
      subtitle: "Beta listing",
      release: { id: beta.id, version: "1.1.0-beta.1", track: "beta" },
    });
    const enrolledResult = await catalog.list({ baseUrl: "https://core.example.test", ...storeUser });
    expect(enrolledResult.apps[0]?.release.id).toBe(beta.id);

    const otherUser = await catalog.list({
      baseUrl: "https://core.example.test",
      mentraUserId: "mu_store_other",
      tenantId: "mentra",
    });
    expect(otherUser.apps[0]?.release.id).toBe(stable.id);

    const returnedToStable = await catalog.setReleaseTrack(
      packageName,
      "stable",
      storeUser,
      "https://core.example.test",
    );
    expect(returnedToStable.release.id).toBe(stable.id);
    expect(await MiniAppTrackEnrollmentModel.countDocuments({ mentraUserId: storeUser.mentraUserId })).toBe(0);

    await miniapps.updateStoreListing(developer, packageName, { subtitle: "Second beta listing" });
    const secondBeta = await miniapps.createRelease(developer, {
      packageName,
      version: "1.1.0-beta.2",
      releaseTrack: "beta",
      manifest: { packageName, name: "Track Test", version: "1.1.0-beta.2" },
      bundle: await releaseBundle({ packageName, name: "Track Test", version: "1.1.0-beta.2" }),
    });
    await miniapps.submitRelease(developer, packageName, secondBeta.id);
    await miniapps.approveRelease({ releaseId: secondBeta.id, adminId: "admin@mentraglass.com" });
    await miniapps.publishRelease({ releaseId: secondBeta.id, adminId: "admin@mentraglass.com" });

    const adminHistory = await miniapps.listAdminSubmissions();
    expect(adminHistory.find(row => row.id === beta.id)?.storeListing.subtitle).toBe("Beta listing");
    expect(adminHistory.find(row => row.id === secondBeta.id)?.storeListing.subtitle).toBe("Second beta listing");
    expect(adminHistory.find(row => row.id === beta.id)?.isActiveRelease).toBe(false);
    expect(adminHistory.find(row => row.id === secondBeta.id)?.isActiveRelease).toBe(true);
    await expect(
      miniapps.publishRelease({ releaseId: beta.id, adminId: "admin@mentraglass.com" }),
    ).rejects.toMatchObject({ code: "invalid_release_state", status: 409 });
    expect((await MiniAppModel.findOne({ packageName }).lean())?.activeBetaReleaseId).toBe(secondBeta.id);

    // Featured ordering follows the listing for the user's selected track,
    // not the stable snapshot on the same app.
    await MiniAppModel.updateOne(
      { packageName },
      {
        $set: {
          "publishedStoreListing.featured": false,
          "publishedBetaStoreListing.featured": true,
        },
      },
    );
    const stablePackage = "com.example.alphabetical";
    await miniapps.createMiniApp(developer, {
      packageName: stablePackage,
      displayName: "Alpha Stable",
      description: "Non-featured stable app",
    });
    await configurePublishableListing(stablePackage);
    const alphaRelease = await miniapps.createRelease(developer, {
      packageName: stablePackage,
      version: "1.0.0",
      manifest: { packageName: stablePackage, name: "Alpha Stable", version: "1.0.0" },
      bundle: await releaseBundle({ packageName: stablePackage, name: "Alpha Stable", version: "1.0.0" }),
    });
    await miniapps.submitRelease(developer, stablePackage, alphaRelease.id);
    await miniapps.approveRelease({ releaseId: alphaRelease.id, adminId: "admin@mentraglass.com" });
    await miniapps.publishRelease({ releaseId: alphaRelease.id, adminId: "admin@mentraglass.com" });
    await catalog.setReleaseTrack(packageName, "beta", storeUser, "https://core.example.test");
    const featuredPage = await catalog.list({
      baseUrl: "https://core.example.test",
      ...storeUser,
      page: 1,
      limit: 1,
    });
    expect(featuredPage.apps[0]).toMatchObject({ packageName, selectedTrack: "beta", featured: true });
    expect(featuredPage.hasMore).toBe(true);
  });

  test("private stable releases self-publish and remain gated by per-user Store access", async () => {
    const packageName = "com.example.private";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Private Staff App",
      description: "Internal distribution",
    });
    await miniapps.updateVisibility(developer, packageName, "private");
    await configurePublishableListing(packageName);
    const release = await miniapps.createRelease(developer, {
      packageName,
      version: "1.0.0",
      manifest: { packageName, name: "Private Staff App", version: "1.0.0" },
      bundle: await releaseBundle({ packageName, name: "Private Staff App", version: "1.0.0" }),
    });

    const published = await miniapps.submitRelease(developer, packageName, release.id);
    expect(published).toMatchObject({ status: "published", publicStoreApprovedAt: null });
    expect((await miniapps.listAdminSubmissions()).find(row => row.id === release.id)?.reviewedBy).toBe(
      `private:${developer.developerId}`,
    );

    const catalog = new StoreCatalogService();
    expect((await catalog.list({ baseUrl: "https://core.example.test" })).apps).toHaveLength(0);
    await expect(catalog.get(packageName, "https://core.example.test", storeUser)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(catalog.getBundleAsset(release.releaseBundleAssetId!, storeUser)).rejects.toMatchObject({ status: 404 });

    const invitation = await miniappAccess.invite(developer, packageName, "tester@example.com");
    expect(invitation.state).toBe("pending");
    const icon = await MiniAppAssetModel.findOne({ orgId: developer.orgId, role: "store_icon" }).lean();
    expect(icon).not.toBeNull();
    await expect(catalog.getPublicAsset(icon!._id.toString())).rejects.toMatchObject({ status: 404 });
    expect((await catalog.getAsset(icon!._id.toString(), storeUser)).cacheControl).toBe("private, no-store");
    expect(await catalog.get(packageName, "https://core.example.test", storeUser)).toMatchObject({
      packageName,
      visibility: "private",
      selectedTrack: "stable",
      release: { id: release.id, installable: true },
    });
    expect((await catalog.list({ baseUrl: "https://core.example.test", ...storeUser })).apps).toHaveLength(1);
    expect((await catalog.getBundleAsset(release.releaseBundleAssetId!, storeUser))._id.toString()).toBe(
      release.releaseBundleAssetId,
    );
    expect((await miniappAccess.getAccess(developer, packageName)).invitations[0]?.state).toBe("accepted");

    await miniappAccess.revoke(developer, packageName, invitation.id);
    await expect(catalog.getAsset(icon!._id.toString(), storeUser)).rejects.toMatchObject({ status: 404 });
    await expect(catalog.get(packageName, "https://core.example.test", storeUser)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(catalog.getBundleAsset(release.releaseBundleAssetId!, storeUser)).rejects.toMatchObject({ status: 404 });

    // Visibility alone never promotes an unreviewed private artifact into the
    // public catalog. A Mentra approval can explicitly make that release public.
    await miniapps.updateVisibility(developer, packageName, "public");
    expect((await MiniAppReleaseModel.findById(release.id).lean())?.status).toBe("submitted");
    expect((await catalog.list({ baseUrl: "https://core.example.test" })).apps).toHaveLength(0);
    await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    await miniapps.publishRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    expect((await catalog.list({ baseUrl: "https://core.example.test" })).apps[0]).toMatchObject({
      packageName,
      visibility: "public",
    });
  });

  test("private betas stay hidden until invitation and revocation stops future beta selection", async () => {
    const packageName = "com.example.closedbeta";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Closed Beta",
      description: "Private beta test",
    });
    await configurePublishableListing(packageName);

    let betaBundleAssetId = "";
    for (const releaseInput of [
      { version: "1.0.0", releaseTrack: "stable" as const },
      { version: "1.1.0-beta.1", releaseTrack: "beta" as const },
    ]) {
      const release = await miniapps.createRelease(developer, {
        packageName,
        ...releaseInput,
        manifest: { packageName, name: "Closed Beta", version: releaseInput.version },
        bundle: await releaseBundle({ packageName, name: "Closed Beta", version: releaseInput.version }),
      });
      await miniapps.submitRelease(developer, packageName, release.id);
      await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
      await miniapps.publishRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
      if (releaseInput.releaseTrack === "beta") betaBundleAssetId = release.releaseBundleAssetId!;
    }

    const catalog = new StoreCatalogService();
    const beforeInvite = await catalog.get(packageName, "https://core.example.test", storeUser);
    expect(beforeInvite).toMatchObject({ selectedTrack: "stable", betaAccess: null, availableTracks: ["stable"] });
    await expect(
      catalog.setReleaseTrack(packageName, "beta", storeUser, "https://core.example.test"),
    ).rejects.toMatchObject({ code: "beta_invitation_required", status: 403 });
    await expect(catalog.getBundleAsset(betaBundleAssetId, storeUser)).rejects.toMatchObject({ status: 404 });

    let invitation = await miniappBetas.invite(developer, packageName, "tester@example.com");
    const invited = await catalog.get(packageName, "https://core.example.test", storeUser);
    expect(invited).toMatchObject({ betaAccess: "invited", availableTracks: ["stable", "beta"] });
    const selected = await catalog.setReleaseTrack(packageName, "beta", storeUser, "https://core.example.test");
    expect(selected).toMatchObject({ selectedTrack: "beta", preferredTrack: "beta", betaAccess: "invited" });
    expect((await miniappBetas.getAccess(developer, packageName)).invitations[0]?.state).toBe("accepted");
    expect((await miniappBetas.invite(developer, packageName, "tester@example.com")).state).toBe("accepted");

    const { MiniAppBetaService: RemappedMiniAppBetaService } = await import(
      "../packages/core/src/services/miniapps/miniapp-beta.service"
    );
    const singlyRemappedBetas = new RemappedMiniAppBetaService(async () => "mu_store_reassigned");
    expect((await singlyRemappedBetas.invite(developer, packageName, "tester@example.com")).state).toBe("pending");
    expect(
      await MiniAppTrackEnrollmentModel.exists({ mentraUserId: storeUser.mentraUserId, packageName }),
    ).toBeNull();
    await expect(catalog.getBundleAsset(betaBundleAssetId, storeUser)).rejects.toMatchObject({ status: 404 });

    const appAfterRebind = await MiniAppModel.findOne({ packageName }).lean();
    await MiniAppTrackEnrollmentModel.create({
      mentraUserId: storeUser.mentraUserId,
      tenantId: storeUser.tenantId,
      miniAppId: appAfterRebind!._id.toString(),
      packageName,
      releaseTrack: "beta",
    });
    const staleEnrollmentBetas = new RemappedMiniAppBetaService(async () => storeUser.mentraUserId);
    await staleEnrollmentBetas.invite(developer, packageName, "reinvited@example.com");
    expect(await catalog.get(packageName, "https://core.example.test", storeUser)).toMatchObject({
      selectedTrack: "stable",
      preferredTrack: "stable",
      betaAccess: "invited",
    });
    await expect(catalog.getBundleAsset(betaBundleAssetId, storeUser)).rejects.toMatchObject({ status: 404 });

    invitation = await miniappBetas.invite(developer, packageName, "tester@example.com");
    expect(invitation.state).toBe("pending");
    await catalog.setReleaseTrack(packageName, "beta", storeUser, "https://core.example.test");

    const conflictingInvitation = await miniappBetas.invite(developer, packageName, "other@example.com");
    const remappedBetas = new RemappedMiniAppBetaService(async () => "mu_store_other");
    const mergedInvitation = await remappedBetas.invite(developer, packageName, "tester@example.com");
    expect(mergedInvitation).toMatchObject({ id: conflictingInvitation.id, state: "pending" });
    expect(
      await MiniAppBetaInvitationModel.countDocuments({
        miniAppId: (await MiniAppModel.findOne({ packageName }))?._id.toString(),
      }),
    ).toBe(1);
    expect(
      await MiniAppTrackEnrollmentModel.exists({ mentraUserId: storeUser.mentraUserId, packageName }),
    ).toBeNull();
    await expect(catalog.getBundleAsset(betaBundleAssetId, storeUser)).rejects.toMatchObject({ status: 404 });
    expect(
      await catalog.get(packageName, "https://core.example.test", {
        mentraUserId: "mu_store_other",
        tenantId: "mentra",
      }),
    ).toMatchObject({ selectedTrack: "stable", betaAccess: "invited" });

    invitation = await miniappBetas.invite(developer, packageName, "tester@example.com");
    expect(invitation.state).toBe("pending");
    await catalog.setReleaseTrack(packageName, "beta", storeUser, "https://core.example.test");
    expect((await catalog.getBundleAsset(betaBundleAssetId, storeUser))._id.toString()).toBe(betaBundleAssetId);
    await expect(miniappBetas.invite(developer, packageName, "missing@example.com")).rejects.toMatchObject({
      code: "mentra_user_not_found",
      status: 404,
    });

    const otherUser = { mentraUserId: "mu_store_other", tenantId: "mentra" };
    expect(await catalog.get(packageName, "https://core.example.test", otherUser)).toMatchObject({
      selectedTrack: "stable",
      betaAccess: null,
      availableTracks: ["stable"],
    });
    await expect(catalog.getBundleAsset(betaBundleAssetId, otherUser)).rejects.toMatchObject({ status: 404 });

    await miniappBetas.revoke(developer, packageName, invitation.id);
    expect(await MiniAppTrackEnrollmentModel.exists({ mentraUserId: storeUser.mentraUserId, packageName })).toBeNull();
    expect(await catalog.get(packageName, "https://core.example.test", storeUser)).toMatchObject({
      selectedTrack: "stable",
      betaAccess: null,
      availableTracks: ["stable"],
    });
    await expect(catalog.getBundleAsset(betaBundleAssetId, storeUser)).rejects.toMatchObject({ status: 404 });

    await miniappBetas.setAccessMode(developer, packageName, "public");
    expect(await catalog.get(packageName, "https://core.example.test", otherUser)).toMatchObject({
      betaAccess: "public",
      availableTracks: ["stable", "beta"],
    });
    await expect(catalog.getBundleAsset(betaBundleAssetId, otherUser)).rejects.toMatchObject({ status: 404 });
    await catalog.setReleaseTrack(packageName, "beta", otherUser, "https://core.example.test");
    expect((await catalog.getBundleAsset(betaBundleAssetId, otherUser))._id.toString()).toBe(betaBundleAssetId);
    await miniappBetas.setAccessMode(developer, packageName, "private");
    expect(await MiniAppTrackEnrollmentModel.exists({ mentraUserId: otherUser.mentraUserId })).toBeNull();
  });

  test("an invited tester can discover a beta before any stable release exists", async () => {
    const packageName = "com.example.betaonly";
    const created = await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Beta Only",
      description: "Private preview",
    });
    await configurePublishableListing(packageName);
    const beta = await miniapps.createRelease(developer, {
      packageName,
      version: "0.9.0",
      releaseTrack: "beta",
      manifest: { packageName, name: "Beta Only", version: "0.9.0" },
      bundle: await releaseBundle({ packageName, name: "Beta Only", version: "0.9.0" }),
    });
    expect(await miniapps.submitRelease(developer, packageName, beta.id)).toMatchObject({
      status: "published",
      publicStoreApprovedAt: null,
    });

    const catalog = new StoreCatalogService();
    await expect(catalog.get(packageName, "https://core.example.test", storeUser)).rejects.toMatchObject({
      code: "not_found",
    });
    await miniappBetas.invite(developer, packageName, "tester@example.com");

    const visible = await catalog.get(packageName, "https://core.example.test", storeUser);
    expect(visible).toMatchObject({
      selectedTrack: "beta",
      preferredTrack: "stable",
      betaAccess: "invited",
      availableTracks: ["beta"],
      release: { version: "0.9.0", track: "beta", installable: false, bundleUrl: null, bundleSha256: null },
    });
    await expect(catalog.getBundleAsset(beta.releaseBundleAssetId!, storeUser)).rejects.toMatchObject({ status: 404 });
    expect(
      (await catalog.list({ ...storeUser, baseUrl: "https://core.example.test" })).apps.map(app => app.packageName),
    ).toContain(packageName);

    const joined = await catalog.setReleaseTrack(packageName, "beta", storeUser, "https://core.example.test");
    expect(joined).toMatchObject({
      selectedTrack: "beta",
      preferredTrack: "beta",
      release: { installable: true, bundleUrl: expect.any(String), bundleSha256: expect.any(String) },
    });
    expect((await catalog.getBundleAsset(beta.releaseBundleAssetId!, storeUser))._id.toString()).toBe(
      beta.releaseBundleAssetId,
    );
    const left = await catalog.setReleaseTrack(packageName, "stable", storeUser, "https://core.example.test");
    expect(left).toMatchObject({
      selectedTrack: "beta",
      preferredTrack: "stable",
      release: { installable: false },
    });
    expect(await MiniAppBetaInvitationModel.exists({ miniAppId: created.id, status: "accepted" })).not.toBeNull();

    await miniappBetas.setAccessMode(developer, packageName, "public");
    const publicUser = { mentraUserId: "mu_store_other", tenantId: "mentra" };
    await expect(catalog.get(packageName, "https://core.example.test", publicUser)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await MiniAppReleaseModel.findById(beta.id).lean())?.status).toBe("submitted");
    await miniapps.approveRelease({ releaseId: beta.id, adminId: "admin@mentraglass.com" });
    await miniapps.publishRelease({ releaseId: beta.id, adminId: "admin@mentraglass.com" });
    expect(await catalog.get(packageName, "https://core.example.test", publicUser)).toMatchObject({
      betaAccess: "public",
      preferredTrack: "stable",
      release: { installable: false, bundleUrl: null },
    });
    expect(await catalog.get(packageName, "https://core.example.test")).toMatchObject({
      betaAccess: "public",
      preferredTrack: "stable",
      release: { installable: false, bundleUrl: null },
    });
    await expect(catalog.getBundleAsset(beta.releaseBundleAssetId!, publicUser)).rejects.toMatchObject({ status: 404 });
    expect(
      await catalog.setReleaseTrack(packageName, "beta", publicUser, "https://core.example.test"),
    ).toMatchObject({ preferredTrack: "beta", release: { installable: true } });
  });
});

async function releaseBundle(manifest: Record<string, unknown>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("miniapp.json", JSON.stringify(manifest));
  return zip.generateAsync({ type: "uint8array" });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function configurePublishableListing(packageName: string): Promise<void> {
  await miniapps.updateStoreListing(developer, packageName, {
    longDescription: "A complete Store description.",
    privacyPolicyUrl: "https://example.com/privacy",
    supportUrl: "https://example.com/support",
  });
  await miniapps.createStoreAsset(developer, packageName, {
    role: "store_icon",
    fileName: "icon.png",
    contentType: "image/png",
    bytes: tinyPng(),
  });
}

async function createAcceptedStoreRelease(packageName: string) {
  await miniapps.createMiniApp(developer, {
    packageName,
    displayName: "Store decision test",
    description: "Store decision serialization test",
  });
  await configurePublishableListing(packageName);
  const release = await miniapps.createRelease(developer, {
    packageName,
    version: "1.0.0",
    manifest: { packageName, name: "Store decision test", version: "1.0.0" },
    bundle: await releaseBundle({ packageName, name: "Store decision test", version: "1.0.0" }),
  });
  await miniapps.submitRelease(developer, packageName, release.id);
  await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
  return release;
}

function tinyPng(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}
