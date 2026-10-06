import test from "node:test"
import assert from "node:assert/strict"
import {routineApi, submitRoutineRequest, routineLabelIds, selectedCatalog, stableRequestId, boundRoutineResult, waitForRoutineResult, requestInputDigest} from "./routine-api.mjs"
import {routineFixture, terminalRoutineFixture} from "./routine-api-fixture.mjs"

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
test("response loss after Core admission reconciles the original stable selector, including partial JSON", async () => {
  for (const partialBody of [false, true]) {
    const f = routineFixture(), request = {requestId: f.request.requestId, routineId: f.definition.id, platform: f.request.input.platform, source: f.source}, calls = []
    const result = await submitRoutineRequest({token: "fixture", request, fetchImpl: async (url, init) => {
      calls.push(init.method)
      if (init.method === "POST") {
        if (partialBody) return new Response('{"requestId":', {status: 200})
        throw new Error("response lost after commit")
      }
      assert.ok(url.endsWith(`/${request.requestId}`))
      return Response.json(f.detail)
    }})
    assert.equal(result.status, "accepted"); assert.deepEqual(result.request, f.request)
    assert.deepEqual(calls, ["POST", "GET"])
  }
})
test("unknown dispatch acceptance retains the stable ID and bounded diagnostics without another POST", async () => {
  for (const status of [503, 404]) {
    const f = routineFixture(), request = {requestId: f.request.requestId, routineId: f.definition.id, platform: f.request.input.platform, source: f.source}, calls = []
    const result = await submitRoutineRequest({token: "fixture", request, fetchImpl: async (url, init) => {
      calls.push(init.method)
      if (init.method === "POST") throw new Error("response lost")
      return Response.json({message: `lookup unavailable\n${"x".repeat(1000)}`}, {status})
    }})
    assert.equal(result.status, "uncertain"); assert.equal(result.requestId, request.requestId); assert.equal(result.request, undefined)
    assert.ok(result.reason.length <= 600); assert.doesNotMatch(result.reason, /[\r\n]/)
    assert.deepEqual(calls, ["POST", "GET"])
  }
})
test("dispatch reconciliation refuses changed source, routine, platform or ID without falsely accepting it", async () => {
  for (const mutate of [d => {d.request.input.build.source.publicationAttempt++}, d => {d.request.input.routineId = "changed"},
    d => {d.request.input.platform = "android"}, d => {d.request.requestId = "changed"}]) {
    const f = routineFixture(), detail = structuredClone(f.detail), request = {requestId: f.request.requestId, routineId: f.definition.id, platform: f.request.input.platform, source: f.source}
    mutate(detail)
    const result = await submitRoutineRequest({token: "fixture", request, fetchImpl: async (url, init) => {
      if (init.method === "POST") throw new Error("response lost")
      return Response.json(detail)
    }})
    assert.equal(result.status, "failed"); assert.equal(result.retryable, false); assert.equal(result.request, undefined)
  }
  const f = routineFixture(), request = {requestId: f.request.requestId, routineId: f.definition.id, platform: f.request.input.platform, source: f.source}, calls = []
  const result = await submitRoutineRequest({token: "fixture", request, fetchImpl: async (url, init) => {
    calls.push(init.method)
    return Response.json({...f.request, input: {...f.request.input, build: {...f.build, source: {...f.source, buildRunId: 999}}}})
  }})
  assert.equal(result.status, "failed"); assert.deepEqual(calls, ["POST"])
})
test("retained uncertain selectors use the normal result wait across temporary absence", async () => {
  const f = routineFixture(); let calls = 0, now = 0
  const detail = await waitForRoutineResult({token: "fixture", requestId: f.request.requestId, now: () => now, timeoutMilliseconds: 60_000,
    sleep: async ms => {now += ms}, fetchImpl: async () => ++calls === 1 ? new Response(null, {status: 404}) : Response.json(f.detail)})
  assert.deepEqual(detail, f.detail); assert.equal(calls, 2)
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

test("request and publication callback jobs select the environment providing their Core capability", async () => {
  const {readFile} = await import("node:fs/promises")
  for (const [name, jobIds] of [["request-e2e-routine", ["request"]], ["dispatch-device-routine", ["resolve", "dispatch"]]]) {
    const workflow = await readFile(new URL(`../workflows/${name}.yml`, import.meta.url), "utf8")
    const jobs = workflow.slice(workflow.indexOf("\njobs:\n")).split(/(?=^  [a-z-]+:\n)/m)
    for (const jobId of jobIds) {
      const job = jobs.find(section => section.startsWith(`  ${jobId}:\n`))
      assert.ok(job, `${name} must contain ${jobId}`)
      assert.match(job, /^    environment: routine-nightly-dev$/m, `${name}.${jobId} must load the environment secret`)
      assert.match(job, /TEST_RUN_INGEST_TOKEN: \$\{\{ secrets\.TEST_RUN_INGEST_TOKEN_DEV \}\}/)
    }
  }
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
  assert.match(results, /fanout:[\s\S]*actions: write/)
  assert.match(results, /fanout:[\s\S]*github\.event_name == 'workflow_run'/)
  assert.match(results, /resolve:[\s\S]*github\.event_name == 'workflow_dispatch'/)
  assert.match(results, /launchRoutineResultNotifications/)
  assert.doesNotMatch(results, /runs-on: ubuntu-latest|routine-result-fanout\.json|Retain authenticated dispatch intent|notification_id|NOTIFICATION_ID/)
  assert.equal((results.match(/runs-on: blacksmith-4vcpu-ubuntu-2404/g) ?? []).length, 4)
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

test("terminal rejection and cancellation return immediately without fabricating a run", async () => {
  for (const status of ["not-run", "cancelled"]) {
    const f = terminalRoutineFixture({status}), row = boundRoutineResult(f.detail)
    assert.equal(row.status, status); assert.equal(row.resultRunId, undefined)
    assert.equal(row.title, f.request.input.routineId); assert.ok(row.reason)
    const detail = await waitForRoutineResult({token: "fixture", requestId: f.request.requestId, fetchImpl: f.fetchImpl,
      sleep: async () => {assert.fail("Terminal request must not wait for a nonexistent report")}})
    assert.equal(detail.result, null); assert.equal(f.calls.length, 1)
  }
})

test("terminal request receipts bind exact input, host, identity and terminal kind", () => {
  const f = terminalRoutineFixture()
  for (const mutate of [d => {d.request.input.build.archive.sha256 = "e".repeat(64)}, d => {d.request.hostRejection.hostId = "other"},
    d => {d.request.hostRejection.requestId = "other"}, d => {d.request.hostRejection.inputSha256 = "e".repeat(64)},
    d => {d.request.hostRejection.reason = ""}, d => {d.request.hostRejection.rejectedAt = "invalid"},
    d => {d.request.hostReceipt = {requestId: d.request.requestId}}, d => {d.request.terminalStatus = "cancelled"},
    d => {d.request.hostRejection.extra = true}]) {
    const detail = structuredClone(f.detail); mutate(detail)
    assert.throws(() => boundRoutineResult(detail), /immutable receipt/)
  }
  const cancellation = terminalRoutineFixture({status: "cancelled"})
  cancellation.request.state = "accepted"
  assert.equal(boundRoutineResult(cancellation.detail), null) // Intent is not settled cancellation.
  assert.equal(requestInputDigest({b: 2, a: [1, {c: true}]}), requestInputDigest({a: [1, {c: true}], b: 2}))
})
