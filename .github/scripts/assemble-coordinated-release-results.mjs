#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"
import {createEnginePackageArtifact, mergeReleaseResultRecords} from "./release-result-records.mjs"

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function provenanceUrl(ota) {
  return `https://github.com/${ota.workflow.repository}/actions/runs/${ota.workflow.runId}`
}

function verifyAsgSelection(plan, ota, selectionFile) {
  if (
    ota.releaseIdentity !== plan.releaseIdentity ||
    ota.sourceCommit !== plan.sourceCommit ||
    ota.selection?.asset !== plan.artifactNames.asgSelection
  ) {
    throw new Error("OTA result does not match the release plan")
  }
  const bytes = readFileSync(selectionFile)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== ota.selection.sha256 || statSync(selectionFile).size !== ota.selection.size) {
    throw new Error("ASG selection file differs from the OTA result")
  }
  const selection = JSON.parse(bytes)
  if (
    selection.releaseSetId !== plan.releaseSetId ||
    selection.releaseIdentity !== plan.releaseIdentity ||
    selection.sourceCommit !== plan.sourceCommit ||
    selection.fingerprint !== ota.asg.fingerprint ||
    selection.versionCode !== ota.asg.versionCode ||
    selection.versionName !== ota.asg.versionName ||
    selection.apk?.asset !== ota.asg.artifact.asset ||
    selection.apk?.sha256 !== ota.asg.artifact.sha256
  ) {
    throw new Error("ASG selection does not describe the OTA result")
  }
  return {sha256, size: bytes.length}
}

function verifyExampleTestflight(plan, starterKit, exampleTestflight) {
  const expectedGroup = plan.channel === "dev" ? "Mentra Dev" : "Mentra Staging"
  if (
    exampleTestflight?.schemaVersion !== 1 ||
    exampleTestflight.releaseSetId !== plan.releaseSetId ||
    exampleTestflight.releaseIdentity !== plan.releaseIdentity ||
    exampleTestflight.channel !== plan.channel ||
    exampleTestflight.mentraosSourceCommit !== plan.sourceCommit ||
    exampleTestflight.starterKitReleaseCommit !== starterKit.starterKit?.releaseCommit ||
    exampleTestflight.app?.id !== "6792839366" ||
    exampleTestflight.app?.bundleId !== "com.mentra.bluetoothsdkexample" ||
    exampleTestflight.version?.marketingVersion !== plan.native.marketingVersion ||
    exampleTestflight.version?.buildNumber !== plan.native.buildNumber ||
    exampleTestflight.build?.processingState !== "VALID" ||
    !["published", "reused"].includes(exampleTestflight.build?.uploadStatus) ||
    typeof exampleTestflight.build?.id !== "string" ||
    exampleTestflight.build.id.length === 0 ||
    exampleTestflight.group?.name !== expectedGroup ||
    typeof exampleTestflight.group?.id !== "string" ||
    exampleTestflight.group.id.length === 0 ||
    !/^https:\/\//.test(exampleTestflight.provenanceUrl || "")
  ) {
    throw new Error("Example TestFlight result does not match the release plan and Starter Kit source")
  }
  if (
    exampleTestflight.ipa !== undefined &&
    (!/^[0-9a-f]{64}$/.test(exampleTestflight.ipa.sha256 || "") ||
      !Number.isSafeInteger(exampleTestflight.ipa.size) ||
      exampleTestflight.ipa.size < 1)
  ) {
    throw new Error("Example TestFlight IPA evidence is invalid")
  }
  return exampleTestflight
}

function verifyStarterKitResult(plan, starterKit, resultUrl, exampleTestflight) {
  if (!starterKit) return undefined
  if (
    starterKit.schemaVersion !== 1 ||
    starterKit.releaseSetId !== plan.releaseSetId ||
    starterKit.releaseIdentity !== plan.releaseIdentity ||
    starterKit.familyBaseVersion !== plan.familyBaseVersion ||
    starterKit.channel !== plan.channel ||
    starterKit.mentraos?.sourceCommit !== plan.sourceCommit
  ) {
    throw new Error("Starter Kit result does not match the release plan")
  }
  for (const packageName of ["@mentra/bluetooth-sdk", "@mentra/engine"]) {
    if (starterKit.packages?.[packageName] !== plan.releaseIdentity) {
      throw new Error(`Starter Kit ${packageName} version does not match the release plan`)
    }
  }
  if (!/^https:\/\//.test(resultUrl || "")) throw new Error("Starter Kit result URL must be public HTTPS")
  if (!/^https:\/\//.test(starterKit.starterKit?.validationRunUrl || "")) {
    throw new Error("Starter Kit validation run URL must be public HTTPS")
  }
  if (!Array.isArray(starterKit.artifacts) || ![3, 4].includes(starterKit.artifacts.length)) {
    throw new Error("Starter Kit result must contain the three required examples and optional native Android")
  }
  const keys = new Set()
  const artifacts = starterKit.artifacts.map((artifact) => {
    if (
      !artifact?.key ||
      keys.has(artifact.key) ||
      typeof artifact.name !== "string" ||
      !artifact.name.includes(plan.releaseIdentity) ||
      !/^https:\/\//.test(artifact.url || "") ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256 || "") ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1
    ) {
      throw new Error("Starter Kit contains an invalid or duplicate example artifact")
    }
    keys.add(artifact.key)
    return {
      status: "published",
      coordinate: artifact.name,
      url: artifact.url,
      sha256: artifact.sha256,
      size: artifact.size,
      provenanceUrl: starterKit.starterKit.validationRunUrl,
    }
  })
  for (const key of ["ios", "reactNative", "reactNativeElevenLabsAudio"]) {
    if (!keys.has(key)) throw new Error(`Starter Kit result is missing ${key}`)
  }
  return {
    record: {...starterKit, resultUrl, testflight: verifyExampleTestflight(plan, starterKit, exampleTestflight)},
    artifacts,
  }
}

export function assembleCoordinatedReleaseResults({
  plan,
  ota,
  npmRecords,
  native,
  mobile,
  starterKit,
  starterKitResultUrl,
  exampleTestflight,
  asgSelectionFile,
  enginePackage,
  releaseAssetBaseUrl,
}) {
  if (plan.releaseSetId !== `mentra-${plan.releaseIdentity}` || ota.releaseSetId !== plan.releaseSetId) {
    throw new Error("Release plan and OTA result do not identify the same release set")
  }
  const merged = mergeReleaseResultRecords({plan, records: [...npmRecords, native, mobile]})
  const selection = verifyAsgSelection(plan, ota, asgSelectionFile)
  const verifiedStarterKit = verifyStarterKitResult(plan, starterKit, starterKitResultUrl, exampleTestflight)
  const otaProvenanceUrl = provenanceUrl(ota)
  const artifacts = [
    ...merged.artifacts,
    {
      status: ota.bundle.status,
      coordinate: ota.bundle.asset,
      url: ota.bundle.url,
      sha256: ota.bundle.sha256,
      size: ota.bundle.size,
      provenanceUrl: otaProvenanceUrl,
    },
    {
      status: ota.asg.reused ? "reused" : ota.manifest.status,
      coordinate: ota.asg.artifact.asset,
      url: ota.asg.artifact.url,
      sha256: ota.asg.artifact.sha256,
      size: ota.asg.artifact.size,
      signingCertificateSha256: ota.asg.artifact.signingCertificateSha256,
      provenanceUrl: otaProvenanceUrl,
    },
    {
      status: ota.selection.status,
      coordinate: ota.selection.asset,
      url: ota.selection.url,
      sha256: selection.sha256,
      size: selection.size,
      provenanceUrl: otaProvenanceUrl,
    },
  ]

  if (enginePackage) {
    artifacts.push(
      createEnginePackageArtifact({
        plan,
        publications: merged.publications,
        packageFile: enginePackage,
        assetBaseUrl: releaseAssetBaseUrl,
      }),
    )
  }
  if (verifiedStarterKit) artifacts.push(...verifiedStarterKit.artifacts)

  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    publications: merged.publications,
    otaManifest: {
      status: ota.manifest.status,
      coordinate: ota.manifest.asset,
      url: ota.manifest.url,
      sha256: ota.manifest.sha256,
      size: ota.manifest.size,
      provenanceUrl: otaProvenanceUrl,
    },
    artifacts,
    ...(verifiedStarterKit ? {starterKit: verifiedStarterKit.record} : {}),
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
  const args = parseArgs(process.argv.slice(2))
  const result = assembleCoordinatedReleaseResults({
    plan: readJson(path.resolve(args.plan)),
    ota: readJson(path.resolve(args.ota)),
    npmRecords: [readJson(path.resolve(args.npm))],
    native: readJson(path.resolve(args.native)),
    mobile: readJson(path.resolve(args.mobile)),
    starterKit: args["starter-kit"] ? readJson(path.resolve(args["starter-kit"])) : undefined,
    starterKitResultUrl: args["starter-kit-result-url"],
    exampleTestflight: args["example-testflight"] ? readJson(path.resolve(args["example-testflight"])) : undefined,
    asgSelectionFile: path.resolve(args["asg-selection"]),
    enginePackage: args["engine-package"] ? path.resolve(args["engine-package"]) : undefined,
    releaseAssetBaseUrl: args["release-asset-base-url"],
  })
  writeFileSync(args.output, serializeReleaseRecord(result))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
