import assert from "node:assert/strict"
import {mkdirSync, mkdtempSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  createMavenRecord,
  createSwiftPmRecord,
  mergeNativeRecords,
  verifySwiftPackage,
} from "./coordinated-sdk-native-records.mjs"

const plan = {
  familyBaseVersion: "3.1.0",
  releaseIdentity: "3.1.0-beta.57",
  releaseSetId: "mentra-3.1.0-beta.57",
  sourceCommit: "a".repeat(40),
  members: {
    "@mentra/bluetooth-sdk": {
      version: "3.1.0-beta.57",
      publishTargets: ["npm", "maven-central", "swift-package-manager"],
    },
  },
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "sdk-native-records-"))
  const sdkAar = path.join(root, "sdk.aar")
  const lc3Aar = path.join(root, "lc3.aar")
  const archive = path.join(root, "swift.tar")
  writeFileSync(sdkAar, "sdk")
  writeFileSync(lc3Aar, "lc3")
  writeFileSync(archive, "swift")
  return {root, sdkAar, lc3Aar, archive}
}

test("records exact Maven and SwiftPM artifacts and merges them", () => {
  const files = fixture()
  const provenanceUrl = "https://github.com/Mentra-Community/MentraOS/actions/runs/123"
  const maven = createMavenRecord({
    plan,
    sdkAar: files.sdkAar,
    sdkUrl: "https://repo.maven.apache.org/maven2/com/mentraglass/bluetooth-sdk/3.1.0-beta.57/sdk.aar",
    lc3Aar: files.lc3Aar,
    lc3Url: "https://repo.maven.apache.org/maven2/com/mentraglass/lc3Lib/3.1.0-beta.57/lc3.aar",
    provenanceUrl,
    status: "published",
  })
  const swiftpm = createSwiftPmRecord({
    plan,
    archive: files.archive,
    archiveUrl:
      "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-v3.1.0-beta.57/mentra-bluetooth-sdk-ios-3.1.0-beta.57.tar",
    tagUrl: "https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios/tree/3.1.0-beta.57",
    mirrorCommit: "b".repeat(40),
    provenanceUrl,
    status: "reused",
  })
  const merged = mergeNativeRecords({plan, maven, swiftpm})

  assert.equal(merged.publications["@mentra/bluetooth-sdk"]["maven-central"].status, "published")
  assert.equal(merged.publications["@mentra/bluetooth-sdk"]["swift-package-manager"].status, "reused")
  assert.equal(
    merged.publications["@mentra/bluetooth-sdk"]["swift-package-manager"].url,
    "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-v3.1.0-beta.57/mentra-bluetooth-sdk-ios-3.1.0-beta.57.tar",
  )
  assert.equal(
    merged.publications["@mentra/bluetooth-sdk"]["swift-package-manager"].sourceTagUrl,
    "https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios/tree/3.1.0-beta.57",
  )
  assert.equal(merged.mirrorCommit, "b".repeat(40))
  assert.equal(merged.artifacts[0].coordinate, "com.mentraglass:lc3Lib:3.1.0-beta.57")
})

test("verifies the exported Swift package version and OTA pin", () => {
  const {root} = fixture()
  const source = path.join(root, "ios/Source")
  mkdirSync(source, {recursive: true})
  const otaUrl = "https://example.com/ota.json"
  const otaSha = "c".repeat(64)
  writeFileSync(
    path.join(source, "GeneratedReleaseMetadata.swift"),
    [plan.familyBaseVersion, plan.releaseIdentity, plan.releaseSetId, plan.sourceCommit, otaUrl, otaSha]
      .map((value) => `static let value = ${JSON.stringify(value)}`)
      .join("\n"),
  )
  writeFileSync(
    path.join(source, "BluetoothSdkDefaults.swift"),
    `private static let swiftPackageSdkVersion = ${JSON.stringify(plan.releaseIdentity)}\n`,
  )
  writeFileSync(path.join(root, "README.md"), `.package(from: ${JSON.stringify(plan.releaseIdentity)})\n`)

  verifySwiftPackage({plan, packageRoot: root, otaManifestUrl: otaUrl, otaManifestSha256: otaSha})
})

test("rejects a Swift package with a mismatched release pin", () => {
  const {root} = fixture()
  const source = path.join(root, "ios/Source")
  mkdirSync(source, {recursive: true})
  writeFileSync(path.join(source, "GeneratedReleaseMetadata.swift"), "wrong")
  writeFileSync(path.join(source, "BluetoothSdkDefaults.swift"), "wrong")
  writeFileSync(path.join(root, "README.md"), "wrong")

  assert.throws(
    () =>
      verifySwiftPackage({
        plan,
        packageRoot: root,
        otaManifestUrl: "https://example.com/ota.json",
        otaManifestSha256: "c".repeat(64),
      }),
    /missing|does not/,
  )
})
