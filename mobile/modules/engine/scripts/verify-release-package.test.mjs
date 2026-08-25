import assert from "node:assert/strict"
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {renderReleaseMetadata} from "./write-release-metadata.mjs"
import {verifyReleasePackage} from "./verify-release-package.mjs"

const expected = {
  familyBaseVersion: "3.1.0",
  releaseIdentity: "3.1.0-beta.57",
  releaseSetId: "mentra-3.1.0-beta.57",
  sourceCommit: "a".repeat(40),
  otaManifestUrl: "https://updates.example.com/mentra/3.1.0-beta.57/version.json",
  otaManifestSha256: "b".repeat(64),
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mentra-engine-package-"))
  mkdirSync(path.join(root, "src/generated"), {recursive: true})
  mkdirSync(path.join(root, "build/generated"), {recursive: true})
  mkdirSync(path.join(root, "build/public"), {recursive: true})
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@mentra/engine",
      version: expected.releaseIdentity,
      exports: {
        ".": {types: "./build/index.d.ts", default: "./build/index.js"},
      },
      dependencies: {
        "@mentra/bluetooth-sdk": expected.releaseIdentity,
        "@mentra/cloud-client": expected.releaseIdentity,
        "@mentra/cloud-protocol": expected.releaseIdentity,
        "@mentra/crust": expected.releaseIdentity,
        "@mentra/miniapp": expected.releaseIdentity,
      },
    }),
  )
  const source = renderReleaseMetadata(expected)
  writeFileSync(path.join(root, "build/index.d.ts"), 'export type {PublicValue} from "./public"\n')
  writeFileSync(path.join(root, "build/public/index.d.ts"), 'export type {PublicValue} from "./value"\n')
  writeFileSync(path.join(root, "build/public/value.d.ts"), "export type PublicValue = string\n")
  writeFileSync(path.join(root, "src/generated/releaseMetadata.ts"), source)
  writeFileSync(
    path.join(root, "build/generated/releaseMetadata.js"),
    source.replace(/export interface[\s\S]*?\n}\n\n/, ""),
  )
  return root
}

test("verifies source and built metadata in an unpacked Engine tarball", () => {
  assert.deepEqual(verifyReleasePackage({packageRoot: fixture(), expected}), {schemaVersion: 1, ...expected})
})

test("rejects a package whose built metadata drifted", () => {
  const root = fixture()
  writeFileSync(path.join(root, "build/generated/releaseMetadata.js"), "export const ENGINE_RELEASE_METADATA = {}")
  assert.throws(
    () => verifyReleasePackage({packageRoot: root, expected}),
    /does not contain expected familyBaseVersion/,
  )
})

test("rejects a packed Engine with a drifting family dependency", () => {
  const root = fixture()
  const manifestPath = path.join(root, "package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  manifest.dependencies["@mentra/bluetooth-sdk"] = "^3.1.0-beta.57"
  writeFileSync(manifestPath, JSON.stringify(manifest))

  assert.throws(() => verifyReleasePackage({packageRoot: root, expected}), /must be exactly/)
})

test("rejects a published private host export", () => {
  const root = fixture()
  const manifestPath = path.join(root, "package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  manifest.exports["./internal"] = {types: "./build/internal.d.ts"}
  writeFileSync(manifestPath, JSON.stringify(manifest))

  assert.throws(() => verifyReleasePackage({packageRoot: root, expected}), /must not publish \.\/internal/)
})

test("rejects an SDK internal import reachable from a public declaration", () => {
  const root = fixture()
  writeFileSync(
    path.join(root, "build/public/value.d.ts"),
    'export type {GlassesStatus} from "@mentra/bluetooth-sdk/internal"\n',
  )

  assert.throws(() => verifyReleasePackage({packageRoot: root, expected}), /leaks forbidden public declaration import/)
})

test("rejects a declaration import that escapes the package", () => {
  const root = fixture()
  writeFileSync(path.join(root, "build/index.d.ts"), 'export type {Outside} from "../../outside"\n')

  assert.throws(() => verifyReleasePackage({packageRoot: root, expected}), /unresolved declaration import/)
})
