/**
 * Release CI replaces this unpinned source default in an isolated checkout.
 * Local source builds must opt into OTA with EXPO_PUBLIC_ASG_OTA_VERSION_URL.
 */
export interface EngineReleaseMetadata {
  schemaVersion: 1
  familyBaseVersion: string | null
  releaseIdentity: string | null
  releaseSetId: string | null
  sourceCommit: string | null
  otaManifestUrl: string | null
  otaManifestSha256: string | null
}

export const ENGINE_RELEASE_METADATA: Readonly<EngineReleaseMetadata> = Object.freeze({
  schemaVersion: 1,
  familyBaseVersion: null,
  releaseIdentity: null,
  releaseSetId: null,
  sourceCommit: null,
  otaManifestUrl: null,
  otaManifestSha256: null,
})
