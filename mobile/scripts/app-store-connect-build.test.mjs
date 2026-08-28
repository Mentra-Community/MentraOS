import assert from "node:assert/strict"
import {generateKeyPairSync} from "node:crypto"
import test from "node:test"

import {
  assignBuildToGroup,
  collectPaginatedData,
  createAppStoreConnectClient,
  findApp,
  findProcessedBuild,
  productionSubmissionStatus,
  setBetaBuildWhatsNew,
  uploadExactBuild,
  waitForProductionSubmission,
  waitForProcessedBuild,
} from "./app-store-connect-build.mjs"

const TEST_PRIVATE_KEY = generateKeyPairSync("ec", {namedCurve: "P-256"}).privateKey.export({
  format: "pem",
  type: "pkcs8",
})

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? "" : JSON.stringify(body)
    },
  }
}

function client(responses) {
  const calls = []
  return {
    calls,
    async request(resource, options = {}) {
      calls.push({resource, options})
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next
    },
  }
}

test("retries transient failures for App Store Connect read requests", async () => {
  const timeout = new TypeError("fetch failed")
  timeout.cause = {code: "UND_ERR_CONNECT_TIMEOUT"}
  const responses = [timeout, response(200, {data: {id: "app-1", attributes: {bundleId: "com.mentra.example"}}})]
  const delays = []
  const api = createAppStoreConnectClient({
    issuerId: "issuer",
    keyId: "key",
    privateKey: TEST_PRIVATE_KEY,
    delay: 25,
    sleep: async (duration) => delays.push(duration),
    fetchImpl: async () => {
      const next = responses.shift()
      if (next instanceof Error) throw next
      return next
    },
  })

  const app = await findApp(api, "com.mentra.example", "app-1")
  assert.equal(app.id, "app-1")
  assert.deepEqual(delays, [25])
})

test("does not retry permanent App Store Connect request failures", async () => {
  let requests = 0
  const api = createAppStoreConnectClient({
    issuerId: "issuer",
    keyId: "key",
    privateKey: TEST_PRIVATE_KEY,
    delay: 0,
    sleep: async () => {},
    fetchImpl: async () => {
      requests += 1
      return response(400, {errors: [{detail: "bad request"}]})
    },
  })

  await assert.rejects(() => findApp(api, "com.mentra.example", "app-1"), /failed with HTTP 400/)
  assert.equal(requests, 1)
})

test("does not replay a mutating request after a transient failure", async () => {
  let requests = 0
  const api = createAppStoreConnectClient({
    issuerId: "issuer",
    keyId: "key",
    privateKey: TEST_PRIVATE_KEY,
    delay: 0,
    sleep: async () => {},
    fetchImpl: async () => {
      requests += 1
      throw new TypeError("fetch failed")
    },
  })

  await assert.rejects(() => api.request("/v1/betaGroups", {method: "POST"}), /fetch failed/)
  assert.equal(requests, 1)
})

test("resolves an App Store app by its authoritative numeric ID", async () => {
  const api = client([{data: {id: "6792839366", attributes: {bundleId: "com.mentra.example"}}}])
  const app = await findApp(api, "com.mentra.example", "6792839366")
  assert.equal(app.id, "6792839366")
  assert.equal(api.calls[0].resource, "/v1/apps/6792839366")
})

test("rejects an App Store app whose numeric ID belongs to another bundle", async () => {
  const api = client([{data: {id: "6792839366", attributes: {bundleId: "com.mentra.other"}}}])
  await assert.rejects(
    () => findApp(api, "com.mentra.example", "6792839366"),
    /has bundle ID com\.mentra\.other, expected com\.mentra\.example/,
  )
})

test("waits for an uploaded build to finish processing", async () => {
  const api = client([
    {data: []},
    {data: [{id: "upload-1", attributes: {state: {state: "PROCESSING"}}}]},
    {data: [{id: "build-1", attributes: {processingState: "PROCESSING"}}]},
    {data: [{id: "upload-1", attributes: {state: {state: "COMPLETE"}}}]},
    {data: [{id: "build-1", attributes: {processingState: "PROCESSING"}}]},
    {data: [{id: "upload-1", attributes: {state: {state: "COMPLETE"}}}]},
    {data: [{id: "build-1", attributes: {processingState: "VALID"}}]},
  ])
  const build = await waitForProcessedBuild(api, {appId: "app-1", buildNumber: 310000057, attempts: 4, delay: 0})
  assert.equal(build.id, "build-1")
  assert.match(api.calls[0].resource, /filter%5Bversion%5D=310000057/)
})

test("can scope an exact build number to its marketing version", async () => {
  const api = client([{data: [{id: "build-1", attributes: {processingState: "VALID"}}]}])
  await waitForProcessedBuild(api, {
    appId: "app-1",
    buildNumber: 310000057,
    marketingVersion: "3.1.0",
    attempts: 1,
  })
  assert.match(api.calls[0].resource, /filter%5BpreReleaseVersion.version%5D=3.1.0/)
})

test("fails when App Store Connect marks a build invalid", async () => {
  const api = client([{data: [{id: "build-1", attributes: {processingState: "FAILED"}}]}])
  await assert.rejects(() => findProcessedBuild(api, {appId: "app-1", buildNumber: 12}), /is FAILED/)
})

test("reconciles an upload accepted before a transient transport failure", async () => {
  const api = client([
    {data: []},
    {data: []},
    {data: []},
    {data: [{id: "upload-1", attributes: {state: {state: "PROCESSING"}}}]},
  ])
  let uploads = 0
  const result = await uploadExactBuild(api, {
    appId: "app-1",
    buildNumber: 310000047,
    marketingVersion: "3.1.0",
    attempts: 2,
    delay: 0,
    sleep: async () => {},
    upload: async () => {
      uploads += 1
      throw new Error("HTTP 504")
    },
  })
  assert.equal(result.reused, true)
  assert.equal(result.upload.id, "upload-1")
  assert.equal(uploads, 1)
})

test("retries a failed upload only while the exact build remains absent", async () => {
  const api = client([{data: []}, {data: []}, {data: []}, {data: []}])
  let uploads = 0
  const result = await uploadExactBuild(api, {
    appId: "app-1",
    buildNumber: 310000047,
    attempts: 2,
    delay: 0,
    sleep: async () => {},
    upload: async () => {
      uploads += 1
      if (uploads === 1) throw new Error("HTTP 504")
    },
  })
  assert.equal(result.reused, false)
  assert.equal(uploads, 2)
})

test("does not upload over an exact build upload that is still processing", async () => {
  const api = client([{data: []}, {data: [{id: "upload-1", attributes: {state: {state: "PROCESSING"}}}]}])
  let uploads = 0
  const result = await uploadExactBuild(api, {
    appId: "app-1",
    buildNumber: 310000047,
    marketingVersion: "3.1.0",
    upload: async () => {
      uploads += 1
    },
  })
  assert.equal(result.reused, true)
  assert.equal(result.upload.id, "upload-1")
  assert.equal(uploads, 0)
  assert.match(api.calls[1].resource, /filter%5BcfBundleShortVersionString%5D=3.1.0/)
  assert.match(api.calls[1].resource, /sort=-uploadedDate/)
})

test("does not treat an awaiting upload placeholder as a delivered build", async () => {
  const api = client([
    {data: []},
    {data: [{id: "upload-1", attributes: {state: {state: "AWAITING_UPLOAD"}}}]},
    {data: []},
    {data: [{id: "upload-1", attributes: {state: {state: "AWAITING_UPLOAD"}}}]},
  ])
  let uploads = 0
  await assert.rejects(
    () =>
      uploadExactBuild(api, {
        appId: "app-1",
        buildNumber: 310000047,
        attempts: 1,
        upload: async () => {
          uploads += 1
          throw new Error("Upload limit reached (90382)")
        },
      }),
    /Upload limit reached \(90382\)/,
  )
  assert.equal(uploads, 1)
})

test("uploads when Apple has only created an awaiting placeholder", async () => {
  const api = client([{data: []}, {data: [{id: "upload-1", attributes: {state: {state: "AWAITING_UPLOAD"}}}]}])
  let uploads = 0
  const result = await uploadExactBuild(api, {
    appId: "app-1",
    buildNumber: 310000047,
    upload: async () => {
      uploads += 1
    },
  })
  assert.equal(result.reused, false)
  assert.equal(uploads, 1)
})

test("retries transient App Store Connect failures while polling", async () => {
  const transient = new Error("App Store Connect returned HTTP 500")
  transient.status = 500
  const api = client([{data: []}, transient, {data: [{id: "build-1", attributes: {processingState: "VALID"}}]}])
  const build = await waitForProcessedBuild(api, {
    appId: "app-1",
    buildNumber: 310000047,
    attempts: 2,
    delay: 0,
  })
  assert.equal(build.id, "build-1")
})

test("retries transient fetch timeouts while polling", async () => {
  const transient = new TypeError("fetch failed")
  transient.cause = {code: "UND_ERR_HEADERS_TIMEOUT"}
  const api = client([{data: []}, transient, {data: [{id: "build-1", attributes: {processingState: "VALID"}}]}])
  const build = await waitForProcessedBuild(api, {
    appId: "app-1",
    buildNumber: 310000047,
    attempts: 2,
    delay: 0,
  })
  assert.equal(build.id, "build-1")
})

test("uses the newest upload when Apple retains an older failed attempt", async () => {
  const api = client([
    {data: []},
    {
      data: [
        {id: "upload-new", attributes: {state: {state: "PROCESSING"}}},
        {id: "upload-old", attributes: {state: {state: "FAILED"}}},
      ],
    },
  ])
  const result = await uploadExactBuild(api, {
    appId: "app-1",
    buildNumber: 310000047,
    upload: async () => {},
  })
  assert.equal(result.upload.id, "upload-new")
})

test("surfaces exact build upload validation failures", async () => {
  const api = client([
    {data: []},
    {
      data: [
        {
          id: "upload-1",
          attributes: {
            state: {state: "FAILED", errors: [{code: "STATE_ERROR", description: "Invalid entitlement"}]},
          },
        },
      ],
    },
  ])
  await assert.rejects(
    () =>
      uploadExactBuild(api, {
        appId: "app-1",
        buildNumber: 310000047,
        upload: async () => {},
      }),
    /STATE_ERROR: Invalid entitlement/,
  )
})

test("idempotently adds a build to exactly one TestFlight group", async () => {
  const api = client([
    {data: [{id: "group-1", attributes: {name: "Mentra Staging"}}]},
    {data: []},
    null,
    {data: [{type: "builds", id: "build-1"}]},
  ])
  const result = await assignBuildToGroup(api, {appId: "app-1", buildId: "build-1", groupName: "Mentra Staging"})
  assert.equal(result.reused, false)
  assert.equal(api.calls[2].options.method, "POST")
  assert.deepEqual(JSON.parse(api.calls[2].options.body), {data: [{type: "builds", id: "build-1"}]})
})

test("does not post when the group already contains the build", async () => {
  const api = client([
    {data: [{id: "group-1", attributes: {name: "Mentra Dev"}}]},
    {data: [{type: "builds", id: "build-1"}]},
  ])
  const result = await assignBuildToGroup(api, {appId: "app-1", buildId: "build-1", groupName: "Mentra Dev"})
  assert.equal(result.reused, true)
  assert.equal(api.calls.length, 2)
})

test("creates TestFlight release notes for the exact processed build", async () => {
  const api = client([
    {data: []},
    {data: {id: "localization-1", attributes: {locale: "en-US", whatsNew: "Release 3.1.0-dev.45"}}},
  ])
  const result = await setBetaBuildWhatsNew(api, {
    buildId: "build-1",
    whatsNew: "Release 3.1.0-dev.45",
  })
  assert.equal(result.localization.id, "localization-1")
  assert.equal(api.calls[1].options.method, "POST")
  assert.equal(JSON.parse(api.calls[1].options.body).data.relationships.build.data.id, "build-1")
})

test("follows every TestFlight relationship page before posting", async () => {
  const api = client([
    {data: [], links: {next: "/v1/betaGroups/group-1/relationships/builds?cursor=next"}},
    {data: [{type: "builds", id: "build-1"}], links: {next: null}},
  ])
  const data = await collectPaginatedData(api, "/v1/betaGroups/group-1/relationships/builds?limit=200")
  assert.deepEqual(data, [{type: "builds", id: "build-1"}])
  assert.equal(api.calls.length, 2)
})

test("recognizes the exact build after App Store submission", async () => {
  const api = client([
    {data: [{id: "version-1", attributes: {appStoreState: "WAITING_FOR_REVIEW"}}]},
    {data: {type: "builds", id: "build-1"}},
  ])
  const status = await productionSubmissionStatus(api, {
    appId: "app-1",
    versionString: "3.1.0",
    buildId: "build-1",
  })
  assert.equal(status.promoted, true)
  assert.equal(status.state, "WAITING_FOR_REVIEW")
})

test("recognizes a build that App Store Connect is processing for distribution", async () => {
  const api = client([
    {data: [{id: "version-1", attributes: {appStoreState: "PROCESSING_FOR_DISTRIBUTION"}}]},
    {data: {type: "builds", id: "build-1"}},
  ])
  const status = await productionSubmissionStatus(api, {
    appId: "app-1",
    versionString: "3.1.0",
    buildId: "build-1",
  })
  assert.equal(status.promoted, true)
  assert.equal(status.state, "PROCESSING_FOR_DISTRIBUTION")
})

test("waits for the App Store version to leave preparation", async () => {
  const api = client([
    {data: [{id: "version-1", attributes: {appStoreState: "PREPARE_FOR_SUBMISSION"}}]},
    {data: {type: "builds", id: "build-1"}},
    {data: [{id: "version-1", attributes: {appStoreState: "IN_REVIEW"}}]},
    {data: {type: "builds", id: "build-1"}},
  ])
  const status = await waitForProductionSubmission(api, {
    appId: "app-1",
    versionString: "3.1.0",
    buildId: "build-1",
    attempts: 2,
    delay: 0,
  })
  assert.equal(status.state, "IN_REVIEW")
})
