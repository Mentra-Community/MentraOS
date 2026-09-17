#!/usr/bin/env node
import assert from "node:assert/strict"
import {randomUUID} from "node:crypto"
import {mkdtemp, open, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {artifactPrefix, createR2Store, publishR2Artifact, readPublicIndex} from "./release-artifact-storage.mjs"

// Synthetic data only. Never rebuild or publish a real release to check the
// storage transport. Every object belongs to a unique disposable release key.
const repository = process.env.GITHUB_REPOSITORY || "Mentra-Community/MentraOS"
const tag = `storage-check-${process.env.GITHUB_RUN_ID || "local"}-${randomUUID()}`
const release = {id: 0, tag_name: tag, draft: false}
const directory = await mkdtemp(path.join(tmpdir(), "mentra-storage-check-"))
const file = path.join(directory, "payload.bin")
const store = await createR2Store()
const records = []
let uploads = 0
const observedStore = {
  ...store,
  async upload(...args) {
    uploads++
    await store.upload(...args)
    // Exercise reconciliation after the service committed the complete object,
    // but the caller did not receive the completion response.
    throw Object.assign(new Error("Injected lost upload-completion response"), {code: "ECONNRESET"})
  },
}

try {
  const fd = await open(file, "w")
  try {
    const block = Buffer.alloc(1024 * 1024, 0xa5)
    for (let index = 0; index < 110; index++) await fd.write(block)
  } finally {
    await fd.close()
  }
  const started = Date.now()
  const asset = await publishR2Artifact({
    repository,
    release,
    name: "payload.bin",
    file,
    store: observedStore,
    updateRelease: false,
  })
  records.push({
    test: "multipart upload and public SHA-256 verification after a lost completion response",
    elapsedMs: Date.now() - started,
    size: asset.size,
    digest: asset.digest,
  })
  await publishR2Artifact({repository, release, name: "payload.bin", file, store: observedStore, updateRelease: false})
  assert.equal(uploads, 1, "an identical retry must not upload the file again")
  const index = await readPublicIndex(repository, tag)
  assert.equal(index.assets.length, 1)
  assert.equal(index.assets[0].digest, asset.digest)
  records.push({test: "idempotent retry and public index", uploads})
  console.log("R2 artifact storage check passed")
} finally {
  try {
    for (const name of ["payload.bin", "_assets.json", "index.html"])
      await store.remove(artifactPrefix(repository, tag) + name)
  } finally {
    await rm(directory, {recursive: true, force: true})
    await writeFile(
      process.env.ARTIFACT_CHECK_REPORT || "artifact-storage-check.json",
      JSON.stringify({repository, tag, records}, null, 2) + "\n",
    )
  }
}
