import {test} from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {callbackRunName, dispatchReadyRequest, planDeviceDispatch, planDeviceDispatches, publicationJobName, PUBLICATION_SEND_STEP, requestAfterPublication} from "./dispatch-device-routine.mjs"
import {createRoutineRequest} from "./request-e2e-routine.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"
import {COORDINATED_FINALIZE_JOB, COORDINATED_PUBLISH_STEP} from "./coordinated-routine-request.mjs"
import {coordinatedFixture} from "./coordinated-routine-fixture.mjs"

const repo = "Mentra-Community/MentraOS"
const source = "a".repeat(40), head = "b".repeat(40), base = "c".repeat(40)
const context = {eventName: "workflow_run", runId: 777, sha: source, repo: {owner: "Mentra-Community", repo: "MentraOS"},
  payload: {workflow_run: {id: 123, run_attempt: 2}}}
const pr = {number: 42, state: "open", base: {ref: "dev"},
  head: {sha: head, ref: "feature", repo: {full_name: repo}}, labels: [{name: "routine:day1-ota"}]}
const build = {id: 123, run_attempt: 2, path: ".github/workflows/mentra-app-ios-build.yml", event: "pull_request",
  created_at: "2026-09-22T00:00:00Z",
  head_sha: head, head_branch: "feature", repository: {full_name: repo}, head_repository: {full_name: repo},
  status: "completed", conclusion: "success", pull_requests: [{number: 42}]}
const producer = {...build, path: ".github/workflows/request-e2e-routine.yml", event: "workflow_dispatch",
  head_sha: source, head_branch: "dev", pull_requests: []}
const artifact = {id: 77, name: "mentra-routine-request-123-2", expired: false, size_in_bytes: 1000,
  digest: `sha256:${"d".repeat(64)}`, workflow_run: {id: 123, head_sha: source}}
const request = {schemaVersion: 1, kind: "mentra-routine-request", requestId: "routine-123-2-42-day1-ota", status: "ready",
  trigger: {kind: "workflow_dispatch", repository: repo, workflow: producer.path, runId: 123, runAttempt: 2,
    ref: "refs/heads/dev", sha: source, workflowSha: source, workflowRef: `${repo}/${producer.path}@refs/heads/dev`},
  routine: {id: "day1-ota", harnessRevision: source}, pullRequest: {number: 42, headSha: head, baseSha: base, baseRef: "dev"},
  selection: {platform: "ios-on-mac", app: {backend: "dev"}, build: {headSha: head, baseSha: base}}}

const publishedJobs = ["build", "publish"].map((name, id) => ({name, id, run_attempt: 2,
  status: "completed", conclusion: "success", started_at: "2026-09-22T00:00:00Z", completed_at: "2026-09-22T00:01:00Z"}))
const callback = {id: context.runId, run_number: 100, run_attempt: 1, display_title: callbackRunName(123, 2),
  event: "workflow_run", path: ".github/workflows/dispatch-device-routine.yml", head_branch: "dev", head_sha: source,
  repository: {full_name: repo}, head_repository: {full_name: repo}}
const publicationJob = {name: publicationJobName(123, 2), run_attempt: 1, status: "in_progress", conclusion: null,
  steps: [{name: PUBLICATION_SEND_STEP, status: "in_progress", conclusion: null, started_at: "2026-09-22T01:00:00Z"}]}
const requestPlan = {mode: "request", routine: "day1-ota", pr: 42, sourceRunId: 123, publicationAttempt: 2,
  sourceCreatedAt: build.created_at, callbackRunId: 777, callbackAttempt: 1}
const dispatchResponse = {status: 200, data: {workflow_run_id: 9000,
  run_url: `https://api.github.com/repos/${repo}/actions/runs/9000`, html_url: `https://github.com/${repo}/actions/runs/9000`}}
function fake({run = build, pull = pr, artifacts = [artifact], baseSha = base, jobs = publishedJobs,
  history = [callback], historyResponse, builds = [build], callbackJobs = {[callback.id]: [publicationJob]},
  dispatch = async () => dispatchResponse} = {}) {
  const calls = []
  // A function entry returns the next jobs API observation of that callback run.
  const jobsFor = (runId) => typeof callbackJobs[runId] === "function" ? callbackJobs[runId]()
    : callbackJobs[runId] ?? (runId === build.id ? jobs : [])
  const listJobsForWorkflowRun = async input => {
    const rows = jobsFor(input.run_id)
    return {data: {total_count: rows.length, jobs: rows}}
  }
  const github = {rest: {
    actions: {getWorkflowRunAttempt: async (input) => {calls.push(["read-attempt", input]); return {data: run}},
      listWorkflowRuns: async (input) => {
        if (input.workflow_id === build.path) {calls.push(["read-builds", input]); return {data: {workflow_runs: builds}}}
        calls.push(["read-callbacks", input]); return {data:
          typeof historyResponse === "function" ? historyResponse(input) : historyResponse ?? {total_count: history.length, workflow_runs: history}}},
      listJobsForWorkflowRun, listWorkflowRunArtifacts: () => {}, createWorkflowDispatch: async (input) => {calls.push(["dispatch", input]); return dispatch()}},
    pulls: {get: async () => ({data: pull})},
    git: {getRef: async ({ref}) => {calls.push(["read-base", ref]); return {data: {ref: `refs/${ref}`, object: {type: "commit", sha: baseSha}}}}},
  }, paginate: async (method, input) => {
    if (method === listJobsForWorkflowRun) return jobsFor(input.run_id)
    calls.push(["read-artifacts", input]); return artifacts
  }}
  return {github, calls, callbackAttempt: 1, wait: async (ms) => {calls.push(["wait", ms])}}
}
const bytes = (value) => Buffer.from(JSON.stringify(value))

test("successful current opted-in iOS publication requests the trusted dev producer", async () => {
  const f = fake()
  const plan = await planDeviceDispatch({...f, context})
  assert.deepEqual(plan, requestPlan)
  const result = await requestAfterPublication({...f, context, plan})
  assert.deepEqual(result, {status: "request-dispatched", pr: 42, requestRunId: 9000, requestUrl: dispatchResponse.data.html_url})
  assert.deepEqual(f.calls.at(-1), ["dispatch", {...context.repo, workflow_id: producer.path, ref: "dev",
    return_run_details: true, inputs: {pr: "42", routine: "day1-ota", request_origin: "pr-label", source_build_run_id: "123", source_publication_attempt: "2"}}])
})

const wake = {...build, id: 124, run_attempt: 1, path: producer.path, created_at: "2026-09-22T01:00:00Z"}
const wakeContext = {...context, runId: 778, payload: {workflow_run: {id: wake.id, run_attempt: wake.run_attempt}}}
const wakeCallback = {...callback, id: wakeContext.runId, run_number: 101, display_title: callbackRunName(wake.id, wake.run_attempt)}
const wakeHistory = {history: [callback, wakeCallback], callbackJobs: {
  [callback.id]: [{name: "resolve", run_attempt: 1, status: "completed", conclusion: "success"}],
  [wakeCallback.id]: [publicationJob],
}}

test("build completes before label opt-in, then the trusted dev resolver produces the private dispatch", async () => {
  assert.equal((await planDeviceDispatch({...fake({pull: {...pr, labels: []}}), context})).mode, "skip")
  const f = fake({run: wake, ...wakeHistory, artifacts: []})
  const plan = await planDeviceDispatch({...f, context: wakeContext})
  assert.deepEqual(plan, {...requestPlan, callbackRunId: wakeContext.runId})
  const sent = await requestAfterPublication({...f, context: wakeContext, plan})
  assert.equal(sent.status, "request-dispatched")
  const dispatch = f.calls.find(([kind]) => kind === "dispatch")[1]
  assert.equal(dispatch.ref, "dev")
  assert.equal(dispatch.inputs.source_build_run_id, "123")
  assert.equal(dispatch.inputs.source_publication_attempt, "2")
  assert.equal(f.calls.some(([kind]) => kind === "read-artifacts"), false)

  // Execute the real trusted resolver with published receipt/OTA fixtures. The
  // wake-up's PR artifact is absent and cannot supply any part of this request.
  const url = (name) => artifactUrl(repo, "pr-builds", name)
  const otaUrl = url(`ota-pr-42-${head}.json`), merge = "e".repeat(40), digest = "d".repeat(64)
  const receipt = {schemaVersion: 1, pr: 42, headSha: head, buildSha: merge, runId: 123, runAttempt: 2,
    app: {pr: 42, headSha: head, buildSha: merge, runId: 123, runAttempt: 2, bundleId: "com.mentra.mentra",
      teamId: "T5XXXL6N36", backend: "dev", otaManifestUrl: otaUrl, executableSha256: digest,
      javascriptSha256: digest, version: "3.2.1", build: "302010030"},
    artifacts: Object.fromEntries([["iphone", "ipa"], ["mac", "zip"]].map(([kind, ext]) => [kind,
      {name: `mentra-ios-${kind}-pr-42-${head}-123-2.${ext}`, size: 1234, sha256: digest}]))}
  const manifest = {releaseVersion: `pr-42-${head}`, apps: {"com.mentra.asg_client": {
    versionName: "3.2.1", versionCode: 302010030, sha256: digest, apkUrl: "https://example.com/asg.apk", apkSize: 123}},
    bes_firmware: {version: "26.9.21.1"}, mtk_full_ota: {end_firmware: "MentraLive_20260915.0"}}
  const trusted = fake()
  trusted.github.rest.git.getRef = async () => ({data: {ref: "refs/heads/dev", object: {type: "commit", sha: base}}})
  trusted.github.rest.repos = {getCommit: async () => ({data: {sha: merge, parents: [{sha: base}, {sha: head}]}})}
  const generated = await createRoutineRequest({github: trusted.github,
    context: {...context, eventName: "workflow_dispatch", runId: sent.requestRunId}, number: Number(dispatch.inputs.pr),
    routine: dispatch.inputs.routine, requestOrigin: dispatch.inputs.request_origin,
    sourceBuildRunId: dispatch.inputs.source_build_run_id, sourcePublicationAttempt: dispatch.inputs.source_publication_attempt,
    source: {runAttempt: 1, ref: "refs/heads/dev", sha: source, workflowSha: source,
      workflowRef: `${repo}/${producer.path}@refs/heads/dev`, actor: "tester"},
    fetchImpl: async (address, options) => {
      if (options.method === "HEAD") {
        assert.equal(address, url(receipt.artifacts.mac.name))
        return new Response(null, {headers: {"content-length": "1234"}})
      }
      assert.ok([otaUrl, url(`mentra-ios-pr-42-${head}-123-2.json`)].includes(address))
      return new Response(JSON.stringify(address === otaUrl ? manifest : receipt))
    }})
  assert.equal(generated.status, "ready")
  assert.equal(generated.selection.producer.runId, build.id)
  assert.equal(generated.selection.producer.publicationAttempt, 2)
  const completed = {...producer, id: sent.requestRunId, run_attempt: 1}
  const readyArtifact = {...artifact, name: `mentra-routine-request-${completed.id}-1`,
    workflow_run: {id: completed.id, head_sha: source}}
  const ready = fake({run: completed, artifacts: [readyArtifact]}), remote = fake()
  const readyContext = {...context, payload: {workflow_run: {id: completed.id, run_attempt: 1}}}
  const readyPlan = await planDeviceDispatch({...ready, context: readyContext})
  const result = await dispatchReadyRequest({...ready, privateGithub: remote.github, context: readyContext,
    plan: readyPlan, bytes: bytes(generated)})
  assert.equal(result.status, "private-job-requested")
  assert.equal(remote.calls[0][1].inputs.request_run_id, String(sent.requestRunId))
  assert.equal(remote.calls[0][1].inputs.request_attempt, "1")
})

test("late opt-in only wakes metadata resolution for a current eligible PR and successful publication", async () => {
  for (const setup of [
    {run: {...wake, pull_requests: []}}, {run: {...wake, pull_requests: [{number: 42}, {number: 43}]}},
    {run: {...wake, head_sha: source}}, {pull: {...pr, labels: []}}, {pull: {...pr, state: "closed"}},
    {pull: {...pr, base: {ref: "main"}}}, {builds: []}, {jobs: []},
    ...[{head_sha: source}, {head_branch: "other"}, {head_repository: {full_name: "fork/repo"}},
      {repository: {full_name: "other/repo"}}, {path: producer.path}, {status: "in_progress"}]
      .map((delta) => ({builds: [{...build, ...delta}]})),
  ]) {
    const f = fake({run: wake, ...wakeHistory, ...setup})
    assert.equal((await planDeviceDispatch({...f, context: wakeContext})).mode, "skip")
    assert.equal(f.calls.some(([kind]) => kind === "dispatch" || kind === "read-artifacts"), false)
  }
  const failedWake = fake({run: {...wake, conclusion: "failure"}, ...wakeHistory})
  assert.equal((await planDeviceDispatch({...failedWake, context: wakeContext})).mode, "request")
  assert.equal(failedWake.calls.some(([kind]) => kind === "read-artifacts"), false)
})

test("late wake-ups share the original publication fence after sent, unknown or legacy callbacks", async () => {
  for (const prior of [
    {...publicationJob, status: "completed", conclusion: "success"},
    {...publicationJob, status: "completed", conclusion: "failure"},
    {...publicationJob, status: "completed", conclusion: "cancelled"},
    {name: "dispatch", run_attempt: 1, status: "completed", conclusion: "success"},
  ]) {
    const f = fake({run: wake, ...wakeHistory, callbackJobs: {
      [callback.id]: [prior], [wakeCallback.id]: [publicationJob],
    }})
    const plan = await planDeviceDispatch({...f, context: wakeContext})
    const result = await requestAfterPublication({...f, context: wakeContext, plan})
    assert.equal(result.status, "request-reconcile")
    assert.equal(result.callbackUrl, `https://github.com/${repo}/actions/runs/${callback.id}`)
    assert.equal(f.calls.some(([kind]) => kind === "dispatch" || kind === "read-artifacts"), false)
  }
})

test("publication fencing follows execution order when a later label callback starts first", async () => {
  const callbackJobs = {[callback.id]: [{...publicationJob, status: "queued", steps: []}], [wakeCallback.id]: [publicationJob]}
  const f = fake({run: wake, ...wakeHistory, callbackJobs})
  const plan = await planDeviceDispatch({...f, context: wakeContext})
  assert.equal((await requestAfterPublication({...f, context: wakeContext, plan})).status, "request-dispatched")
  callbackJobs[wakeCallback.id] = [{...publicationJob, status: "completed", conclusion: "success"}]
  callbackJobs[callback.id] = [publicationJob]
  const original = fake({...wakeHistory, callbackJobs})
  const originalPlan = await planDeviceDispatch({...original, context})
  assert.equal((await requestAfterPublication({...original, context, plan: originalPlan})).status, "request-reconcile")
  assert.equal(original.calls.some(([kind]) => kind === "dispatch"), false)
})

test("three callbacks do not let a cancelled pending job consume the publication", async () => {
  const thirdWake = {...wake, id: 125}
  const third = {...wakeCallback, id: 779, run_number: 102, display_title: callbackRunName(thirdWake.id, 1)}
  const thirdContext = {...wakeContext, runId: third.id, payload: {workflow_run: {id: thirdWake.id, run_attempt: 1}}}
  for (const unsent of [
    {...publicationJob, status: "completed", conclusion: "cancelled", steps: []},
    {...publicationJob, status: "completed", conclusion: "cancelled", steps: [
      {name: PUBLICATION_SEND_STEP, status: "completed", conclusion: "cancelled", started_at: null}]},
    {...publicationJob, status: "completed", conclusion: "failure", steps: [
      {name: PUBLICATION_SEND_STEP, status: "completed", conclusion: "skipped", started_at: null}]},
  ]) {
    const history = [callback, wakeCallback, third]
    const callbackJobs = {[callback.id]: [publicationJob], [wakeCallback.id]: [unsent],
      [third.id]: [{...publicationJob, status: "queued", steps: []}]}
    const first = fake({history, callbackJobs})
    const plan = await planDeviceDispatch({...first, context})
    assert.equal((await requestAfterPublication({...first, context, plan})).status, "request-dispatched")
    callbackJobs[callback.id] = [{...publicationJob, status: "completed", conclusion: "success"}]
    callbackJobs[third.id] = [publicationJob]
    const later = fake({run: thirdWake, history, callbackJobs})
    const laterPlan = await planDeviceDispatch({...later, context: thirdContext})
    assert.equal((await requestAfterPublication({...later, context: thirdContext, plan: laterPlan})).status, "request-reconcile")
    assert.equal(first.calls.filter(([kind]) => kind === "dispatch").length, 1)
    assert.equal(later.calls.some(([kind]) => kind === "dispatch"), false)
  }
})

test("late labels select a retained publication and distinct publication attempts keep distinct fences", async () => {
  const original = publishedJobs.map((job) => ({...job, id: job.id + 10, run_attempt: 1}))
  const retained = fake({run: wake, ...wakeHistory, jobs: [...original, ...publishedJobs]})
  const retainedPlan = await planDeviceDispatch({...retained, context: wakeContext})
  assert.equal(retainedPlan.publicationAttempt, 1)
  const next = fake({run: wake, ...wakeHistory, callbackJobs: {
    [callback.id]: [{...publicationJob, name: publicationJobName(123, 1), status: "completed", conclusion: "success"}],
    [wakeCallback.id]: [publicationJob],
  }})
  const plan = await planDeviceDispatch({...next, context: wakeContext})
  assert.equal((await requestAfterPublication({...next, context: wakeContext, plan})).status, "request-dispatched")
})

test("failed, stale, ambiguous or no-longer-requested builds never create a request", async () => {
  for (const setup of [
    {run: {...build, conclusion: "failure"}, jobs: []}, {run: {...build, pull_requests: []}},
    {run: {...build, pull_requests: [{number: 42}, {number: 43}]}},
    {run: {...build, head_sha: "e".repeat(40)}}, {pull: {...pr, labels: []}},
    {pull: {...pr, state: "closed"}}, {pull: {...pr, base: {ref: "main"}}},
    {run: {...build, path: ".github/workflows/unrelated.yml"}},
  ]) assert.equal((await planDeviceDispatch({github: fake(setup).github, context})).mode, "skip")
})

test("notification failure does not suppress a successfully published iOS build", async () => {
  const f = fake({run: {...build, conclusion: "failure"}, jobs: [...publishedJobs,
    {name: "notify-pr-builds", id: 3, run_attempt: 2, status: "completed", conclusion: "failure"}]})
  assert.deepEqual(await planDeviceDispatch({...f, context}), requestPlan)
})

test("notification-only retries retaining an earlier publication create no new generation", async () => {
  const original = publishedJobs.map(job => ({...job, id: job.id + 10, run_attempt: 1}))
  const f = fake({jobs: [...original, ...publishedJobs]})
  assert.equal((await planDeviceDispatch({...f, context})).mode, "skip")
  assert.equal(f.calls.some(([kind]) => kind === "dispatch" || kind === "read-callbacks"), false)
})

test("one retained callback owns the generation even across queued duplicate callbacks and reruns", async () => {
  const later = {...callback, id: 778, run_number: 101}
  const callbackJobs = {[callback.id]: [publicationJob], [later.id]: [{...publicationJob, status: "queued", steps: []}]}
  const f = fake({history: [later, callback], callbackJobs})
  const plan = await planDeviceDispatch({...f, context})
  await requestAfterPublication({...f, context, plan})
  callbackJobs[callback.id] = [{...publicationJob, status: "completed", conclusion: "success"}]
  callbackJobs[later.id] = [publicationJob]
  const duplicateContext = {...context, runId: later.id}
  const duplicatePlan = await planDeviceDispatch({...f, context: duplicateContext})
  const duplicate = await requestAfterPublication({...f, context: duplicateContext, plan: duplicatePlan})
  assert.equal(duplicate.status, "request-reconcile")
  assert.equal(duplicate.callbackUrl, `https://github.com/${repo}/actions/runs/777`)
  assert.equal((await planDeviceDispatch({...f, context, callbackAttempt: 2})).mode, "reconcile")
  assert.equal(f.calls.filter(([kind]) => kind === "dispatch").length, 1)
})

test("absent, truncated, duplicated or untrusted callback history cannot authorize a send", async () => {
  for (const setup of [{history: []}, {history: [callback, callback]},
    {history: [{...callback, head_sha: head}]}, {history: [{...callback, head_repository: {full_name: "fork/repo"}}]},
    {historyResponse: {total_count: 1000, workflow_runs: [callback]}},
    {historyResponse: {total_count: 2, workflow_runs: [callback]}}, {callbackJobs: {}},
    {callbackJobs: {[callback.id]: [{...publicationJob, steps: []}]}},
    {callbackJobs: {[callback.id]: [{...publicationJob, run_attempt: 2}]}},
    // A rerun whose run attempt is not yet visible still cannot reuse attempt 1's send.
    {callbackJobs: {[callback.id]: [{...publicationJob, status: "completed", conclusion: "failure"},
      {...publicationJob, run_attempt: 2}]}}]) {
    const f = fake(setup)
    const plan = await planDeviceDispatch({...f, context})
    await assert.rejects(() => requestAfterPublication({...f, context, plan}))
    assert.equal(f.calls.some(([kind]) => kind === "dispatch"), false)
  }
})

// Observed 2026-09-26: callback 36265660530 read its jobs about 0.7s after its
// Android send step started. The retained job later showed that exact step, name
// and attempt, but the read failed the fence before any request was sent.
const coordinatedRun = {...build, path: ".github/workflows/coordinated-release.yml", event: "push", head_branch: "dev", pull_requests: []}
const androidSend = {...publicationJob, name: publicationJobName(123, 2, "no-glasses-android", "dev")}
const laggingSends = [[], [{...androidSend, status: "queued", steps: []}],
  [{...androidSend, steps: [{name: "Create scoped public request token", status: "in_progress", conclusion: null, started_at: "2026-09-22T01:00:00Z"}]}],
  [{...androidSend, steps: [{name: PUBLICATION_SEND_STEP, status: "queued", conclusion: null, started_at: null}]}]]
const observations = (...rows) => () => rows.length > 1 ? rows.shift() : rows[0]

test("a running send not yet visible through the jobs API is observed again, then requested once", async () => {
  for (const lagging of laggingSends) {
    const f = fake({run: coordinatedRun, jobs: [coordinatedJob()],
      callbackJobs: {[callback.id]: observations(lagging, lagging, [androidSend])}})
    const plan = await planDeviceDispatch({...f, context, routine: "no-glasses-android"})
    const result = await requestAfterPublication({...f, context, plan})
    assert.equal(result.status, "request-dispatched")
    assert.equal(f.calls.filter(([kind]) => kind === "wait").length, 2)
    assert.equal(f.calls.filter(([kind]) => kind === "dispatch").length, 1)
    assert.equal(f.calls.at(-1)[1].inputs.routine, "no-glasses-android")
  }
})

test("a current send that never becomes visible is refused after a bounded wait, before any dispatch", async () => {
  for (const lagging of laggingSends) {
    const f = fake({run: coordinatedRun, jobs: [coordinatedJob()], callbackJobs: {[callback.id]: lagging}})
    const plan = await planDeviceDispatch({...f, context, routine: "no-glasses-android"})
    await assert.rejects(() => requestAfterPublication({...f, context, plan}), /Current publication send is absent/)
    const waits = f.calls.filter(([kind]) => kind === "wait").map(([, ms]) => ms)
    assert.ok(waits.length > 0 && waits.every((ms) => ms > 0) && waits.reduce((a, b) => a + b) <= 15000)
    assert.equal(f.calls.some(([kind]) => kind === "dispatch"), false)
  }
})

test("an earlier callback whose send appears while this one waits for its own record still owns the generation", async () => {
  let f
  const waited = () => f.calls.some(([kind]) => kind === "wait")
  const callbackJobs = {
    [callback.id]: () => waited() ? [publicationJob] : [{...publicationJob, status: "queued", steps: []}],
    [wakeCallback.id]: observations([], [publicationJob]),
  }
  f = fake({run: wake, ...wakeHistory, callbackJobs})
  const plan = await planDeviceDispatch({...f, context: wakeContext})
  const result = await requestAfterPublication({...f, context: wakeContext, plan})
  assert.equal(result.status, "request-reconcile")
  assert.equal(result.callbackUrl, `https://github.com/${repo}/actions/runs/${callback.id}`)
  assert.equal(f.calls.some(([kind]) => kind === "dispatch"), false)
})

test("the complete callback history is paginated and changing history fails closed", async () => {
  const others = Array.from({length: 100}, (_, index) => ({...callback, id: 1000 + index,
    display_title: callbackRunName(1000 + index, 1)}))
  const response = (input) => ({total_count: 101, workflow_runs: input.page === 1 ? others : [callback]})
  const f = fake({historyResponse: response})
  const plan = await planDeviceDispatch({...f, context})
  assert.deepEqual(plan, requestPlan)
  await requestAfterPublication({...f, context, plan})
  assert.deepEqual(f.calls.filter(([kind]) => kind === "read-callbacks").map(([, input]) => input.page), [1, 2])
  const changed = fake({historyResponse: (input) => ({...response(input), total_count: input.page === 1 ? 101 : 102})})
  await assert.rejects(() => requestAfterPublication({...changed, context, plan}), /history changed/)
  assert.equal(changed.calls.some(([kind]) => kind === "dispatch"), false)
})

test("lost, malformed and old 204 acknowledgements remain unknown and callback reruns never resend", async () => {
  for (const dispatch of [async () => {throw new Error("lost acknowledgement")}, async () => ({status: 204}),
    async () => ({status: 503}), async () => ({status: 200, data: {workflow_run_id: 9000}}),
    async () => ({...dispatchResponse, data: {...dispatchResponse.data, html_url: "https://other.example/run/9000"}})]) {
    const f = fake({dispatch})
    const plan = await planDeviceDispatch({...f, context})
    const result = await requestAfterPublication({...f, context, plan})
    assert.equal(result.status, "request-dispatch-unknown")
    assert.equal((await planDeviceDispatch({...f, context, callbackAttempt: 2})).mode, "reconcile")
    assert.equal(f.calls.filter(([kind]) => kind === "dispatch").length, 1)
  }
})

test("fork or mismatching attempt metadata is rejected before dispatch", async () => {
  for (const delta of [{head_repository: {full_name: "fork/MentraOS"}}, {repository: {full_name: "other/repo"}},
    {run_attempt: 1}, {id: 124}, {head_sha: "invalid"}]) {
    const f = fake({run: {...build, ...delta}})
    await assert.rejects(() => planDeviceDispatch({...f, context}))
    assert.equal(f.calls.some(([kind]) => kind === "dispatch"), false)
  }
})

test("trusted request callback identifies one immutable artifact from the exact attempt", async () => {
  const f = fake({run: producer})
  const plan = await planDeviceDispatch({...f, context})
  assert.deepEqual(plan, {mode: "dispatch", runId: 123, runAttempt: 2, sourceSha: source,
    artifactId: 77, artifactName: artifact.name})
  for (const artifacts of [[], [artifact, {...artifact, id: 78}], [{...artifact, expired: true}],
    [{...artifact, digest: null}], [{...artifact, size_in_bytes: 3e6}],
    [{...artifact, workflow_run: {id: 124, head_sha: source}}]]) {
    await assert.rejects(() => planDeviceDispatch({github: fake({run: producer, artifacts}).github, context}))
  }
})

test("PR bootstrap or non-dev request callbacks do not reach the private queue", async () => {
  for (const delta of [{event: "pull_request"}, {head_branch: "feature"}]) {
    assert.equal((await planDeviceDispatch({github: fake({run: {...producer, ...delta}}).github, context})).mode, "skip")
  }
})

test("ready request sends immutable source IDs and its authenticated routine to the fixed private workflow", async () => {
  const f = fake({run: producer}), remote = fake()
  const plan = await planDeviceDispatch({...f, context})
  const result = await dispatchReadyRequest({...f, privateGithub: remote.github, context, plan, bytes: bytes(request)})
  assert.equal(result.status, "private-job-requested")
  assert.deepEqual(remote.calls, [["dispatch", {owner: "Mentra-Community", repo: "Mentra-Automated-Testing",
    workflow_id: "device-routine.yml", ref: "main", inputs: {source_repository: repo, request_run_id: "123", request_attempt: "2", routine_id: "day1-ota"}}]])
})

test("no-artifact, removed opt-in and superseded base are not queued", async () => {
  const plan = await planDeviceDispatch({github: fake({run: producer}).github, context})
  for (const [setup, value] of [[{}, {...request, status: "no-artifact", selection: null}],
    [{pull: {...pr, labels: []}}, request], [{baseSha: "f".repeat(40)}, request]]) {
    const f = fake(setup), remote = fake()
    assert.equal((await dispatchReadyRequest({...f, privateGithub: remote.github, context, plan, bytes: bytes(value)})).status, "not-dispatched")
    assert.equal(remote.calls.length, 0)
  }
})

test("mismatched producer JSON and missing dispatch capability fail before private dispatch", async () => {
  const f = fake({run: producer}), remote = fake()
  const plan = await planDeviceDispatch({...f, context})
  for (const value of [{...request, trigger: {...request.trigger, runAttempt: 1}},
    {...request, trigger: {...request.trigger, sha: head}}, {...request, requestId: "other"},
    {...request, selection: {...request.selection, platform: "android"}},
    {...request, routine: {...request.routine, harnessRevision: head}}]) {
    await assert.rejects(() => dispatchReadyRequest({...f, privateGithub: remote.github, context, plan, bytes: bytes(value)}))
  }
  await assert.rejects(() => dispatchReadyRequest({...f, context, plan, bytes: bytes(request)}), /Missing short-lived GitHub App dispatch token/)
  await assert.rejects(() => dispatchReadyRequest({...f, context, plan, bytes: Buffer.alloc(1048577)}), /1 MiB/)
  assert.equal(remote.calls.length, 0)
})

test("all routine labels create independent fenced generations for one exact publication", async () => {
  const routines = ["day1-ota", "no-glasses", "mentra-call"]
  const pull = {...pr, labels: routines.map(routine => ({name: `routine:${routine}`}))}
  const jobs = routines.map(routine => ({...publicationJob, name: publicationJobName(123, 2, routine)}))
  const f = fake({pull, callbackJobs: {[callback.id]: jobs}})
  const plans = (await planDeviceDispatches({...f, context})).filter(plan => plan.mode === "request")
  assert.deepEqual(plans.map(plan => plan.routine), routines)
  for (const plan of plans) assert.equal((await requestAfterPublication({...f, context, plan})).status, "request-dispatched")
  assert.deepEqual(f.calls.filter(([kind]) => kind === "dispatch").map(([, call]) => call.inputs), [
    {pr: "42", routine: "day1-ota", request_origin: "pr-label", source_build_run_id: "123", source_publication_attempt: "2"},
    {pr: "42", routine: "no-glasses", request_origin: "pr-label", source_build_run_id: "123", source_publication_attempt: "2"},
    {pr: "42", routine: "mentra-call", request_origin: "pr-label", source_build_run_id: "123", source_publication_attempt: "2"},
  ])
})

test("a previous day-one send does not consume no-glasses, and no-glasses replay remains fenced", async () => {
  const pull = {...pr, labels: [{name: "routine:no-glasses"}]}
  const noGlassesJob = {...publicationJob, name: publicationJobName(123, 2, "no-glasses")}
  for (const prior of [publicationJob, {...publicationJob, name: "Request publication 123 / attempt 2"},
    {name: "dispatch", status: "completed"}]) {
    const f = fake({run: wake, pull, ...wakeHistory, callbackJobs: {
      [callback.id]: [prior], [wakeCallback.id]: [noGlassesJob],
    }})
    const plan = await planDeviceDispatch({...f, context: wakeContext, routine: "no-glasses"})
    assert.equal((await requestAfterPublication({...f, context: wakeContext, plan})).status, "request-dispatched")
  }
  const replay = fake({run: wake, pull, ...wakeHistory, callbackJobs: {
    [callback.id]: [{...noGlassesJob, status: "completed", conclusion: "failure"}], [wakeCallback.id]: [noGlassesJob],
  }})
  const plan = await planDeviceDispatch({...replay, context: wakeContext, routine: "no-glasses"})
  assert.equal((await requestAfterPublication({...replay, context: wakeContext, plan})).status, "request-reconcile")
  assert.equal(replay.calls.some(([kind]) => kind === "dispatch"), false)
})

test("a completed trusted request has one private callback regardless of registered routine count", async () => {
  const f = fake({run: producer})
  const plans = await planDeviceDispatches({...f, context})
  assert.equal(plans.length, 1)
  assert.equal(plans[0].mode, "dispatch")
  assert.equal(f.calls.filter(([kind]) => kind === "read-artifacts").length, 1)
})

for (const routine of ["no-glasses", "mentra-call"]) test(`explicit trusted ${routine} request queues without a label but retains current PR and base checks`, async () => {
  const manual = {...request, requestId: `routine-123-2-42-${routine}`,
    routine: {...request.routine, id: routine, authorization: "workflow-dispatch"}}
  const f = fake({run: producer, pull: {...pr, labels: []}}), remote = fake()
  const plan = await planDeviceDispatch({...f, context})
  assert.equal((await dispatchReadyRequest({...f, privateGithub: remote.github, context, plan, bytes: bytes(manual)})).status,
    "private-job-requested")
  assert.deepEqual(remote.calls[0][1].inputs, {source_repository: repo, request_run_id: "123", request_attempt: "2", routine_id: routine})
  for (const setup of [{pull: {...pr, state: "closed", labels: []}}, {pull: {...pr, head: {...pr.head, sha: source}, labels: []}},
    {baseSha: source}, {pull: {...pr, base: {ref: "main"}, labels: []}}]) {
    const changed = fake(setup), privateGithub = fake()
    assert.equal((await dispatchReadyRequest({...changed, privateGithub: privateGithub.github, context, plan, bytes: bytes(manual)})).status,
      "not-dispatched")
    assert.equal(privateGithub.calls.length, 0)
  }
  for (const authorization of [undefined, "pr-label"]) {
    const automatic = {...manual, routine: {...manual.routine, authorization}}
    assert.equal((await dispatchReadyRequest({...f, privateGithub: remote.github, context, plan, bytes: bytes(automatic)})).status,
      "not-dispatched")
  }
  for (const routine of [{...manual.routine, id: "unknown"}, {...manual.routine, authorization: "label-free"}])
    await assert.rejects(() => dispatchReadyRequest({...f, context, plan, bytes: bytes({...manual, routine})}))
})

const stagingPr = {...pr, base: {ref: "staging"}}
test("staging PR build, late-label and wake-up callbacks request through the unchanged trusted dev route", async () => {
  for (const [run, callbackContext, setup] of [[build, context, {}], [wake, wakeContext, wakeHistory]]) {
    const f = fake({run, pull: stagingPr, ...setup})
    const plan = await planDeviceDispatch({...f, context: callbackContext})
    assert.deepEqual(plan, {...requestPlan, callbackRunId: callbackContext.runId})
    assert.equal((await requestAfterPublication({...f, context: callbackContext, plan})).status, "request-dispatched")
    const [, dispatch] = f.calls.find(([kind]) => kind === "dispatch")
    assert.equal(dispatch.ref, "dev")
    assert.deepEqual(dispatch.inputs, {pr: "42", routine: "day1-ota", request_origin: "pr-label", source_build_run_id: "123", source_publication_attempt: "2"})
  }
  // A notification-only retry of a staging build is still not a new generation.
  const retained = fake({pull: stagingPr, jobs: [...publishedJobs.map(job => ({...job, id: job.id + 10, run_attempt: 1})), ...publishedJobs]})
  assert.equal((await planDeviceDispatch({...retained, context})).mode, "skip")
})

test("the shared staging wire request dispatches only while its PR base, head, tip and backend still agree", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/pr-routine-requests.json", import.meta.url)))
  const plan = (value) => ({mode: "dispatch", runId: value.trigger.runId, runAttempt: value.trigger.runAttempt, sourceSha: value.trigger.sha})
  const current = (value, delta = {}) => ({number: value.pullRequest.number, state: "open", base: {ref: value.pullRequest.baseRef},
    head: {sha: value.pullRequest.headSha, ref: "feature", repo: {full_name: repo}}, labels: [{name: "routine:day1-ota"}], ...delta})
  for (const name of ["labelCallback", "stagingLabelCallback"]) {
    const value = fixtures[name], f = fake({pull: current(value), baseSha: value.pullRequest.baseSha}), remote = fake()
    const result = await dispatchReadyRequest({...f, privateGithub: remote.github, context, plan: plan(value), bytes: bytes(value)})
    assert.equal(result.status, "private-job-requested")
    assert.deepEqual(f.calls.filter(([kind]) => kind === "read-base"), [["read-base", `heads/${value.pullRequest.baseRef}`]])
    assert.deepEqual(remote.calls[0][1].inputs, {source_repository: repo, request_run_id: "200", request_attempt: "1", routine_id: "day1-ota"})
  }
  const staged = fixtures.stagingLabelCallback
  for (const setup of [{pull: current(staged, {base: {ref: "dev"}})}, {pull: current(staged), baseSha: "f".repeat(40)},
    {pull: current(staged, {head: {sha: "f".repeat(40), ref: "feature", repo: {full_name: repo}}})},
    {pull: current(staged, {labels: []})}, {pull: current(staged, {state: "closed"})}]) {
    const f = fake({baseSha: staged.pullRequest.baseSha, ...setup}), remote = fake()
    assert.equal((await dispatchReadyRequest({...f, privateGithub: remote.github, context, plan: plan(staged), bytes: bytes(staged)})).status, "not-dispatched")
    assert.equal(remote.calls.length, 0)
  }
  for (const change of [v => { v.selection.app.backend = "dev" }, v => { v.pullRequest.baseRef = "dev" },
    v => { v.pullRequest.baseRef = v.selection.app.backend = "main" }, v => { delete v.selection.app }]) {
    const value = structuredClone(staged); change(value)
    const f = fake({pull: current(staged), baseSha: staged.pullRequest.baseSha}), remote = fake()
    await assert.rejects(() => dispatchReadyRequest({...f, privateGithub: remote.github, context, plan: plan(value), bytes: bytes(value)}),
      /destination is not admitted/)
    assert.equal(remote.calls.length, 0)
  }
})

test("workflow matrix preserves trusted code, independent routine fences and disabled POST retries", async () => {
  const workflow = await readFile(new URL("../workflows/dispatch-device-routine.yml", import.meta.url), "utf8")
  assert.match(workflow, /matrix: \$\{\{ fromJSON\(needs\.resolve\.outputs\.matrix\) \}\}/)
  assert.match(workflow, /fail-fast: false/)
  assert.match(workflow, /device-publication-\{0\}-\{1\}-\{2\}/)
  assert.match(workflow, /matrix\.sourceRunId, matrix\.publicationAttempt, matrix\.routine/)
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/)
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.workflow_run\.head_sha/)
  assert.equal((workflow.match(/retries: 0/g) ?? []).length, 3)
  assert.match(workflow, /retry: \{enabled: false\}/)
  assert.match(workflow, /device-coordinated-\{0\}-\{1\}/)
  assert.match(workflow, /Coordinated Mentra Release/)
})

test("observed automatic request metadata selects dispatch while the unrelated push callback skips", async () => {
  // Sanitized API metadata from 2026-09-23. The ready request had no callback;
  // replaying its hypothetical callback verifies selection without sending it.
  const sha = "a0ab47d9ccccba7b5d6177ccce816f1e16f051d3"
  const run = {...producer, id: 35922337673, run_attempt: 1, head_sha: sha}
  const observedArtifact = {...artifact, id: 10777751569, name: "mentra-routine-request-35922337673-1",
    size_in_bytes: 1496, digest: "sha256:9ae30b9dc05cf1a463e199a7afca45a2f8c6f347e4b141196bfbf3527a302e29",
    workflow_run: {id: run.id, head_sha: sha}}
  const ready = fake({run, artifacts: [observedArtifact]})
  const plans = await planDeviceDispatches({...ready,
    context: {...context, sha, payload: {workflow_run: {id: run.id, run_attempt: 1}}}})
  assert.deepEqual(plans, [{mode: "dispatch", runId: run.id, runAttempt: 1, sourceSha: sha,
    artifactId: observedArtifact.id, artifactName: observedArtifact.name}])
  assert.equal(ready.calls.some(([kind]) => kind === "dispatch"), false)

  const push = {...build, id: 35921148279, run_attempt: 1, event: "push", head_branch: "dev",
    head_sha: sha, pull_requests: []}
  const unrelated = fake({run: push})
  const skipped = await planDeviceDispatches({...unrelated, context: {...context, runId: 35922478698,
    sha, payload: {workflow_run: {id: push.id, run_attempt: 1}}}})
  assert.ok(skipped.every(plan => plan.mode === "skip"))
  assert.equal(unrelated.calls.some(([kind]) => kind === "dispatch" || kind === "read-artifacts"), false)
})

const coordinatedJob = (attempt = 2) => ({id: 1000 + attempt, name: COORDINATED_FINALIZE_JOB, run_attempt: attempt,
  status: "completed", conclusion: "success", steps: [{name: COORDINATED_PUBLISH_STEP, status: "completed", conclusion: "success"}]})

test("successful dev and staging builds request independent Mac and Android no-glasses routines through dev", async () => {
  for (const channel of ["dev", "staging"]) {
    const run = {...build, path: ".github/workflows/coordinated-release.yml", event: "push", head_branch: channel, pull_requests: []}
    const job = {...publicationJob, name: publicationJobName(123, 2, "no-glasses", channel)}
    const f = fake({run, jobs: [coordinatedJob()], callbackJobs: {[callback.id]: [job]}})
    const work = (await planDeviceDispatches({...f, context})).filter(plan => plan.mode === "request")
    assert.deepEqual(work.map(plan => plan.routine), ["no-glasses", "no-glasses-android"])
    assert.equal(work[0].routine, "no-glasses")
    assert.equal(work[0].pr, undefined)
    assert.equal((await requestAfterPublication({...f, context, plan: work[0]})).status, "request-dispatched")
    assert.deepEqual(f.calls.at(-1)[1].inputs, {channel, routine: "no-glasses", request_origin: "successful-build",
      source_build_run_id: "123", source_publication_attempt: "2"})
  }
  for (const delta of [{head_branch: "main"}, {conclusion: "failure"}, {event: "pull_request"}]) {
    const run = {...build, path: ".github/workflows/coordinated-release.yml", event: "push", head_branch: "dev", ...delta}
    assert.equal((await planDeviceDispatches({...fake({run}), context})).some(plan => plan.mode === "request"), false)
  }
})

test("coordinated reruns retain one automatic generation even after an ambiguous send", async () => {
  const run = {...build, path: ".github/workflows/coordinated-release.yml", event: "push", head_branch: "dev", run_attempt: 3}
  const nextContext = {...context, runId: 778, payload: {workflow_run: {id: 123, run_attempt: 3}}}
  const next = {...callback, id: 778, run_number: 101, display_title: callbackRunName(123, 3)}
  const job = {...publicationJob, name: publicationJobName(123, 2, "no-glasses", "dev")}
  assert.equal(job.name, publicationJobName(123, 3, "no-glasses", "dev"))
  assert.notEqual(job.name, publicationJobName(124, 3, "no-glasses", "dev"))
  const f = fake({run, jobs: [coordinatedJob()], history: [callback, next], callbackJobs: {
    [callback.id]: [{...job, status: "completed", conclusion: "failure"}], [next.id]: [job]}})
  const plan = await planDeviceDispatch({...f, context: nextContext, routine: "no-glasses"})
  assert.equal((await requestAfterPublication({...f, context: nextContext, plan})).status, "request-reconcile")
  assert.equal(f.calls.some(([kind]) => kind === "dispatch"), false)
})

for (const routine of ["no-glasses", "mentra-call"]) test(`coordinated ${routine} ready requests keep private dispatch limited to authenticated request IDs`, async () => {
  const {options, state} = coordinatedFixture("staging")
  const request = await createRoutineRequest({...options, routine})
  const plan = {mode: "dispatch", runId: 500, runAttempt: 1, sourceSha: options.source.sha}
  const remote = fake()
  const args = {...options, plan, privateGithub: remote.github, bytes: bytes(request)}
  assert.equal((await dispatchReadyRequest(args)).status, "private-job-requested")
  assert.deepEqual(remote.calls[0][1], {owner: "Mentra-Community", repo: "Mentra-Automated-Testing", workflow_id: "device-routine.yml",
    ref: "main", inputs: {source_repository: repo, request_run_id: "500", request_attempt: "1", routine_id: routine}})
  for (const changed of [{...request, pullRequest: {number: 42}}, {...request, schemaVersion: 1},
    {...request, source: {...request.source, channel: "main"}},
    {...request, selection: {...request.selection, archive: {...request.selection.archive, sha256: "a".repeat(64)}}}])
    await assert.rejects(dispatchReadyRequest({...args, bytes: bytes(changed)}))
  state.ancestry = "diverged"
  await assert.rejects(dispatchReadyRequest(args), /ancestor/)
  assert.equal(remote.calls.length, 1)
})

for (const channel of ["dev", "staging"]) test(`queued ${channel} request dispatches once after dev advances`, async () => {
  const {options, state} = coordinatedFixture(channel)
  const request = await createRoutineRequest(options), frozen = bytes(request)
  state.devSha = "f".repeat(40)
  const plan = {mode: "dispatch", runId: 500, runAttempt: 1, sourceSha: options.source.sha}
  const remote = fake()
  assert.equal((await dispatchReadyRequest({...options, plan, privateGithub: remote.github, bytes: frozen})).status,
    "private-job-requested")
  assert.equal(remote.calls.length, 1)
  assert.deepEqual(remote.calls[0][1].inputs, {source_repository: repo, request_run_id: "500", request_attempt: "1", routine_id: "no-glasses"})
  assert.deepEqual(bytes(request), frozen)
  assert.ok(state.calls.some(call => call.compare === `${request.trigger.sha}...${state.devSha}`))
})

test("diverged, missing or forged issuer ancestry cannot dispatch a queued request", async () => {
  const issuer = "b".repeat(40), different = "f".repeat(40)
  const valid = {status: "ahead", base_commit: {sha: issuer}, merge_base_commit: {sha: issuer}}
  for (const ancestry of [null, {}, {...valid, status: "diverged"}, {...valid, status: "behind"},
    {...valid, base_commit: {sha: different}}, {...valid, merge_base_commit: {sha: different}},
    {...valid, base_commit: undefined}, {...valid, merge_base_commit: undefined}]) {
    const {options, state} = coordinatedFixture()
    const request = await createRoutineRequest(options)
    state.devSha = different
    const compare = options.github.rest.repos.compareCommitsWithBasehead
    options.github.rest.repos.compareCommitsWithBasehead = async input => input.basehead.startsWith(`${issuer}...`)
      ? {data: ancestry} : compare(input)
    const plan = {mode: "dispatch", runId: 500, runAttempt: 1, sourceSha: options.source.sha}, remote = fake()
    await assert.rejects(dispatchReadyRequest({...options, plan, privateGithub: remote.github, bytes: bytes(request)}), /issuer is not an ancestor/)
    assert.equal(remote.calls.length, 0)
  }
})


for (const cloned of [false, true]) test(`automatic successful retry selects original publication and creates a ready request (${cloned ? "cloned" : "original-only"} finalizer)`, async () => {
  const {state, options} = coordinatedFixture()
  state.run.id = 123
  state.artifacts[0].workflow_run.id = 123
  const original = {...coordinatedJob(1), started_at: "2026-09-22T00:01:00Z", completed_at: "2026-09-22T00:02:00Z"}
  state.jobs = cloned ? [original, {...original, id: 1002, run_attempt: 2}] : [original]
  const job = {...publicationJob, name: publicationJobName(123, 1, "no-glasses", "dev")}
  const f = fake({run: state.run, jobs: state.jobs, callbackJobs: {[callback.id]: [job]}})
  const plan = await planDeviceDispatch({...f, context, routine: "no-glasses"})
  assert.equal(plan.publicationAttempt, 1)
  assert.equal((await requestAfterPublication({...f, context, plan})).status, "request-dispatched")
  const sent = f.calls.find(([kind]) => kind === "dispatch")[1].inputs
  assert.equal(sent.source_build_run_id, "123")
  assert.equal(sent.source_publication_attempt, "1")
  assert.equal(sent.request_origin, "successful-build")

  options.github.rest.actions.getWorkflowRunAttempt = async input => {
    assert.equal(input.run_id, 123)
    assert.equal(input.attempt_number, 1)
    // The original finalizer succeeded, but a sibling job failed before retry 2.
    return {data: {...state.run, run_attempt: 1, conclusion: "failure"}}
  }
  const request = await createRoutineRequest({...options, channel: sent.channel, routine: sent.routine,
    requestOrigin: sent.request_origin, sourceBuildRunId: sent.source_build_run_id,
    sourcePublicationAttempt: sent.source_publication_attempt})
  assert.equal(request.status, "ready", request.reason)
  assert.equal(request.source.publicationAttempt, 1)
  assert.equal(request.selection.producer.publicationAttempt, 1)
})

test("automatic successful builds cannot substitute an earlier publication after a failed or skipped finalizer", async () => {
  const run = {...build, path: ".github/workflows/coordinated-release.yml", event: "push", head_branch: "dev"}
  for (const job of [{...coordinatedJob(2), conclusion: "failure"}, {...coordinatedJob(2), conclusion: "skipped"},
    {...coordinatedJob(2), steps: [{name: COORDINATED_PUBLISH_STEP, status: "completed", conclusion: "skipped"}]}]) {
    const f = fake({run, jobs: [coordinatedJob(1), job]})
    await assert.rejects(planDeviceDispatch({...f, context, routine: "no-glasses"}), /did not publish/)
    assert.equal(f.calls.some(([kind]) => kind === "dispatch"), false)
  }
})


test("private callback mints a repo-scoped App token only after artifact download in trusted code", async () => {
  const workflow = await readFile(new URL("../workflows/dispatch-device-routine.yml", import.meta.url), "utf8")
  const producer = await readFile(new URL("../workflows/request-e2e-routine.yml", import.meta.url), "utf8")
  const token = workflow.split("      - name: Create scoped private dispatch token\n")[1]?.split("      - name: ")[0]
  assert.ok(token)
  assert.match(token, /if: matrix.mode == 'dispatch'/)
  assert.match(token, /uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3/)
  assert.match(token, /app-id: \$\{\{ vars.TEST_RUN_GITHUB_APP_ID \}\}/)
  assert.match(token, /private-key: \$\{\{ secrets.TEST_RUN_GITHUB_APP_PRIVATE_KEY \}\}/)
  assert.match(token, /owner: Mentra-Community\n          repositories: Mentra-Automated-Testing\n/)
  assert.deepEqual(token.match(/permission-[a-z-]+: [a-z]+/g), ["permission-actions: write"])
  assert.doesNotMatch(token, /skip-token-revoke/)
  const mint = workflow.indexOf("- name: Create scoped private dispatch token")
  assert.ok(workflow.indexOf("- name: Download the exact immutable request artifact") < mint)
  assert.ok(mint < workflow.indexOf("- name: Queue the ready request in the private repository"))
  assert.match(workflow, /TEST_RUN_DISPATCH_TOKEN: \$\{\{ steps.dispatch-token.outputs.token \}\}/)
  assert.doesNotMatch(workflow, /E2E_PRIVATE_DISPATCH_TOKEN|secrets.*PAT/)
  assert.doesNotMatch(producer, /TEST_RUN_GITHUB_APP_PRIVATE_KEY|create-github-app-token|TEST_RUN_DISPATCH_TOKEN/)
})

test("automatic requests use a separate public-repository App token for the callback-producing send", async () => {
  const workflow = await readFile(new URL("../workflows/dispatch-device-routine.yml", import.meta.url), "utf8")
  const step = name => workflow.split(`      - name: ${name}\n`)[1]?.split("      - name: ")[0]
  const token = step("Create scoped public request token"), send = step("Send trusted publication request")
  assert.ok(token && send)
  assert.match(token, /if: matrix.mode == 'request'/)
  assert.match(token, /id: request-token/)
  assert.match(token, /uses: actions\/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3/)
  assert.match(token, /app-id: \$\{\{ vars.TEST_RUN_GITHUB_APP_ID \}\}/)
  assert.match(token, /private-key: \$\{\{ secrets.TEST_RUN_GITHUB_APP_PRIVATE_KEY \}\}/)
  assert.match(token, /owner: Mentra-Community\n          repositories: MentraOS\n/)
  assert.deepEqual(token.match(/permission-[a-z-]+: [a-z]+/g), ["permission-actions: write"])
  assert.doesNotMatch(token, /skip-token-revoke/)
  assert.ok(workflow.indexOf("- name: Create scoped public request token") < workflow.indexOf("- name: Send trusted publication request"))
  assert.match(send, /if: matrix.mode == 'request'/)
  assert.match(send, /github-token: \$\{\{ steps.request-token.outputs.token \}\}/)
  assert.doesNotMatch(send, /github\.token|GITHUB_TOKEN|dispatch-token|PRIVATE_KEY/)
  assert.doesNotMatch(step("Queue the ready request in the private repository"), /request-token/)
})


test("an Android producer callback requests only its matching Android label, and private dispatch preserves platform", async () => {
  const routine = "no-glasses-android"
  const pull = {...pr, labels: [{name: `routine:${routine}`}, {name: "routine:no-glasses"}]}
  const run = {...build, path: ".github/workflows/mentra-app-android-build.yml"}
  const jobs = [{...publishedJobs[0], steps: [{name: "Upload APK to the public artifact CDN", status: "completed", conclusion: "success"}]}]
  const send = {...publicationJob, name: publicationJobName(run.id, run.run_attempt, routine)}
  const f = fake({run, pull, jobs, callbackJobs: {[callback.id]: [send]}})
  const plans = (await planDeviceDispatches({...f, context})).filter(plan => plan.mode === "request")
  assert.deepEqual(plans.map(plan => plan.routine), [routine])
  assert.equal((await requestAfterPublication({...f, context, plan: plans[0]})).status, "request-dispatched")
  assert.equal(f.calls.at(-1)[1].inputs.routine, routine)
  const ready = structuredClone(request)
  ready.routine.id = routine
  ready.requestId = "routine-123-2-42-no-glasses-android"
  ready.selection.platform = "android"
  const remote = fake({pull}), selected = {mode: "dispatch", runId: 123, runAttempt: 2, sourceSha: source}
  await dispatchReadyRequest({...remote, privateGithub: remote.github, context, plan: selected, bytes: Buffer.from(JSON.stringify(ready))})
  assert.equal(remote.calls.at(-1)[1].inputs.routine_id, routine)
  ready.selection.platform = "ios-on-mac"
  await assert.rejects(dispatchReadyRequest({...remote, privateGithub: remote.github, context, plan: selected,
    bytes: Buffer.from(JSON.stringify(ready))}), /Invalid ready selection/)
})
