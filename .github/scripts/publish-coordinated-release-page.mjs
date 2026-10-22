#!/usr/bin/env node
import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

import {validateExamplesResult} from "./bluetooth-examples-result.mjs"
import {finalizeReleaseManifest} from "./release-family.mjs"
import {downloadNames} from "./coordinated-install-downloads.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"

const START = "<!-- mentra-release-downloads:start -->"
const END = "<!-- mentra-release-downloads:end -->"

export function completedReleaseDownloads(plan, manifest) {
  if (
    !["dev", "beta"].includes(plan.channel) ||
    !/^[0-9]+\.[0-9]+\.[0-9]+-(dev|beta)\.[1-9][0-9]*$/.test(plan.releaseIdentity)
  ) {
    throw new Error("Only completed development and beta releases have automatic download pages")
  }
  assert.deepEqual(finalizeReleaseManifest({plan, results: manifest, completedAt: manifest.completedAt}), manifest)
  const asset = (key) => manifest.artifacts.find((entry) => entry.coordinate === plan.artifactNames[key])
  const names = downloadNames(plan)
  return {
    apk: asset("androidApp"),
    aab: asset("androidStoreApp"),
    ipa: asset("iosApp"),
    install: manifest.artifacts.find((entry) => entry.coordinate === names.install),
    mac: manifest.artifacts.find((entry) => entry.coordinate === names.mac),
  }
}

const EXAMPLE_LABELS = Object.freeze({
  reactNative: "React Native example APK",
  android: "Native Android example APK",
  reactNativeElevenLabsAudio: "React Native ElevenLabs audio example APK",
  ios: "Native iOS example IPA (unsigned)",
})

// The Bluetooth example apps are published once the release is finalized;
// the page lists them when they are.
export function releaseDownloadNotes({plan, manifest, repository, examples}) {
  const {apk, aab, ipa, install, mac} = completedReleaseDownloads(plan, manifest)
  const download = (label, asset) => `- [${label}](${asset.url})`
  const exampleLines = examples
    ? [
        "",
        "## Bluetooth example apps",
        ...Object.entries(EXAMPLE_LABELS).map(([key, label]) =>
          download(
            label,
            validateExamplesResult(plan, examples).artifacts.find((artifact) => artifact.key === key),
          ),
        ),
      ]
    : []
  const asg = manifest.artifacts.find(
    (entry) => entry.coordinate.startsWith("mentra-live-asg-") && entry.coordinate.endsWith(".apk"),
  )
  return [
    START,
    `Mentra ${plan.releaseIdentity} — ${plan.channel === "dev" ? "development" : "beta"} build.`,
    "",
    "## Mentra App downloads",
    download("Android phone APK — install the Mentra App", apk),
    download("Android App Bundle (AAB)", aab),
    ...(install ? [download("Install on iPhone / share install link", install)] : [download("iOS IPA", ipa)]),
    ...(mac ? [download("macOS ZIP — registered Apple Silicon Macs", mac)] : []),
    "",
    "## Glasses and developer downloads",
    ...(asg ? [download("Mentra Live glasses APK (ASG)", asg)] : []),
    download("Glasses OTA manifest", manifest.otaManifest),
    // Only beta releases publish the portable OTA bundle.
    ...[
      ["otaBundle", "Glasses OTA bundle"],
      ["enginePackage", "Mentra Engine package"],
    ].flatMap(([key, label]) => {
      const asset = manifest.artifacts.find((entry) => entry.coordinate === plan.artifactNames[key])
      return key === "otaBundle" && !plan.artifactNames[key] ? [] : [download(label, asset)]
    }),
    download("Mentra Bluetooth SDK for iOS", manifest.publications["@mentra/bluetooth-sdk"]["swift-package-manager"]),
    download("Release manifest and SHA-256 checksums", {
      url: artifactUrl(repository, plan.artifactContainerTag, plan.artifactNames.releaseManifest),
    }),
    ...exampleLines,
    "",
    `Source: [\`${plan.sourceCommit.slice(0, 7)}\`](https://github.com/${repository}/commit/${plan.sourceCommit}).`,
    examples
      ? "Downloads are hosted on Mentra's artifact CDN."
      : "Downloads are hosted on Mentra's artifact CDN. Example apps are added when they are published.",
    END,
  ].join("\n")
}

// A production release promotes a beta: its container holds the canonical
// production record and byte-identical copies of the beta's OTA manifest and
// portable OTA bundle. The Mentra App ships through the stores.
export function productionReleaseDownloadNotes({plan, manifest, repository}) {
  if (plan.channel !== "production" || manifest.kind !== "mentra-production-release") {
    throw new Error("Production download notes need a production plan and release record")
  }
  if (manifest.releaseIdentity !== plan.releaseIdentity || manifest.sourceCommit !== plan.sourceCommit) {
    throw new Error("The production release record does not match the plan")
  }
  const asset = (key) => {
    const entry = (manifest.artifacts || []).find((artifact) => artifact.coordinate === plan.artifactNames[key])
    if (!entry) throw new Error(`The production release record does not list ${plan.artifactNames[key]}`)
    return entry
  }
  const download = (label, entry) => `- [${label}](${entry.url})`
  const beta = manifest.promotion.selectedBetaIdentity
  return [
    START,
    `Mentra ${plan.releaseIdentity} — production release, promoted from beta ${beta}.`,
    "",
    "## Glasses and developer downloads",
    download("Glasses OTA manifest", asset("otaManifest")),
    download("Glasses OTA bundle", asset("otaBundle")),
    download("Release record and SHA-256 checksums", {
      url: artifactUrl(repository, plan.artifactContainerTag, plan.artifactNames.releaseManifest),
    }),
    "",
    `The OTA manifest and bundle are byte-identical copies of beta ${beta}'s, which the Bluetooth SDK ${plan.releaseIdentity} packages pin.`,
    `Source: [\`${plan.sourceCommit.slice(0, 7)}\`](https://github.com/${repository}/commit/${plan.sourceCommit}).`,
    END,
  ].join("\n")
}

// Updates the stable production release's downloads in place. That release is
// created as a draft and published by hand after the final availability
// checks, so this never creates, publishes or retags it.
export function publishProductionReleasePage({plan, manifest, repository, releaseId, api = githubApi}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository")
  const notes = productionReleaseDownloadNotes({plan, manifest, repository})
  const release = api(`repos/${repository}/releases/${releaseId}`)
  assert.equal(release.tag_name, plan.artifactContainerTag, "The release must be the production container")
  assert.equal(release.prerelease, false)
  const body = updateDownloadNotes(release.body || "", notes)
  if (body === release.body) return release
  return api(`repos/${repository}/releases/${release.id}`, {method: "PATCH", data: {body}})
}

export function updateDownloadNotes(body = "", notes) {
  const start = body.indexOf(START)
  const end = body.indexOf(END)
  if (start < 0 && end < 0) return [body.trimEnd(), notes].filter(Boolean).join("\n\n") + "\n"
  if (start < 0 || end < start) throw new Error("Malformed managed download notes")
  return body.slice(0, start) + notes + body.slice(end + END.length)
}

function githubApi(route, {method = "GET", data, allowMissing = false} = {}) {
  try {
    return JSON.parse(
      execFileSync("gh", ["api", "--method", method, route, ...(data ? ["--input", "-"] : [])], {
        encoding: "utf8",
        input: data ? JSON.stringify(data) : undefined,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    )
  } catch (error) {
    if (allowMissing && /\(HTTP 404\)/.test(String(error.stderr))) return null
    throw error
  }
}

export function publishCoordinatedReleasePage({plan, manifest, repository, examples, api = githubApi}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository")
  const notes = releaseDownloadNotes({plan, manifest, repository, examples})
  const tag = `mentra-v${plan.releaseIdentity}`
  const route = `repos/${repository}`
  // Finalization owns the source tag. Never create or move one while repairing notes.
  const ref = api(`${route}/git/ref/tags/${tag}`)
  assert.equal(ref.object.type, "commit")
  assert.equal(ref.object.sha, plan.sourceCommit, "Release tag must identify the completed source")
  const existing = api(`${route}/releases/tags/${tag}`, {allowMissing: true})
  if (existing) {
    assert.equal(existing.draft, false, "Do not publish a draft through download-page repair")
    assert.equal(existing.prerelease, true)
    const body = updateDownloadNotes(existing.body || "", notes)
    if (body === existing.body) return existing
    return api(`${route}/releases/${existing.id}`, {method: "PATCH", data: {body}})
  }
  return api(`${route}/releases`, {
    method: "POST",
    data: {
      tag_name: tag,
      target_commitish: plan.sourceCommit,
      name: `Mentra ${plan.releaseIdentity}`,
      body: updateDownloadNotes("", notes),
      draft: false,
      prerelease: true,
      make_latest: "false",
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const option = (name) => {
    const index = process.argv.indexOf(`--${name}`)
    if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`)
    return process.argv[index + 1]
  }
  const optional = (name) => (process.argv.includes(`--${name}`) ? option(name) : undefined)
  const plan = JSON.parse(readFileSync(option("plan"), "utf8"))
  const input = {
    plan,
    manifest: JSON.parse(readFileSync(option("manifest"), "utf8")),
    repository: option("repository"),
  }
  const release =
    plan.channel === "production"
      ? publishProductionReleasePage({...input, releaseId: option("release-id")})
      : publishCoordinatedReleasePage({
          ...input,
          examples: optional("examples") ? JSON.parse(readFileSync(optional("examples"), "utf8")) : undefined,
        })
  console.log(release.html_url)
}
