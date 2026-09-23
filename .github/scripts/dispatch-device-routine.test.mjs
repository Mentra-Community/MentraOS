import {test} from "node:test"
import assert from "node:assert/strict"
import {readFile} from "node:fs/promises"
import {callbackRunName, dispatchReadyRequest, planDeviceDispatch, planDeviceDispatches, publicationJobName, PUBLICATION_SEND_STEP, requestAfterPublication} from "./dispatch-device-routine.mjs"
import {createRoutineRequest} from "./request-e2e-routine.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"

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
  routine: {id: "day1-ota", harnessRevision: source}, pullRequest: {number: 42, headSha: head, baseSha: base},
  selection: {platform: "ios-on-mac", build: {headSha: head, baseSha: base}}}

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
  const listJobsForWorkflowRun = () => {}
  const github = {rest: {
    actions: {getWorkflowRunAttempt: async (input) => {calls.push(["read-attempt", input]); return {data: run}},
      listWorkflowRuns: async (input) => {
        if (input.workflow_id === build.path) {calls.push(["read-builds", input]); return {data: {workflow_runs: builds}}}
        calls.push(["read-callbacks", input]); return {data:
          typeof historyResponse === "function" ? historyResponse(input) : historyResponse ?? {total_count: history.length, workflow_runs: history}}},
      listJobsForWorkflowRun, listWorkflowRunArtifacts: () => {}, createWorkflowDispatch: async (input) => {calls.push(["dispatch", input]); return dispatch()}},
    pulls: {get: async () => ({data: pull})}, git: {getRef: async () => ({data: {object: {sha: baseSha}}})},
  }, paginate: async (method, input) => {
    if (method === listJobsForWorkflowRun) return callbackJobs[input.run_id] ??
      (input.run_id === build.id ? jobs : [])
    calls.push(["read-artifacts", input]); return artifacts
  }}
  return {github, calls, callbackAttempt: 1}
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
    {pull: {...pr, base: {ref: "staging"}}}, {builds: []}, {jobs: []},
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
    {pull: {...pr, state: "closed"}}, {pull: {...pr, base: {ref: "staging"}}},
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
    {callbackJobs: {[callback.id]: [{...publicationJob, run_attempt: 2}]}}]) {
    const f = fake(setup)
    const plan = await planDeviceDispatch({...f, context})
    await assert.rejects(() => requestAfterPublication({...f, context, plan}))
    assert.equal(f.calls.some(([kind]) => kind === "dispatch"), false)
  }
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

test("ready request sends only immutable source IDs to the fixed private workflow", async () => {
  const f = fake({run: producer}), remote = fake()
  const plan = await planDeviceDispatch({...f, context})
  const result = await dispatchReadyRequest({...f, privateGithub: remote.github, context, plan, bytes: bytes(request)})
  assert.equal(result.status, "private-job-requested")
  assert.deepEqual(remote.calls, [["dispatch", {owner: "Mentra-Community", repo: "Mentra-Automated-Testing",
    workflow_id: "device-routine.yml", ref: "main", inputs: {source_repository: repo, request_run_id: "123", request_attempt: "2"}}]])
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
  await assert.rejects(() => dispatchReadyRequest({...f, context, plan, bytes: bytes(request)}), /E2E_PRIVATE_DISPATCH_TOKEN/)
  await assert.rejects(() => dispatchReadyRequest({...f, context, plan, bytes: Buffer.alloc(1048577)}), /1 MiB/)
  assert.equal(remote.calls.length, 0)
})

test("both routine labels create independent fenced generations for one exact publication", async () => {
  const pull = {...pr, labels: [{name: "routine:day1-ota"}, {name: "routine:no-glasses"}]}
  const jobs = ["day1-ota", "no-glasses"].map(routine => ({...publicationJob, name: publicationJobName(123, 2, routine)}))
  const f = fake({pull, callbackJobs: {[callback.id]: jobs}})
  const plans = await planDeviceDispatches({...f, context})
  assert.deepEqual(plans.map(plan => plan.routine), ["day1-ota", "no-glasses"])
  for (const plan of plans) assert.equal((await requestAfterPublication({...f, context, plan})).status, "request-dispatched")
  assert.deepEqual(f.calls.filter(([kind]) => kind === "dispatch").map(([, call]) => call.inputs), [
    {pr: "42", routine: "day1-ota", request_origin: "pr-label", source_build_run_id: "123", source_publication_attempt: "2"},
    {pr: "42", routine: "no-glasses", request_origin: "pr-label", source_build_run_id: "123", source_publication_attempt: "2"},
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

test("explicit trusted no-glasses request queues without a label but retains current PR and base checks", async () => {
  const manual = {...request, requestId: "routine-123-2-42-no-glasses",
    routine: {...request.routine, id: "no-glasses", authorization: "workflow-dispatch"}}
  const f = fake({run: producer, pull: {...pr, labels: []}}), remote = fake()
  const plan = await planDeviceDispatch({...f, context})
  assert.equal((await dispatchReadyRequest({...f, privateGithub: remote.github, context, plan, bytes: bytes(manual)})).status,
    "private-job-requested")
  assert.deepEqual(remote.calls[0][1].inputs, {source_repository: repo, request_run_id: "123", request_attempt: "2"})
  for (const setup of [{pull: {...pr, state: "closed", labels: []}}, {pull: {...pr, head: {...pr.head, sha: source}, labels: []}},
    {baseSha: source}, {pull: {...pr, base: {ref: "staging"}, labels: []}}]) {
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
})
