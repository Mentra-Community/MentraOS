#!/usr/bin/env node
// The Bluetooth example apps a release publishes, by deterministic name.
//
// The examples workflow uploads them to the release container itself, and the
// release page, the docs and Slack link them by these names, so no separate
// result record is passed between jobs.
//
//   names  prints each file name, one per line
//   urls   writes <key>_name and <key>_url outputs (keys in snake_case)
import {appendFileSync, readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {artifactUrl} from "./release-artifact-storage.mjs"

const APK = "application/vnd.android.package-archive"

export const EXAMPLE_ARTIFACTS = Object.freeze([
  {key: "reactNative", prefix: "mentra-example-react-native", suffix: ".apk", contentType: APK},
  {key: "android", prefix: "mentra-example-android", suffix: ".apk", contentType: APK},
  {key: "reactNativeElevenLabsAudio", prefix: "mentra-example-rn-elevenlabs-audio", suffix: ".apk", contentType: APK},
  {key: "ios", prefix: "mentra-example-ios", suffix: "-unsigned.ipa", contentType: "application/octet-stream"},
])

export function exampleArtifactName(key, releaseIdentity) {
  const artifact = EXAMPLE_ARTIFACTS.find((candidate) => candidate.key === key)
  if (!artifact) throw new Error(`Unknown example artifact ${key}`)
  if (!/^\d+\.\d+\.\d+(?:-(?:dev|beta)\.[1-9]\d*)?$/.test(releaseIdentity || "")) {
    throw new Error(`Invalid release identity ${JSON.stringify(releaseIdentity)}`)
  }
  return `${artifact.prefix}-${releaseIdentity}${artifact.suffix}`
}

// Each example of the release, with its URL in the release's container.
export function exampleArtifacts(plan, repository) {
  return EXAMPLE_ARTIFACTS.map(({key}) => {
    const name = exampleArtifactName(key, plan.releaseIdentity)
    return {key, name, url: artifactUrl(repository, plan.artifactContainerTag, name)}
  })
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = {}
  for (let index = 0; index < rest.length; index += 2) args[rest[index].replace(/^--/, "")] = rest[index + 1]
  const plan = JSON.parse(readFileSync(path.resolve(args.plan), "utf8"))
  const artifacts = exampleArtifacts(plan, args.repository || "Mentra-Community/MentraOS")
  if (command === "names") {
    for (const {name} of artifacts) console.log(name)
    return
  }
  if (command !== "urls") throw new Error(`Unknown command ${JSON.stringify(command)}`)
  const lines = artifacts.flatMap(({key, name, url}) => {
    const id = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    return [`${id}_name=${name}`, `${id}_url=${url}`]
  })
  console.log(lines.join("\n"))
  if (args["github-output"]) appendFileSync(args["github-output"], `${lines.join("\n")}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
