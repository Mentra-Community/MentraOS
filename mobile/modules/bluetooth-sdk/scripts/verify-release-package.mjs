#!/usr/bin/env node
import {readFileSync} from "node:fs"
import path from "node:path"

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`)
  return process.argv[index + 1]
}

const packageRoot = path.resolve(option("package-root"))
const releaseIdentity = option("release-identity")
const otaManifestUrl = option("ota-manifest-url")
const otaManifestSha256 = option("ota-manifest-sha256")
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"))
if (packageJson.version !== releaseIdentity) {
  throw new Error(`Packed SDK version ${JSON.stringify(packageJson.version)} does not match ${releaseIdentity}`)
}

const files = [
  "src/generated/releaseMetadata.ts",
  "build/generated/releaseMetadata.js",
  "android/src/main/java/com/mentra/bluetoothsdk/GeneratedReleaseMetadata.kt",
  "ios/Source/GeneratedReleaseMetadata.swift",
]
for (const relativePath of files) {
  const contents = readFileSync(path.join(packageRoot, relativePath), "utf8")
  if (!contents.includes(otaManifestUrl)) throw new Error(`${relativePath} does not contain the OTA manifest URL`)
  if (!contents.includes(otaManifestSha256))
    throw new Error(`${relativePath} does not contain the OTA manifest SHA-256`)
  if (!contents.includes(releaseIdentity)) throw new Error(`${relativePath} does not contain the release identity`)
}

console.log(`Verified packed Bluetooth SDK ${releaseIdentity} metadata across JavaScript, Android, and iOS`)
