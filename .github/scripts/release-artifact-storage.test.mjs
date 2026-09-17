import assert from "node:assert/strict"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  artifactKey,
  artifactUrl,
  mergeAssets,
  publishR2Artifact,
  readPublicIndex,
  releaseDownloadBody,
  updateIndex,
  usesPrivateArtifactStorage,
  validateIndex,
} from "./release-artifact-storage.mjs"
import {matchesPattern, parseArgs} from "./release-assets.mjs"

const repository = "Mentra-Community/MentraOS"
const release = {id: 123, tag_name: "mentra-builds-v3.2.0", draft: false}
const digest = "a".repeat(64)
function asset(name = "one.apk") {
  const url = artifactUrl(repository, release.tag_name, name)
  return {
    id: `r2:${artifactKey(repository, release.tag_name, name)}`,
    name,
    size: 10,
    digest: `sha256:${digest}`,
    state: "uploaded",
    url,
    browser_download_url: url,
  }
}

function memoryStore() {
  const values = new Map()
  let sequence = 0
  return {
    values,
    uploads: 0,
    async head(key) {
      const value = values.get(key)
      return value
        ? {ContentLength: value.body.length, Metadata: value.metadata, ETag: value.etag, LastModified: new Date(0)}
        : null
    },
    async read(key) {
      const value = values.get(key)
      return value ? {body: value.body.toString(), etag: value.etag} : null
    },
    async put(key, body, options = {}) {
      const old = values.get(key)
      if ((options.IfNoneMatch === "*" && old) || (options.IfMatch && old?.etag !== options.IfMatch)) {
        throw Object.assign(new Error("Precondition failed"), {$metadata: {httpStatusCode: 412}})
      }
      values.set(key, {body: Buffer.from(body), etag: `etag-${++sequence}`, metadata: options.Metadata})
    },
    async upload(key, file, hash, options = {}) {
      this.uploads++
      await this.put(key, await readFile(file), {
        Metadata: {sha256: hash},
        ...(options.etag ? {IfMatch: options.etag} : {IfNoneMatch: "*"}),
      })
    },
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "r2-artifact-test-"))
  t.after(() => rm(directory, {recursive: true, force: true}))
  const file = path.join(directory, "file.apk")
  await writeFile(file, "signed APK bytes")
  const store = memoryStore()
  return {
    repository,
    release,
    name: "file.apk",
    file,
    store,
    updateRelease: false,
    log() {},
    verify: async () => {},
    wait: async () => {},
  }
}

test("artifact keys preserve release identity and reject traversal/reserved index names", () => {
  assert.equal(
    artifactUrl(repository, "v1.2.3", "file name.apk"),
    "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/v1.2.3/file%20name.apk",
  )
  for (const name of ["../file", "a/b", "a\\b", "_assets.json", "index.html", "..", ""]) {
    assert.throws(() => artifactKey(repository, "v1", name))
  }
  assert.throws(() => artifactKey(repository, "../v1", "a.apk"))
})

test("public index fails closed on wrong release, altered download URLs, and duplicate entries", () => {
  const index = {schemaVersion: 1, repository, tag: release.tag_name, assets: [asset()]}
  assert.equal(validateIndex(index, repository, release.tag_name), index)
  assert.throws(() => validateIndex({...index, tag: "other"}, repository, release.tag_name))
  assert.throws(() =>
    validateIndex(
      {...index, assets: [{...asset(), url: "https://untrusted.example/a.apk"}]},
      repository,
      release.tag_name,
    ),
  )
  assert.throws(() => validateIndex({...index, assets: [asset(), asset()]}, repository, release.tag_name))
})

test("missing public index permits legacy lookup; service failures never masquerade as absence", async () => {
  assert.deepEqual((await readPublicIndex(repository, release.tag_name, async () => ({status: 404}))).assets, [])
  await assert.rejects(
    readPublicIndex(repository, release.tag_name, async () => ({status: 503, ok: false})),
    /HTTP 503/,
  )
})

test("R2 entries supersede matching legacy names while keeping old-only assets readable", () => {
  assert.deepEqual(
    mergeAssets(
      [
        {id: 1, name: "one.apk"},
        {id: 2, name: "old.apk"},
      ],
      [asset()],
    ),
    [{id: 2, name: "old.apk"}, asset()],
  )
})

test("private promotion drafts remain private; final production distribution uses the CDN", () => {
  assert.equal(
    usesPrivateArtifactStorage({draft: true, tag_name: "mentra-production-promotion-v3.2.0-attempt-1"}),
    true,
  )
  assert.equal(usesPrivateArtifactStorage({draft: true, tag_name: "unrelated-private-draft"}), true)
  assert.equal(usesPrivateArtifactStorage({draft: true, tag_name: "mentra-v3.2.0"}), false)
  assert.equal(usesPrivateArtifactStorage(release), false)
})

test("concurrent publishers preserve both artifact records through conditional index updates", async () => {
  const store = memoryStore()
  await Promise.all(
    ["one.apk", "two.apk"].map((name) =>
      updateIndex(
        store,
        repository,
        release.tag_name,
        (old) => [...old, asset(name)],
        async () => {},
      ),
    ),
  )
  const index = JSON.parse((await store.read(`${repository}/releases/${release.tag_name}/_assets.json`)).body)
  assert.deepEqual(
    index.assets.map((a) => a.name),
    ["one.apk", "two.apk"],
  )
})

test("an upload-completion response lost after commit reconciles and publishes verified bytes", async (t) => {
  const options = await fixture(t)
  const upload = options.store.upload.bind(options.store)
  options.store.upload = async (...args) => {
    await upload(...args)
    throw new Error("Lost completion response")
  }
  const result = await publishR2Artifact(options)
  assert.equal(options.store.uploads, 1)
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(
    JSON.parse((await options.store.read(`${repository}/releases/${release.tag_name}/_assets.json`)).body).assets
      .length,
    1,
  )
})

test("a retry verifies and reuses the existing object without uploading it again", async (t) => {
  const options = await fixture(t)
  let verifications = 0
  options.verify = async () => {
    verifications++
  }
  await publishR2Artifact(options)
  await publishR2Artifact(options)
  assert.equal(options.store.uploads, 1)
  assert.equal(verifications, 2)
})

test("immutable artifacts refuse different bytes before any replacement upload", async (t) => {
  const options = await fixture(t)
  await publishR2Artifact(options)
  await writeFile(options.file, "different signed APK")
  await assert.rejects(publishR2Artifact(options), /Refusing to overwrite immutable/)
  assert.equal(options.store.uploads, 1)
})

test("failed public verification cannot publish a download record", async (t) => {
  const options = await fixture(t)
  options.verify = async () => {
    throw new Error("Downloaded artifact SHA-256 mismatch")
  }
  await assert.rejects(publishR2Artifact(options), /SHA-256 mismatch/)
  assert.equal(await options.store.read(`${repository}/releases/${release.tag_name}/_assets.json`), null)
})

test("upload failure without a committed matching object stays failed", async (t) => {
  const options = await fixture(t)
  options.store.upload = async () => {
    throw new Error("Storage unavailable")
  }
  await assert.rejects(publishR2Artifact(options), /Storage unavailable/)
  assert.equal(options.store.values.size, 0)
})

test("rolling PR artifacts can be replaced atomically and keep their mobile reuse fingerprint", async (t) => {
  const options = {
    ...(await fixture(t)),
    release: {...release, tag_name: "pr-builds"},
    replace: true,
    fingerprint: digest,
  }
  await publishR2Artifact(options)
  await writeFile(options.file, "rebuilt APK")
  const result = await publishR2Artifact(options)
  assert.equal(options.store.uploads, 2)
  assert.equal(result.label, `mobile-v1:${digest}:${result.digest.slice(7)}`)
  await assert.rejects(publishR2Artifact({...options, release}), /Replacement is only allowed/)
})

test("release notes retain existing text and add one CDN download index link", () => {
  const body = releaseDownloadBody("Existing release notes", repository, release.tag_name)
  assert.match(body, /^Existing release notes/)
  assert.match(body, /artifactscdn\.mentraglass\.com/)
  assert.equal(releaseDownloadBody(body, repository, release.tag_name), body)
})

test("download patterns support multiple exact/glob selections without interpreting regexp punctuation", () => {
  assert.deepEqual(parseArgs(["--tag", "v1", "--pattern", "a.json", "--pattern", "*.apk", "--clobber"]).patterns, [
    "a.json",
    "*.apk",
  ])
  assert.equal(matchesPattern("app-1.apk", "app-*.apk"), true)
  assert.equal(matchesPattern("app-1Xapk", "app-*.apk"), false)
})
