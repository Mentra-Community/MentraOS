#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {requirePublicHttpsUrl, serializeReleaseRecord} from "./release-family.mjs"

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const PUBLICATION_STATUSES = new Set(["built", "published", "reused"])

function canonicalJson(value) {
  return serializeReleaseRecord(value).trimEnd()
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function normalizeCertificateSha256(value) {
  const normalized = value.replaceAll(":", "").toLowerCase()
  if (!SHA256_PATTERN.test(normalized)) throw new Error("signingCertificateSha256 must be a SHA-256 digest")
  return normalized
}

function validateIdentity(identity) {
  if (!identity || identity.schemaVersion !== 1 || !SHA256_PATTERN.test(identity.fingerprint)) {
    throw new Error("Invalid ASG build identity")
  }
  if (!Number.isSafeInteger(identity.versionCode) || identity.versionCode <= 0 || !identity.versionName) {
    throw new Error("Invalid ASG build version metadata")
  }
  return identity
}

export function createAsgProvenance({identity, releasePlan, apkPath, apkUrl, signingCertificateSha256}) {
  validateIdentity(identity)
  if (releasePlan.releaseSetId !== `mentra-${releasePlan.releaseIdentity}` || !releasePlan.sourceCommit) {
    throw new Error("Invalid release plan for ASG provenance")
  }
  return {
    schemaVersion: 1,
    fingerprint: identity.fingerprint,
    versionCode: identity.versionCode,
    versionName: identity.versionName,
    buildIdentity: identity,
    apk: {
      asset: identity.apkAsset,
      url: requirePublicHttpsUrl(apkUrl, "ASG APK URL"),
      sha256: sha256File(apkPath),
      size: statSync(apkPath).size,
      signingCertificateSha256: normalizeCertificateSha256(signingCertificateSha256),
    },
    originatingReleaseSetId: releasePlan.releaseSetId,
    originatingReleaseIdentity: releasePlan.releaseIdentity,
    sourceCommit: releasePlan.sourceCommit,
  }
}

export function verifyAsgProvenance({identity, provenance, apkPath, signingCertificateSha256}) {
  validateIdentity(identity)
  if (provenance.schemaVersion !== 1 || provenance.fingerprint !== identity.fingerprint) {
    throw new Error("ASG provenance fingerprint does not match selected build identity")
  }
  for (const field of ["versionCode", "versionName"]) {
    if (provenance[field] !== identity[field]) throw new Error(`ASG provenance ${field} does not match`)
  }
  if (provenance.apk?.asset !== identity.apkAsset) throw new Error("ASG provenance APK asset does not match")
  if (provenance.apk?.sha256 !== sha256File(apkPath)) throw new Error("ASG APK SHA-256 does not match provenance")
  if (provenance.apk?.size !== statSync(apkPath).size) throw new Error("ASG APK size does not match provenance")
  if (
    normalizeCertificateSha256(provenance.apk?.signingCertificateSha256 ?? "") !==
    normalizeCertificateSha256(signingCertificateSha256)
  ) {
    throw new Error("ASG signing certificate does not match provenance")
  }
  requirePublicHttpsUrl(provenance.apk.url, "ASG provenance APK URL")
  if (!provenance.originatingReleaseSetId || !provenance.sourceCommit) {
    throw new Error("ASG provenance is missing its origin")
  }
  return provenance
}

export function createAsgSelection({releasePlan, identity, provenance}) {
  validateIdentity(identity)
  if (releasePlan.artifactNames?.asgSelection !== `mentra-live-asg-selection-${releasePlan.releaseIdentity}.json`) {
    throw new Error("Release plan has an invalid ASG selection artifact name")
  }
  return {
    schemaVersion: 1,
    releaseSetId: releasePlan.releaseSetId,
    releaseIdentity: releasePlan.releaseIdentity,
    sourceCommit: releasePlan.sourceCommit,
    fingerprint: identity.fingerprint,
    versionCode: identity.versionCode,
    versionName: identity.versionName,
    originatingReleaseSetId: provenance.originatingReleaseSetId,
    apk: provenance.apk,
    provenanceAsset: identity.provenanceAsset,
  }
}

export function createOtaReleaseResult({
  releasePlan,
  identity,
  provenance,
  selectionPath,
  selectionUrl,
  selectionStatus,
  manifestPath,
  manifestUrl,
  bundlePath,
  bundleUrl,
  bundleStatus,
  manifestStatus,
  reused,
  workflow,
}) {
  if (
    !PUBLICATION_STATUSES.has(selectionStatus) ||
    !PUBLICATION_STATUSES.has(manifestStatus) ||
    !PUBLICATION_STATUSES.has(bundleStatus)
  ) {
    throw new Error("ASG selection, OTA manifest, and bundle must have valid publication statuses")
  }
  verifyAsgProvenance({
    identity,
    provenance,
    apkPath: workflow.apkPath,
    signingCertificateSha256: workflow.signingCertificateSha256,
  })
  const manifest = readJson(manifestPath)
  const asg = manifest.apps?.["com.mentra.asg_client"]
  if (
    asg?.versionCode !== identity.versionCode ||
    asg?.versionName !== identity.versionName ||
    asg?.apkUrl !== provenance.apk.url ||
    asg?.sha256 !== provenance.apk.sha256 ||
    asg?.apkSize !== provenance.apk.size
  ) {
    throw new Error("OTA manifest does not pin the selected ASG artifact exactly")
  }
  if (canonicalJson(manifest.mtk_patches) !== canonicalJson(releasePlan.otaInputs.mtkPatches)) {
    throw new Error("OTA manifest MTK inputs differ from the release plan")
  }
  if (canonicalJson(manifest.bes_firmware) !== canonicalJson(releasePlan.otaInputs.besFirmware)) {
    throw new Error("OTA manifest BES input differs from the release plan")
  }
  const selection = readJson(selectionPath)
  const expectedSelection = createAsgSelection({releasePlan, identity, provenance})
  if (canonicalJson(selection) !== canonicalJson(expectedSelection)) {
    throw new Error("ASG selection record does not match the selected build")
  }
  const result = {
    schemaVersion: 1,
    releaseSetId: releasePlan.releaseSetId,
    releaseIdentity: releasePlan.releaseIdentity,
    sourceCommit: releasePlan.sourceCommit,
    firmwareManifestSha256: releasePlan.otaInputs.firmwareManifest.sha256,
    selection: {
      status: selectionStatus,
      asset: releasePlan.artifactNames.asgSelection,
      url: requirePublicHttpsUrl(selectionUrl, "ASG selection URL"),
      sha256: sha256File(selectionPath),
      size: statSync(selectionPath).size,
    },
    manifest: {
      status: manifestStatus,
      asset: releasePlan.artifactNames.otaManifest,
      url: requirePublicHttpsUrl(manifestUrl, "OTA manifest URL"),
      sha256: sha256File(manifestPath),
      size: statSync(manifestPath).size,
    },
    bundle: {
      status: bundleStatus,
      asset: path.basename(bundlePath),
      url: requirePublicHttpsUrl(bundleUrl, "OTA bundle URL"),
      sha256: sha256File(bundlePath),
      size: statSync(bundlePath).size,
    },
    asg: {
      fingerprint: identity.fingerprint,
      versionCode: identity.versionCode,
      versionName: identity.versionName,
      reused: Boolean(reused),
      originatingReleaseSetId: provenance.originatingReleaseSetId,
      artifact: provenance.apk,
      provenanceAsset: identity.provenanceAsset,
    },
    workflow: {
      repository: workflow.repository,
      runId: String(workflow.runId),
      runAttempt: Number(workflow.runAttempt),
    },
  }
  if (!result.workflow.repository || !result.workflow.runId || !Number.isSafeInteger(result.workflow.runAttempt)) {
    throw new Error("OTA workflow provenance is incomplete")
  }
  return result
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
  const identity = readJson(args.identity)
  const apkPath = path.resolve(args.apk)
  const signingCertificateSha256 = args["signing-certificate-sha256"]
  if (command === "create-provenance") {
    const record = createAsgProvenance({
      identity,
      releasePlan: readJson(args.plan),
      apkPath,
      apkUrl: args["apk-url"],
      signingCertificateSha256,
    })
    writeFileSync(args.output, serializeReleaseRecord(record))
    return
  }
  if (command === "verify-provenance") {
    verifyAsgProvenance({
      identity,
      provenance: readJson(args.provenance),
      apkPath,
      signingCertificateSha256,
    })
    return
  }
  if (command === "create-selection") {
    const record = createAsgSelection({
      releasePlan: readJson(args.plan),
      identity,
      provenance: readJson(args.provenance),
    })
    writeFileSync(args.output, serializeReleaseRecord(record))
    return
  }
  if (command === "create-result") {
    const record = createOtaReleaseResult({
      releasePlan: readJson(args.plan),
      identity,
      provenance: readJson(args.provenance),
      selectionPath: path.resolve(args.selection),
      selectionUrl: args["selection-url"],
      selectionStatus: args["selection-status"],
      manifestPath: path.resolve(args.manifest),
      manifestUrl: args["manifest-url"],
      bundlePath: path.resolve(args.bundle),
      bundleUrl: args["bundle-url"],
      bundleStatus: args["bundle-status"],
      manifestStatus: args["manifest-status"],
      reused: args.reused === "true",
      workflow: {
        apkPath,
        signingCertificateSha256,
        repository: args.repository,
        runId: args["run-id"],
        runAttempt: Number(args["run-attempt"]),
      },
    })
    writeFileSync(args.output, serializeReleaseRecord(record))
    return
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
