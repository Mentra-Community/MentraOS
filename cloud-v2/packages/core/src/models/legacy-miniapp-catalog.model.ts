/**
 * @fileoverview The frozen catalog of Core's former built-in Store, read-only.
 *
 * LEGACY. Released Mentra App versions before the Store's headless updates
 * still install and update their preinstalled miniapps from Core
 * (`/api/client/miniapps`, `api/client/miniapps.api.ts`). These schemas read the
 * rows that serve them: the active registry and revision, the releases they
 * name, and each release's bundle asset. Nothing writes them any more, so Core
 * neither creates these collections nor builds their indexes.
 *
 * Remove this file with that API once supported Mentra App versions install
 * only from the Store's backend.
 */

import {Schema, type InferSchemaType} from "mongoose"
import {registerModel} from "./register-model"

/** The registry environments the catalog was published for. */
export const LEGACY_REGISTRY_ENVIRONMENTS = ["debug", "dev", "staging", "prod"] as const
export type LegacyRegistryEnvironment = (typeof LEGACY_REGISTRY_ENVIRONMENTS)[number]

const READ_ONLY = {autoCreate: false, autoIndex: false} as const

const LegacyRegistrySchema = new Schema(
  {
    name: {type: String, required: true},
    environment: {type: String, required: true},
    tenantId: {type: String, default: null},
    status: {type: String, required: true},
    activeRevisionId: {type: String, default: null},
  },
  {...READ_ONLY, collection: "preinstalled_registries"},
)

const LegacyRegistryRevisionSchema = new Schema(
  {
    registryId: {type: String, required: true},
    status: {type: String, required: true},
    entries: {
      type: [
        new Schema(
          {
            releaseId: {type: String, required: true},
            required: {type: Boolean, default: false},
            installPolicy: {type: String, default: "install_once"},
            minMobileVersion: {type: String, default: null},
            maxMobileVersion: {type: String, default: null},
          },
          {_id: false},
        ),
      ],
      default: [],
    },
  },
  {...READ_ONLY, collection: "preinstalled_registry_revisions"},
)

const LegacyReleaseSchema = new Schema(
  {
    packageName: {type: String, required: true},
    version: {type: String, required: true},
    status: {type: String, required: true},
    releaseBundleAssetId: {type: String, default: null},
    bundleSha256: {type: String, default: null},
  },
  {...READ_ONLY, collection: "miniapp_releases"},
)

const LegacyAssetSchema = new Schema(
  {
    role: {type: String, required: true},
    storageKey: {type: String, required: true},
    fileName: {type: String, required: true},
    contentType: {type: String, required: true},
    sizeBytes: {type: Number, required: true},
    sha256: {type: String, required: true},
  },
  {...READ_ONLY, collection: "miniapp_assets"},
)

export type LegacyRegistry = InferSchemaType<typeof LegacyRegistrySchema>
export type LegacyRegistryRevision = InferSchemaType<typeof LegacyRegistryRevisionSchema>
export type LegacyRelease = InferSchemaType<typeof LegacyReleaseSchema>
export type LegacyAsset = InferSchemaType<typeof LegacyAssetSchema>

export const LegacyRegistryModel = registerModel("LegacyPreinstalledRegistry", LegacyRegistrySchema)
export const LegacyRegistryRevisionModel = registerModel("LegacyPreinstalledRegistryRevision", LegacyRegistryRevisionSchema)
export const LegacyReleaseModel = registerModel("LegacyMiniappRelease", LegacyReleaseSchema)
export const LegacyAssetModel = registerModel("LegacyMiniappAsset", LegacyAssetSchema)
