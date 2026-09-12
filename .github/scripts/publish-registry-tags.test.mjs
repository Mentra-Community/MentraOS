import assert from "node:assert/strict"
import test from "node:test"

import {manifestDigest, parseImageReference, publishRegistryTags, tagName} from "./publish-registry-tags.mjs"

const IMAGE = "ghcr.io/mentra-community/mentra-cloud"
const MANIFEST = Buffer.from('{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json"}')
const DIGEST = manifestDigest(MANIFEST)
const MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json"

function registry({manifest = MANIFEST, contentType = MEDIA_TYPE} = {}) {
  const puts = []
  const fetchImpl = async (url, options = {}) => {
    if (url.includes("/token")) {
      return {ok: true, json: async () => ({token: "registry-token"})}
    }
    if ((options.method ?? "GET") === "GET") {
      return {
        ok: true,
        headers: new Headers({"content-type": contentType}),
        arrayBuffer: async () => manifest,
      }
    }
    puts.push({url, contentType: options.headers["content-type"], body: options.body})
    return {ok: true, headers: new Headers({"docker-content-digest": manifestDigest(options.body)})}
  }
  return {fetchImpl, puts}
}

test("splits a registry host from its repository", () => {
  assert.deepEqual(parseImageReference(IMAGE), {
    registry: "ghcr.io",
    repository: "mentra-community/mentra-cloud",
  })
  assert.throws(() => parseImageReference("mentra-cloud"), /fully qualified/)
  assert.throws(() => parseImageReference(`${IMAGE}:3.2.0`), /tag or digest/)
})

test("reads the tag out of a fully qualified reference", () => {
  assert.equal(tagName(`${IMAGE}:3.2.0-dev.148`), "3.2.0-dev.148")
  assert.equal(tagName(`${IMAGE}:45fea8f1b4e1d5e96a4a3458777d66e87d08e9a0`), "45fea8f1b4e1d5e96a4a3458777d66e87d08e9a0")
  assert.throws(() => tagName(IMAGE), /not tagged/)
})

test("republishes the exact manifest bytes so every tag keeps the built digest", async () => {
  const {fetchImpl, puts} = registry()
  const result = await publishRegistryTags({
    image: IMAGE,
    digest: DIGEST,
    tags: [`${IMAGE}:3.2.0-dev.148`, `${IMAGE}:45fea8f1b4e1d5e96a4a3458777d66e87d08e9a0`],
    username: "actor",
    password: "token",
    fetchImpl,
  })

  assert.deepEqual(result, {
    digest: DIGEST,
    tags: ["3.2.0-dev.148", "45fea8f1b4e1d5e96a4a3458777d66e87d08e9a0"],
  })
  assert.equal(puts.length, 2)
  for (const put of puts) {
    assert.equal(put.contentType, MEDIA_TYPE)
    assert.equal(manifestDigest(put.body), DIGEST)
  }
  assert.ok(puts[0].url.endsWith("/v2/mentra-community/mentra-cloud/manifests/3.2.0-dev.148"))
})

test("refuses to publish when the registry hands back different bytes", async () => {
  const {fetchImpl, puts} = registry({manifest: Buffer.from('{"schemaVersion":2}')})
  await assert.rejects(
    publishRegistryTags({
      image: IMAGE,
      digest: DIGEST,
      tags: [`${IMAGE}:3.2.0-dev.148`],
      username: "actor",
      password: "token",
      fetchImpl,
    }),
    /Registry returned sha256:/,
  )
  assert.equal(puts.length, 0)
})

test("rejects a manifest media type the release does not publish", async () => {
  const {fetchImpl} = registry({contentType: "application/json"})
  await assert.rejects(
    publishRegistryTags({
      image: IMAGE,
      digest: DIGEST,
      tags: [`${IMAGE}:3.2.0-dev.148`],
      username: "actor",
      password: "token",
      fetchImpl,
    }),
    /Unexpected manifest media type/,
  )
})

test("requires a digest and at least one tag", async () => {
  const {fetchImpl} = registry()
  await assert.rejects(
    publishRegistryTags({image: IMAGE, digest: "3.2.0", tags: [`${IMAGE}:x`], fetchImpl}),
    /Invalid digest/,
  )
  await assert.rejects(publishRegistryTags({image: IMAGE, digest: DIGEST, tags: [], fetchImpl}), /At least one tag/)
})
