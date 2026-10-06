import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import test from "node:test"
import {applyRoutineResult, ROUTINE_BLOCK} from "./release-slack-message.mjs"
import {jobName, prepareRoutineUpdate, readActionsJson, resolveRoutineNotifications, resolveRoutineSelectors, resolveRoutineResults,
  launchRoutineResultNotifications, stateName, WORKFLOW} from "./release-routine-slack.mjs"
import {boundRoutineResult} from "./routine-api.mjs"
import {routineFixture, terminalRoutineFixture} from "./routine-api-fixture.mjs"
import {renderPrRoutineResult, publishPrRoutineResult} from "./pr-routine-result.mjs"
const repo = {owner: "Mentra-Community", repo: "MentraOS"}, repository = "Mentra-Community/MentraOS"
const context = {repo, eventName: "workflow_dispatch", ref: "refs/heads/dev", runId: 701}
const run = (id, overrides = {}) => ({id, run_attempt: 1, head_sha: "a".repeat(40), head_branch: "dev", event: "workflow_dispatch", status: "completed", conclusion: "success",
  path: WORKFLOW, repository: {full_name: repository}, head_repository: {full_name: repository}, created_at: "2026-10-03T00:00:00Z", ...overrides})
function fixture() {
  const f = routineFixture({channel: "dev"}), notification = {schemaVersion: 2, kind: "mentra-release-slack-message",
    build: {repository, channel: "dev", runId: 10, headSha: f.build.headSha, release: f.build.releaseIdentity, artifacts: {[f.request.input.platform]: f.build.archive.sha256}},
    producer: {runId: 10, runAttempt: 2, headSha: f.build.headSha}, message: {channel: "CDEV", ts: "100.123", botId: "BBUILDS"},
    payload: {blocks: [{type: "section", text: {type: "mrkdwn", text: "Original downloads"}}, {type: "section", block_id: ROUTINE_BLOCK, text: {type: "mrkdwn", text: "Available"}}]}, rows: {}}
  return {...f, notification, plan: {notification, row: boundRoutineResult(f.detail), sourceCreatedAt: "2026-10-03T00:00:00Z"}}
}
test("bound frozen platform archive resolves exact editable release post", async () => {
  const f = fixture(), github = {rest: {actions: {getWorkflowRunAttempt: async () => ({data: run(10, {run_attempt: 2, path: ".github/workflows/coordinated-release.yml"})}), listWorkflowRunArtifacts: () => {}}},
    paginate: async () => [{id: 1, name: "release-slack-message-10-2"}]}
  const options = {github, context, details: [f.detail], read: async () => ({"slack-release-message.json": f.notification})}
  assert.equal((await resolveRoutineNotifications(options))[0].row.title, f.definition.title)
  f.notification.build.artifacts["ios-on-mac"] = "f".repeat(64); await assert.rejects(resolveRoutineNotifications(options), /archive differs/)
})
test("obsolete release receipt formats are refused rather than adapted", async () => {
  const f = fixture()
  f.notification.schemaVersion = 1
  const github = {rest: {actions: {getWorkflowRunAttempt: async () => ({data: run(10, {run_attempt: 2, path: ".github/workflows/coordinated-release.yml"})}), listWorkflowRunArtifacts: () => {}}},
    paginate: async () => [{id: 1, name: "release-slack-message-10-2"}]}
  await assert.rejects(resolveRoutineNotifications({github, context, details: [f.detail],
    read: async () => ({"slack-release-message.json": f.notification})}), /Invalid retained release message/)
})

test("explicit notification selector is validated; only current-attempt callback artifacts are read", async () => {
  assert.deepEqual(await resolveRoutineSelectors({context, requestId: "example-request"}), ["example-request"])
  await assert.rejects(resolveRoutineSelectors({context, requestId: "../invalid"}), /selector/)
  const producer = run(10, {path: ".github/workflows/request-e2e-routine.yml"})
  const github = {rest: {actions: {getWorkflowRunAttempt: async () => ({data: producer}), listWorkflowRunArtifacts: () => {}}}, paginate: async () => [{id: 1, name: "routine-dispatches-10-1"}, {id: 2, name: "routine-dispatches-10-2"}]}
  const ids = await resolveRoutineSelectors({github, context: {...context, eventName: "workflow_run", payload: {workflow_run: producer}},
    read: async (_github, _repo, _run, name) => {
      assert.equal(name, "routine-dispatches-10-1");
      return {"routine-dispatches.json": {requestIds: ["new-check-request", "second-check-request"]}}
    }})
  assert.deepEqual(ids, ["new-check-request", "second-check-request"])
})
test("retained state applies every prior row before a later independently completed request", async () => {
  const f = fixture(), previousRow = {...f.plan.row, routineId: "previous-check", title: "Previous check", requestId: "previous-request", resultRunId: "previous-request"}
  const prior = applyRoutineResult(f.notification, previousRow), priorRun = run(700), currentRun = run(701, {status: "in_progress", event: "workflow_run"})
  const jobs = new Map([[700, [{id: 100, name: jobName({...f.plan, row: previousRow}), run_attempt: 1, status: "completed", started_at: "2026-10-03T12:00:00Z", completed_at: "2026-10-03T12:01:00Z"}]],
    [701, [{id: 101, name: jobName(f.plan), run_attempt: 1, status: "in_progress", started_at: "2026-10-03T12:02:00Z"}]]])
  const github = {rest: {actions: {listWorkflowRuns: async () => ({data: {total_count: 2, workflow_runs: [priorRun, currentRun]}}), listJobsForWorkflowRun: "jobs", listWorkflowRunArtifacts: "artifacts"}},
    paginate: async (method, input) => method === "jobs" ? jobs.get(input.run_id) : [{id: 1, name: stateName(700, 1, previousRow.requestId)}]}
  let saved
  const state = await prepareRoutineUpdate({github, context, plan: f.plan, runAttempt: 1,
    read: async () => ({"slack-update-state.json": prior}), write: async (_, body) => {saved = JSON.parse(body)}})
  assert.equal(Object.keys(state.rows).length, 2); assert.deepEqual(saved, state)
  assert.equal(state.payload.blocks[0].text.text, "Original downloads")
  github.paginate = async (method, input) => method === "jobs" ? jobs.get(input.run_id) : []
  jobs.get(700)[0].steps = [{name: "Update original Slack message", started_at: "2026-10-03T12:00:01Z", conclusion: "success"}]
  await assert.rejects(prepareRoutineUpdate({github, context, plan: f.plan, runAttempt: 1, write: async () => {}}), /refusing to erase/)
})
test("GitHub JSON reader verifies digest, file set and bounds without extracting archive", async () => {
  const bytes = Buffer.from("fixture zip"), artifact = {id: 1, name: "receipt", expired: false, size_in_bytes: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, workflow_run: {id: 10, head_sha: "a".repeat(40)}}
  const github = {rest: {actions: {listWorkflowRunArtifacts: () => {}, downloadArtifact: async () => ({data: bytes})}}, paginate: async () => [artifact]}
  assert.deepEqual(await readActionsJson(github, repo, run(10), "receipt", ["data.json"], {readZip: async () => ({"data.json": {ok: true}})}), {"data.json": {ok: true}})
  artifact.digest = `sha256:${"f".repeat(64)}`; await assert.rejects(readActionsJson(github, repo, run(10), "receipt", ["data.json"], {readZip: async () => ({})}), /digest differs/)
})

test("fanout child workflows publish rejected request and pass before a transient neighbor fails", async () => {
  const rejected = terminalRoutineFixture(), passed = routineFixture({routineId: "second.arbitrary-check"})
  const details = new Map([["rejected", rejected.detail], ["passed", passed.detail]])
  let releaseTransient, startedTransient
  const started = new Promise(resolve => {startedTransient = resolve}), transient = new Promise((_, reject) => {releaseTransient = reject})
  const comments = [], github = {paginate: async () => [], rest: {issues: {listComments: () => {}, createComment: async plan => {
    comments.push(plan.body); return {data: {id: comments.length}}
  }}}}
  const f = fanoutFixture(), childResults = []
  f.github.rest.actions.createWorkflowDispatch = async ({inputs}) => {
    // Dispatch acknowledges a child; its own result wait and publication run independently.
    const child = resolveRoutineResults({requestIds: [inputs.request_id], wait: async ({requestId}) => {
      if (requestId === "transient") {startedTransient(); return transient}
      return details.get(requestId)
    }}).then(([detail]) => publishPrRoutineResult({github, context, plan: renderPrRoutineResult(detail)}))
    childResults.push(child.then(value => ({status: "fulfilled", value}), reason => ({status: "rejected", reason})))
  }
  const launches = await launchRoutineResultNotifications({...f, requestIds: ["transient", "rejected", "passed"]})
  assert.equal(launches.length, 3)
  await started
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(comments.length, 2) // Publication is not waiting for the neighboring API outage.
  assert.ok(comments.some(body => body.includes("No framework result has been published")))
  assert.ok(comments.some(body => body.includes("Recording and full result")))
  releaseTransient(new Error("Core API remained unavailable"))
  const children = await Promise.all(childResults)
  assert.equal(children.filter(child => child.status === "fulfilled").length, 2)
  assert.equal(children[0].status, "rejected"); assert.match(children[0].reason.message, /Core API remained unavailable/)
})

test("release receipt updates retain a published pass alongside an immediately rejected request", () => {
  const f = fixture(), rejected = terminalRoutineFixture({channel: "dev", routineId: "unavailable.other-check"})
  const receipt = boundRoutineResult(rejected.detail), updated = applyRoutineResult(applyRoutineResult(f.notification, f.plan.row), receipt)
  assert.equal(Object.keys(updated.rows).length, 2)
  assert.equal(updated.rows[`${receipt.routineId}:${receipt.platform}`].resultRunId, undefined)
  assert.match(updated.payload.blocks[1].text.text, /Passed/)
  assert.match(updated.payload.blocks[1].text.text, /Not run.*Request receipt/)
  assert.match(updated.payload.blocks[1].text.text, /Installed host cannot execute/)
})

function fanoutFixture() {
  const producer = run(10, {path: ".github/workflows/request-e2e-routine.yml"}), current = run(701, {status: "in_progress", event: "workflow_run"})
  const launches = [], github = {rest: {actions: {getWorkflowRunAttempt: async () => ({data: producer}),
    getWorkflowRun: async () => ({data: current}),
    createWorkflowDispatch: async input => {launches.push(input)}}}, paginate: async () => assert.fail("Fanout must not inspect notification titles")}
  return {producer, launches, github, context: {...context, eventName: "workflow_run", payload: {workflow_run: producer}}}
}

test("automatic fanout launches every neighbor despite failure and retries the same accepted request", async () => {
  const f = fanoutFixture(), requestIds = ["failed-neighbor", "published-pass", "rejected-request"]
  f.github.rest.actions.createWorkflowDispatch = async input => {
    f.launches.push(input)
    if (input.inputs.request_id === "failed-neighbor") throw new Error("transient dispatch outage")
  }
  await assert.rejects(launchRoutineResultNotifications({...f, requestIds}), error => error instanceof AggregateError && error.errors.length === 1)
  assert.equal(f.launches.length, 3)
  for (const launch of f.launches) {
    assert.equal(launch.ref, "dev"); assert.equal(launch.workflow_id, WORKFLOW)
    assert.deepEqual(Object.keys(launch.inputs), ["request_id"])
  }
  assert.equal((await launchRoutineResultNotifications({...f, requestIds: ["published-pass"]}))[0].status, "launched")
  assert.equal(f.launches.length, 4)
  await assert.rejects(launchRoutineResultNotifications({...f, context: {...f.context, eventName: "workflow_dispatch"}, requestIds}), /trusted unique/)
})

test("failed or uncertain fanout dispatch can retry the same publication identity without a new Core request", async () => {
  const f = fanoutFixture()
  f.github.rest.actions.createWorkflowDispatch = async input => {f.launches.push(input); throw new Error("dispatch response lost")}
  await assert.rejects(launchRoutineResultNotifications({...f, requestIds: ["uncertain-request"]}), /dispatch response lost/)
  f.github.rest.actions.createWorkflowDispatch = async input => {f.launches.push(input)}
  assert.equal((await launchRoutineResultNotifications({...f, requestIds: ["uncertain-request"]}))[0].status, "launched")
  assert.equal(f.launches.length, 2)
  assert.deepEqual(f.launches[0], f.launches[1])
})

test("manually forged matching notification titles cannot suppress another accepted request", async () => {
  const f = fanoutFixture(), requestId = "real-request"
  const history = [run(800, {display_title: "Routine result real-request", conclusion: "success"})]
  f.github.rest.actions.listWorkflowRuns = async () => ({data: {workflow_runs: history}})
  f.github.paginate = async () => assert.fail("Display title history cannot authorize publication suppression")
  const [result] = await launchRoutineResultNotifications({...f, requestIds: [requestId]})
  assert.equal(result.status, "launched"); assert.equal(f.launches.length, 1)
  assert.deepEqual(f.launches[0].inputs, {request_id: requestId})
})

test("failed request producer's authenticated artifact still publishes accepted neighbors and ignores extra outcomes", async () => {
  const f = fanoutFixture(); f.producer.conclusion = "failure"
  const selector = {requestIds: ["accepted-first", "accepted-third"], outcomes: [
    {requestId: "accepted-first", routineId: "first", status: "accepted"},
    {requestId: "rejected-second", routineId: "second", status: "failed", reason: "Recorder unavailable"},
    {requestId: "accepted-third", routineId: "third", status: "accepted"},
  ]}
  const bytes = Buffer.from("authenticated selector zip"), artifact = {id: 1, name: "routine-dispatches-10-1", expired: false,
    size_in_bytes: bytes.length, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    workflow_run: {id: 10, head_sha: f.producer.head_sha}}
  f.github.rest.actions.listWorkflowRunArtifacts = "artifacts"
  f.github.rest.actions.downloadArtifact = async () => ({data: bytes})
  f.github.paginate = async (method, input) => {
    assert.equal(method, "artifacts"); assert.equal(input.run_id, f.producer.id)
    return [artifact, {...artifact, id: 2, name: "routine-dispatches-10-2"}]
  }
  const requestIds = await resolveRoutineSelectors({...f, read: (...args) => readActionsJson(...args, {
    readZip: async () => ({"routine-dispatches.json": selector}),
  })})
  assert.deepEqual(requestIds, selector.requestIds)
  await launchRoutineResultNotifications({...f, requestIds})
  assert.deepEqual(f.launches.map(launch => launch.inputs.request_id), selector.requestIds)
  assert.ok(f.launches.every(launch => launch.inputs.request_id !== "rejected-second"))
})
