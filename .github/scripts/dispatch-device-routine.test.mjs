import test from "node:test"
import assert from "node:assert/strict"
import {planDeviceDispatches, dispatchRoutinePlan} from "./dispatch-device-routine.mjs"
import {routineFixture} from "./routine-api-fixture.mjs"
const repository = "Mentra-Community/MentraOS"
function fixture() {
  const f = routineFixture(), run = {id: 10, run_attempt: 2, status: "completed", event: "pull_request", head_sha: "a".repeat(40), head_branch: "example",
    path: ".github/workflows/mentra-app-ios-build.yml", repository: {full_name: repository}, head_repository: {full_name: repository}, pull_requests: [{number: 12, head: {sha: "a".repeat(40)}}]}
  const pr = {number: 12, state: "open", base: {ref: "dev"}, head: {sha: run.head_sha, ref: "example", repo: {full_name: repository}}, labels: [`routine:${f.definition.id}`]}
  const github = {rest: {actions: {getWorkflowRunAttempt: async () => ({data: run}), listJobsForWorkflowRun: () => {}}, pulls: {get: async () => ({data: pr})}},
    paginate: async () => ["build", "publish"].map((name, i) => ({id: i + 1, name, run_attempt: 2, status: "completed", conclusion: "success"}))}
  return {...f, run, pr, github, context: {repo: {owner: "Mentra-Community", repo: "MentraOS"}, eventName: "workflow_run", payload: {workflow_run: run}}}
}
test("completed app publication routes all current labels through Core and retains source attempt", async () => {
  const f = fixture(), options = {...f, token: "fixture"}
  const plans = await planDeviceDispatches(options)
  assert.equal(plans.length, 1); assert.equal(plans[0].routineId, f.definition.id)
  assert.deepEqual(plans[0].source, f.source)
  assert.equal((await dispatchRoutinePlan({token: "fixture", plan: plans[0], fetchImpl: f.fetchImpl})).status, "accepted")
  assert.equal(f.calls.at(-1).options.method, "POST")
  f.pr.head.sha = "d".repeat(40); assert.deepEqual(await planDeviceDispatches(options), [])
})

test("callback dispatch uses bound stable-ID reconciliation and keeps uncertain outcomes honest", async () => {
  for (const lookupStatus of [200, 503, 404]) {
    const f = fixture(), [plan] = await planDeviceDispatches({...f, token: "fixture"}), calls = []
    const outcome = await dispatchRoutinePlan({token: "fixture", plan, fetchImpl: async (url, init) => {
      calls.push(init.method)
      if (init.method === "POST") throw new Error("lost after commit")
      return lookupStatus === 200 ? Response.json({...f.detail, request: {...f.request, requestId: plan.requestId}})
        : new Response(null, {status: lookupStatus})
    }})
    assert.equal(outcome.requestId, plan.requestId); assert.equal(outcome.status, lookupStatus === 200 ? "accepted" : "uncertain")
    assert.equal(Boolean(outcome.request), lookupStatus === 200); assert.deepEqual(calls, ["POST", "GET"])
  }
})

test("callback workflow writes intent before dispatch and uploads before reporting failed outcomes", async () => {
  const {readFile} = await import("node:fs/promises")
  const workflow = await readFile(new URL("../workflows/dispatch-device-routine.yml", import.meta.url), "utf8")
  assert.ok(workflow.indexOf("await writeFile('routine-dispatch.json'") < workflow.indexOf("await dispatchRoutinePlan"))
  assert.ok(workflow.indexOf("core.setOutput('persisted', 'true')") < workflow.indexOf("await dispatchRoutinePlan"))
  assert.match(workflow, /requestIds: outcome\.status === 'failed' \? \[\] : \[plan\.requestId\]/)
  assert.equal((workflow.match(/if: always\(\) && steps\.queue\.outputs\.persisted == 'true'/g) ?? []).length, 2)
  assert.ok(workflow.indexOf("actions/upload-artifact@v4") < workflow.indexOf("Report admission outcome after retaining selectors"))
})
test("coordinated publication alone requests no coverage; unknown selected label refuses", async () => {
  const f = fixture(), options = {...f, token: "fixture"}
  f.run.path = ".github/workflows/coordinated-release.yml"; assert.deepEqual(await planDeviceDispatches(options), [])
  f.run.path = ".github/workflows/mentra-app-ios-build.yml"; f.pr.labels.push("routine:unknown")
  await assert.rejects(planDeviceDispatches(options), /not enrolled/)
})
test("callback refuses untrusted or ambiguous publication metadata", async () => {
  const f = fixture(), options = {...f, token: "fixture"}
  f.run.head_repository.full_name = "external/repo"; await assert.rejects(planDeviceDispatches(options), /differs/)
  f.run.head_repository.full_name = repository; f.run.pull_requests.push({...f.run.pull_requests[0], number: 13})
  await assert.rejects(planDeviceDispatches(options), /ambiguous/)
})

test("identical authenticated PR associations select once; distinct PR numbers refuse", async () => {
  const f = fixture(), options = {...f, token: "fixture"}
  f.run.pull_requests.push(structuredClone(f.run.pull_requests[0]))
  assert.equal((await planDeviceDispatches(options)).length, 1)
  f.run.pull_requests.push({...f.run.pull_requests[0], number: 13})
  await assert.rejects(planDeviceDispatches(options), /ambiguous/)
})

test("same-repository non-PR app callbacks skip before inspecting publication or enrollment", async () => {
  for (const event of ["push", "workflow_dispatch", "schedule"]) {
    const f = fixture(); f.run.event = event
    f.github.paginate = async () => assert.fail("Non-PR callback must not inspect publication")
    assert.deepEqual(await planDeviceDispatches({...f, token: "fixture", fetchImpl: async () => assert.fail("Non-PR callback must not contact Core")}), [])
  }
})
