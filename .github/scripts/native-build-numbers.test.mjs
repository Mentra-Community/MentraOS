import assert from "node:assert/strict"
import test from "node:test"

import {
  nativeBuildPrefix,
  playReleaseStatus,
  productionBuildFloor,
  reserveNativeBuilds,
} from "./native-build-numbers.mjs"
import {reserveOnGitHub} from "./reserve-native-builds.mjs"

const empty = () => ({schemaVersion: 1, reservations: []})
const request = (overrides = {}) => ({
  key: "coordinated:222",
  baseVersion: "3.2.0",
  sourceCommit: "a".repeat(40),
  minimumSequence: 222,
  ...overrides,
})

test("3.2.0 build 222 is 320000222, with collision-free bounded family fields", () => {
  assert.equal(reserveNativeBuilds(empty(), request()).reservation.buildNumbers[0], 320000222)
  assert.equal(nativeBuildPrefix("3.1.0"), 310000000)
  assert.equal(nativeBuildPrefix("3.2.1"), 321000000)
  assert.equal(
    reserveNativeBuilds(empty(), request({baseVersion: "20.9.9", minimumSequence: 999999})).reservation.buildNumbers[0],
    2099999999,
  )
  for (const baseVersion of ["3.10.0", "3.2.10", "21.0.0", "3.2.0-beta.1", "03.2.0", "3.2", "0.1.0"]) {
    assert.throws(() => nativeBuildPrefix(baseVersion))
  }
  for (const minimumSequence of [0, -1, 1.2, 1000000, NaN]) {
    assert.throws(() => reserveNativeBuilds(empty(), request({minimumSequence})))
  }
})

test("dev, production and staging reserve distinct numbers and retries preserve the original allocation", () => {
  const dev = reserveNativeBuilds(empty(), request())
  const production = reserveNativeBuilds(dev.state, request({key: "production:3.2.0:1", count: 2}))
  assert.deepEqual(production.reservation.buildNumbers, [320000223, 320000224])
  const staging = reserveNativeBuilds(production.state, request({key: "coordinated:223", minimumSequence: 223}))
  assert.deepEqual(staging.reservation.buildNumbers, [320000225])
  assert.deepEqual(
    reserveNativeBuilds(staging.state, request({minimumBuildNumber: 320000999})).reservation,
    dev.reservation,
  )
  assert.throws(() => reserveNativeBuilds(staging.state, request({sourceCommit: "b".repeat(40)})), /Retry changed/)
  assert.throws(() => reserveNativeBuilds(staging.state, request({count: 2})), /Retry changed/)
})

test("store floors and reserved pairs cannot overflow the selected family", () => {
  assert.deepEqual(
    reserveNativeBuilds(empty(), request({minimumBuildNumber: 320000500, count: 2})).reservation.buildNumbers,
    [320000501, 320000502],
  )
  assert.throws(() => reserveNativeBuilds(empty(), request({minimumBuildNumber: 900000002})), /refusing to jump/)
  assert.throws(() => reserveNativeBuilds(empty(), request({minimumSequence: 999999, count: 2})), /refusing to jump/)
})

test("corrupt or duplicate ledger reservations fail closed", () => {
  const entry = reserveNativeBuilds(empty(), request()).reservation
  assert.throws(
    () => reserveNativeBuilds({schemaVersion: 1, reservations: [entry, entry]}, request()),
    /Duplicate reservation/,
  )
  assert.throws(
    () => reserveNativeBuilds({schemaVersion: 1, reservations: [entry, {...entry, key: "other"}]}, request()),
    /Duplicate native/,
  )
  assert.throws(
    () => reserveNativeBuilds({schemaVersion: 1, reservations: [{...entry, buildNumbers: [310000222]}]}, request()),
    /does not belong/,
  )
  assert.throws(
    () => reserveNativeBuilds({schemaVersion: 2, reservations: []}, request()),
    /Invalid native build ledger/,
  )
})

const inventory = () => ({
  apple: {maxBuildNumber: 900000002, maxBuildNumbersByMarketingVersion: {"3.2.0": 320000222}},
  google: {
    currentVersionCode: 50572796,
    maxVersionCode: 900000002,
    tracks: {
      "internal": [900000002],
      "dev": [320000220],
      "beta": [310000212],
      "production-candidates": [],
      "production": [50572796],
    },
  },
})

test("production follows its delivery tracks and iOS version instead of retired codes or a newer dev family", () => {
  const data = inventory()
  data.google.tracks.dev = [330000001]
  const floor = (value) => productionBuildFloor({inventory: value, betaBuildNumber: 320000221, baseVersion: "3.2.0"})
  assert.equal(floor(data), 320000222)
  const candidates = inventory()
  candidates.google.tracks["production-candidates"] = [900000003]
  assert.equal(floor(candidates), 900000003)
  const missing = inventory()
  delete missing.google.tracks["production-candidates"]
  assert.throws(() => floor(missing), /Missing Google Play inventory/)
  assert.throws(() => floor({...data, apple: {maxBuildNumber: 900000002}}), /Missing numeric Apple inventory/)
})

test("Play preflight rejects downgrades and unowned duplicate codes, but permits an immutable retry", () => {
  assert.equal(playReleaseStatus({versionCode: 320000222, existingCodes: [310000217]}), "new")
  assert.equal(playReleaseStatus({versionCode: 320000222, existingCodes: []}), "new")
  assert.throws(() => playReleaseStatus({versionCode: 320000222, existingCodes: [900000002]}), /downgrade/)
  assert.throws(() => playReleaseStatus({versionCode: 320000222, existingCodes: [320000222]}), /immutable artifacts/)
  assert.equal(
    playReleaseStatus({versionCode: 320000222, existingCodes: ["320000222"], immutableArtifactsExist: true}),
    "exists",
  )
  for (const versionCode of [NaN, 0, -1, 2.5, 2100000001])
    assert.throws(() => playReleaseStatus({versionCode, existingCodes: []}))
})

// Model GitHub's actual non-fast-forward restriction. Concurrent writers may
// prepare commits together, but only a child of the current head can win.
function github() {
  let head = null,
    serial = 0,
    conflicts = 0,
    loseResponse = false
  const objects = new Map()
  const calls = []
  const response = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body})
  const save = (value) => {
    const sha = String(++serial).padStart(40, "0")
    objects.set(sha, {...value, sha})
    return objects.get(sha)
  }
  async function fetchImpl(url, options) {
    const endpoint = url.split("/repos/Mentra/Test/")[1]
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({endpoint, method: options.method, body})
    if (endpoint === "git/ref/heads/mentra-native-build-ledger")
      return head ? response({object: {sha: head}}) : response({}, 404)
    if (options.method === "GET") return response(objects.get(endpoint.split("/").at(-1)))
    if (endpoint === "git/trees") {
      const blob = save({content: Buffer.from(body.tree[0].content).toString("base64")})
      return response(save({tree: [{path: "native-builds.json", type: "blob", sha: blob.sha}]}))
    }
    if (endpoint === "git/commits") return response(save({...body, tree: {sha: body.tree}}))
    if (endpoint === "git/refs" || endpoint === "git/refs/heads/mentra-native-build-ledger") {
      assert.notEqual(body.force, true)
      const commit = objects.get(body.sha)
      if ((endpoint === "git/refs" && head) || (head && !commit.parents.includes(head))) {
        conflicts++
        return response({}, 422)
      }
      head = body.sha
      if (loseResponse) {
        loseResponse = false
        throw new Error("connection lost after server committed")
      }
      return response({object: {sha: head}})
    }
    throw new Error(`Unexpected API call ${endpoint}`)
  }
  return {
    fetchImpl,
    calls,
    loseNextResponse: () => {
      loseResponse = true
    },
    conflicts: () => conflicts,
  }
}
const remoteRequest = (server, override = {}) => ({
  repository: "Mentra/Test",
  token: "test-only",
  fetchImpl: server.fetchImpl,
  request: request(),
  ...override,
})

test("concurrent workflow allocations retry a rejected ref update without duplicating codes", async () => {
  const server = github()
  const first = await Promise.all([
    reserveOnGitHub(remoteRequest(server)),
    reserveOnGitHub(remoteRequest(server, {request: request({key: "production:3.2.0:1", count: 2})})),
  ])
  assert.equal(new Set(first.flatMap((r) => r.buildNumbers)).size, 3)
  assert.ok(server.conflicts() > 0)
  const later = await Promise.all([
    reserveOnGitHub(remoteRequest(server, {request: request({key: "coordinated:224"})})),
    reserveOnGitHub(remoteRequest(server, {request: request({key: "coordinated:225"})})),
  ])
  assert.equal(new Set([...first, ...later].flatMap((r) => r.buildNumbers)).size, 5)
  assert.ok(server.calls.some((c) => c.method === "PATCH" && c.body.force === false))
})

test("a lost reservation response is recovered by the next retry with the same key", async () => {
  const server = github()
  server.loseNextResponse()
  await assert.rejects(reserveOnGitHub(remoteRequest(server)), /connection lost/)
  const retry = await reserveOnGitHub(remoteRequest(server))
  assert.deepEqual(retry.buildNumbers, [320000222])
  const writes = server.calls.filter((call) => call.method !== "GET").length
  await reserveOnGitHub(remoteRequest(server))
  assert.equal(server.calls.filter((call) => call.method !== "GET").length, writes)
})

test("dry-run reads existing reservations but makes no ledger writes", async () => {
  const server = github()
  await reserveOnGitHub(remoteRequest(server, {dryRun: true}))
  assert.ok(server.calls.every((call) => call.method === "GET"))
})

test("CLI release plan carries the reservation into the environment used by both native platforms", async () => {
  const {mkdtempSync, readFileSync, writeFileSync, rmSync} = await import("node:fs")
  const {tmpdir} = await import("node:os")
  const {execFileSync} = await import("node:child_process")
  const {prepareMobileReleaseEnvironment} = await import("./prepare-mobile-release-env.mjs")
  const {loadReleaseFamily} = await import("./release-family.mjs")
  const family = loadReleaseFamily()
  const dir = mkdtempSync(`${tmpdir()}/mentra-native-plan-`)
  try {
    const reservation = reserveNativeBuilds(empty(), request({baseVersion: family.familyBaseVersion})).reservation
    writeFileSync(`${dir}/reservation.json`, JSON.stringify(reservation))
    execFileSync(process.execPath, [
      ".github/scripts/create-release-plan.mjs",
      "--branch",
      "dev",
      "--sequence",
      "222",
      "--source-commit",
      request().sourceCommit,
      "--native-reservation",
      `${dir}/reservation.json`,
      "--output",
      `${dir}/plan.json`,
    ])
    const plan = JSON.parse(readFileSync(`${dir}/plan.json`, "utf8"))
    assert.deepEqual(plan.native.reservation, reservation)
    assert.equal(plan.native.googlePlayTrack, "dev")
    assert.equal(plan.native.buildNumber, nativeBuildPrefix(family.familyBaseVersion) + 222)
    const env = prepareMobileReleaseEnvironment({
      plan,
      template: "EXPO_PUBLIC_MENTRAOS_VERSION=0.0.0\n",
      backendEnvironment: "dev",
      otaManifestUrl: "https://example.com/ota.json",
      publicValues: {},
    })
    assert.ok(env.includes(`MENTRAOS_NATIVE_MARKETING_VERSION=${family.familyBaseVersion}\n`))
    assert.ok(env.includes(`MENTRAOS_PINNED_BUILD_NUMBER=${plan.native.buildNumber}\n`))
    assert.ok(env.includes(`EXPO_PUBLIC_MENTRAOS_VERSION=${family.familyBaseVersion}-dev.222\n`))
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
})
