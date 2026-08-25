#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function provenanceUrl(ota) {
  return `https://github.com/${ota.workflow.repository}/actions/runs/${ota.workflow.runId}`
}

function mergePublicationRecords(plan, records) {
  const publications = {}
  const artifacts = []
  for (const record of records) {
    if (record.releaseSetId !== plan.releaseSetId) throw new Error("Publication record belongs to another release set")
    for (const [member, targets] of Object.entries(record.publications || {})) {
      publications[member] ||= {}
      for (const [target, publication] of Object.entries(targets)) {
        const existing = publications[member][target]
        if (existing && JSON.stringify(existing) !== JSON.stringify(publication)) {
          throw new Error(`Conflicting publication records for ${member}:${target}`)
        }
        publications[member][target] = publication
      }
    }
    artifacts.push(...(record.artifacts || []))
  }
  return {publications, artifacts}
}

function requirePublicationCoverage(plan, publications) {
  for (const [member, definition] of Object.entries(plan.members)) {
    for (const target of definition.publishTargets) {
      if (!publications[member]?.[target]) throw new Error(`Missing publication result for ${member}:${target}`)
    }
  }
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

export function assembleCoordinatedReleaseResults({
  plan,
  ota,
  npmRecords,
  native,
  mobile,
  asgSelectionFile,
  enginePackage,
  releaseAssetBaseUrl,
}) {
  if (plan.releaseSetId !== `mentra-${plan.releaseIdentity}` || ota.releaseSetId !== plan.releaseSetId) {
    throw new Error("Release plan and OTA result do not identify the same release set")
  }
  const merged = mergePublicationRecords(plan, [...npmRecords, native, mobile])
  requirePublicationCoverage(plan, merged.publications)
  const selection = verifyAsgSelection(plan, ota, asgSelectionFile)
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
    const enginePublication = merged.publications["@mentra/engine"]?.npm
    if (!enginePublication) throw new Error("Engine package artifact has no matching npm publication")
    const bytes = readFileSync(enginePackage)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    if (sha256 !== enginePublication.sha256) throw new Error("Engine release asset differs from the npm package")
    artifacts.push({
      status: enginePublication.status,
      coordinate: plan.artifactNames.enginePackage,
      url: `${releaseAssetBaseUrl}/${plan.artifactNames.enginePackage}`,
      sha256,
      size: statSync(enginePackage).size,
      provenanceUrl: enginePublication.provenanceUrl,
    })
  }

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
    npmRecords: [args["npm-foundation"], args["npm-sdk"], args["npm-miniapp"], args["npm-engine"]].map((file) =>
      readJson(path.resolve(file)),
    ),
    native: readJson(path.resolve(args.native)),
    mobile: readJson(path.resolve(args.mobile)),
    asgSelectionFile: path.resolve(args["asg-selection"]),
    enginePackage: args["engine-package"] ? path.resolve(args["engine-package"]) : undefined,
    releaseAssetBaseUrl: args["release-asset-base-url"],
  })
  writeFileSync(args.output, serializeReleaseRecord(result))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
