#!/usr/bin/env node
import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

import {exampleArtifacts} from "./bluetooth-example-artifacts.mjs"
import {createRelease, githubApi} from "./github-release-create.mjs"
import {finalizeReleaseManifest} from "./release-family.mjs"
import {downloadNames} from "./coordinated-install-downloads.mjs"
import {artifactUrl, releaseBodyUpdate} from "./release-artifact-storage.mjs"

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

// The release's Bluetooth example apps, by their deterministic names. Only the
// published ones are listed: `published` is a predicate on the file name.
function exampleLines(plan, repository, published) {
  const examples = exampleArtifacts(plan, repository).filter(({name}) => published(name))
  if (examples.length === 0) return []
  return ["", "## Bluetooth example apps", ...examples.map(({key, url}) => `- [${EXAMPLE_LABELS[key]}](${url})`)]
}

// A dev or beta page, written once per release after finalize and the
// examples. `examples` says whether the examples workflow published them.
export function releaseDownloadNotes({plan, manifest, repository, examples = false}) {
  const {apk, aab, ipa, install, mac} = completedReleaseDownloads(plan, manifest)
  const download = (label, asset) => `- [${label}](${asset.url})`
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
    ...exampleLines(plan, repository, () => examples),
    "",
    `Source: [\`${plan.sourceCommit.slice(0, 7)}\`](https://github.com/${repository}/commit/${plan.sourceCommit}).`,
    "Downloads are hosted on Mentra's artifact CDN.",
    END,
  ].join("\n")
}

// A production release promotes a beta: its container holds the canonical
// production record and byte-identical copies of the beta's OTA manifest and
// portable OTA bundle. The Mentra App ships through the stores.
// `assetNames` are the files in the stable release container; the production
// example apps are listed when the production example workflow published them.
export function productionReleaseDownloadNotes({plan, manifest, repository, assetNames = []}) {
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
    ...exampleLines(plan, repository, (name) => assetNames.includes(name)),
    "",
    `The OTA manifest and bundle are byte-identical copies of beta ${beta}'s, which the Bluetooth SDK ${plan.releaseIdentity} packages pin.`,
    `Source: [\`${plan.sourceCommit.slice(0, 7)}\`](https://github.com/${repository}/commit/${plan.sourceCommit}).`,
    END,
  ].join("\n")
}

// Updates the stable production release's downloads in place. That release is
// created as a draft and published by hand after the final availability
// checks, so this never creates, publishes or retags it.
export function publishProductionReleasePage({plan, manifest, repository, releaseId, assetNames, api = githubApi}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository")
  const notes = productionReleaseDownloadNotes({plan, manifest, repository, assetNames})
  const release = api(`repos/${repository}/releases/${releaseId}`)
  assert.equal(release.tag_name, plan.artifactContainerTag, "The release must be the production container")
  assert.equal(release.prerelease, false)
  const body = updateDownloadNotes(release.body || "", notes)
  if (body === release.body) return release
  // The stable release is a draft until it is published by hand; keep its tag
  // (and so the release) by sending it with the body.
  return api(`repos/${repository}/releases/${release.id}`, {
    method: "PATCH",
    data: releaseBodyUpdate(release, release.tag_name, body),
  })
}

export function updateDownloadNotes(body = "", notes) {
  const start = body.indexOf(START)
  const end = body.indexOf(END)
  if (start < 0 && end < 0) return [body.trimEnd(), notes].filter(Boolean).join("\n\n") + "\n"
  if (start < 0 || end < start) throw new Error("Malformed managed download notes")
  return body.slice(0, start) + notes + body.slice(end + END.length)
}

async function missingAsNull(request) {
  try {
    return await request()
  } catch (error) {
    if (error.status === 404) return null
    throw error
  }
}

export async function publishCoordinatedReleasePage({plan, manifest, repository, examples = false, api = githubApi, wait, log}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository")
  const notes = releaseDownloadNotes({plan, manifest, repository, examples})
  const tag = `mentra-v${plan.releaseIdentity}`
  const route = `repos/${repository}`
  // Finalization owns the source tag. Never create or move one while repairing notes.
  const ref = await api(`${route}/git/ref/tags/${tag}`)
  assert.equal(ref.object.type, "commit")
  assert.equal(ref.object.sha, plan.sourceCommit, "Release tag must identify the completed source")
  const validate = (release) => {
    assert.equal(release.draft, false, "Do not publish a draft through download-page repair")
    assert.equal(release.prerelease, true)
    return release
  }
  const existing = await missingAsNull(() => api(`${route}/releases/tags/${tag}`))
  const release = existing
    ? validate(existing)
    : await createRelease({
        repository,
        release: {
          tag_name: tag,
          target_commitish: plan.sourceCommit,
          name: `Mentra ${plan.releaseIdentity}`,
          body: updateDownloadNotes("", notes),
          draft: false,
          prerelease: true,
          make_latest: "false",
        },
        validate,
        api,
        ...(wait ? {wait} : {}),
        ...(log ? {log} : {}),
      })
  // A release another publisher created between the lookup and our create
  // still gets this run's managed notes.
  const body = updateDownloadNotes(release.body || "", notes)
  if (body === release.body) return release
  return api(`${route}/releases/${release.id}`, {
    method: "PATCH",
    data: releaseBodyUpdate(release, release.tag_name, body),
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
  const input = {plan, manifest: JSON.parse(readFileSync(option("manifest"), "utf8")), repository: option("repository")}
  const release =
    plan.channel === "production"
      ? publishProductionReleasePage({
          ...input,
          releaseId: option("release-id"),
          assetNames: optional("assets")
            ? JSON.parse(readFileSync(option("assets"), "utf8"))
                .filter((asset) => asset.state === "uploaded")
                .map((asset) => asset.name)
            : [],
        })
      : await publishCoordinatedReleasePage({...input, examples: optional("examples") === "true"})
  console.log(release.html_url)
}
