import assert from "node:assert/strict"
import test from "node:test"
import {readFile} from "node:fs/promises"
import {createRoutineRequest} from "./request-e2e-routine.mjs"
import {dispatchReadyRequest} from "./dispatch-device-routine.mjs"
import {coordinatedFixture} from "./coordinated-routine-fixture.mjs"
import {COORDINATED_WORKFLOW, COORDINATED_FINALIZE_JOB, COORDINATED_PUBLISH_STEP} from "./coordinated-routine-request.mjs"
import {NIGHTLY_SEND_STEP, NIGHTLY_WORKFLOW,
  nightlyDate, nightlyJobName, planNightlyRequests, sendNightlySequence,
  waitForNightlyRequests, dispatchNightlySequence, validateNightlyMarker, authenticateNightlyMarker} from "./nightly-device-routines.mjs"

const repository = "Mentra-Community/MentraOS", sha = "b".repeat(40)
const plan = {date: "2026-09-23", channel: "dev", sourceRunId: 100,
  publicationAttempt: 2, releaseIdentity: "3.3.0-dev.223"}
const current = {id: 5000, run_attempt: 1, event: "schedule", path: NIGHTLY_WORKFLOW,
  head_branch: "dev", head_sha: sha, created_at: "2026-09-23T07:17:00Z",
  repository: {full_name: repository}, head_repository: {full_name: repository}}
const context = {repo: {owner: "Mentra-Community", repo: "MentraOS"}, eventName: "schedule",
  runId: current.id, sha, payload: {schedule: "0 7 * * *"}}
const publicationJob = (id, attempt = 2) => ({id, name: COORDINATED_FINALIZE_JOB, run_attempt: attempt,
  status: "completed", conclusion: "success", steps: [{name: COORDINATED_PUBLISH_STEP, status: "completed", conclusion: "success"}]})
const sendJob = (id, overrides = {}) => ({id, name: nightlyJobName(plan), run_attempt: 1,
  status: "in_progress", conclusion: null, steps: [{name: NIGHTLY_SEND_STEP, status: "in_progress",
    conclusion: null, started_at: "2026-09-23T07:18:00Z"}], ...overrides})

function fixture() {
  const dev = coordinatedFixture(), staging = coordinatedFixture("staging")
  staging.state.run.id = 200
  staging.state.artifacts[0].workflow_run.id = 200
  const publications = new Map([[100, dev.state], [200, staging.state]])
  const state = {requestRuns: new Map(), requestArtifacts: new Map(), run: structuredClone(current), history: [structuredClone(current)],
    candidates: {dev: [dev.state.run], staging: [staging.state.run]},
    jobs: new Map([[100, [publicationJob(1001)]], [200, [publicationJob(2001)]], [5000, [sendJob(50001)]]]),
    historyResponse: null, jobsResponse: null, dispatchResponse: {status: 200, data: {workflow_run_id: 9000,
      html_url: `https://github.com/${repository}/actions/runs/9000`, run_url: `https://api.github.com/repos/${repository}/actions/runs/9000`}},
    dispatchError: false, calls: []}
  const listWorkflowRunArtifacts = () => {}
  const github = {rest: {actions: {
    getWorkflowRun: async input => ({data: input.run_id === current.id ? state.run : state.requestRuns.get(input.run_id)}),
    getWorkflowRunAttempt: async input => {
      state.calls.push(["attempt", input])
      return {data: input.run_id === current.id ? state.run : publications.get(input.run_id)?.run}
    },
    listWorkflowRunArtifacts,
    listWorkflowRuns: async input => {
      state.calls.push(["history", input])
      if (input.workflow_id === COORDINATED_WORKFLOW)
        return {data: {workflow_runs: state.candidates[input.branch]}}
      return {data: state.historyResponse ? state.historyResponse(input) : {total_count: state.history.length, workflow_runs: state.history}}
    },
    listJobsForWorkflowRun: async input => {
      state.calls.push(["jobs", input])
      const jobs = state.jobs.get(input.run_id) ?? []
      return {data: state.jobsResponse ? state.jobsResponse(input) : {total_count: jobs.length, jobs}}
    },
    createWorkflowDispatch: async input => {
      state.calls.push(["dispatch", input])
      if (state.dispatchError) throw new Error("response lost")
      const offset = state.calls.filter(([kind]) => kind === "dispatch").length - 1
      if (state.dispatchResponse?.data?.workflow_run_id === 9000 && offset) return {status: 200,
        data: {workflow_run_id: 9000 + offset, html_url: `https://github.com/${repository}/actions/runs/${9000 + offset}`,
          run_url: `https://api.github.com/repos/${repository}/actions/runs/${9000 + offset}`}}
      return state.dispatchResponse
    },
  }, git: dev.options.github.rest.git, repos: dev.options.github.rest.repos},
  paginate: async (method, input) => {
    assert.equal(method, listWorkflowRunArtifacts)
    return state.requestArtifacts.get(input.run_id) ?? publications.get(input.run_id)?.artifacts ?? []
  }}
  const options = {github, context, attempt: 1, fetchImpl: (url, init) =>
    (url.includes("-beta.") ? staging : dev).options.fetchImpl(url, init)}
  return {state, options, dev, staging, publications}
}

test("only one UTC trigger covers LA midnight, including both DST transition dates", () => {
  for (const [day, active] of [["2026-01-13", 8], ["2026-09-23", 7],
    ["2026-03-08", 8], ["2026-03-09", 7], ["2026-11-01", 7], ["2026-11-02", 8]]) {
    for (const hour of [7, 8]) assert.equal(nightlyDate(`0 ${hour} * * *`, `${day}T0${hour}:17:00Z`), hour === active ? day : null)
  }
})

test("delayed triggers retain intended local date but cannot drift past the bounded delivery window", () => {
  assert.equal(nightlyDate("0 7 * * *", "2026-09-23T12:59:59Z"), "2026-09-23")
  assert.equal(nightlyDate("0 8 * * *", "2026-01-13T13:59:59Z"), "2026-01-13")
  for (const value of ["2026-09-23T06:59:59Z", "2026-09-23T13:00:00Z", "invalid"])
    assert.throws(() => nightlyDate("0 7 * * *", value))
  assert.throws(() => nightlyDate("0 0 * * *", current.created_at))
})

test("planner selects exact verified publications for both channels and only advanced routines", async () => {
  const f = fixture(), result = await planNightlyRequests(f.options)
  assert.deepEqual(result.requests.map(({date, channel, sourceRunId, publicationAttempt}) =>
    ({date, channel, sourceRunId, publicationAttempt})), ["dev", "staging"].map(channel =>
    ({date: "2026-09-23", channel, sourceRunId: channel === "dev" ? 100 : 200, publicationAttempt: 2})))
  assert.deepEqual(result.unavailable, [])
  assert.equal(f.state.calls.some(([kind]) => kind === "dispatch"), false)
})

test("newer dry-run and missing-artifact successes cannot replace the latest real publication", async () => {
  const f = fixture()
  const dry = {...f.dev.state.run, id: 102, event: "workflow_dispatch", created_at: "2026-09-23T03:00:00Z"}
  const missing = {...f.dev.state.run, id: 101, created_at: "2026-09-23T02:00:00Z"}
  f.state.candidates.dev = [f.dev.state.run, missing, dry]
  f.state.jobs.set(102, [{...publicationJob(1021), steps: [{name: COORDINATED_PUBLISH_STEP, status: "completed", conclusion: "skipped"}]}])
  f.state.jobs.set(101, [publicationJob(1011)])
  f.publications.set(102, {run: dry, artifacts: [{...f.dev.state.artifacts[0], workflow_run: {id: 102, head_sha: dry.head_sha}}]})
  f.publications.set(101, {run: missing, artifacts: []})
  const result = await planNightlyRequests(f.options)
  assert.ok(result.requests.filter(row => row.channel === "dev").every(row => row.sourceRunId === 100))
  assert.equal(f.state.calls.some(([kind, input]) => kind === "jobs" && input.run_id === 102), true)
})

test("a successful earlier attempt cannot qualify the selected publication retry", async () => {
  const f = fixture()
  f.state.jobs.set(100, [publicationJob(1001, 1), {...publicationJob(1002), conclusion: "skipped"}])
  const result = await planNightlyRequests(f.options)
  assert.deepEqual(result.unavailable.map(row => row.channel), ["dev"])
  assert.ok(result.requests.length === 1 && result.requests.every(row => row.channel === "staging"))
})

test("one unavailable or unreadable channel preserves the other channel requests", async () => {
  for (const candidates of [[], undefined]) {
    const f = fixture(); f.state.candidates.staging = candidates
    const result = await planNightlyRequests(f.options)
    assert.deepEqual(result.unavailable.map(row => row.channel), ["staging"])
    assert.equal(result.requests.length, 1)
    assert.ok(result.requests.every(row => row.channel === "dev"))
  }
})

test("wrong UTC trigger is a no-op; reruns and untrusted workflow identities cannot plan sends", async () => {
  const f = fixture()
  f.state.run.created_at = "2026-09-23T08:00:00Z"
  const skipped = await planNightlyRequests({...f.options, context: {...context, payload: {schedule: "0 8 * * *"}}})
  assert.deepEqual(skipped.requests, [])
  assert.deepEqual(skipped.unavailable, [])
  assert.equal(f.state.calls.length, 0)
  for (const patch of [{event: "workflow_dispatch"}, {head_branch: "staging"}, {head_sha: "c".repeat(40)},
    {path: ".github/workflows/untrusted.yml"}, {repository: {full_name: "fork/MentraOS"}}]) {
    const bad = fixture(); Object.assign(bad.state.run, patch)
    await assert.rejects(planNightlyRequests(bad.options), /identity/)
  }
  const retry = fixture(); retry.state.run.run_attempt = 2
  await assert.rejects(planNightlyRequests({...retry.options, attempt: 2}), /reconciliation/)
  assert.equal(retry.state.calls.length, 0)
})

test("nightly sends distinct marked members for the same exact publication", async () => {
  const f = fixture(), result = await sendNightlySequence({...f.options, plan})
  assert.equal(result.status, "requests-dispatched")
  assert.deepEqual(result.members, [{routine: "day1-ota", runId: 9000, runAttempt: 1},
    {routine: "mentra-call", runId: 9001, runAttempt: 1}])
  assert.deepEqual(f.state.calls.filter(([kind]) => kind === "dispatch"), ["day1-ota", "mentra-call"].map(routine =>
    ["dispatch", {...context.repo, workflow_id: ".github/workflows/request-e2e-routine.yml", ref: "dev", return_run_details: true,
      inputs: {channel: "dev", routine, request_origin: "workflow-dispatch", source_build_run_id: "100",
        source_publication_attempt: "2", nightly_run_id: "5000", nightly_run_attempt: "1"}}]))
})

test("invalid nightly coordinates cannot enter dispatch history or send", async () => {
  for (const patch of [{date: "2026-09-22"}, {channel: "main"}, {routine: "no-glasses"},
    {routine: "arbitrary"}, {sourceRunId: 0}, {publicationAttempt: 1.5}]) {
    const f = fixture()
    await assert.rejects(sendNightlySequence({...f.options, plan: {...plan, ...patch}}), /Invalid nightly/)
    assert.equal(f.state.calls.length, 0)
  }
})

test("lost or malformed sends remain unknown and reruns never send again", async () => {
  for (const reply of [null, {status: 204}, {status: 200, data: {workflow_run_id: 9000}},
    {status: 200, data: {workflow_run_id: 9000, html_url: "https://example.test", run_url: "https://example.test"}}]) {
    const f = fixture(); f.state.dispatchError = reply === null; f.state.dispatchResponse = reply
    await assert.rejects(sendNightlySequence({...f.options, plan}), /outcome is unknown/)
    assert.equal(f.state.calls.filter(([kind]) => kind === "dispatch").length, 1)
    f.state.run.run_attempt = 2
    await assert.rejects(sendNightlySequence({...f.options, attempt: 2, plan}), /Invalid nightly/)
    assert.equal(f.state.calls.filter(([kind]) => kind === "dispatch").length, 1)
  }
})

test("an earlier started send owns the date/channel even when failed or response was lost", async () => {
  for (const conclusion of ["success", "failure", "cancelled", null]) {
    const f = fixture(), prior = {...current, id: 4999}
    f.state.history.push(prior)
    f.state.jobs.set(prior.id, [sendJob(49991, {status: "completed", conclusion})])
    await assert.rejects(sendNightlySequence({...f.options, plan}), /earlier nightly owns/)
    assert.equal(f.state.calls.some(([kind]) => kind === "dispatch"), false)
  }
})

test("a queued cancellation before send and other dates/channels do not consume this generation", async () => {
  const f = fixture(), prior = {...current, id: 4999}
  f.state.history.push(prior)
  f.state.jobs.set(prior.id, [
    sendJob(49991, {status: "completed", conclusion: "cancelled", steps: []}),
    sendJob(49992, {name: nightlyJobName({...plan, date: "2026-09-22"})}),
    sendJob(49993, {name: nightlyJobName({...plan, channel: "staging"})}),

  ])
  assert.equal((await sendNightlySequence({...f.options, plan})).status, "requests-dispatched")
})

test("missing, partial, duplicated or foreign run/job history cannot authorize a send", async () => {
  const patches = [
    f => f.state.history = [],
    f => f.state.history = [{...current, id: 4999}],
    f => f.state.history = [current, current],
    f => f.state.history = [{...current, head_repository: {full_name: "fork/MentraOS"}}],
    f => f.state.historyResponse = () => ({total_count: 2, workflow_runs: [current]}),
    f => f.state.historyResponse = () => ({total_count: 1000, workflow_runs: [current]}),
    f => f.state.jobs.set(5000, []),
    f => f.state.jobs.set(5000, [sendJob(50001, {steps: undefined})]),
    f => f.state.jobs.set(5000, [sendJob(50001), sendJob(50001)]),
    f => f.state.jobsResponse = () => ({total_count: 2, jobs: [sendJob(50001)]}),
    f => f.state.jobs.set(5000, [sendJob(50001, {run_attempt: 2})]),
    f => f.state.jobs.set(5000, [sendJob(50001, {steps: [{name: NIGHTLY_SEND_STEP, status: "completed", conclusion: "skipped"}]})]),
  ]
  for (const mutate of patches) {
    const f = fixture(); mutate(f)
    await assert.rejects(sendNightlySequence({...f.options, plan}))
    assert.equal(f.state.calls.some(([kind]) => kind === "dispatch"), false)
  }
})

test("complete multi-page history is read and changing totals fail closed", async () => {
  const f = fixture()
  const older = Array.from({length: 100}, (_, i) => ({...current, id: 4000 + i}))
  for (const run of older) f.state.jobs.set(run.id, [{id: run.id * 10, name: "plan", steps: []}])
  f.state.historyResponse = input => ({total_count: 101, workflow_runs: input.page === 1 ? older : [current]})
  assert.equal((await sendNightlySequence({...f.options, plan})).status, "requests-dispatched")
  assert.equal(f.state.calls.filter(([kind, input]) => kind === "history" && input.workflow_id === NIGHTLY_WORKFLOW).length, 2)
  f.state.calls = []
  f.state.historyResponse = input => ({total_count: input.page === 1 ? 101 : 102, workflow_runs: input.page === 1 ? older : [current]})
  await assert.rejects(sendNightlySequence({...f.options, plan}), /history changed/)
  assert.equal(f.state.calls.some(([kind]) => kind === "dispatch"), false)
})

test("the current send can be found on a later complete job page", async () => {
  const f = fixture(), otherJobs = Array.from({length: 100}, (_, i) => ({id: i + 1, name: "other", steps: []}))
  f.state.jobsResponse = input => ({total_count: 101, jobs: input.page === 1 ? otherJobs : [sendJob(50001)]})
  assert.equal((await sendNightlySequence({...f.options, plan})).status, "requests-dispatched")
  assert.equal(f.state.calls.filter(([kind]) => kind === "jobs").length, 2)
})

test("workflow is opt-in, preserves other eligible channels, and sends through trusted source with no retries", async () => {
  const workflow = await readFile(new URL("../workflows/nightly-device-routines.yml", import.meta.url), "utf8")
  const coordinated = await readFile(new URL("../workflows/coordinated-release.yml", import.meta.url), "utf8")
  assert.match(workflow, /vars\.DEVICE_ROUTINE_NIGHTLY_ENABLED == 'true'/)
  assert.match(workflow, /cron: '0 7 \* \* \*'/)
  assert.match(workflow, /cron: '0 8 \* \* \*'/)
  assert.match(workflow, /availability:\n    needs: plan/)
  assert.match(workflow, /core\.setFailed\('Some channels have no verified retained publication/)
  assert.match(workflow, /request:\n    needs: plan/)
  assert.doesNotMatch(workflow, /needs:.*availability/)
  assert.match(workflow, /fail-fast: false/)
  assert.match(workflow, /group: nightly-device-\$\{\{ matrix.date \}\}-\$\{\{ matrix.channel \}\}/)
  assert.doesNotMatch(workflow, /matrix.routine/)
  assert.match(workflow, /Queue one private OTA then Call job/)
  assert.equal((workflow.match(/uses: actions\/download-artifact@v4/g) ?? []).length, 2)
  assert.match(workflow, /E2E_PRIVATE_DISPATCH_TOKEN: \$\{\{ secrets.E2E_PRIVATE_DISPATCH_TOKEN \}\}/)
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/)
  assert.equal((workflow.match(/retries: 0/g) ?? []).length, 4)
  assert.doesNotMatch(workflow, /workflow_dispatch:|self-hosted|mentra-device-worker/)
  assert.ok(coordinated.includes(`name: ${COORDINATED_FINALIZE_JOB}`))
  assert.ok(coordinated.includes(`name: ${COORDINATED_PUBLISH_STEP}`))
})

async function sequenceFixture() {
  const f = fixture()
  const sent = await sendNightlySequence({...f.options, plan})
  const requests = []
  for (const member of sent.members) {
    const request = await createRoutineRequest({...f.dev.options, github: f.options.github,
      context: {...f.dev.options.context, runId: member.runId}, routine: member.routine,
      nightlyRunId: current.id, nightlyRunAttempt: 1})
    assert.equal(request.status, "ready")
    requests.push(request)
    f.state.requestRuns.set(member.runId, {...current, id: member.runId, event: "workflow_dispatch",
      path: ".github/workflows/request-e2e-routine.yml", status: "completed", conclusion: "success"})
    f.state.requestArtifacts.set(member.runId, [{id: member.runId + 1000, expired: false,
      name: `mentra-routine-request-${member.runId}-1`, size_in_bytes: 4000, digest: `sha256:${"f".repeat(64)}`,
      workflow_run: {id: member.runId, head_sha: sha}}])
  }
  const ready = await waitForNightlyRequests({...f.options, sent})
  const privateCalls = []
  const privateGithub = {rest: {actions: {createWorkflowDispatch: async input => {
    privateCalls.push(input); return {status: 204}
  }}}}
  const options = {...f.options, privateGithub, plan, ready, bytes: requests.map(request => Buffer.from(JSON.stringify(request)))}
  return {...f, sent, requests, ready, privateCalls, sequenceOptions: options}
}

test("real request producers create two authenticated artifacts and queue one private job with exact request coordinates", async () => {
  const f = await sequenceFixture()
  assert.deepEqual(f.requests.map(request => request.sequence), ["day1-ota", "mentra-call"].map(member =>
    ({kind: "nightly-ota-call", runId: 5000, runAttempt: 1, member})))
  assert.equal((await dispatchNightlySequence(f.sequenceOptions)).status, "private-sequence-requested")
  assert.deepEqual(f.privateCalls, [{owner: "Mentra-Community", repo: "Mentra-Automated-Testing",
    workflow_id: "nightly-device-routines.yml", ref: "main", inputs: {source_repository: repository,
      ota_request_run_id: "9000", ota_request_attempt: "1", call_request_run_id: "9001", call_request_attempt: "1"}}])
})

test("marked callbacks never dispatch either member separately, including no-artifact members", async () => {
  const f = await sequenceFixture()
  for (const request of f.requests) for (const status of ["ready", "no-artifact"]) {
    const result = await dispatchReadyRequest({...f.options, privateGithub: f.sequenceOptions.privateGithub,
      plan: {mode: "dispatch", runId: request.trigger.runId, runAttempt: 1, sourceSha: sha},
      bytes: Buffer.from(JSON.stringify({...request, status}))})
    assert.equal(result.status, "not-dispatched")
    assert.match(result.reason, /sequence member/)
  }
  assert.equal(f.privateCalls.length, 0)
})

test("malformed or foreign markers never downgrade to standalone requests", async () => {
  const f = await sequenceFixture()
  const mutations = [r => r.sequence = null, r => r.sequence.runId = 0, r => r.sequence.runAttempt = 2,
    r => r.sequence.member = "mentra-call", r => r.sequence.kind = "other", r => r.sequence.extra = true,
    r => r.schemaVersion = 1, r => r.source.channel = "main", r => r.routine.authorization = "successful-build"]
  for (const mutate of mutations) {
    const request = structuredClone(f.requests[0]); mutate(request)
    assert.throws(() => validateNightlyMarker(request), /Invalid nightly/)
    await assert.rejects(dispatchReadyRequest({...f.options, privateGithub: f.sequenceOptions.privateGithub,
      plan: {mode: "dispatch", runId: request.trigger.runId, runAttempt: 1, sourceSha: sha},
      bytes: Buffer.from(JSON.stringify(request))}))
  }
  assert.equal(validateNightlyMarker({schemaVersion: 1}), null)
  assert.equal(f.privateCalls.length, 0)
})

test("producer authenticates scheduled source and entered send; stale, manual and missing send sources fail", async () => {
  for (const change of [f => f.state.run.event = "workflow_dispatch", f => f.state.run.head_branch = "staging",
    f => f.state.run.head_repository.full_name = "foreign/repo", f => f.state.run.run_attempt = 2,
    f => f.state.jobs.set(5000, [{id: 501, name: "other", steps: []}]),
    f => f.state.jobs.set(5000, [sendJob(501, {steps: [{name: NIGHTLY_SEND_STEP, status: "queued"}]})])]) {
    const f = await sequenceFixture(); change(f)
    await assert.rejects(authenticateNightlyMarker({...f.options, request: f.requests[0]}))
  }
  const f = fixture()
  await assert.rejects(createRoutineRequest({...f.dev.options, channel: "pr", number: 1,
    nightlyRunId: 5000, nightlyRunAttempt: 1}), /require a coordinated channel/)
  await assert.rejects(createRoutineRequest({...f.dev.options, github: f.options.github,
    nightlyRunId: 5000, nightlyRunAttempt: 1}), /Invalid nightly sequence marker/)
})

test("readiness waits are bounded and never resend; one failure or retry prevents the private job", async () => {
  for (const mutate of [f => f.state.requestRuns.get(9001).conclusion = "failure",
    f => f.state.requestRuns.get(9001).run_attempt = 2,
    f => f.state.requestRuns.get(9001).head_branch = "staging",
    f => f.state.requestArtifacts.get(9001).push({...f.state.requestArtifacts.get(9001)[0], id: 99999}),
    f => f.state.requestArtifacts.get(9001)[0].workflow_run.head_sha = "f".repeat(40),
    f => f.state.requestArtifacts.get(9001)[0].digest = "absent"]) {
    const f = await sequenceFixture(); mutate(f)
    await assert.rejects(waitForNightlyRequests({...f.options, sent: f.sent}))
    assert.equal(f.state.calls.filter(([kind]) => kind === "dispatch").length, 2)
    assert.equal(f.privateCalls.length, 0)
  }
  const f = await sequenceFixture(); f.state.requestRuns.get(9001).status = "queued"
  let clock = 0, sleeps = 0
  await assert.rejects(waitForNightlyRequests({...f.options, sent: f.sent, timeoutMs: 30_000,
    now: () => clock, sleep: async ms => {clock += ms; sleeps++}}), /deadline/)
  assert.equal(sleeps, 2)
  assert.equal(f.state.calls.filter(([kind]) => kind === "dispatch").length, 2)
})

test("both full published selections, markers and producer identities must agree before private dispatch", async () => {
  const mutations = [r => r.selection.archive.sha256 = "a".repeat(64), r => r.selection.otaManifest.size++,
    r => r.selection.receipt.url += "?different", r => r.selection.app.build = "different",
    r => r.source.buildRunId++, r => r.source.publicationAttempt++, r => r.source.channel = "staging",
    r => r.sequence.runId++, r => r.sequence.member = "day1-ota", r => r.trigger.sha = "f".repeat(40),
    r => r.trigger.runId--, r => r.status = "no-artifact", r => delete r.sequence]
  for (const mutate of mutations) {
    const f = await sequenceFixture(); mutate(f.requests[1])
    await assert.rejects(dispatchNightlySequence({...f.sequenceOptions,
      bytes: f.requests.map(request => Buffer.from(JSON.stringify(request)))}))
    assert.equal(f.privateCalls.length, 0)
  }
})

test("partial and ambiguous dispatches never retry or queue a replacement generation", async () => {
  const f = fixture()
  const dispatch = f.options.github.rest.actions.createWorkflowDispatch
  f.options.github.rest.actions.createWorkflowDispatch = async input => {
    if (input.inputs.routine === "mentra-call") throw new Error("response lost")
    return dispatch(input)
  }
  await assert.rejects(sendNightlySequence({...f.options, plan}), /unknown/)
  assert.equal(f.state.calls.filter(([kind]) => kind === "dispatch").length, 1)
  const ready = await sequenceFixture()
  ready.sequenceOptions.privateGithub.rest.actions.createWorkflowDispatch = async input => {
    ready.privateCalls.push(input); throw new Error("response lost")
  }
  await assert.rejects(dispatchNightlySequence(ready.sequenceOptions), /unknown/)
  assert.equal(ready.privateCalls.length, 1)
  ready.state.run.run_attempt = 2
  await assert.rejects(dispatchNightlySequence({...ready.sequenceOptions, attempt: 2}))
  assert.equal(ready.privateCalls.length, 1)
})

test("legacy nightly member send history also fences the whole channel sequence", async () => {
  const f = fixture(), prior = {...current, id: 4999}
  f.state.history.push(prior)
  f.state.jobs.set(prior.id, [sendJob(49991, {name: "Nightly 2026-09-23 / dev / mentra-call", steps: [
    {name: "Send the nightly routine request", status: "completed", conclusion: "failure", started_at: current.created_at}]
  })])
  await assert.rejects(sendNightlySequence({...f.options, plan}), /earlier nightly owns/)
  assert.equal(f.state.calls.some(([kind]) => kind === "dispatch"), false)
})

test("duplicate member acknowledgements and duplicate ready coordinates fail closed", async () => {
  const f = fixture()
  let sends = 0
  f.options.github.rest.actions.createWorkflowDispatch = async () => {sends++; return f.state.dispatchResponse}
  await assert.rejects(sendNightlySequence({...f.options, plan}), /unknown/)
  assert.equal(sends, 2)
  const ready = await sequenceFixture()
  const duplicate = structuredClone(ready.sent)
  duplicate.members[1].runId = duplicate.members[0].runId
  await assert.rejects(waitForNightlyRequests({...ready.options, sent: duplicate}), /acknowledgements/)
  assert.equal(ready.privateCalls.length, 0)
})
