import assert from "node:assert/strict"
import test from "node:test"

import {
  assignBuildToGroup,
  collectPaginatedData,
  findProcessedBuild,
  productionSubmissionStatus,
  setBetaBuildWhatsNew,
  waitForProductionSubmission,
  waitForProcessedBuild,
} from "./app-store-connect-build.mjs"

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

test("waits for an uploaded build to finish processing", async () => {
  const api = client([
    {data: []},
    {data: [{id: "build-1", attributes: {processingState: "PROCESSING"}}]},
    {data: [{id: "build-1", attributes: {processingState: "VALID"}}]},
  ])
  const build = await waitForProcessedBuild(api, {appId: "app-1", buildNumber: 310000057, attempts: 3, delay: 0})
  assert.equal(build.id, "build-1")
  assert.match(api.calls[0].resource, /filter%5Bversion%5D=310000057/)
})

test("fails when App Store Connect marks a build invalid", async () => {
  const api = client([{data: [{id: "build-1", attributes: {processingState: "FAILED"}}]}])
  await assert.rejects(() => findProcessedBuild(api, {appId: "app-1", buildNumber: 12}), /is FAILED/)
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
