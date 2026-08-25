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
import { MiniAppModel } from "../packages/core/src/models/miniapp.model";
import { MiniAppReleaseModel } from "../packages/core/src/models/miniapp-release.model";
import { MiniAppTrackEnrollmentModel } from "../packages/core/src/models/miniapp-track-enrollment.model";
import { DeveloperSigningKeyModel } from "../packages/core/src/models/developer-signing-key.model";
import { PreinstalledRegistryModel } from "../packages/core/src/models/preinstalled-registry.model";
import { PreinstalledRegistryRevisionModel } from "../packages/core/src/models/preinstalled-registry-revision.model";
import type { PreinstalledRegistryService } from "../packages/core/src/services/miniapps/preinstalled-registry.service";
import type { MiniAppService } from "../packages/core/src/services/miniapps/miniapp.service";
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
let registries: PreinstalledRegistryService;
let signing: DeveloperSigningService;

beforeAll(async () => {
  await connectMongo(process.env.MONGO_URL ?? "mongodb://127.0.0.1:27017/mentra-cloud-v2-test");
  await Promise.all([
    MiniAppModel.syncIndexes(),
    MiniAppReleaseModel.syncIndexes(),
    MiniAppTrackEnrollmentModel.syncIndexes(),
    DeveloperSigningKeyModel.syncIndexes(),
    MiniAppAssetModel.syncIndexes(),
    PreinstalledRegistryModel.syncIndexes(),
    PreinstalledRegistryRevisionModel.syncIndexes(),
  ]);
  const { MiniAppService } = await import("../packages/core/src/services/miniapps/miniapp.service");
  const { PreinstalledRegistryService } = await import(
    "../packages/core/src/services/miniapps/preinstalled-registry.service"
  );
  const { DeveloperSigningService } = await import("../packages/core/src/services/miniapps/developer-signing.service");
  miniapps = new MiniAppService();
  registries = new PreinstalledRegistryService();
  signing = new DeveloperSigningService();
});

afterAll(async () => {
  await disconnectMongo();
});

beforeEach(async () => {
  await Promise.all([
    MiniAppModel.deleteMany({ orgId: developer.orgId }),
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

  test("getBundleAsset only serves bundles for accepted or published releases", async () => {
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
    await expect(registries.getBundleAsset(assetId)).rejects.toMatchObject({ status: 404 });

    // Once accepted, the same asset id resolves.
    await miniapps.submitRelease(developer, "com.example.secret", release.id);
    await miniapps.approveRelease({ releaseId: release.id, adminId: "admin@mentraglass.com" });
    const asset = await registries.getBundleAsset(assetId);
    expect(asset._id.toString()).toBe(assetId);
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
    expect(catalog.apps[0]?.release.bundleUrl).toContain("/api/client/miniapps/bundles/");

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

  test("stable and beta publish independently and Core selects beta only for the enrolled user", async () => {
    const packageName = "com.example.tracks";
    await miniapps.createMiniApp(developer, {
      packageName,
      displayName: "Track Test",
      description: "Track selection",
    });
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

function tinyPng(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
}
