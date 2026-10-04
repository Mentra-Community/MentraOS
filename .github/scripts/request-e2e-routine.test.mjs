import test from "node:test"
import assert from "node:assert/strict"
import {createRoutineRequests, assertRoutineRequestOutcomes, planForDefinition, successfulMacPublication, successfulAndroidPublication} from "./request-e2e-routine.mjs"
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

test("later admission rejection preserves earlier selectors and attempts subsequent selected members", async () => {
  const fixtures = ["first.accepted", "second.rejected", "third.accepted"].map(routineId => routineFixture({routineId})), attempts = []
  const pr = {number: 12, state: "open", base: {ref: "dev"}, head: {sha: "a".repeat(40), ref: "example", repo: {full_name: "Mentra-Community/MentraOS"}},
    labels: fixtures.map(f => `routine:${f.definition.id}`)}
  const run = {id: 10, run_attempt: 2, status: "completed", event: "pull_request", head_sha: pr.head.sha, head_branch: pr.head.ref,
    path: ".github/workflows/mentra-app-ios-build.yml", repository: {full_name: "Mentra-Community/MentraOS"}, head_repository: {full_name: "Mentra-Community/MentraOS"}}
  const github = {rest: {pulls: {get: async () => ({data: pr})}, actions: {listWorkflowRuns: "runs", listJobsForWorkflowRun: "jobs"}},
    paginate: async method => method === "runs" ? [run] : ["build", "publish"].map((name, index) => ({id: index + 1, name, run_attempt: 2, status: "completed", conclusion: "success"}))}
  const result = await createRoutineRequests({github, context: {...context, eventName: "pull_request_target"}, token: "fixture", number: 12,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/routine-catalog")) return Response.json({routines: fixtures.map(f => f.enrollment)})
      const plan = JSON.parse(init.body); attempts.push(plan.routineId)
      if (plan.routineId === "second.rejected") return Response.json({message: "Required recorder is unavailable"}, {status: 409})
      return fixtures.find(f => f.definition.id === plan.routineId).fetchImpl(url, init)
    }})
  assert.deepEqual(attempts, fixtures.map(f => f.definition.id))
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ["accepted", "failed", "accepted"])
  const retained = JSON.parse(JSON.stringify({requestIds: result.requests.map(request => request.requestId), outcomes: result.outcomes}))
  assert.equal(retained.requestIds.length, 2); assert.equal(retained.outcomes[1].retryable, false)
  assert.throws(() => assertRoutineRequestOutcomes(retained.outcomes), error => error instanceof AggregateError && /second.rejected.*Required recorder/.test(error.message))
  assert.doesNotThrow(() => assertRoutineRequestOutcomes(result.outcomes.filter(outcome => outcome.status !== "failed")))
})

test("request workflow retains accepted selectors before reporting member failures, including failed summary", async () => {
  const {readFile} = await import("node:fs/promises")
  const workflow = await readFile(new URL("../workflows/request-e2e-routine.yml", import.meta.url), "utf8")
  assert.match(workflow, /JSON\.stringify\(\{requestIds: result\.requests\.map\(request => request\.requestId\), outcomes: result\.outcomes\}\)/)
  assert.equal((workflow.match(/if: always\(\) && steps\.queue\.outputs\.persisted == 'true'/g) ?? []).length, 2)
  assert.ok(workflow.indexOf("actions/upload-artifact@v4") < workflow.indexOf("Report independent member admission failures"))
  assert.ok(workflow.indexOf("core.setOutput('persisted', 'true')") < workflow.indexOf("core.summary"))
})

test("stored admission outcomes bound API reasons and do not copy raw source-provider failures", async () => {
  const f = routineFixture({channel: "dev"}), options = {context, token: "fixture", routine: f.definition.id, platform: "ios-on-mac", source: f.source}
  const result = await createRoutineRequests({...options, fetchImpl: async (url, init) => url.endsWith("/routine-catalog")
    ? f.fetchImpl(url, init) : Response.json({message: `Recorder unavailable\n${"x".repeat(2000)}`}, {status: 409})})
  assert.equal(result.outcomes[0].status, "failed")
  assert.ok(result.outcomes[0].reason.length <= 600); assert.doesNotMatch(result.outcomes[0].reason, /[\r\n]/)
  const pr = {number: 12, state: "open", base: {ref: "dev"}, head: {sha: "a".repeat(40), ref: "example", repo: {full_name: "Mentra-Community/MentraOS"}},
    labels: [`routine:${f.definition.id}`]}
  const failedSource = await createRoutineRequests({github: {rest: {pulls: {get: async () => ({data: pr})}, actions: {listWorkflowRuns: "runs"}},
    paginate: async () => {throw new Error("raw provider credential details")}}, context: {...context, eventName: "pull_request_target"},
    token: "fixture", number: 12, fetchImpl: f.fetchImpl})
  assert.equal(failedSource.outcomes[0].reason, "Current PR app publication could not be authenticated")
  assert.doesNotMatch(JSON.stringify(failedSource), /raw provider credential/)
})
