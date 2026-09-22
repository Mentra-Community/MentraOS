import assert from "node:assert/strict"
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  artifactKey,
  artifactHeaders,
  artifactUrl,
  mergeAssets,
  publishR2Artifact,
  readArtifactIndex,
  readPublicIndex,
  releaseDownloadBody,
  resolveArtifactUrl,
  sha256File,
  updateIndex,
  usesPrivateArtifactStorage,
  validateIndex,
} from "./release-artifact-storage.mjs"
import {matchesPattern, parseArgs, removeAsset} from "./release-assets.mjs"

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
    async list(prefix) {
      return [...values]
        .filter(([key]) => key.startsWith(prefix))
        .map(([Key, value]) => ({Key, ETag: value.etag, LastModified: value.modified}))
    },
    async head(key) {
      const value = values.get(key)
      return value
        ? {ContentLength: value.body.length, Metadata: value.metadata, ETag: value.etag, LastModified: value.modified}
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
      values.set(key, {
        body: Buffer.from(body),
        etag: `etag-${++sequence}`,
        metadata: options.Metadata,
        modified: new Date(),
        cacheControl: options.CacheControl,
      })
    },
    async upload(key, file, hash, options = {}) {
      this.uploads++
      await this.put(key, await readFile(file), {
        ...artifactHeaders(file, hash, options.fingerprint),
        ...(options.etag ? {IfMatch: options.etag} : {IfNoneMatch: "*"}),
      })
    },
    async remove(key) {
      values.delete(key)
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

test("serves iPhone installation pages and manifests with browser-compatible MIME types", async (t) => {
  const {file} = await fixture(t)
  for (const [ext, type] of [
    ["html", "text/html; charset=utf-8"],
    ["plist", "text/xml; charset=utf-8"],
    ["ipa", "application/octet-stream"],
    ["json", "application/json"],
  ]) {
    const candidate = `${file}.${ext}`
    await writeFile(candidate, "test bytes")
    const headers = artifactHeaders(candidate, digest)
    assert.equal(headers.ContentType, type)
    assert.equal(headers.CacheControl, "no-store")
  }
})

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

test("mobile URLs preserve private and historical storage while routing new public files to R2", () => {
  const privateRelease = {...release, draft: true, tag_name: "mentra-production-promotion-v3.2.0-attempt-1"}
  const legacy = {
    ...asset(),
    id: 123,
    browser_download_url: "https://github.com/Mentra-Community/MentraOS/releases/download/mentra-builds-v3.2.0/one.apk",
  }
  for (const name of ["new.apk", "new.aab", "new.ipa"]) {
    assert.equal(
      resolveArtifactUrl(repository, privateRelease, name, [], {allowMissing: true}),
      `https://github.com/${repository}/releases/download/${privateRelease.tag_name}/${name}`,
    )
    assert.equal(
      resolveArtifactUrl(repository, release, name, [], {allowMissing: true}),
      artifactUrl(repository, release.tag_name, name),
    )
  }
  assert.equal(resolveArtifactUrl(repository, release, legacy.name, [legacy]), legacy.browser_download_url)
  assert.equal(
    resolveArtifactUrl(repository, release, legacy.name, [asset()], {legacy: [legacy]}),
    legacy.browser_download_url,
  )
  assert.equal(resolveArtifactUrl(repository, release, "one.apk", [asset()]), asset().url)
  assert.throws(() => resolveArtifactUrl(repository, release, "missing.apk", []), /Expected an existing/)
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

test("publish-delete-rebuild does not serve stale cached bytes at the same URL", async (t) => {
  const options = await fixture(t)
  const cache = new Map()
  options.verify = async (_repository, record, file) => {
    const stored = options.store.values.get(record.id.slice(3))
    let response = cache.get(record.url)
    if (!response || ["no-cache", "no-store"].includes(response.cacheControl)) {
      response = {...stored}
      if (response.cacheControl !== "no-store") cache.set(record.url, response)
    }
    await writeFile(file, response.body)
    assert.equal(`sha256:${await sha256File(file)}`, record.digest)
  }
  const first = await publishR2Artifact(options)
  await removeAsset(repository, first.id, options.store)
  await writeFile(options.file, "rebuilt signed bytes after incomplete-pair cleanup")
  const rebuilt = await publishR2Artifact(options)
  assert.equal(rebuilt.url, first.url)
  assert.notEqual(rebuilt.digest, first.digest)
})

test("failed public verification cannot publish a download record", async (t) => {
  const options = await fixture(t)
  options.verify = async () => {
    throw new Error("Downloaded artifact SHA-256 mismatch")
  }
  await assert.rejects(publishR2Artifact(options), /SHA-256 mismatch/)
  assert.equal(await options.store.read(`${repository}/releases/${release.tag_name}/_assets.json`), null)
  await assert.rejects(readArtifactIndex(repository, release.tag_name, options), /SHA-256 mismatch/)
})

test("a restarted build discovers verified committed bytes after index publication failed", async (t) => {
  const options = await fixture(t)
  const indexKey = `${repository}/releases/${release.tag_name}/_assets.json`
  const put = options.store.put.bind(options.store)
  options.store.put = async (key, ...args) => {
    if (key === indexKey) throw new Error("Job stopped before indexing")
    return put(key, ...args)
  }
  await assert.rejects(publishR2Artifact(options), /Job stopped/)
  assert.equal(await options.store.read(indexKey), null)
  options.store.put = put
  let verifications = 0
  options.verify = async (_repo, record, file) => {
    verifications++
    await writeFile(file, options.store.values.get(record.id.slice(3)).body)
    assert.equal(record.digest, `sha256:${await sha256File(file)}`)
    assert.equal(record.size, (await readFile(file)).length)
  }
  const index = await readArtifactIndex(repository, release.tag_name, options)
  assert.deepEqual(
    index.assets.map((a) => a.name),
    [options.name],
  )
  assert.equal(JSON.parse((await options.store.read(indexKey)).body).assets[0].digest, index.assets[0].digest)
  assert.ok(await options.store.read(`${repository}/releases/${release.tag_name}/index.html`))
  // The next lookup sees this as reusable, without downloading or rebuilding.
  assert.deepEqual(await readArtifactIndex(repository, release.tag_name, options), index)
  assert.equal(verifications, 1)
  await publishR2Artifact(options)
  assert.equal(options.store.uploads, 1)
})

test("recovery restores PR reuse fingerprints and repairs an interrupted rolling replacement", async (t) => {
  const options = {
    ...(await fixture(t)),
    release: {...release, tag_name: "pr-builds"},
    replace: true,
    fingerprint: digest,
  }
  const first = await publishR2Artifact(options)
  await writeFile(options.file, "next signed APK")
  await assert.rejects(
    publishR2Artifact({
      ...options,
      verify: async () => {
        throw new Error("Job stopped")
      },
    }),
    /Job stopped/,
  )
  const index = await readArtifactIndex(repository, "pr-builds", options)
  assert.equal(index.assets.length, 1)
  assert.notEqual(index.assets[0].digest, first.digest)
  assert.equal(index.assets[0].label, `mobile-v1:${digest}:${await sha256File(options.file)}`)
})

test("recovery cannot replace a newer concurrently published rolling record", async (t) => {
  const options = {...(await fixture(t)), release: {...release, tag_name: "pr-builds"}, replace: true}
  await assert.rejects(
    publishR2Artifact({
      ...options,
      verify: async () => {
        throw new Error("Job stopped")
      },
    }),
    /Job stopped/,
  )
  const index = await readArtifactIndex(repository, "pr-builds", {
    store: options.store,
    verify: async () => {
      await writeFile(options.file, "a newer successful publication")
      await publishR2Artifact(options)
    },
  })
  assert.equal(index.assets[0].digest, `sha256:${await sha256File(options.file)}`)
})

test("recovery never resurrects expired rolling objects awaiting lifecycle deletion", async (t) => {
  const options = {...(await fixture(t)), release: {...release, tag_name: "pr-builds"}, replace: true}
  await assert.rejects(
    publishR2Artifact({
      ...options,
      verify: async () => {
        throw new Error("Job stopped")
      },
    }),
    /Job stopped/,
  )
  options.store.values.get(artifactKey(repository, "pr-builds", options.name)).modified = new Date(
    Date.now() - 8 * 86400000,
  )
  assert.deepEqual((await readArtifactIndex(repository, "pr-builds", options)).assets, [])
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
