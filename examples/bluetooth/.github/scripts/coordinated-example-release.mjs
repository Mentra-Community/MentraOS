#!/usr/bin/env node

import {createHash} from "node:crypto"
import {readdirSync, readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

const VERSION_PATTERN = /^(\d+\.\d+\.\d+)(?:-(dev|beta)\.([1-9]\d*))?$/
const SHA_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

const EXAMPLE_ARTIFACTS = [
  {key: "android", prefix: "mentra-example-android", suffix: ".apk", contentType: "application/vnd.android.package-archive"},
  {key: "ios", prefix: "mentra-example-ios", suffix: "-unsigned.ipa", contentType: "application/octet-stream"},
  {
    key: "reactNative",
    prefix: "mentra-example-react-native",
    suffix: ".apk",
    contentType: "application/vnd.android.package-archive",
  },
  {
    key: "reactNativeElevenLabsAudio",
    prefix: "mentra-example-rn-elevenlabs-audio",
    suffix: ".apk",
    contentType: "application/vnd.android.package-archive",
  },
]

function parseArgs(args) {
  const [command, ...rest] = args
  const values = {}
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index]
    const value = rest[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return {command, values}
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

export function validatePayload(payload) {
  if (payload?.schemaVersion !== 1) throw new Error("Unsupported coordinated example payload schema")

  const releaseIdentity = assertString(payload.releaseIdentity, "releaseIdentity")
  const match = VERSION_PATTERN.exec(releaseIdentity)
  if (!match) throw new Error(`Invalid coordinated release identity ${JSON.stringify(releaseIdentity)}`)

  const familyBaseVersion = assertString(payload.familyBaseVersion, "familyBaseVersion")
  if (match[1] !== familyBaseVersion) throw new Error("releaseIdentity does not match familyBaseVersion")
  if (payload.releaseSetId !== `mentra-${releaseIdentity}`) throw new Error("releaseSetId does not match releaseIdentity")

  const expectedChannel = match[2] === "dev" ? "dev" : match[2] === "beta" ? "beta" : "production"
  if (payload.channel !== expectedChannel) throw new Error("releaseIdentity does not match channel")

  const targetBranch = expectedChannel === "dev" ? "dev" : expectedChannel === "beta" ? "staging" : "main"
  if (!SHA_PATTERN.test(payload.mentraos?.sourceCommit || "")) throw new Error("Invalid MentraOS source commit")
  if (!/^https:\/\//.test(payload.mentraos?.coordinatorRunUrl || "")) {
    throw new Error("Invalid MentraOS coordinator run URL")
  }
  if (!/^https:\/\//.test(payload.ota?.manifestUrl || "")) throw new Error("Invalid OTA manifest URL")
  if (!SHA256_PATTERN.test(payload.ota?.manifestSha256 || "")) throw new Error("Invalid OTA manifest SHA-256")
  if (!SHA_PATTERN.test(payload.expectedStarterKitHead || "")) throw new Error("Invalid expected Starter Kit head")

  for (const packageName of ["@mentra/bluetooth-sdk", "@mentra/engine"]) {
    if (payload.packages?.[packageName] !== releaseIdentity) {
      throw new Error(`${packageName} must match the coordinated release identity`)
    }
  }

  return {
    releaseIdentity,
    familyBaseVersion,
    channel: expectedChannel,
    targetBranch,
    candidateBranch: `coordinated/${releaseIdentity}`,
    sourceTag: `sdk-${releaseIdentity}`,
    artifactContainerTag:
      expectedChannel === "production" ? `sdk-${releaseIdentity}` : `sdk-builds-v${familyBaseVersion}`,
  }
}

function replaceExactlyOnce(contents, pattern, replacement, label) {
  const matches = contents.match(pattern)
  if (!matches || matches.length !== 1) throw new Error(`Expected exactly one ${label}`)
  return contents.replace(pattern, replacement)
}

function updateJsonDependency(filePath, dependencies) {
  const packageJson = JSON.parse(readFileSync(filePath, "utf8"))
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof packageJson.dependencies?.[name] !== "string") {
      throw new Error(`${filePath} does not declare ${name}`)
    }
    packageJson.dependencies[name] = version
  }
  writeFileSync(filePath, `${JSON.stringify(packageJson, null, 2)}\n`)
}

export function synchronizeExampleVersions(rootDir, releaseIdentity) {
  if (!VERSION_PATTERN.test(releaseIdentity)) throw new Error(`Invalid release identity ${releaseIdentity}`)

  const gradlePath = path.join(rootDir, "examples/android/gradle.properties")
  const gradle = replaceExactlyOnce(
    readFileSync(gradlePath, "utf8"),
    /^mentraSdkVersion=.*$/gm,
    `mentraSdkVersion=${releaseIdentity}`,
    "native Android SDK version",
  )
  writeFileSync(gradlePath, gradle)

  const projectPath = path.join(rootDir, "examples/ios/MentraExample.xcodeproj/project.pbxproj")
  const project = readFileSync(projectPath, "utf8")
  const packageBlockPattern = /(repositoryURL = "https:\/\/github\.com\/Mentra-Community\/mentra-bluetooth-sdk-ios\.git";[\s\S]*?requirement = \{[\s\S]*?kind = exactVersion;[\s\S]*?version = )[^;]+(;[\s\S]*?\};)/g
  const updatedProject = replaceExactlyOnce(
    project,
    packageBlockPattern,
    `$1${releaseIdentity}$2`,
    "native iOS SDK version",
  )
  writeFileSync(projectPath, updatedProject)

  updateJsonDependency(path.join(rootDir, "examples/react-native/package.json"), {
    "@mentra/bluetooth-sdk": releaseIdentity,
    "@mentra/engine": releaseIdentity,
  })
  updateJsonDependency(path.join(rootDir, "examples/react-native-elevenlabs-audio/package.json"), {
    "@mentra/bluetooth-sdk": releaseIdentity,
  })
}

function listFilesRecursively(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? listFilesRecursively(entryPath) : [entryPath]
  })
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

export function createReleaseResult({payload, repository, releaseCommit, mergeCommit, pullRequestUrl, validationRunUrl, artifactDir}) {
  const release = validatePayload(payload)
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error(`Invalid repository ${JSON.stringify(repository)}`)
  if (!SHA_PATTERN.test(releaseCommit)) throw new Error("Invalid Starter Kit release commit")
  if (!SHA_PATTERN.test(mergeCommit)) throw new Error("Invalid Starter Kit merge commit")
  if (!/^https:\/\//.test(pullRequestUrl)) throw new Error("Invalid Starter Kit pull request URL")
  if (!/^https:\/\//.test(validationRunUrl)) throw new Error("Invalid Starter Kit validation run URL")

  const files = listFilesRecursively(artifactDir)
  const assetBaseUrl = `https://github.com/${repository}/releases/download/${release.artifactContainerTag}`
  const artifacts = EXAMPLE_ARTIFACTS.map(({key, prefix, suffix, contentType}) => {
    const name = `${prefix}-${release.releaseIdentity}${suffix}`
    const matches = files.filter((filePath) => path.basename(filePath) === name)
    if (matches.length !== 1) throw new Error(`Expected exactly one built artifact named ${name}`)
    return {
      key,
      name,
      url: `${assetBaseUrl}/${name}`,
      size: statSync(matches[0]).size,
      sha256: sha256(matches[0]),
      contentType,
    }
  })

  return {
    schemaVersion: 1,
    releaseSetId: payload.releaseSetId,
    releaseIdentity: release.releaseIdentity,
    familyBaseVersion: release.familyBaseVersion,
    channel: release.channel,
    mentraos: payload.mentraos,
    ota: payload.ota,
    starterKit: {
      baseCommit: payload.expectedStarterKitHead,
      releaseCommit,
      mergeCommit,
      sourceTag: release.sourceTag,
      artifactContainerTag: release.artifactContainerTag,
      releaseUrl: `https://github.com/${repository}/releases/tag/${release.artifactContainerTag}`,
      pullRequestUrl,
      validationRunUrl,
    },
    packages: payload.packages,
    artifacts,
    testflight: null,
  }
}

function appendGitHubOutput(filePath, values) {
  if (!filePath) return
  const lines = Object.entries(values).map(([name, value]) => `${name}=${value}`)
  writeFileSync(filePath, `${lines.join("\n")}\n`, {flag: "a"})
}

function readJson(filePath) {
  return JSON.parse(readFileSync(path.resolve(filePath), "utf8"))
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const {command, values} = parseArgs(process.argv.slice(2))
  if (command === "validate") {
    const release = validatePayload(readJson(values.payload))
    appendGitHubOutput(values["github-output"], release)
    console.log(JSON.stringify(release))
  } else if (command === "sync") {
    synchronizeExampleVersions(path.resolve(values.root || "."), values.identity)
  } else if (command === "result") {
    const result = createReleaseResult({
      payload: readJson(values.payload),
      repository: values.repository,
      releaseCommit: values["release-commit"],
      mergeCommit: values["merge-commit"],
      pullRequestUrl: values["pull-request-url"],
      validationRunUrl: values["validation-run-url"],
      artifactDir: path.resolve(values["artifact-dir"]),
    })
    writeFileSync(path.resolve(values.output), `${JSON.stringify(result, null, 2)}\n`)
  } else {
    throw new Error(`Unknown command ${JSON.stringify(command)}`)
  }
}
