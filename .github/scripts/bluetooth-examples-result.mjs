#!/usr/bin/env node
// Records the Bluetooth example apps one coordinated release built from
// examples/bluetooth at its source commit.
//
//   build    describes the built APKs and IPA (names, SHA-256, sizes) for the
//            release plan; the examples workflow uploads it with the files
//   locate   adds the public URL each file has in the release container, after
//            the release finalized and the files were published there; a file
//            an earlier attempt already published keeps its published bytes
//
// The located result feeds the example store uploads, the example release
// record (mentra-example-release-<identity>.json) and the documentation.
import {createHash} from "node:crypto"
import {appendFileSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {artifactUrl} from "./release-artifact-storage.mjs"
import {requirePublicHttpsUrl} from "./release-family.mjs"

export const EXAMPLES_BUILD_KIND = "mentra-bluetooth-examples-build"
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const APK = "application/vnd.android.package-archive"

export const EXAMPLE_ARTIFACTS = Object.freeze([
  {key: "android", prefix: "mentra-example-android", suffix: ".apk", contentType: APK},
  {key: "ios", prefix: "mentra-example-ios", suffix: "-unsigned.ipa", contentType: "application/octet-stream"},
  {key: "reactNative", prefix: "mentra-example-react-native", suffix: ".apk", contentType: APK},
  {key: "reactNativeElevenLabsAudio", prefix: "mentra-example-rn-elevenlabs-audio", suffix: ".apk", contentType: APK},
])

export function exampleArtifactName(key, releaseIdentity) {
  const artifact = EXAMPLE_ARTIFACTS.find((candidate) => candidate.key === key)
  if (!artifact) throw new Error(`Unknown example artifact ${key}`)
  return `${artifact.prefix}-${releaseIdentity}${artifact.suffix}`
}

function listFiles(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(file) : [file]
  })
}

export function createExamplesBuild({plan, files, otaManifestUrl, otaManifestSha256, provenanceUrl}) {
  if (!plan?.releaseIdentity || plan.releaseSetId !== `mentra-${plan.releaseIdentity}`) {
    throw new Error("A coordinated release plan is required")
  }
  if (!COMMIT_PATTERN.test(plan.sourceCommit || "")) throw new Error("The release plan has no source commit")
  if (!SHA256_PATTERN.test(otaManifestSha256 || "")) throw new Error("The OTA manifest SHA-256 is invalid")
  const artifacts = EXAMPLE_ARTIFACTS.map(({key, contentType}) => {
    const name = exampleArtifactName(key, plan.releaseIdentity)
    const matches = files.filter((file) => path.basename(file) === name)
    if (matches.length !== 1)
      throw new Error(`Expected exactly one built example named ${name}, found ${matches.length}`)
    const bytes = readFileSync(matches[0])
    if (bytes.length === 0) throw new Error(`${name} is empty`)
    return {key, name, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, contentType}
  })
  return {
    schemaVersion: 1,
    kind: EXAMPLES_BUILD_KIND,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    familyBaseVersion: plan.familyBaseVersion,
    channel: plan.channel,
    sourceCommit: plan.sourceCommit,
    sourcePath: "examples/bluetooth",
    otaManifest: {url: requirePublicHttpsUrl(otaManifestUrl, "OTA manifest URL"), sha256: otaManifestSha256},
    artifacts,
    provenanceUrl: requirePublicHttpsUrl(provenanceUrl, "provenance URL"),
  }
}

// Validates a build or located result against the plan it was built for.
export function validateExamplesResult(plan, result, {located = true} = {}) {
  if (
    result?.schemaVersion !== 1 ||
    result.kind !== EXAMPLES_BUILD_KIND ||
    result.releaseSetId !== plan.releaseSetId ||
    result.releaseIdentity !== plan.releaseIdentity ||
    result.channel !== plan.channel ||
    result.sourceCommit !== plan.sourceCommit ||
    !SHA256_PATTERN.test(result.otaManifest?.sha256 || "") ||
    !Array.isArray(result.artifacts)
  ) {
    throw new Error("The example builds do not match the release plan")
  }
  const keys = result.artifacts.map(({key}) => key)
  const expected = EXAMPLE_ARTIFACTS.map(({key}) => key)
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    throw new Error(`The example builds must contain exactly ${expected.join(", ")}`)
  }
  for (const artifact of result.artifacts) {
    if (
      artifact.name !== exampleArtifactName(artifact.key, plan.releaseIdentity) ||
      !SHA256_PATTERN.test(artifact.sha256 || "") ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size < 1 ||
      (located && (!/^https:\/\//.test(artifact.url || "") || !["published", "reused"].includes(artifact.status)))
    ) {
      throw new Error(`Example artifact ${artifact.name} is invalid`)
    }
  }
  requirePublicHttpsUrl(result.provenanceUrl, "provenance URL")
  return result
}

// Adds each file's release-container URL. The container listing is
// authoritative: a file an earlier attempt of this release already published
// keeps the bytes it was published with.
export function locateExamples({plan, build, repository, containerTag, assets}) {
  validateExamplesResult(plan, build, {located: false})
  if (containerTag !== plan.artifactContainerTag)
    throw new Error("The examples must be published to the release container")
  const artifacts = build.artifacts.map((artifact) => {
    const matches = (assets || []).filter((asset) => asset.name === artifact.name && asset.state === "uploaded")
    if (matches.length !== 1) throw new Error(`${artifact.name} is not published in ${containerTag}`)
    const [asset] = matches
    const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || "")?.[1]
    if (!sha256 || !Number.isSafeInteger(asset.size)) throw new Error(`${artifact.name} has no published digest`)
    return {
      ...artifact,
      sha256,
      size: asset.size,
      url: artifactUrl(repository, containerTag, artifact.name),
      status: sha256 === artifact.sha256 ? "published" : "reused",
    }
  })
  return validateExamplesResult(plan, {...build, artifacts})
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

const readJson = (file) => JSON.parse(readFileSync(path.resolve(file), "utf8"))

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  const plan = readJson(args.plan)
  let result
  if (command === "build") {
    result = createExamplesBuild({
      plan,
      files: listFiles(path.resolve(args.dir)).filter((file) => statSync(file).isFile()),
      otaManifestUrl: args["ota-manifest-url"],
      otaManifestSha256: args["ota-manifest-sha256"],
      provenanceUrl: args["provenance-url"],
    })
  } else if (command === "locate") {
    result = locateExamples({
      plan,
      build: readJson(args.build),
      repository: args.repository,
      containerTag: args["container-tag"],
      assets: readJson(args.assets),
    })
    if (args["github-output"]) {
      for (const artifact of result.artifacts) {
        const key = artifact.key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
        appendFileSync(args["github-output"], `${key}_name=${artifact.name}\n${key}_url=${artifact.url}\n`)
      }
    }
  } else {
    throw new Error(`Unknown command ${JSON.stringify(command)}`)
  }
  writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    `Wrote ${command === "build" ? "example builds" : "published examples"} for ${result.releaseIdentity} to ${args.output}`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
