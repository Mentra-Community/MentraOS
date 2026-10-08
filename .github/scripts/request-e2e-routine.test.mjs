import test from "node:test"
import assert from "node:assert/strict"
import {createRoutineRequests, assertRoutineRequestOutcomes, planRoutineRequest, successfulMacPublication, successfulAndroidPublication} from "./request-e2e-routine.mjs"
import {requestInputDigest} from "./routine-api.mjs"
import {routineFixture} from "./routine-api-fixture.mjs"
const context = {repo: {owner: "Mentra-Community", repo: "MentraOS"}, eventName: "workflow_dispatch", ref: "refs/heads/dev", runId: 100}

test("manual requests need no enrollment and bind workflow occurrence plus optional revision", async () => {
  const f = routineFixture({channel: "dev"})
  const options = {context, token: "fixture", routine: "new.unpublished", platform: "ios-on-mac", source: f.source, fetchImpl: f.fetchImpl}
  const first = await createRoutineRequests(options), retry = await createRoutineRequests({...options, context: {...context, runAttempt: 9}})
  const next = await createRoutineRequests({...options, context: {...context, runId: 200}})
  assert.equal(first.requests[0].requestId, retry.requests[0].requestId)
  assert.notEqual(first.requests[0].requestId, next.requests[0].requestId)
  assert.equal(first.requests[0].state, "preparing")
  assert.equal(first.requests[0].input, undefined)
  assert.ok(f.calls.every(call => !call.url.endsWith("/routine-catalog")))
  const overridden = await createRoutineRequests({...options, routineRevision: "d".repeat(40)})
  assert.equal(overridden.requests[0].dispatchIntent.routineRevision, "d".repeat(40))
  assert.notEqual(first.requests[0].requestId, overridden.requests[0].requestId)
  await assert.rejects(createRoutineRequests({...options, platform: "unsupported"}), /explicit request/)
  await assert.rejects(createRoutineRequests({...options, routineRevision: "main"}), /exact commit/)
  await assert.rejects(createRoutineRequests({...options, source: undefined}), /exact published/)
})
test("labels distinguish unsupported platforms from pending compatible app publications", async () => {
  const f = routineFixture()
  const pr = {number: 12, state: "open", base: {ref: "dev"}, head: {sha: "a".repeat(40), ref: "example", repo: {full_name: "Mentra-Community/MentraOS"}},
    labels: [{name: `routine:${f.definition.id}`}, {name: "routine:new.unpublished"}]}
  const comments = [], github = {rest: {pulls: {get: async () => ({data: pr})}, actions: {listWorkflowRuns: () => {}},
    issues: {listComments: 'comments', createComment: async value => comments.push(value)}}, paginate: async () => []}
  const result = await createRoutineRequests({github, context: {...context, eventName: "pull_request_target"}, token: "fixture", number: 12,
    fetchImpl: async (url, init) => {
      assert.equal(init.method, 'GET')
      return Response.json({routineRevision: 'b'.repeat(40), routines: [{routineId: f.definition.id, platforms: ['ios-on-mac']},
        {routineId: 'new.unpublished', platforms: ['android']}]})
    }})
  assert.equal(result.requests.length, 0)
  assert.deepEqual(result.pending.map(row => [row.routineId, row.platform]), [
    [f.definition.id, "ios-on-mac"], ["new.unpublished", "android"]])
  assert.equal(comments.length, 1); assert.equal(result.outcomes.filter(row => row.status === 'skipped').length, 2)
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
  const github = {rest: {pulls: {get: async () => ({data: pr})}, actions: {listWorkflowRuns: "runs", listJobsForWorkflowRun: "jobs"},
    issues: {listComments: 'comments', createComment: async () => {throw new Error('comment unavailable')}}},
    paginate: async (method, options) => method === 'comments' ? [] : method === "runs" ? options.workflow_id === run.path ? [run] : [] : ["build", "publish"].map((name, index) => ({id: index + 1, name, run_attempt: 2, status: "completed", conclusion: "success"}))}
  const result = await createRoutineRequests({github, context: {...context, eventName: "pull_request_target"}, token: "fixture", number: 12,
    fetchImpl: async (url, init) => {
      if (new URL(url).pathname.endsWith("/routine-catalog")) return Response.json({routineRevision: 'b'.repeat(40),
        routines: fixtures.map(f => ({routineId: f.definition.id, platforms: ['ios-on-mac']}))})
      const plan = JSON.parse(init.body); attempts.push(plan.routineId)
      if (plan.routineId === "second.rejected") return Response.json({message: "Required recorder is unavailable"}, {status: 409})
      return fixtures.find(f => f.definition.id === plan.routineId).fetchImpl(url, init)
    }})
  assert.deepEqual(attempts, fixtures.map(f => f.definition.id))
  assert.match(result.notificationError, /retained admission outcomes are unchanged/)
  assert.deepEqual(result.outcomes.map(outcome => outcome.status), ["skipped", "accepted", "skipped", "failed", "skipped", "accepted"])
  const retained = JSON.parse(JSON.stringify({requestIds: result.requestIds, outcomes: result.outcomes}))
  assert.equal(retained.requestIds.length, 2); assert.equal(retained.outcomes[3].retryable, false)
  assert.throws(() => assertRoutineRequestOutcomes(retained.outcomes), error => error instanceof AggregateError && /second.rejected.*Required recorder/.test(error.message))
  assert.doesNotThrow(() => assertRoutineRequestOutcomes(result.outcomes.filter(outcome => outcome.status !== "failed")))
})

test("request workflow retains accepted selectors before reporting member failures, including failed summary", async () => {
  const {readFile} = await import("node:fs/promises")
  const workflow = await readFile(new URL("../workflows/request-e2e-routine.yml", import.meta.url), "utf8")
  assert.match(workflow, /JSON\.stringify\(\{requestIds: result\.requestIds, outcomes: result\.outcomes\}\)/)
  assert.equal((workflow.match(/if: always\(\) && steps\.queue\.outputs\.persisted == 'true'/g) ?? []).length, 2)
  assert.ok(workflow.indexOf("actions/upload-artifact@v4") < workflow.indexOf("Report independent member admission failures"))
  assert.ok(workflow.indexOf("core.setOutput('persisted', 'true')") < workflow.indexOf("core.summary"))
})

test("manual response loss retains accepted acknowledgements or durable uncertain selectors before outcome failure", async () => {
  for (const lookupStatus of [200, 503, 404]) {
    const f = routineFixture({channel: "dev"}), plan = planRoutineRequest({routineId: f.definition.id, platform: "ios-on-mac"}, f.source, {occurrenceId: "manual-100"})
    const result = await createRoutineRequests({context, token: "fixture", routine: f.definition.id, platform: "ios-on-mac", source: f.source,
      fetchImpl: async (url, init) => {
        if (url.endsWith("/routine-catalog")) return f.fetchImpl(url, init)
        if (init.method === "POST") throw new Error("lost after commit")
        return lookupStatus === 200 ? Response.json({...f.detail, request: {...f.request, requestId: plan.requestId, dispatchIntent: {...f.request.dispatchIntent, requestId: plan.requestId}, dispatchIntentSha256: requestInputDigest({...f.request.dispatchIntent, requestId: plan.requestId})}})
          : new Response(null, {status: lookupStatus})
      }})
    const retained = JSON.parse(JSON.stringify({requestIds: result.requestIds, outcomes: result.outcomes}))
    assert.deepEqual(retained.requestIds, [plan.requestId])
    assert.equal(result.requests.length, lookupStatus === 200 ? 1 : 0)
    assert.equal(result.outcomes[0].status, lookupStatus === 200 ? "accepted" : "uncertain")
    if (lookupStatus === 200) assert.doesNotThrow(() => assertRoutineRequestOutcomes(retained.outcomes))
    else assert.throws(() => assertRoutineRequestOutcomes(retained.outcomes), /admission failed/)
  }
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
  assert.equal(failedSource.outcomes.find(row => row.status === 'failed').reason, "Current PR app publication could not be authenticated")
  assert.doesNotMatch(JSON.stringify(failedSource), /raw provider credential/)
})
