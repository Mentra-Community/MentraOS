import test from "node:test"
import assert from "node:assert/strict"
import {routineApi, routineLabelIds, selectedCatalog, stableRequestId, boundRoutineResult, waitForRoutineResult} from "./routine-api.mjs"
import {routineFixture} from "./routine-api-fixture.mjs"

test("unfamiliar routine labels resolve only through enrolled definitions", () => {
  const f = routineFixture(), catalog = {routines: [f.enrollment]}
  assert.deepEqual(routineLabelIds({labels: ["routine:example.screen-check", {name: "routine:example.screen-check"}, {name: "other"}]}), [f.definition.id])
  assert.equal(selectedCatalog(catalog, [f.definition.id])[0].title, f.definition.title)
  assert.throws(() => selectedCatalog(catalog, ["not-enrolled"]), /not enrolled/)
  assert.throws(() => selectedCatalog(catalog, [f.definition.id], "android"), /not enrolled for android/)
  assert.throws(() => selectedCatalog({routines: [f.enrollment, f.enrollment]}), /ambiguous/)
})
test("source-based request identity is stable and binds routine, platform and publication", () => {
  const f = routineFixture(), input = {occurrenceId: "source-pr-10-2", routineId: f.definition.id, platform: "ios-on-mac", source: f.source}
  assert.equal(stableRequestId(input), stableRequestId(structuredClone(input)))
  for (const change of [{routineId: "another-check"}, {platform: "android"}, {source: {...f.source, publicationAttempt: 3}}])
    assert.notEqual(stableRequestId(input), stableRequestId({...input, ...change}))
})
test("API authenticates source-bound acknowledgements and reports explicit admission failures", async () => {
  const f = routineFixture(), request = {requestId: "example-request", routineId: f.definition.id, platform: "ios-on-mac", source: f.source}
  await routineApi({token: "fixture-token", operation: "dispatch", request, fetchImpl: f.fetchImpl})
  assert.equal(f.calls[0].options.headers.Authorization, "Bearer fixture-token")
  assert.equal(f.calls[0].options.redirect, "error")
  await assert.rejects(routineApi({token: "fixture", operation: "dispatch", request,
    fetchImpl: async () => Response.json({...f.request, input: {...f.request.input, routineId: "another-check"}})}), /changed the original/)
  await assert.rejects(routineApi({token: "fixture", operation: "dispatch", request,
    fetchImpl: async () => Response.json({message: "Host lacks required recorder"}, {status: 409})}), /Host lacks required recorder/)
})
test("result refuses mismatched source, host and definition; upload/evidence failure never passes", () => {
  const f = routineFixture()
  assert.equal(boundRoutineResult(f.detail).status, "passed")
  for (const mutate of [d => {d.result.run.hostId = "other"}, d => {d.result.run.build.archive.sha256 = "f".repeat(64)},
    d => {d.result.definition.id = "other"}, d => {d.result.run.definitionRevision = "f".repeat(40)}]) {
    const detail = structuredClone(f.detail); mutate(detail); assert.throws(() => boundRoutineResult(detail), /differs/)
  }
  f.detail.result.uploadsComplete = false; assert.equal(boundRoutineResult(f.detail).status, "upload-incomplete")
  f.detail.result.uploadsComplete = true; f.detail.result.evidenceStatus = "failed"; assert.equal(boundRoutineResult(f.detail).status, "failed")
})
test("result polling retries transient outages and waits for uploads without new requests", async () => {
  const f = routineFixture(); let calls = 0, now = 0
  const detail = await waitForRoutineResult({token: "fixture", requestId: f.request.requestId, timeoutMilliseconds: 100,
    now: () => now, sleep: async ms => {now += ms}, fetchImpl: async () => {
      calls++; if (calls === 1) return new Response(null, {status: 503})
      return Response.json({...f.detail, result: {...f.detail.result, uploadsComplete: calls > 2}})
    }})
  assert.equal(detail.result.uploadsComplete, false) // deadline retains the honest upload-incomplete receipt
  assert.equal(calls, 2)
})

test("active callers contain no routine registry and preserve enable gates and trusted source checkout", async () => {
  const {readFile, readdir} = await import("node:fs/promises")
  const workflows = new URL("../workflows/", import.meta.url)
  const request = await readFile(new URL("request-e2e-routine.yml", workflows), "utf8")
  const dispatch = await readFile(new URL("dispatch-device-routine.yml", workflows), "utf8")
  const nightly = await readFile(new URL("nightly-device-routines.yml", workflows), "utf8")
  const results = await readFile(new URL("notify-release-routine.yml", workflows), "utf8")
  assert.match(request, /routine:[\s\S]*type: string/)
  assert.match(request, /pull_request_target:/); assert.match(request, /ref: dev/)
  assert.match(request, /DEVICE_ROUTINE_PR_DISPATCH_ENABLED == 'true'/)
  assert.match(dispatch, /DEVICE_ROUTINE_PR_DISPATCH_ENABLED == 'true'/)
  assert.match(nightly, /DEVICE_ROUTINE_NIGHTLY_ENABLED == 'true'/)
  assert.match(nightly, /SLACK_WEBHOOK_DEV_BUILDS/); assert.match(nightly, /publishNightlyWebhook/)
  assert.match(results, /request_id:/); assert.match(results, /resolveRoutineResults/)
  assert.doesNotMatch(request + dispatch + results, /worker_run_id|privateGithub|TEST_RUN_GITHUB_APP_PRIVATE_KEY|nightlyOnly/)
  for (const name of await readdir(new URL("./", import.meta.url))) if (name.endsWith(".mjs") && !name.endsWith(".test.mjs") && !name.endsWith("-fixture.mjs")) {
    const source = await readFile(new URL(name, import.meta.url), "utf8")
    assert.doesNotMatch(source, /DEVICE_ROUTINES|device-routines\.mjs|registeredRoutine\(/, name)
  }
})

test("client refuses a reported pass that contradicts steps or cleanup", () => {
  const f = routineFixture()
  f.detail.result.run.result.steps[0].status = "not-run"
  assert.throws(() => boundRoutineResult(f.detail), /contradicts/)
  f.detail.result.run.result.steps[0].status = "passed"; f.detail.result.run.result.teardown.ready = false
  assert.throws(() => boundRoutineResult(f.detail), /contradicts/)
})
