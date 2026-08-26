#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function verifySelectedFile(file, selected, label) {
  const sha256 = sha256File(file)
  if (sha256 !== selected.sha256) throw new Error(`${label} differs from the selected beta artifact`)
  if (selected.size !== undefined && statSync(file).size !== selected.size) {
    throw new Error(`${label} size differs from the selected beta artifact`)
  }
  return selected
}

export function createProductionPromotionRecords({plan, selection, apk, aab, ipa, provenanceUrl}) {
  if (plan.channel !== "production" || plan.releaseIdentity !== plan.familyBaseVersion) {
    throw new Error("A stable production release plan is required")
  }
  if (
    selection.releaseSetId !== plan.releaseSetId ||
    selection.sourceCommit !== plan.sourceCommit ||
    selection.native.buildNumber !== plan.native.buildNumber
  ) {
    throw new Error("Promotion selection does not match the stable release plan")
  }
  const androidApk = verifySelectedFile(apk, selection.mobileArtifacts.androidApk, "Android APK")
  const androidAab = verifySelectedFile(aab, selection.mobileArtifacts.androidAab, "Android AAB")
  const iosIpa = verifySelectedFile(ipa, selection.mobileArtifacts.iosIpa, "iOS IPA")
  const promoted = (record) => ({...record, status: "promoted", provenanceUrl})

  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    promotion: {
      selectedBetaReleaseSetId: selection.selectedBetaReleaseSetId,
      selectedBetaIdentity: selection.selectedBetaIdentity,
      selectedBetaManifest: selection.betaManifest,
    },
    publications: {
      mentraos: {
        "google-play": {
          status: "promoted",
          coordinate: `com.mentra.mentra:${plan.native.buildNumber}:production`,
          url: "https://play.google.com/console/",
          sha256: androidAab.sha256,
          provenanceUrl,
        },
        "app-store-connect": {
          status: "promoted",
          coordinate: `com.mentra.mentra:${plan.native.marketingVersion}:${plan.native.buildNumber}:App Store`,
          url: "https://appstoreconnect.apple.com/apps",
          sha256: iosIpa.sha256,
          provenanceUrl,
        },
      },
    },
    otaManifest: promoted(selection.otaManifest),
    artifacts: [promoted(androidApk), promoted(androidAab), promoted(iosIpa), ...selection.otaArtifacts.map(promoted)],
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
  const result = createProductionPromotionRecords({
    plan: JSON.parse(readFileSync(path.resolve(args.plan), "utf8")),
    selection: JSON.parse(readFileSync(path.resolve(args.selection), "utf8")),
    apk: path.resolve(args.apk),
    aab: path.resolve(args.aab),
    ipa: path.resolve(args.ipa),
    provenanceUrl: args["provenance-url"],
  })
  writeFileSync(path.resolve(args.output), serializeReleaseRecord(result))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
