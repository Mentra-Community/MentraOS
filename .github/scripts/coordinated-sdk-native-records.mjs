#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const STATUSES = new Set(["built", "published", "reused"])

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function requireHttps(value, label) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without a fragment`)
  }
  return url.toString()
}

function validatePlan(plan) {
  const sdk = plan.members?.["@mentra/bluetooth-sdk"]
  if (
    plan.releaseSetId !== `mentra-${plan.releaseIdentity}` ||
    sdk?.version !== plan.releaseIdentity ||
    !sdk?.publishTargets?.includes("maven-central") ||
    !sdk?.publishTargets?.includes("swift-package-manager")
  ) {
    throw new Error("Release plan does not contain a coordinated Bluetooth SDK release")
  }
  return plan
}

function artifact({coordinate, file, url, provenanceUrl, status}) {
  if (!STATUSES.has(status)) throw new Error(`Unsupported publication status ${JSON.stringify(status)}`)
  if (!coordinate) throw new Error("Artifact coordinate is required")
  return {
    status,
    coordinate,
    url: requireHttps(url, `${coordinate} URL`),
    sha256: sha256File(file),
    size: statSync(file).size,
    provenanceUrl: requireHttps(provenanceUrl, `${coordinate} provenance URL`),
  }
}

export function createMavenRecord({plan, sdkAar, sdkUrl, lc3Aar, lc3Url, provenanceUrl, status}) {
  validatePlan(plan)
  const version = plan.releaseIdentity
  const sdk = artifact({
    coordinate: `com.mentraglass:bluetooth-sdk:${version}`,
    file: sdkAar,
    url: sdkUrl,
    provenanceUrl,
    status,
  })
  const lc3 = artifact({
    coordinate: `com.mentraglass:lc3Lib:${version}`,
    file: lc3Aar,
    url: lc3Url,
    provenanceUrl,
    status,
  })
  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    publications: {"@mentra/bluetooth-sdk": {"maven-central": sdk}},
    artifacts: [lc3],
  }
}

export function verifySwiftPackage({plan, packageRoot, otaManifestUrl, otaManifestSha256}) {
  validatePlan(plan)
  if (!SHA256_PATTERN.test(otaManifestSha256)) throw new Error("Invalid OTA manifest SHA-256")
  const generated = readFileSync(path.join(packageRoot, "ios/Source/GeneratedReleaseMetadata.swift"), "utf8")
  const defaults = readFileSync(path.join(packageRoot, "ios/Source/BluetoothSdkDefaults.swift"), "utf8")
  const readme = readFileSync(path.join(packageRoot, "README.md"), "utf8")
  for (const value of [plan.familyBaseVersion, plan.releaseIdentity, plan.releaseSetId, plan.sourceCommit]) {
    if (!generated.includes(JSON.stringify(value))) throw new Error(`Swift release metadata is missing ${value}`)
  }
  if (!generated.includes(JSON.stringify(otaManifestUrl)) || !generated.includes(JSON.stringify(otaManifestSha256))) {
    throw new Error("Swift release metadata does not contain the selected OTA pin")
  }
  if (!defaults.includes(`swiftPackageSdkVersion = ${JSON.stringify(plan.releaseIdentity)}`)) {
    throw new Error("Swift package SDK version does not match the release identity")
  }
  if (!readme.includes(`from: ${JSON.stringify(plan.releaseIdentity)}`)) {
    throw new Error("Swift package README does not reference the release identity")
  }
  for (const contents of [generated, defaults, readme]) {
    if (contents.includes("__MENTRA_BLUETOOTH_SDK_VERSION__")) {
      throw new Error("Swift package contains an unresolved SDK version placeholder")
    }
  }
}

export function createSwiftPmRecord({plan, archive, archiveUrl, tagUrl, mirrorCommit, provenanceUrl, status}) {
  validatePlan(plan)
  if (!COMMIT_PATTERN.test(mirrorCommit)) throw new Error("SwiftPM mirror commit must be a full Git SHA")
  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    mirrorCommit,
    publications: {
      "@mentra/bluetooth-sdk": {
        "swift-package-manager": {
          ...artifact({
            coordinate: `Mentra-Community/mentra-bluetooth-sdk-ios@${plan.releaseIdentity}`,
            file: archive,
            url: archiveUrl,
            provenanceUrl,
            status,
          }),
          sourceTagUrl: requireHttps(tagUrl, "SwiftPM source tag URL"),
        },
      },
    },
    artifacts: [],
  }
}

export function mergeNativeRecords({plan, maven, swiftpm}) {
  validatePlan(plan)
  for (const [name, record] of Object.entries({maven, swiftpm})) {
    if (record.releaseSetId !== plan.releaseSetId) throw new Error(`${name} record belongs to another release set`)
  }
  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    mirrorCommit: swiftpm.mirrorCommit,
    publications: {
      "@mentra/bluetooth-sdk": {
        ...maven.publications["@mentra/bluetooth-sdk"],
        ...swiftpm.publications["@mentra/bluetooth-sdk"],
      },
    },
    artifacts: [...(maven.artifacts || []), ...(swiftpm.artifacts || [])],
  }
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

function main() {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  const plan = validatePlan(readJson(path.resolve(args.plan)))
  let record
  if (command === "verify-swiftpm") {
    verifySwiftPackage({
      plan,
      packageRoot: path.resolve(args["package-root"]),
      otaManifestUrl: args["ota-manifest-url"],
      otaManifestSha256: args["ota-manifest-sha256"],
    })
    return
  }
  if (command === "create-maven") {
    record = createMavenRecord({
      plan,
      sdkAar: path.resolve(args["sdk-aar"]),
      sdkUrl: args["sdk-url"],
      lc3Aar: path.resolve(args["lc3-aar"]),
      lc3Url: args["lc3-url"],
      provenanceUrl: args["provenance-url"],
      status: args.status,
    })
  } else if (command === "create-swiftpm") {
    record = createSwiftPmRecord({
      plan,
      archive: path.resolve(args.archive),
      archiveUrl: args["archive-url"],
      tagUrl: args["tag-url"],
      mirrorCommit: args["mirror-commit"],
      provenanceUrl: args["provenance-url"],
      status: args.status,
    })
  } else if (command === "merge") {
    record = mergeNativeRecords({plan, maven: readJson(args.maven), swiftpm: readJson(args.swiftpm)})
  } else {
    throw new Error(`Unknown command ${JSON.stringify(command)}`)
  }
  writeFileSync(args.output, serializeReleaseRecord(record))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
