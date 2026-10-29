/**
 * @fileoverview Read the frozen preinstalled catalog for released Mentra App versions.
 *
 * LEGACY. Mentra App versions released before the Store's headless updates
 * install and update their preinstalled miniapps from Core's registry: they ask
 * for the registry and download each bundle from Core. Core's built-in Store,
 * which published that catalog, is gone, so the catalog no longer changes; this
 * serves what it last held. Remove it with `/api/client/miniapps` once supported
 * Mentra App versions install only from the Store's backend.
 */

import {
  LEGACY_REGISTRY_ENVIRONMENTS,
  LegacyAssetModel,
  LegacyRegistryModel,
  LegacyRegistryRevisionModel,
  LegacyReleaseModel,
  type LegacyRegistryEnvironment,
} from "../../models/legacy-miniapp-catalog.model"

/** The registry the catalog was published under, in every environment. */
const DEFAULT_REGISTRY_NAME = "default"
/** Release states whose bundles were cleared to reach phones. */
const RELEASED = ["accepted", "published"]
/** The asset role of a release's installable bundle. */
const RELEASE_BUNDLE = "release_bundle"
const OBJECT_ID = /^[0-9a-f]{24}$/i

export interface LegacyRegistryEntry {
  packageName: string
  version: string
  bundleUrl: string
  bundleSha256: string
  required: boolean
  installPolicy: string
  channel: string
  minMobileVersion?: string
  maxMobileVersion?: string
  tenantId?: string
}

export interface LegacyRegistryResponse {
  generatedAt: string
  entries: LegacyRegistryEntry[]
}

export class LegacyRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "LegacyRegistryError"
  }
}

/**
 * The active registry for `environment` (Core's own environment when absent or unknown), the
 * tenant's own registry first. It lists only entries a phone can download, the rule
 * `legacyBundleAsset` serves by: a release that cleared review, with its release bundle. Each
 * bundle is downloaded from `baseUrl`.
 */
export async function legacyClientRegistry(opts: {
  environment?: string | null
  tenantId?: string | null
  baseUrl: string
}): Promise<LegacyRegistryResponse> {
  const empty = () => ({generatedAt: new Date().toISOString(), entries: []})
  const environment = registryEnvironment(opts.environment)
  const registry = await LegacyRegistryModel.findOne({
    environment,
    name: DEFAULT_REGISTRY_NAME,
    status: "active",
    tenantId: opts.tenantId ? {$in: [opts.tenantId, null]} : null,
  })
    .sort({tenantId: -1})
    .lean()
  if (!registry?.activeRevisionId) return empty()

  const revision = await LegacyRegistryRevisionModel.findOne({
    _id: registry.activeRevisionId,
    registryId: registry._id.toString(),
    status: "active",
  }).lean()
  if (!revision) return empty()

  const releaseIds = revision.entries.map(entry => entry.releaseId).filter(id => OBJECT_ID.test(id))
  const releases = await LegacyReleaseModel.find({_id: {$in: releaseIds}, status: {$in: RELEASED}}).lean()
  const releaseById = new Map(releases.map(release => [release._id.toString(), release]))
  const assetIds = releases.flatMap(release =>
    release.releaseBundleAssetId && OBJECT_ID.test(release.releaseBundleAssetId) ? [release.releaseBundleAssetId] : [],
  )
  const assets = await LegacyAssetModel.find({_id: {$in: assetIds}, role: RELEASE_BUNDLE}).lean()
  const assetIdsFound = new Set(assets.map(asset => asset._id.toString()))

  const baseUrl = opts.baseUrl.replace(/\/$/, "")
  const entries = revision.entries.flatMap((entry): LegacyRegistryEntry[] => {
    const release = releaseById.get(entry.releaseId)
    if (!release?.releaseBundleAssetId || !release.bundleSha256) return []
    if (!assetIdsFound.has(release.releaseBundleAssetId)) return []
    return [
      {
        packageName: release.packageName,
        version: release.version,
        bundleUrl: `${baseUrl}/api/client/miniapps/bundles/${release.releaseBundleAssetId}/download`,
        bundleSha256: release.bundleSha256,
        required: entry.required ?? false,
        installPolicy: entry.installPolicy ?? "install_once",
        channel: registry.environment,
        minMobileVersion: entry.minMobileVersion ?? undefined,
        maxMobileVersion: entry.maxMobileVersion ?? undefined,
        tenantId: registry.tenantId ?? undefined,
      },
    ]
  })
  return {generatedAt: new Date().toISOString(), entries}
}

/**
 * A bundle asset a phone may download: a release bundle of a release that cleared review. Anything
 * else is 404 (not 403), so an id's existence is never confirmed.
 */
export async function legacyBundleAsset(assetId: string) {
  const notFound = () => new LegacyRegistryError("not_found", "bundle asset not found", 404)
  if (!OBJECT_ID.test(assetId)) throw notFound()
  const asset = await LegacyAssetModel.findOne({_id: assetId, role: RELEASE_BUNDLE}).lean()
  if (!asset) throw notFound()
  const released = await LegacyReleaseModel.exists({releaseBundleAssetId: assetId, status: {$in: RELEASED}})
  if (!released) throw notFound()
  return asset
}

function registryEnvironment(value: string | null | undefined): LegacyRegistryEnvironment {
  const known = (candidate: string | null | undefined): candidate is LegacyRegistryEnvironment =>
    LEGACY_REGISTRY_ENVIRONMENTS.includes(candidate as LegacyRegistryEnvironment)
  if (known(value)) return value
  const own = process.env.CLOUD_CORE_ENVIRONMENT
  return known(own) ? own : "dev"
}
