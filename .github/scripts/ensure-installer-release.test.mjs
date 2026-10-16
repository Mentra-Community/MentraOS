import assert from "node:assert/strict"
import test from "node:test"

import {ensureInstallerRelease} from "./ensure-installer-release.mjs"

const coordinates = {repository: "owner/repo", tag: "mentra-private-cloud-3.3.0-dev.941", sourceCommit: "a".repeat(40)}
const release = {id: 42, tag_name: coordinates.tag, target_commitish: coordinates.sourceCommit, draft: false, prerelease: true}
const failure = (status, properties = {}) => Object.assign(new Error("API failed"), {status, ...properties})
function fixture(responses) {
  const calls = [], delays = [], logs = []
  return {
    args: {
      ...coordinates,
      api: async (route, options = {}) => {
        calls.push({route, ...options})
        const response = responses.shift()
        assert.notEqual(response, undefined, "unexpected API request")
        if (response instanceof Error) throw response
        return response
      },
      wait: async (delay) => delays.push(delay),
      log: (message) => logs.push(message),
    },
    calls, delays, logs,
  }
}

test("reuses a matching immutable release without creating or editing it", async () => {
  const f = fixture([release])
  assert.deepEqual(await ensureInstallerRelease(f.args), release)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].route, `repos/owner/repo/releases/tags/${coordinates.tag}`)
})

test("creates only after an explicit 404 and preserves source, title and public prerelease", async () => {
  const f = fixture([failure(404), release])
  assert.equal((await ensureInstallerRelease(f.args)).id, 42)
  assert.equal(f.calls[1].method, "POST")
  assert.deepEqual(f.calls[1].data, {
    tag_name: coordinates.tag,
    target_commitish: coordinates.sourceCommit,
    name: "Mentra Private Cloud 3.3.0-dev.941",
    body: "Versioned Azure installer, checksum and publication evidence. Obtain the private IT guide and approved image access from Mentra before deployment.",
    draft: false,
    prerelease: true,
    make_latest: "false",
  })
})

test("reconciles a committed release after the POST returns 500 without a second create", async () => {
  const f = fixture([failure(404), failure(500), release])
  assert.deepEqual(await ensureInstallerRelease(f.args), release)
  assert.deepEqual(f.delays, [5000])
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 1)
})

test("retries the same absent tag after a transient create failure", async () => {
  const f = fixture([failure(404), failure(500), failure(404), release])
  assert.deepEqual(await ensureInstallerRelease(f.args), release)
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 2)
  assert.deepEqual(f.calls[1].data, f.calls[3].data)
})

test("never treats a transient lookup error as absence", async () => {
  const f = fixture([failure(503), release])
  assert.deepEqual(await ensureInstallerRelease(f.args), release)
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 0)
})

test("honors the POST cooldown before making the reconciliation lookup", async () => {
  const f = fixture([failure(404), failure(429, {retryAfterMs: 12000}), release])
  let waited = false
  const api = f.args.api
  f.args.api = async (...args) => {
    if (f.calls.length === 2) assert.equal(waited, true)
    return api(...args)
  }
  f.args.wait = async (delay) => {
    assert.equal(delay, 12000)
    waited = true
  }
  await ensureInstallerRelease(f.args)
})

test("does not violate an over-budget cooldown", async () => {
  const f = fixture([failure(404), failure(429, {retryAfterMs: 300000})])
  await assert.rejects(ensureInstallerRelease(f.args), (error) => error.status === 429)
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.delays, [])
})

test("recovers a concurrent tag conflict only when the existing release matches", async () => {
  const f = fixture([failure(404), failure(422), release])
  assert.deepEqual(await ensureInstallerRelease(f.args), release)
  assert.deepEqual(f.delays, [])
  const absent = fixture([failure(404), failure(422), failure(404)])
  await assert.rejects(ensureInstallerRelease(absent.args), (error) => error.status === 422)
  assert.deepEqual(absent.delays, [])
})

test("reconciles a committed last attempt before declaring failure", async () => {
  const f = fixture([failure(404), failure(500), failure(404), failure(500), failure(404), failure(500), release])
  assert.deepEqual(await ensureInstallerRelease(f.args), release)
  assert.deepEqual(f.delays, [5000, 10000, 20000])
  assert.equal(f.calls.filter((call) => call.method === "POST").length, 3)
})

test("bounds attempts and preserves the failure if no release was committed", async () => {
  const f = fixture([failure(404), failure(500), failure(404), failure(500), failure(404), failure(500), failure(404)])
  await assert.rejects(ensureInstallerRelease(f.args), (error) => error.status === 500)
  assert.equal(f.calls.length, 7)
  assert.deepEqual(f.delays, [5000, 10000, 20000])
})

for (const status of [400, 401, 403]) {
  test(`fails immediately on permanent lookup HTTP ${status}`, async () => {
    const f = fixture([failure(status)])
    await assert.rejects(ensureInstallerRelease(f.args), (error) => error.status === status)
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.delays, [])
  })
  test(`fails immediately on permanent creation HTTP ${status}`, async () => {
    const f = fixture([failure(404), failure(status)])
    await assert.rejects(ensureInstallerRelease(f.args), (error) => error.status === status)
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.delays, [])
  })
}

for (const mismatch of [{target_commitish: "b".repeat(40)}, {tag_name: "another-tag"}, {draft: true}, {prerelease: false}, {id: "42"}]) {
  test(`refuses an existing mismatched release (${Object.keys(mismatch)[0]}) without modification`, async () => {
    const f = fixture([{...release, ...mismatch}])
    await assert.rejects(ensureInstallerRelease(f.args))
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.delays, [])
  })
}

test("transport errors reconcile the same tag and never echo raw request data", async () => {
  const f = fixture([failure(404), failure(undefined, {code: "ECONNRESET", message: "Bearer private-token https://private/?secret=value"}), release])
  await ensureInstallerRelease(f.args)
  assert.equal(f.logs.length, 1)
  assert.doesNotMatch(f.logs[0], /Bearer|private-token|secret=value|https:/)
})

test("invalid coordinates never reach GitHub", async () => {
  const f = fixture([])
  for (const invalid of [{repository: "../repo"}, {sourceCommit: "dev"}, {tag: "mentra-private-cloud-3.3.0-dev.0"}]) {
    await assert.rejects(ensureInstallerRelease({...f.args, ...invalid}))
  }
  assert.deepEqual(f.calls, [])
})
