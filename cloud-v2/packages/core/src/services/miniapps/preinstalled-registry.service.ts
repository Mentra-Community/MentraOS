import { MiniAppAssetModel } from "../../models/miniapp-asset.model";
import { MiniAppModel } from "../../models/miniapp.model";
import { MiniAppReleaseModel } from "../../models/miniapp-release.model";
import {
  PREINSTALLED_REGISTRY_ENVIRONMENTS,
  PreinstalledRegistryModel,
  type PreinstalledRegistry,
} from "../../models/preinstalled-registry.model";
import {
  PREINSTALLED_INSTALL_POLICIES,
  PreinstalledRegistryRevisionModel,
  type PreinstalledRegistryRevision,
} from "../../models/preinstalled-registry-revision.model";

export type PreinstalledRegistryEnvironment = typeof PREINSTALLED_REGISTRY_ENVIRONMENTS[number];
export type PreinstalledInstallPolicy = typeof PREINSTALLED_INSTALL_POLICIES[number];

export interface AdminIdentity {
  adminId: string;
}

export interface CreateRegistryRevisionEntryInput {
  releaseId: string;
  required?: boolean;
  installPolicy?: PreinstalledInstallPolicy;
  minMobileVersion?: string | null;
  maxMobileVersion?: string | null;
  priority?: number;
}

export interface CreateRegistryRevisionInput {
  entries: CreateRegistryRevisionEntryInput[];
  reason?: string | null;
}

export interface ClientRegistryOptions {
  environment?: string | null;
  tenantId?: string | null;
  baseUrl: string;
}

const DEFAULT_REGISTRY_NAME = "default";

export class PreinstalledRegistryService {
  async listRegistries() {
    const registries = await PreinstalledRegistryModel.find({ status: { $ne: "archived" } })
      .sort({ environment: 1, name: 1 })
      .lean();
    return registries.map(serializeRegistry);
  }

  async ensureRegistry(admin: AdminIdentity, input: {
    environment: PreinstalledRegistryEnvironment;
    name?: string;
    tenantId?: string | null;
  }) {
    const name = input.name?.trim() || DEFAULT_REGISTRY_NAME;
    const existing = await PreinstalledRegistryModel.findOne({
      environment: input.environment,
      name,
      tenantId: input.tenantId ?? null,
      status: { $ne: "archived" },
    }).lean();
    if (existing) return serializeRegistry(existing);

    const created = await PreinstalledRegistryModel.create({
      name,
      environment: input.environment,
      tenantId: input.tenantId ?? null,
      status: "draft",
      createdBy: admin.adminId,
    });
    return serializeRegistry(created.toObject());
  }

  async listPublishableReleases() {
    const releases = await MiniAppReleaseModel.find({
      releaseBundleAssetId: { $ne: null },
      status: { $in: ["accepted", "published"] },
    })
      .sort({ createdAt: -1 })
      .lean();
    const appIds = [...new Set(releases.map(release => release.miniAppId))];
    const apps = await MiniAppModel.find({ _id: { $in: appIds } }).lean();
    const appsById = new Map(apps.map(app => [app._id.toString(), app]));

    return releases.map(release => {
      const app = appsById.get(release.miniAppId);
      return {
        id: release._id.toString(),
        miniAppId: release.miniAppId,
        packageName: release.packageName,
        displayName: app?.displayName ?? release.packageName,
        version: release.version,
        status: release.status,
        bundleSha256: release.bundleSha256 ?? null,
        bundleSizeBytes: release.bundleSizeBytes ?? null,
        createdAt: release.createdAt?.toISOString() ?? null,
      };
    });
  }

  async listRevisions(registryId: string) {
    const registry = await this.requireRegistry(registryId);
    const revisions = await PreinstalledRegistryRevisionModel.find({ registryId: registry._id.toString() })
      .sort({ createdAt: -1 })
      .lean();
    return revisions.map(serializeRevision);
  }

  async createRevision(admin: AdminIdentity, registryId: string, input: CreateRegistryRevisionInput) {
    const registry = await this.requireRegistry(registryId);
    const entries = await Promise.all(
      input.entries.map((entry, index) => this.resolveEntry(entry, index)),
    );
    assertOneReleasePerMiniApp(entries);

    const revision = await PreinstalledRegistryRevisionModel.create({
      registryId: registry._id.toString(),
      status: "draft",
      reason: input.reason?.trim() || null,
      entries,
      createdBy: admin.adminId,
    });

    return serializeRevision(revision.toObject());
  }

  async promoteRevision(admin: AdminIdentity, registryId: string, revisionId: string) {
    const registry = await this.requireRegistry(registryId);
    const revision = await PreinstalledRegistryRevisionModel.findOne({
      _id: revisionId,
      registryId: registry._id.toString(),
    });
    if (!revision) {
      throw new PreinstalledRegistryServiceError("not_found", "registry revision not found", 404);
    }

    await PreinstalledRegistryRevisionModel.updateMany(
      { registryId: registry._id.toString(), status: "active" },
      { $set: { status: "archived" } },
    );

    revision.status = "active";
    revision.promotedBy = admin.adminId;
    revision.promotedAt = new Date();
    await revision.save();

    registry.status = "active";
    registry.activeRevisionId = revision._id.toString();
    registry.updatedBy = admin.adminId;
    await registry.save();

    return {
      registry: serializeRegistry(registry.toObject()),
      revision: serializeRevision(revision.toObject()),
    };
  }

  async clientRegistry(opts: ClientRegistryOptions) {
    const environment = normalizeEnvironment(opts.environment);
    const registry = await PreinstalledRegistryModel.findOne({
      environment,
      name: DEFAULT_REGISTRY_NAME,
      status: "active",
      tenantId: opts.tenantId
        ? { $in: [opts.tenantId, null] }
        : null,
    })
      .sort({ tenantId: -1 })
      .lean();
    if (!registry?.activeRevisionId) {
      return { generatedAt: new Date().toISOString(), entries: [] };
    }

    const revision = await PreinstalledRegistryRevisionModel.findOne({
      _id: registry.activeRevisionId,
      registryId: registry._id.toString(),
      status: "active",
    }).lean();
    if (!revision) {
      return { generatedAt: new Date().toISOString(), entries: [] };
    }

    const releaseIds = revision.entries.map(entry => entry.releaseId);
    const releases = await MiniAppReleaseModel.find({ _id: { $in: releaseIds } }).lean();
    const releaseById = new Map(releases.map(release => [release._id.toString(), release]));
    const assetIds = releases.map(release => release.releaseBundleAssetId).filter(Boolean) as string[];
    const assets = await MiniAppAssetModel.find({ _id: { $in: assetIds } }).lean();
    const assetById = new Map(assets.map(asset => [asset._id.toString(), asset]));

    const baseUrl = opts.baseUrl.replace(/\/$/, "");
    const entries = revision.entries
      .map(entry => {
        const release = releaseById.get(entry.releaseId);
        if (!release?.releaseBundleAssetId || !release.bundleSha256) return null;
        const asset = assetById.get(release.releaseBundleAssetId);
        if (!asset) return null;
        return {
          packageName: release.packageName,
          version: release.version,
          bundleUrl: `${baseUrl}/api/client/miniapps/bundles/${asset._id.toString()}/download`,
          bundleSha256: release.bundleSha256,
          required: entry.required,
          installPolicy: entry.installPolicy,
          channel: registry.environment,
          minMobileVersion: entry.minMobileVersion ?? undefined,
          maxMobileVersion: entry.maxMobileVersion ?? undefined,
          tenantId: registry.tenantId ?? undefined,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    return { generatedAt: new Date().toISOString(), entries };
  }

  async getBundleAsset(assetId: string) {
    const asset = await MiniAppAssetModel.findOne({ _id: assetId, role: "release_bundle" }).lean();
    if (!asset) throw new PreinstalledRegistryServiceError("not_found", "bundle asset not found", 404);
    // Only serve bundles that belong to a release which cleared review
    // (accepted/published). Without this, any release_bundle asset id resolves to
    // a downloadable zip, exposing draft/rejected/unpublished bundles to anyone
    // who has the id. 404 (not 403) so we do not confirm an id exists.
    const released = await MiniAppReleaseModel.exists({
      releaseBundleAssetId: assetId,
      status: { $in: ["accepted", "published"] },
    });
    if (!released) throw new PreinstalledRegistryServiceError("not_found", "bundle asset not found", 404);
    return asset;
  }

  private async requireRegistry(registryId: string) {
    const registry = await PreinstalledRegistryModel.findOne({ _id: registryId, status: { $ne: "archived" } });
    if (!registry) throw new PreinstalledRegistryServiceError("not_found", "registry not found", 404);
    return registry;
  }

  private async resolveEntry(input: CreateRegistryRevisionEntryInput, index: number) {
    const release = await MiniAppReleaseModel.findOne({ _id: input.releaseId });
    if (!release) {
      throw new PreinstalledRegistryServiceError("invalid_release", `release ${input.releaseId} not found`, 400);
    }
    if (!release.releaseBundleAssetId || !release.bundleSha256) {
      throw new PreinstalledRegistryServiceError(
        "invalid_release",
        `release ${input.releaseId} has no release bundle`,
        400,
      );
    }
    return {
      miniAppId: release.miniAppId,
      releaseId: release._id.toString(),
      required: input.required ?? false,
      installPolicy: input.installPolicy ?? "install_once",
      minMobileVersion: input.minMobileVersion ?? null,
      maxMobileVersion: input.maxMobileVersion ?? null,
      priority: input.priority ?? index,
    };
  }
}

function assertOneReleasePerMiniApp(entries: Array<{ miniAppId: string; releaseId: string }>): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const previousReleaseId = seen.get(entry.miniAppId);
    if (previousReleaseId) {
      throw new PreinstalledRegistryServiceError(
        "duplicate_miniapp_release",
        `preinstall registry can only include one release per miniapp; ${entry.miniAppId} includes ${previousReleaseId} and ${entry.releaseId}`,
        400,
      );
    }
    seen.set(entry.miniAppId, entry.releaseId);
  }
}

export class PreinstalledRegistryServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PreinstalledRegistryServiceError";
  }
}

function normalizeEnvironment(value: string | null | undefined): PreinstalledRegistryEnvironment {
  if (value && PREINSTALLED_REGISTRY_ENVIRONMENTS.includes(value as PreinstalledRegistryEnvironment)) {
    return value as PreinstalledRegistryEnvironment;
  }
  const env = process.env.CLOUD_CORE_ENVIRONMENT;
  if (env && PREINSTALLED_REGISTRY_ENVIRONMENTS.includes(env as PreinstalledRegistryEnvironment)) {
    return env as PreinstalledRegistryEnvironment;
  }
  return "dev";
}

function serializeRegistry(registry: PreinstalledRegistry & { _id: unknown; createdAt?: Date; updatedAt?: Date }) {
  return {
    id: String(registry._id),
    name: registry.name,
    environment: registry.environment,
    tenantId: registry.tenantId ?? null,
    status: registry.status,
    activeRevisionId: registry.activeRevisionId ?? null,
    createdAt: registry.createdAt?.toISOString() ?? null,
    updatedAt: registry.updatedAt?.toISOString() ?? null,
  };
}

function serializeRevision(revision: PreinstalledRegistryRevision & { _id: unknown; createdAt?: Date; updatedAt?: Date }) {
  return {
    id: String(revision._id),
    registryId: revision.registryId,
    status: revision.status,
    reason: revision.reason ?? null,
    entries: revision.entries
      .map(entry => ({
        id: entry._id?.toString() ?? "",
        miniAppId: entry.miniAppId,
        releaseId: entry.releaseId,
        required: entry.required,
        installPolicy: entry.installPolicy,
        minMobileVersion: entry.minMobileVersion ?? null,
        maxMobileVersion: entry.maxMobileVersion ?? null,
        priority: entry.priority,
      }))
      .sort((a, b) => a.priority - b.priority),
    promotedAt: revision.promotedAt?.toISOString() ?? null,
    createdAt: revision.createdAt?.toISOString() ?? null,
    updatedAt: revision.updatedAt?.toISOString() ?? null,
  };
}
