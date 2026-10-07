import assert from "node:assert/strict"
import {readFileSync} from "node:fs"
import test from "node:test"

import {
  advanceChannel,
  buildPointer,
  channelOf,
  channelUrls,
  compareVersions,
  renderBootstrap,
} from "./publish-private-cloud-channel.mjs"

const repository = "Mentra-Community/MentraOS"
const image = `ghcr.io/mentra-community/mentra-cloud@sha256:${"b".repeat(64)}`

function pointer(version) {
  return buildPointer({
    repository,
    version,
    sha256: "a".repeat(64),
    release: {
      schemaVersion: 1,
      releaseTag: version,
      sourceImage: image,
      installerSourceCommit: "c".repeat(40),
      managedMiniapps: [{packageName: "com.mentra.call", version: "2.1.38", sha256: "d".repeat(64)}],
    },
    publishedAt: "2026-10-07T00:00:00.000Z",
  })
}

function memoryStore() {
  const values = new Map()
  let sequence = 0
  return {
    values,
    async read(key) {
      const value = values.get(key)
      return value ? {body: value.body, etag: value.etag} : null
    },
    async put(key, body, options = {}) {
      const existing = values.get(key)
      if ((options.IfNoneMatch === "*" && existing) || (options.IfMatch && existing?.etag !== options.IfMatch)) {
        throw Object.assign(new Error("precondition"), {$metadata: {httpStatusCode: 412}})
      }
      values.set(key, {body, etag: `"${++sequence}"`, options})
    },
  }
}

test("release identities map to channels and order within one", () => {
  assert.equal(channelOf("3.3.0-dev.711"), "dev")
  assert.equal(channelOf("3.3.0-beta.4"), "beta")
  assert.equal(channelOf("3.3.0"), "stable")
  assert.throws(() => channelOf("3.3.0-rc.1"))
  assert.equal(compareVersions("3.3.0-dev.711", "3.3.0-dev.92"), 1)
  assert.equal(compareVersions("3.3.0-dev.711", "3.4.0-dev.1"), -1)
  assert.equal(compareVersions("3.3.0-dev.7", "3.3.0-dev.7"), 0)
  assert.throws(() => compareVersions("3.3.0-dev.7", "3.3.0-beta.7"))
})

test("pointer names the immutable release bytes, image and install command", () => {
  const value = pointer("3.3.0-dev.711")
  const base = "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS"
  assert.equal(value.archiveUrl, `${base}/releases/mentra-private-cloud-3.3.0-dev.711/mentra-private-cloud.tar.gz`)
  assert.equal(value.downloadsPage, `${base}/releases/mentra-private-cloud-3.3.0-dev.711/index.html`)
  assert.equal(value.image, image)
  assert.equal(value.imageTag, "ghcr.io/mentra-community/mentra-cloud:3.3.0-dev.711")
  assert.deepEqual(value.managedMiniapps, [{packageName: "com.mentra.call", version: "2.1.38"}])
  assert.equal(value.installCommand, `curl -fsSL ${base}/private-cloud/dev/install.sh | bash`)
  assert.deepEqual(channelUrls(repository, "dev"), {
    install: `${base}/private-cloud/dev/install.sh`,
    latest: `${base}/private-cloud/dev/latest.json`,
  })
  assert.throws(() =>
    buildPointer({
      repository,
      version: "3.3.0-dev.711",
      sha256: "a".repeat(64),
      release: {schemaVersion: 1, releaseTag: "3.3.0-dev.710", sourceImage: image},
    }),
  )
})

test("the published bootstrap has exactly one channel placeholder", () => {
  const source = readFileSync(
    new URL("../../cloud-v2/deploy/azure/enterprise-reference/installer/bootstrap.sh", import.meta.url),
    "utf8",
  )
  const rendered = renderBootstrap(source, "dev")
  assert.match(rendered, /MENTRA_CHANNEL="\$\{MENTRA_CHANNEL:-dev\}"/)
  assert.doesNotMatch(rendered, /__MENTRA_CHANNEL__/)
  assert.match(rendered.trimEnd(), /\nmain "\$@"$/)
  assert.throws(() => renderBootstrap("no placeholder", "dev"))
})

test("channel pointers only move forward and write install.sh first", async () => {
  const store = memoryStore()
  const key = `${repository}/private-cloud/dev/latest.json`
  assert.deepEqual(await advanceChannel({store, repository, pointer: pointer("3.3.0-dev.710"), bootstrap: "v710"}), {
    advanced: true,
    version: "3.3.0-dev.710",
  })
  assert.equal(
    store.values.get(`${repository}/private-cloud/dev/install.sh`).options.ContentType,
    "text/plain; charset=utf-8",
  )
  assert.equal(store.values.get(key).options.CacheControl, "no-store")

  await advanceChannel({store, repository, pointer: pointer("3.3.0-dev.711"), bootstrap: "v711"})
  // Re-running an older release leaves both stable URLs on the newest one.
  assert.deepEqual(await advanceChannel({store, repository, pointer: pointer("3.3.0-dev.710"), bootstrap: "v710"}), {
    advanced: false,
    version: "3.3.0-dev.711",
  })
  assert.equal(JSON.parse(store.values.get(key).body).version, "3.3.0-dev.711")
  assert.equal(store.values.get(`${repository}/private-cloud/dev/install.sh`).body, "v711")
})

test("a concurrent newer publication wins the conditional pointer write", async () => {
  const store = memoryStore()
  const realPut = store.put
  let raced = false
  store.put = async (key, body, options) => {
    if (key.endsWith("latest.json") && !raced) {
      raced = true
      await realPut(key, `${JSON.stringify(pointer("3.3.0-dev.712"))}\n`, {})
    }
    return realPut(key, body, options)
  }
  const result = await advanceChannel({
    store,
    repository,
    pointer: pointer("3.3.0-dev.711"),
    bootstrap: "v711",
    wait: async () => {},
  })
  assert.deepEqual(result, {advanced: false, version: "3.3.0-dev.712"})
})
