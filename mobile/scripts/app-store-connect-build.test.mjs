import assert from "node:assert/strict"
import test from "node:test"

import {
  assignBuildToGroup,
  collectPaginatedData,
  findProcessedBuild,
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
    {data: [{id: "group-1", attributes: {name: "Beta"}}]},
    {data: []},
    null,
    {data: [{type: "builds", id: "build-1"}]},
  ])
  const result = await assignBuildToGroup(api, {appId: "app-1", buildId: "build-1", groupName: "Beta"})
  assert.equal(result.reused, false)
  assert.equal(api.calls[2].options.method, "POST")
  assert.deepEqual(JSON.parse(api.calls[2].options.body), {data: [{type: "builds", id: "build-1"}]})
})

test("does not post when the group already contains the build", async () => {
  const api = client([{data: [{id: "group-1", attributes: {name: "Dev"}}]}, {data: [{type: "builds", id: "build-1"}]}])
  const result = await assignBuildToGroup(api, {appId: "app-1", buildId: "build-1", groupName: "Dev"})
  assert.equal(result.reused, true)
  assert.equal(api.calls.length, 2)
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
