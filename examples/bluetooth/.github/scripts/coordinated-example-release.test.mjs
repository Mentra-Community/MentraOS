import assert from "node:assert/strict"
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {createReleaseResult, synchronizeExampleVersions, validatePayload} from "./coordinated-example-release.mjs"

const sha = "a".repeat(40)
const manifestSha = "b".repeat(64)

function payload(identity = "3.1.0-beta.57") {
  const [base, prerelease] = identity.split("-")
  const channel = prerelease?.startsWith("dev.") ? "dev" : prerelease?.startsWith("beta.") ? "beta" : "production"
  return {
    schemaVersion: 1,
    releaseSetId: `mentra-${identity}`,
    familyBaseVersion: base,
    releaseIdentity: identity,
    channel,
    mentraos: {sourceCommit: sha, coordinatorRunUrl: "https://github.com/Mentra/MentraOS/actions/runs/1"},
    ota: {manifestUrl: "https://example.com/ota.json", manifestSha256: manifestSha},
    packages: {"@mentra/bluetooth-sdk": identity, "@mentra/engine": identity},
    expectedStarterKitHead: sha,
  }
}

test("validates channel and derives Starter Kit release coordinates", () => {
  assert.deepEqual(validatePayload(payload()), {
    releaseIdentity: "3.1.0-beta.57",
    familyBaseVersion: "3.1.0",
    channel: "beta",
    targetBranch: "staging",
    candidateBranch: "coordinated/3.1.0-beta.57",
    sourceTag: "sdk-3.1.0-beta.57",
    artifactContainerTag: "sdk-builds-v3.1.0",
  })
  assert.equal(validatePayload(payload("3.1.0-dev.42")).targetBranch, "dev")
  assert.equal(validatePayload(payload("3.1.0")).artifactContainerTag, "sdk-3.1.0")
})

test("rejects mismatched package versions", () => {
  const invalid = payload()
  invalid.packages["@mentra/engine"] = "3.1.0-beta.56"
  assert.throws(() => validatePayload(invalid), /must match/)
})

test("synchronizes all maintained example manifests", () => {
  const root = mkdtempSync(path.join(tmpdir(), "starter-kit-sync-"))
  mkdirSync(path.join(root, "examples/android"), {recursive: true})
  mkdirSync(path.join(root, "examples/ios/MentraExample.xcodeproj"), {recursive: true})
  mkdirSync(path.join(root, "examples/react-native"), {recursive: true})
  mkdirSync(path.join(root, "examples/react-native-elevenlabs-audio"), {recursive: true})
  writeFileSync(path.join(root, "examples/android/gradle.properties"), "mentraSdkVersion=1.0.0\n")
  writeFileSync(
    path.join(root, "examples/ios/MentraExample.xcodeproj/project.pbxproj"),
    'repositoryURL = "https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git";\nrequirement = {\nkind = exactVersion;\nversion = 1.0.0;\n};\n',
  )
  writeFileSync(path.join(root, "examples/ios/project.yml"), "packages:\n  MentraBluetoothSDK:\n    exactVersion: 1.0.0\n")
  writeFileSync(
    path.join(root, "examples/react-native/package.json"),
    JSON.stringify({dependencies: {"@mentra/bluetooth-sdk": "1.0.0", "@mentra/engine": "1.0.0"}}),
  )
  writeFileSync(
    path.join(root, "examples/react-native-elevenlabs-audio/package.json"),
    JSON.stringify({dependencies: {"@mentra/bluetooth-sdk": "1.0.0"}}),
  )

  synchronizeExampleVersions(root, "3.1.0-dev.42")

  assert.match(readFileSync(path.join(root, "examples/android/gradle.properties"), "utf8"), /3\.1\.0-dev\.42/)
  assert.match(
    readFileSync(path.join(root, "examples/ios/MentraExample.xcodeproj/project.pbxproj"), "utf8"),
    /version = 3\.1\.0-dev\.42/,
  )
  assert.match(readFileSync(path.join(root, "examples/ios/project.yml"), "utf8"), /exactVersion: 3\.1\.0-dev\.42/)
  assert.equal(
    JSON.parse(readFileSync(path.join(root, "examples/react-native/package.json"))).dependencies["@mentra/engine"],
    "3.1.0-dev.42",
  )
})

test("creates a deterministic result for all four artifacts", () => {
  const artifactDir = mkdtempSync(path.join(tmpdir(), "starter-kit-artifacts-"))
  const identity = "3.1.0-beta.57"
  for (const name of [
    `mentra-example-android-${identity}.apk`,
    `mentra-example-ios-${identity}-unsigned.ipa`,
    `mentra-example-react-native-${identity}.apk`,
    `mentra-example-rn-elevenlabs-audio-${identity}.apk`,
  ]) {
    writeFileSync(path.join(artifactDir, name), name)
  }

  const result = createReleaseResult({
    payload: payload(identity),
    repository: "Mentra-Community/Mentra-Bluetooth-SDK-Starter-Kit",
    releaseCommit: sha,
    mergeCommit: "c".repeat(40),
    pullRequestUrl: "https://github.com/Mentra/pr/1",
    validationRunUrl: "https://github.com/Mentra/actions/1",
    artifactDir,
  })

  assert.equal(result.starterKit.artifactContainerTag, "sdk-builds-v3.1.0")
  assert.equal(result.artifacts.length, 4)
  assert.ok(result.artifacts.every((artifact) => artifact.sha256.length === 64 && artifact.size > 0))
})
