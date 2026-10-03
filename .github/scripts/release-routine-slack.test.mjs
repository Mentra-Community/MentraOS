import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import test from "node:test"
import {applyRoutineResult, ROUTINE_BLOCK} from "./release-slack-message.mjs"
import {jobName, prepareRoutineUpdate, readActionsJson, resolveRoutineNotifications, resolveRoutineSelectors, stateName, WORKFLOW} from "./release-routine-slack.mjs"
import {boundRoutineResult} from "./routine-api.mjs"
import {routineFixture} from "./routine-api-fixture.mjs"
const repo = {owner: "Mentra-Community", repo: "MentraOS"}, repository = "Mentra-Community/MentraOS"
const context = {repo, eventName: "workflow_dispatch", ref: "refs/heads/dev", runId: 701}
const run = (id, overrides = {}) => ({id, run_attempt: 1, head_sha: "a".repeat(40), head_branch: "dev", event: "workflow_dispatch", status: "completed",
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
test("explicit notification selector is validated; callback artifacts remain only request IDs", async () => {
  assert.deepEqual(await resolveRoutineSelectors({context, requestId: "example-request"}), ["example-request"])
  await assert.rejects(resolveRoutineSelectors({context, requestId: "../invalid"}), /selector/)
  const producer = run(10, {path: ".github/workflows/request-e2e-routine.yml"})
  const github = {rest: {actions: {getWorkflowRunAttempt: async () => ({data: producer}), listWorkflowRunArtifacts: () => {}}}, paginate: async () => [{id: 1, name: "routine-dispatches-10-1"}, {id: 2, name: "routine-dispatches-10-2"}]}
  const ids = await resolveRoutineSelectors({github, context: {...context, eventName: "workflow_run", payload: {workflow_run: producer}},
    read: async () => ({"routine-dispatches.json": {requestIds: ["new-check-request", "second-check-request"]}})})
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
