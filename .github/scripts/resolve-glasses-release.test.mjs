import assert from "node:assert/strict"
import test from "node:test"

import {releaseRecordSha256, serializeReleaseRecord} from "./release-family.mjs"
import {
  compareReleaseIdentities,
  GlassesReleaseError,
  resolveGlassesRelease,
} from "./resolve-glasses-release.mjs"

const COMMIT = "a".repeat(40)
const OTHER_COMMIT = "b".repeat(40)
const SHA = "c".repeat(64)
const BETA_SHA = "d".repeat(64)

function release(tag, fields = {}) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    published_at: "2026-10-01T00:00:00Z",
    target_commitish: "dev",
    ...fields,
  }
}

function asset(container, name, digest = SHA) {
  const url = `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/${container}/${name}`
  return {name, url, digest: `sha256:${digest}`, state: "uploaded", size: 10}
}

function planFor(identity, channel, container, extra = {}) {
  const plan = {
    schemaVersion: 1,
    releaseIdentity: identity,
    channel,
    releaseSetId: `mentra-${identity}`,
    artifactContainerTag: container,
    sourceCommit: COMMIT,
    artifactNames: {
      releasePlan: `mentra-release-plan-${identity}.json`,
      releaseManifest: `mentra-release-${identity}.json`,
      otaManifest: `mentra-live-ota-${identity}.json`,
    },
    ...extra,
  }
  return plan
}

function recordFor(plan, ota, extra = {}) {
  return {
    schemaVersion: 1,
    releaseIdentity: plan.releaseIdentity,
    channel: plan.channel,
    releaseSetId: plan.releaseSetId,
    sourceCommit: plan.sourceCommit,
    releasePlanSha256: releaseRecordSha256(plan),
    otaManifest: ota,
    ...extra,
  }
}

function storeFrom(documents) {
  const byUrl = new Map()
  for (const [url, value] of documents) byUrl.set(url, serializeReleaseRecord(value))
  return {
    async fetchImpl(url) {
      const body = byUrl.get(url)
      if (!body) return {ok: false, status: 404, async text() { return "" }}
      return {ok: true, status: 200, async text() { return body }}
    },
  }
}

function indexOf(container, names) {
  return {schemaVersion: 1, repository: "Mentra-Community/MentraOS", tag: container, assets: names}
}

const liveList = [
  release("mentra-v3.2.1", {draft: true, published_at: null}),
  release("mentra-v3.1.1", {draft: true, published_at: null}),
  release("mentra-v3.1.0", {draft: true, published_at: null}),
  release("mentra-v3.3.0-dev.864", {prerelease: true, published_at: "2026-10-12T00:00:00Z"}),
  release("mentra-private-cloud-2026-10-01", {prerelease: true}),
  release("mentra-builds-v3.3.0", {prerelease: true}),
]

test("a published stable release beats a newer dev prerelease, a draft, and Private Cloud", async () => {
  const identity = "3.2.1"
  const container = "mentra-v3.2.1"
  const beta = "3.2.1-beta.522"
  const otaUrl = "https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/mentra-builds-v3.2.1/mentra-live-ota-3.2.1-beta.522.json"
  const promotion = {
    selectedBetaIdentity: beta,
    selectedBetaReleaseSetId: `mentra-${beta}`,
    selectedBetaManifest: {url: `https://example.com/mentra-release-${beta}.json`, sha256: BETA_SHA},
  }
  const plan = planFor(identity, "production", container, {promotion})
  const ota = {status: "promoted", coordinate: `mentra-live-ota-${beta}.json`, url: otaUrl, sha256: SHA}
  const record = recordFor(plan, ota, {promotion})
  const planUrl = `https://cdn.example/${container}/plan.json`
  const recordUrl = `https://cdn.example/${container}/record.json`
  const documents = storeFrom([[planUrl, plan], [recordUrl, record]])
  const index = indexOf(container, [
    {...asset(container, `mentra-release-plan-${identity}.json`), url: planUrl},
    {...asset(container, `mentra-release-${identity}.json`), url: recordUrl},
  ])
  const pin = await resolveGlassesRelease({
    track: "production",
    complete: true,
    releases: [
      ...liveList,
      release(container, {published_at: "2026-10-02T00:00:00Z", target_commitish: COMMIT}),
      release("mentra-v9.9.9-dev.1", {prerelease: true, published_at: "2026-10-13T00:00:00Z"}),
    ],
    fetchImpl: documents.fetchImpl,
    readIndex: async () => index,
  })
  assert.equal(pin.releaseIdentity, identity)
  assert.equal(pin.otaUrl, otaUrl)
  assert.equal(pin.selectedBetaIdentity, beta)
  assert.equal(pin.track, "production")
})

test("the current live release list has no published production set", async () => {
  await assert.rejects(
    resolveGlassesRelease({track: "production", releases: liveList, complete: true, readIndex: async () => indexOf("unused", [])}),
    (error) => error instanceof GlassesReleaseError && error.exitCode === 10,
  )
})

test("a truncated release page is rejected", async () => {
  await assert.rejects(
    resolveGlassesRelease({track: "production", releases: liveList, complete: false}),
    /truncated/,
  )
})

test("staging selects the greatest complete beta triplet and ignores an OTA-only blob", async () => {
  const older = "3.2.1-beta.999"
  const newer = "3.3.0-beta.1"
  const dev = "3.3.0-dev.900"
  const oldContainer = "mentra-builds-v3.2.1"
  const newContainer = "mentra-builds-v3.3.0"
  const plan = planFor(newer, "beta", newContainer)
  const otaUrl = `https://artifactscdn.mentraglass.com/Mentra-Community/MentraOS/releases/${newContainer}/mentra-live-ota-${newer}.json`
  const ota = {status: "published", coordinate: `mentra-live-ota-${newer}.json`, url: otaUrl, sha256: SHA}
  const record = recordFor(plan, ota)
  const planUrl = "https://cdn.example/new-plan.json"
  const recordUrl = "https://cdn.example/new-record.json"
  const documents = storeFrom([[planUrl, plan], [recordUrl, record]])
  const indexes = new Map([
    [oldContainer, indexOf(oldContainer, [
      asset(oldContainer, `mentra-release-plan-${older}.json`),
      asset(oldContainer, `mentra-release-${older}.json`),
      asset(oldContainer, `mentra-live-ota-${older}.json`),
      asset(oldContainer, "mentra-live-ota-3.2.1-beta.1000.json"),
    ])],
    [newContainer, indexOf(newContainer, [
      {...asset(newContainer, `mentra-release-plan-${newer}.json`), url: planUrl},
      {...asset(newContainer, `mentra-release-${newer}.json`), url: recordUrl},
      {...asset(newContainer, `mentra-live-ota-${newer}.json`, SHA), url: otaUrl},
      asset(newContainer, `mentra-release-plan-${dev}.json`),
      asset(newContainer, `mentra-live-ota-${dev}.json`),
    ])],
  ])
  const pin = await resolveGlassesRelease({
    track: "staging",
    complete: true,
    releases: [release(oldContainer, {prerelease: true}), release(newContainer, {prerelease: true})],
    fetchImpl: documents.fetchImpl,
    readIndex: async (_repository, tag) => indexes.get(tag),
  })
  assert.equal(pin.releaseIdentity, newer)
  assert.equal(pin.channel, "beta")
  assert.equal(pin.otaUrl, otaUrl)
  assert.equal(compareReleaseIdentities(newer, older) > 0, true)
})

test("a missing beta page is allowed and a mismatched page commit is not", async () => {
  const identity = "3.3.0-dev.4"
  const container = "mentra-builds-v3.3.0"
  const plan = planFor(identity, "dev", container)
  const otaUrl = `https://cdn.example/mentra-live-ota-${identity}.json`
  const record = recordFor(plan, {status: "published", coordinate: `mentra-live-ota-${identity}.json`, url: otaUrl, sha256: SHA})
  const planUrl = "https://cdn.example/dev-plan.json"
  const recordUrl = "https://cdn.example/dev-record.json"
  const documents = storeFrom([[planUrl, plan], [recordUrl, record]])
  const index = indexOf(container, [
    {...asset(container, `mentra-release-plan-${identity}.json`), url: planUrl},
    {...asset(container, `mentra-release-${identity}.json`), url: recordUrl},
    {...asset(container, `mentra-live-ota-${identity}.json`), url: otaUrl},
  ])
  const pin = await resolveGlassesRelease({
    track: "dev",
    complete: true,
    releases: [release(container, {prerelease: true})],
    fetchImpl: documents.fetchImpl,
    readIndex: async () => index,
  })
  assert.equal(pin.releaseIdentity, identity)
  await assert.rejects(
    resolveGlassesRelease({
      track: "dev",
      complete: true,
      releases: [release(container, {prerelease: true}), release(`mentra-v${identity}`, {prerelease: true, target_commitish: OTHER_COMMIT})],
      fetchImpl: documents.fetchImpl,
      readIndex: async () => index,
    }),
    /records commit/,
  )
})

test("a mismatched plan channel, release-set id, or digest is rejected", async () => {
  const identity = "3.3.0-beta.2"
  const container = "mentra-builds-v3.3.0"
  const plan = planFor(identity, "dev", container)
  const otaUrl = "https://cdn.example/ota.json"
  const record = recordFor(plan, {status: "published", coordinate: `mentra-live-ota-${identity}.json`, url: otaUrl, sha256: SHA})
  record.channel = "beta"
  const planUrl = "https://cdn.example/bad-plan.json"
  const recordUrl = "https://cdn.example/bad-record.json"
  const documents = storeFrom([[planUrl, plan], [recordUrl, record]])
  const index = indexOf(container, [
    {...asset(container, `mentra-release-plan-${identity}.json`), url: planUrl},
    {...asset(container, `mentra-release-${identity}.json`), url: recordUrl},
    {...asset(container, `mentra-live-ota-${identity}.json`), url: otaUrl},
  ])
  await assert.rejects(
    resolveGlassesRelease({
      track: "staging",
      complete: true,
      releases: [release(container)],
      fetchImpl: documents.fetchImpl,
      readIndex: async () => index,
    }),
    (error) => error.exitCode === 12 || /does not/.test(error.message),
  )
})

test("an index failure other than a missing container stops the run", async () => {
  await assert.rejects(
    resolveGlassesRelease({
      track: "dev",
      complete: true,
      releases: [release("mentra-builds-v3.3.0")],
      readIndex: async () => { throw new Error("HTTP 500") },
    }),
    /HTTP 500/,
  )
})

test("authentication, rate limit, and short downloads fail before a pin is returned", async () => {
  const identity = "3.1.0"
  const container = "mentra-v3.1.0"
  const planUrl = "https://cdn.example/plan.json"
  const recordUrl = "https://cdn.example/record.json"
  const index = indexOf(container, [
    {...asset(container, `mentra-release-plan-${identity}.json`), url: planUrl},
    {...asset(container, `mentra-release-${identity}.json`), url: recordUrl},
  ])
  const releases = [release(container, {published_at: "2026-01-01T00:00:00Z"})]
  for (const status of [401, 429]) {
    await assert.rejects(
      resolveGlassesRelease({
        track: "production",
        complete: true,
        releases,
        readIndex: async () => index,
        fetchImpl: async () => ({ok: false, status, async text() { return "" }}),
      }),
      (error) => error.exitCode === 1,
    )
  }
  await assert.rejects(
    resolveGlassesRelease({
      track: "production",
      complete: true,
      releases,
      readIndex: async () => index,
      fetchImpl: async () => ({ok: true, status: 200, async text() { return "{" }}),
    }),
    (error) => error.exitCode === 12,
  )
})
