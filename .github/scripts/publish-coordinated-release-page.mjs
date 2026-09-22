#!/usr/bin/env node
import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"

import {finalizeReleaseManifest} from "./release-family.mjs"
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
  return {apk: asset("androidApp"), aab: asset("androidStoreApp"), ipa: asset("iosApp")}
}

export function releaseDownloadNotes({plan, manifest, repository}) {
  const {apk, aab, ipa} = completedReleaseDownloads(plan, manifest)
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
    download("iOS IPA", ipa),
    "",
    "## Glasses and developer downloads",
    ...(asg ? [download("Mentra Live glasses APK (ASG)", asg)] : []),
    download("Glasses OTA manifest", manifest.otaManifest),
    ...["otaBundle", "enginePackage"].map((key) => {
      const asset = manifest.artifacts.find((entry) => entry.coordinate === plan.artifactNames[key])
      return download(key === "otaBundle" ? "Glasses OTA bundle" : "Mentra Engine package", asset)
    }),
    download("Mentra Bluetooth SDK for iOS", manifest.publications["@mentra/bluetooth-sdk"]["swift-package-manager"]),
    download("Release manifest and SHA-256 checksums", {
      url: artifactUrl(repository, plan.artifactContainerTag, plan.artifactNames.releaseManifest),
    }),
    "",
    `Source: [\`${plan.sourceCommit.slice(0, 7)}\`](https://github.com/${repository}/commit/${plan.sourceCommit}).`,
    "Downloads are hosted on Mentra's artifact CDN. Example apps are distributed separately.",
    END,
  ].join("\n")
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

export function publishCoordinatedReleasePage({plan, manifest, repository, api = githubApi}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("Invalid repository")
  const notes = releaseDownloadNotes({plan, manifest, repository})
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
  const release = publishCoordinatedReleasePage({
    plan: JSON.parse(readFileSync(option("plan"), "utf8")),
    manifest: JSON.parse(readFileSync(option("manifest"), "utf8")),
    repository: option("repository"),
  })
  console.log(release.html_url)
}
