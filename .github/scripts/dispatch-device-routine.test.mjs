import test from "node:test"
import assert from "node:assert/strict"
import {planDeviceDispatches, dispatchRoutinePlan} from "./dispatch-device-routine.mjs"
import {requestInputDigest} from "./routine-api.mjs"
import {routineFixture, portableRoutineFixture} from "./routine-api-fixture.mjs"
import {createRoutineRequests} from './request-e2e-routine.mjs'
import {ANDROID_PUBLICATION_STEP} from './pr-android-artifacts.mjs'
const repository = "Mentra-Community/MentraOS"
function fixture() {
  const f = routineFixture(), run = {id: 10, run_attempt: 2, status: "completed", event: "pull_request", head_sha: "a".repeat(40), head_branch: "example",
    path: ".github/workflows/mentra-app-ios-build.yml", repository: {full_name: repository}, head_repository: {full_name: repository}, pull_requests: [{number: 12, head: {sha: "a".repeat(40)}}]}
  const pr = {number: 12, state: "open", base: {ref: "dev"}, head: {sha: run.head_sha, ref: "example", repo: {full_name: repository}}, labels: [`routine:${f.definition.id}`]}
  const comments = [], issues = {listComments: 'comments', createComment: async value => {comments.push(value); return {data: {id: 1}}}}
  const github = {rest: {actions: {getWorkflowRunAttempt: async () => ({data: run}), listJobsForWorkflowRun: () => {}}, pulls: {get: async () => ({data: pr})}, issues},
    paginate: async method => method === issues.listComments ? [] : ["build", "publish"].map((name, i) => ({id: i + 1, name, run_attempt: 2, status: "completed", conclusion: "success"}))}
  return {...f, run, pr, github, comments, context: {repo: {owner: "Mentra-Community", repo: "MentraOS"}, eventName: "workflow_run", payload: {workflow_run: run}}}
}
test("completed app publication routes all current labels through Core and retains source attempt", async () => {
  const f = fixture(), options = {...f, token: "fixture", fetchImpl: f.fetchImpl}
  const plans = await planDeviceDispatches(options)
  assert.equal(plans.length, 1); assert.equal(plans[0].routineId, f.definition.id)
  assert.deepEqual(plans[0].source, f.source)
  assert.equal(plans[0].routineRevision, f.enrollment.definitionRevision)
  assert.equal((await dispatchRoutinePlan({token: "fixture", plan: plans[0], fetchImpl: f.fetchImpl})).status, "accepted")
  assert.equal(f.calls.at(-1).options.method, "POST")
  f.pr.head.sha = "d".repeat(40); assert.deepEqual(await planDeviceDispatches(options), [])
})

test("callback dispatch uses bound stable-ID reconciliation and keeps uncertain outcomes honest", async () => {
  for (const lookupStatus of [200, 503, 404]) {
    const f = fixture(), [plan] = await planDeviceDispatches({...f, token: "fixture", fetchImpl: f.fetchImpl}), calls = []
    const outcome = await dispatchRoutinePlan({token: "fixture", plan, fetchImpl: async (url, init) => {
      calls.push(init.method)
      if (calls.length === 1) return new Response(null, {status: 404})
      if (init.method === "POST") throw new Error("lost after commit")
      return lookupStatus === 200 ? Response.json({...f.detail, request: {...f.request, requestId: plan.requestId, dispatchIntent: {...f.request.dispatchIntent, requestId: plan.requestId}, dispatchIntentSha256: requestInputDigest({...f.request.dispatchIntent, requestId: plan.requestId})}})
        : new Response(null, {status: lookupStatus})
    }})
    assert.equal(outcome.requestId, plan.requestId); assert.equal(outcome.status, lookupStatus === 200 ? "accepted" : "uncertain")
    assert.equal(Boolean(outcome.request), lookupStatus === 200); assert.deepEqual(calls, ["GET", "POST", "GET"])
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
test("coordinated publication alone requests no coverage; unknown exact descriptions refuse without dispatch", async () => {
  const f = fixture(), options = {...f, token: "fixture", fetchImpl: f.fetchImpl}
  f.run.path = ".github/workflows/coordinated-release.yml"; assert.deepEqual(await planDeviceDispatches(options), [])
  f.run.path = ".github/workflows/mentra-app-ios-build.yml"; f.pr.labels.push("routine:unknown")
  await assert.rejects(planDeviceDispatches(options), /differs/)
})
test("callback refuses untrusted or ambiguous publication metadata", async () => {
  const f = fixture(), options = {...f, token: "fixture", fetchImpl: f.fetchImpl}
  f.run.head_repository.full_name = "external/repo"; await assert.rejects(planDeviceDispatches(options), /differs/)
  f.run.head_repository.full_name = repository; f.run.pull_requests.push({...f.run.pull_requests[0], number: 13})
  await assert.rejects(planDeviceDispatches(options), /ambiguous/)
})

test("identical authenticated PR associations select once; distinct PR numbers refuse", async () => {
  const f = fixture(), options = {...f, token: "fixture", fetchImpl: f.fetchImpl}
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

test('exact Android, Mac and shared definitions filter each callback and freeze one source revision', async () => {
  for (const platform of ['android', 'ios-on-mac']) {
    const f = fixture(), revision = 'c'.repeat(40)
    f.pr.labels = ['routine:android-only', 'routine:mac-only', 'routine:shared']
    f.run.path = platform === 'android' ? '.github/workflows/mentra-app-android-build.yml' : '.github/workflows/mentra-app-ios-build.yml'
    const catalogCalls = [], definitions = [
      {routineId: 'android-only', platforms: ['android']},
      {routineId: 'mac-only', platforms: ['ios-on-mac']},
      {routineId: 'shared', platforms: ['android', 'ios-on-mac']},
    ]
    f.github.paginate = async method => method === 'comments' ? [] : platform === 'android'
      ? [{id: 1, name: 'build', run_attempt: 2, status: 'completed', conclusion: 'success',
        steps: [{name: ANDROID_PUBLICATION_STEP, status: 'completed', conclusion: 'success'}]}]
      : ['build', 'publish'].map((name, i) => ({id: i + 1, name, run_attempt: 2, status: 'completed', conclusion: 'success'}))
    const plans = await planDeviceDispatches({...f, token: 'fixture', fetchImpl: async (url, init) => {
      if (!new URL(url).pathname.endsWith('/routine-catalog')) return new Response(null, {status: 404})
      catalogCalls.push({url, init}); return Response.json({routineRevision: revision, routines: definitions})
    }})
    assert.deepEqual(plans.map(plan => plan.routineId), [platform === 'android' ? 'android-only' : 'mac-only', 'shared'])
    assert.ok(plans.every(plan => plan.platform === platform && plan.routineRevision === revision))
    assert.equal(catalogCalls.length, 1); assert.equal(catalogCalls[0].init.method, 'GET')
    assert.equal(f.comments.length, 1)
    assert.match(f.comments[0].body, /not queued.*exact routine source/)
    assert.match(f.comments[0].body, new RegExp(platform === 'android' ? 'mac-only' : 'android-only'))
    assert.match(f.comments[0].body, /not a device test result/)
  }
})

test('unpublished exact platform metadata remains requestable without an unsupported claim', async () => {
  const f = fixture(), revision = 'd'.repeat(40)
  const plans = await planDeviceDispatches({...f, token: 'fixture', fetchImpl: async url =>
    new URL(url).pathname.endsWith('/routine-catalog') ? Response.json({routineRevision: revision, routines: [{routineId: f.definition.id}]}) : new Response(null, {status: 404})})
  assert.equal(plans.length, 1); assert.equal(plans[0].routineRevision, revision); assert.deepEqual(f.comments, [])
})

test('failed unsupported disposition leaves compatible callback plans intact', async t => {
  const f = fixture(), warnings = []
  f.pr.labels = ['routine:mobile-only', 'routine:compatible']
  f.github.rest.issues.createComment = async () => {throw new Error('comment unavailable')}
  t.mock.method(console, 'warn', value => warnings.push(value))
  const plans = await planDeviceDispatches({...f, token: 'fixture', fetchImpl: async url =>
    new URL(url).pathname.endsWith('/routine-catalog') ? Response.json({routineRevision: 'd'.repeat(40), routines: [
      {routineId: 'mobile-only', platforms: ['android']}, {routineId: 'compatible', platforms: ['ios-on-mac']},
    ]}) : new Response(null, {status: 404})})
  assert.deepEqual(plans.map(plan => plan.routineId), ['compatible'])
  assert.equal(warnings.length, 1); assert.match(warnings[0], /compatible plans are unchanged/)
})

test('publication and label retries retain the same admitted revision and cancellation as main advances', async () => {
  for (const firstPath of ['callback', 'labels']) {
    const f = fixture(), rows = new Map(), posts = [], oldRevision = 'b'.repeat(40)
    let main = oldRevision
    f.github.rest.actions.listWorkflowRuns = 'runs'
    f.github.paginate = async (method, options) => method === 'comments' ? [] : method === 'runs'
      ? options.workflow_id === f.run.path ? [f.run] : []
      : ['build', 'publish'].map((name, i) => ({id: i + 1, name, run_attempt: 2, status: 'completed', conclusion: 'success'}))
    const fetchImpl = async (url, init) => {
      if (new URL(url).pathname.endsWith('/routine-catalog')) return Response.json({routineRevision: main,
        routines: [{routineId: f.definition.id, platforms: ['ios-on-mac']}]})
      if (init.method === 'GET') {
        const row = rows.get(new URL(url).pathname.split('/').at(-1))
        return row ? Response.json({request: row, result: null}) : new Response(null, {status: 404})
      }
      const plan = JSON.parse(init.body); posts.push(plan)
      const row = portableRoutineFixture().request
      row.requestId = plan.requestId; row.fleetSelection = {...row.fleetSelection, ...plan}
      row.fleetSelectionSha256 = requestInputDigest(row.fleetSelection); rows.set(plan.requestId, row)
      return Response.json(row)
    }
    const callback = async () => {
      const [plan] = await planDeviceDispatches({...f, token: 'fixture', fetchImpl})
      return dispatchRoutinePlan({token: 'fixture', plan, fetchImpl})
    }
    const labels = async () => (await createRoutineRequests({github: f.github,
      context: {...f.context, eventName: 'pull_request_target'}, token: 'fixture', number: f.pr.number, fetchImpl})).outcomes.find(row => row.status === 'accepted')
    const first = await (firstPath === 'callback' ? callback() : labels())
    main = 'd'.repeat(40)
    const second = await (firstPath === 'callback' ? labels() : callback())
    assert.equal(first.requestId, second.requestId); assert.equal(posts.length, 1)
    const row = rows.get(first.requestId)
    assert.equal(row.fleetSelection.routineRevision, oldRevision)
    row.state = 'terminal'; row.terminalStatus = 'not-run'
    row.fleetCancellation = {requestedAt: '2026-10-08T09:00:00Z', reason: 'Original occurrence cancelled'}
    const retry = await callback()
    assert.equal(retry.request.state, 'terminal'); assert.equal(retry.request.fleetCancellation.reason, 'Original occurrence cancelled')
    await labels(); assert.equal(posts.length, 1); assert.equal(rows.size, 1)
  }
})

test('superseded CI without successful artifact publication never inspects Core or submits a test', async () => {
  for (const workflow of ['.github/workflows/mentra-app-ios-build.yml', '.github/workflows/mentra-app-android-build.yml']) {
    const f = fixture(); f.run.path = workflow; f.run.conclusion = 'cancelled';
    f.github.paginate = async () => workflow.includes('android') ? [{id:1,name:'build',run_attempt:2,status:'completed',conclusion:'cancelled',
      steps:[{name:ANDROID_PUBLICATION_STEP,status:'completed',conclusion:'skipped'}]}] :
      [{id:1,name:'build',run_attempt:2,status:'completed',conclusion:'cancelled'}, {id:2,name:'publish',run_attempt:2,status:'completed',conclusion:'skipped'}];
    assert.deepEqual(await planDeviceDispatches({...f,token:'fixture',fetchImpl:async()=>assert.fail('Unpublished CI must not contact Core')}),[]);
  }
});
