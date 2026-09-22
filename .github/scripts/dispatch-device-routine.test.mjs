import {test} from "node:test"
import assert from "node:assert/strict"
import {callbackRunName, dispatchReadyRequest, planDeviceDispatch, requestAfterPublication} from "./dispatch-device-routine.mjs"

const repo = "Mentra-Community/MentraOS"
const source = "a".repeat(40), head = "b".repeat(40), base = "c".repeat(40)
const context = {eventName: "workflow_run", runId: 777, sha: source, repo: {owner: "Mentra-Community", repo: "MentraOS"},
  payload: {workflow_run: {id: 123, run_attempt: 2}}}
const pr = {number: 42, state: "open", base: {ref: "dev"},
  head: {sha: head, repo: {full_name: repo}}, labels: [{name: "routine:day1-ota"}]}
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
const requestPlan = {mode: "request", pr: 42, sourceRunId: 123, publicationAttempt: 2, callbackRunId: 777, callbackAttempt: 1}
const dispatchResponse = {status: 200, data: {workflow_run_id: 9000,
  run_url: `https://api.github.com/repos/${repo}/actions/runs/9000`, html_url: `https://github.com/${repo}/actions/runs/9000`}}
function fake({run = build, pull = pr, artifacts = [artifact], baseSha = base, jobs = publishedJobs,
  history = [callback], historyResponse, dispatch = async () => dispatchResponse} = {}) {
  const calls = []
  const listJobsForWorkflowRun = () => {}
  const github = {rest: {
    actions: {getWorkflowRunAttempt: async (input) => {calls.push(["read-attempt", input]); return {data: run}},
      listWorkflowRuns: async (input) => {calls.push(["read-callbacks", input]); return {data:
        typeof historyResponse === "function" ? historyResponse(input) : historyResponse ?? {total_count: history.length, workflow_runs: history}}},
      listJobsForWorkflowRun, listWorkflowRunArtifacts: () => {}, createWorkflowDispatch: async (input) => {calls.push(["dispatch", input]); return dispatch()}},
    pulls: {get: async () => ({data: pull})}, git: {getRef: async () => ({data: {object: {sha: baseSha}}})},
  }, paginate: async (method) => method === listJobsForWorkflowRun ? jobs : artifacts}
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
    return_run_details: true, inputs: {pr: "42", routine: "day1-ota", source_build_run_id: "123", source_publication_attempt: "2"}}])
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
  const f = fake({history: [later, callback]})
  const plan = await planDeviceDispatch({...f, context})
  await requestAfterPublication({...f, context, plan})
  const duplicate = await planDeviceDispatch({...f, context: {...context, runId: later.id}})
  assert.equal(duplicate.mode, "reconcile")
  assert.equal(duplicate.callbackUrl, `https://github.com/${repo}/actions/runs/777`)
  assert.equal((await planDeviceDispatch({...f, context, callbackAttempt: 2})).mode, "reconcile")
  assert.equal(f.calls.filter(([kind]) => kind === "dispatch").length, 1)
})

test("absent, truncated, duplicated or untrusted callback history cannot authorize a send", async () => {
  for (const setup of [{history: []}, {history: [callback, callback]},
    {history: [{...callback, head_sha: head}]}, {history: [{...callback, head_repository: {full_name: "fork/repo"}}]},
    {historyResponse: {total_count: 1000, workflow_runs: [callback]}},
    {historyResponse: {total_count: 2, workflow_runs: [callback]}}]) {
    const f = fake(setup)
    await assert.rejects(() => planDeviceDispatch({...f, context}))
    assert.equal(f.calls.some(([kind]) => kind === "dispatch"), false)
  }
})

test("the complete callback history is paginated and changing history fails closed", async () => {
  const others = Array.from({length: 100}, (_, index) => ({...callback, id: 1000 + index,
    display_title: callbackRunName(1000 + index, 1)}))
  const response = (input) => ({total_count: 101, workflow_runs: input.page === 1 ? others : [callback]})
  const f = fake({historyResponse: response})
  assert.deepEqual(await planDeviceDispatch({...f, context}), requestPlan)
  assert.deepEqual(f.calls.filter(([kind]) => kind === "read-callbacks").map(([, input]) => input.page), [1, 2])
  const changed = fake({historyResponse: (input) => ({...response(input), total_count: input.page === 1 ? 101 : 102})})
  await assert.rejects(() => planDeviceDispatch({...changed, context}), /history changed/)
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
