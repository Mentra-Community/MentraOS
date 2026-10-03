import test from "node:test"
import assert from "node:assert/strict"
import {createRoutineRequests, planForDefinition, successfulMacPublication, successfulAndroidPublication} from "./request-e2e-routine.mjs"
import {routineFixture} from "./routine-api-fixture.mjs"
const context = {repo: {owner: "Mentra-Community", repo: "MentraOS"}, eventName: "workflow_dispatch", ref: "refs/heads/dev"}

test("manual exact-source requests admit an unfamiliar enrolled ID and use stable source identity", async () => {
  const f = routineFixture({channel: "dev"})
  const options = {context, token: "fixture", routine: f.definition.id, platform: "ios-on-mac", source: f.source, fetchImpl: f.fetchImpl}
  const first = await createRoutineRequests(options), second = await createRoutineRequests({...options, context: {...context, runId: 200, runAttempt: 9}})
  assert.equal(first.requests[0].requestId, second.requests[0].requestId)
  assert.equal(first.requests[0].requestId, planForDefinition({routineId: f.definition.id, platform: "ios-on-mac"}, f.source).requestId)
  await assert.rejects(createRoutineRequests({...options, routine: "unknown"}), /not enrolled/)
  await assert.rejects(createRoutineRequests({...options, platform: "android"}), /not enrolled/)
  await assert.rejects(createRoutineRequests({...options, source: undefined}), /exact published/)
})
test("all selected PR labels are resolved and pending publications make no dispatch", async () => {
  const f = routineFixture(), another = {...f.enrollment, routineId: "second-check", definition: {...f.definition, id: "second-check"}}
  const pr = {number: 12, state: "open", base: {ref: "dev"}, head: {sha: "a".repeat(40), ref: "example", repo: {full_name: "Mentra-Community/MentraOS"}},
    labels: [{name: `routine:${f.definition.id}`}, {name: "routine:second-check"}]}
  const github = {rest: {pulls: {get: async () => ({data: pr})}, actions: {listWorkflowRuns: () => {}}}, paginate: async () => []}
  const result = await createRoutineRequests({github, context: {...context, eventName: "pull_request_target"}, token: "fixture", number: 12,
    fetchImpl: async () => Response.json({routines: [f.enrollment, another]})})
  assert.equal(result.requests.length, 0); assert.deepEqual(result.pending.map(row => row.routineId), [f.definition.id, "second-check"])
  pr.labels.push({name: "routine:not-enrolled"})
  await assert.rejects(createRoutineRequests({github, context: {...context, eventName: "pull_request_target"}, token: "fixture", number: 12,
    fetchImpl: async () => Response.json({routines: [f.enrollment, another]})}), /not enrolled/)
})
test("retained successful producer jobs select their original publication attempt", () => {
  const base = {status: "completed", conclusion: "success", started_at: "a", completed_at: "b"}
  const jobs = [{...base, name: "build", run_attempt: 1}, {...base, name: "publish", run_attempt: 1},
    {...base, name: "build", run_attempt: 2}, {...base, name: "publish", run_attempt: 2}]
  assert.deepEqual(successfulMacPublication({status: "completed", run_attempt: 2}, jobs), {buildAttempt: 1, publicationAttempt: 1})
  const android = [{...base, name: "build", run_attempt: 2, steps: [{name: "Publish immutable signed Android APK and receipt", status: "completed", conclusion: "success"}]}]
  // A successful build alone cannot claim publication without the exact publisher step.
  assert.equal(successfulAndroidPublication({status: "completed", run_attempt: 2}, android), null)
})
