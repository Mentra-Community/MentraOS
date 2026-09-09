/**
 * Release CI replaces this unpinned source default in an isolated checkout.
 * Local source builds must opt into OTA with the debug configuration API.
 */
export interface BluetoothSdkReleaseMetadata {
  schemaVersion: 1
  familyBaseVersion: string | null
  releaseIdentity: string | null
  releaseSetId: string | null
  sourceCommit: string | null
  otaManifestUrl: string | null
  otaManifestSha256: string | null
}

export const BLUETOOTH_SDK_RELEASE_METADATA: Readonly<BluetoothSdkReleaseMetadata> = Object.freeze({
  schemaVersion: 1,
  familyBaseVersion: null,
  releaseIdentity: null,
  releaseSetId: null,
  sourceCommit: null,
  otaManifestUrl: null,
  otaManifestSha256: null,
})
