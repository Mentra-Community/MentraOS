#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {requirePublicHttpsUrl} from "./release-family.mjs"

function uniqueDownloadableRecords(manifest) {
  const records = [manifest.otaManifest, ...(manifest.artifacts || [])]
  for (const [member, targets] of Object.entries(manifest.publications || {})) {
    if (member === "mentraos") continue
    records.push(...Object.values(targets))
  }
  const byUrl = new Map()
  for (const record of records) {
    if (!record?.url || !record?.sha256) throw new Error("Release manifest contains an incomplete artifact record")
    const existing = byUrl.get(record.url)
    if (existing && existing.sha256 !== record.sha256) throw new Error(`Conflicting hashes recorded for ${record.url}`)
    byUrl.set(record.url, record)
  }
  return [...byUrl.values()]
}

export async function verifyReleaseArtifacts(manifest, fetchImpl = fetch) {
  const verified = []
  for (const record of uniqueDownloadableRecords(manifest)) {
    const url = requirePublicHttpsUrl(record.url, `Artifact ${record.coordinate} URL`)
    const response = await fetchImpl(url)
    if (!response.ok) throw new Error(`Artifact ${record.coordinate} returned HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    if (sha256 !== record.sha256) throw new Error(`Artifact ${record.coordinate} no longer matches its release hash`)
    verified.push({coordinate: record.coordinate, url: record.url, sha256, size: bytes.length})
  }
  return verified
}

async function main() {
  const index = process.argv.indexOf("--manifest")
  if (index < 0 || !process.argv[index + 1]) throw new Error("Missing --manifest")
  const manifest = JSON.parse(readFileSync(path.resolve(process.argv[index + 1]), "utf8"))
  const verified = await verifyReleaseArtifacts(manifest)
  console.log(`Verified ${verified.length} immutable release artifacts`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
