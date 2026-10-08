#!/usr/bin/env node
// Point a Private Cloud channel's stable download URLs at a published release.
// Customers and the partner docs use these two fixed URLs instead of versioned
// links: <channel>/install.sh (the bootstrap) and <channel>/latest.json.
import {createHash} from "node:crypto"
import {appendFileSync, readFileSync} from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"
import {setTimeout as sleep} from "node:timers/promises"

import {
  ARTIFACT_ORIGIN,
  artifactBaseUrl,
  artifactUrl,
  createR2Store,
  readPublicIndex,
} from "./release-artifact-storage.mjs"

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(dev|beta)\.([1-9]\d*))?$/
const ARCHIVE = "mentra-private-cloud.tar.gz"
const CHANNEL_PLACEHOLDER = "__MENTRA_CHANNEL__"

export function channelOf(version) {
  const match = VERSION.exec(version || "")
  if (!match) throw new Error(`Invalid Private Cloud release identity ${JSON.stringify(version)}`)
  return match[4] || "stable"
}

// Versions within one channel order by base version, then prerelease number.
export function compareVersions(left, right) {
  const [a, b] = [VERSION.exec(left), VERSION.exec(right)]
  if (!a || !b || channelOf(left) !== channelOf(right)) throw new Error(`Cannot order ${left} and ${right}`)
  for (const index of [1, 2, 3, 5]) {
    const difference = Number(a[index] || 0) - Number(b[index] || 0)
    if (difference) return Math.sign(difference)
  }
  return 0
}

export function channelPrefix(repository, channel) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "")) throw new Error("Invalid repository")
  if (!["dev", "beta", "stable"].includes(channel)) throw new Error(`Invalid channel ${channel}`)
  return `${repository}/private-cloud/${channel}/`
}

export function channelUrls(repository, channel) {
  const base = `${ARTIFACT_ORIGIN}/${channelPrefix(repository, channel)}`
  return {install: `${base}install.sh`, latest: `${base}latest.json`}
}

export function buildPointer({repository, version, sha256, release, publishedAt}) {
  const channel = channelOf(version)
  const tag = `mentra-private-cloud-${version}`
  if (!/^[0-9a-f]{64}$/.test(sha256 || "")) throw new Error("Invalid installer checksum")
  if (release?.schemaVersion !== 1 || release.releaseTag !== version) {
    throw new Error("Installer release.json does not belong to this release")
  }
  if (!/^ghcr\.io\/mentra-community\/mentra-cloud@sha256:[0-9a-f]{64}$/.test(release.sourceImage || "")) {
    throw new Error("Installer release.json has no pinned Mentra Cloud image")
  }
  return {
    schemaVersion: 1,
    channel,
    version,
    releaseTag: tag,
    archiveUrl: artifactUrl(repository, tag, ARCHIVE),
    sha256,
    downloadsPage: `${artifactBaseUrl(repository, tag)}/index.html`,
    image: release.sourceImage,
    imageTag: `ghcr.io/mentra-community/mentra-cloud:${version}`,
    sourceCommit: release.installerSourceCommit,
    managedMiniapps: (release.managedMiniapps || []).map(({packageName, version}) => ({packageName, version})),
    // Download before running: with `curl | bash`, a failed download still exits 0.
    installCommand: `curl -fsSLo mentra-install.sh ${channelUrls(repository, channel).install} && bash mentra-install.sh`,
    publishedAt,
  }
}

export function renderBootstrap(source, channel) {
  if (source.split(CHANNEL_PLACEHOLDER).length !== 2) throw new Error("Bootstrap must contain one channel placeholder")
  return source.replace(CHANNEL_PLACEHOLDER, channel)
}

const preconditionFailed = (error) => [409, 412].includes(error.$metadata?.httpStatusCode)

// latest.json is the commit point: install.sh is written first, and neither
// moves backwards when an older release is re-run.
export async function advanceChannel({store, repository, pointer, bootstrap, wait = sleep}) {
  const prefix = channelPrefix(repository, pointer.channel)
  const key = `${prefix}latest.json`
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await store.read(key)
    const current = previous ? JSON.parse(previous.body) : null
    if (current && compareVersions(current.version, pointer.version) >= 0) {
      return {advanced: false, version: current.version}
    }
    await store.put(`${prefix}install.sh`, bootstrap, {
      ContentType: "text/plain; charset=utf-8",
      CacheControl: "no-store",
    })
    try {
      await store.put(key, `${JSON.stringify(pointer, null, 2)}\n`, {
        ContentType: "application/json",
        CacheControl: "no-store",
        ...(previous ? {IfMatch: previous.etag} : {IfNoneMatch: "*"}),
      })
      return {advanced: true, version: pointer.version}
    } catch (error) {
      if (!preconditionFailed(error) || attempt === 7) throw error
      await wait(100 * 2 ** attempt)
    }
  }
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error("Expected --name value pairs")
    values[argv[index].slice(2)] = argv[index + 1]
  }
  for (const name of ["repository", "version", "archive", "release-json", "bootstrap"]) {
    if (!values[name]) throw new Error(`--${name} is required`)
  }
  return values
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const tag = `mentra-private-cloud-${args.version}`
  // Point only at bytes the public CDN index already serves for this release.
  const index = await readPublicIndex(args.repository, tag)
  const published = index.assets.find((asset) => asset.name === ARCHIVE)
  const sha256 = createHash("sha256")
    .update(readFileSync(path.resolve(args.archive)))
    .digest("hex")
  if (!published || published.digest !== `sha256:${sha256}`) {
    throw new Error(`${tag} does not publish the verified installer archive`)
  }
  const pointer = buildPointer({
    repository: args.repository,
    version: args.version,
    sha256,
    release: JSON.parse(readFileSync(path.resolve(args["release-json"]), "utf8")),
    publishedAt: new Date().toISOString(),
  })
  const bootstrap = renderBootstrap(readFileSync(path.resolve(args.bootstrap), "utf8"), pointer.channel)
  const result = await advanceChannel({store: await createR2Store(), repository: args.repository, pointer, bootstrap})
  const urls = channelUrls(args.repository, pointer.channel)
  console.log(
    result.advanced
      ? `Private Cloud ${pointer.channel} now points at ${pointer.version}: ${urls.latest}`
      : `Private Cloud ${pointer.channel} already points at ${result.version}; left unchanged.`,
  )
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = [
      "## Private Cloud downloads",
      "",
      `- Channel \`${pointer.channel}\`: \`${result.version}\`${result.advanced ? "" : " (unchanged)"}`,
      `- Install: \`${pointer.installCommand}\``,
      `- Pointer: ${urls.latest}`,
      "",
    ].join("\n")
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
