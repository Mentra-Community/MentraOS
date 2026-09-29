import assert from "node:assert/strict"
import test from "node:test"
import {readFile} from "node:fs/promises"
import {createRoutineRequest} from "./request-e2e-routine.mjs"
import {verifyCoordinatedReadyRequest} from "./coordinated-routine-request.mjs"
import {coordinatedAndroidFixture, coordinatedFixture} from "./coordinated-routine-fixture.mjs"

test("the shared private/public wire fixture is the actual producer output", async () => {
  const {state, options} = coordinatedFixture()
  const fixture = JSON.parse(await readFile(new URL("./fixtures/coordinated-routine-request.json", import.meta.url)))
  assert.deepEqual(fixture, {request: await createRoutineRequest(options), plan: state.plan, receipt: state.receipt, ota: state.ota})
})

for (const channel of ["dev", "staging"]) test(`${channel} selects an exact successful historical coordinated publication`, async () => {
  const {state, options, pin} = coordinatedFixture(channel)
  const request = await createRoutineRequest(options)
  assert.equal(request.schemaVersion, 2)
  assert.equal(request.status, "ready")
  assert.equal(request.requestId, `routine-500-1-${channel}-no-glasses`)
  assert.equal(request.pullRequest, undefined)
  assert.equal(request.selection.build.baseSha, undefined)
  assert.equal(request.selection.producer.buildAttempt, undefined)
  assert.deepEqual(request.selection.app, state.receipt.app)
  assert.equal(request.selection.releasePlan.sha256, pin(state.plan))
  assert.equal(request.selection.receipt.sha256, pin(state.receipt))
  assert.equal(request.selection.otaManifest.sha256, pin(state.ota))
  await verifyCoordinatedReadyRequest({...options, request})
})

test("exact selection never substitutes another run, attempt, branch or source", async () => {
  for (const change of [{id: 101}, {run_attempt: 1}, {head_branch: "main"}, {event: "pull_request"},
    {path: ".github/workflows/other.yml"}, {status: "in_progress"},
    {repository: {full_name: "other/repository"}}, {head_repository: {full_name: "other/repository"}}]) {
    const {state, options} = coordinatedFixture()
    Object.assign(state.run, change)
    assert.equal((await createRoutineRequest(options)).status, "no-artifact")
  }
  for (const ancestry of ["behind", "diverged"]) {
    const {state, options} = coordinatedFixture(); state.ancestry = ancestry
    assert.equal((await createRoutineRequest(options)).status, "no-artifact")
  }
})

test("retained run artifacts cannot qualify skipped, earlier or dry-run publication attempts", async () => {
  for (const scenario of ["earlier-attempt", "later-skipped", "dry-run", "missing-publish-step", "ambiguous-finalizer"]) {
    const {state, options} = coordinatedFixture()
    const published = structuredClone(state.jobs[0])
    if (scenario === "earlier-attempt") {
      state.run.run_attempt = 1
      state.jobs.unshift({...published, id: 999, run_attempt: 1, conclusion: "skipped", steps: []})
    }
    if (scenario === "later-skipped") {
      state.jobs.unshift({...published, id: 999, run_attempt: 1})
      state.jobs[1].conclusion = "skipped"
    }
    if (scenario === "dry-run") state.jobs[0].steps[0].conclusion = "skipped"
    if (scenario === "missing-publish-step") state.jobs[0].steps = []
    if (scenario === "ambiguous-finalizer") state.jobs.push({...published, id: 1002})
    const request = await createRoutineRequest({...options, sourcePublicationAttempt: String(state.run.run_attempt)})
    assert.equal(request.status, "no-artifact", scenario)
    assert.match(request.reason, /did not publish immutable assets/, scenario)
    assert.equal(request.selection, null)
    assert.ok(state.calls.some(call => call.jobs?.run_id === state.run.id))
    assert.equal(state.calls.some(call => call.url), false, "Reject before reading retained CDN assets")
  }
})

for (const channel of ["dev", "staging"]) test(`${channel} accepts the original finalized attempt despite downstream failure and later job retries`, async () => {
  const {state, options} = coordinatedFixture(channel)
  state.run.run_attempt = 1
  state.run.conclusion = "failure"
  state.jobs[0].run_attempt = 1
  state.jobs.push({...state.jobs[0], id: 1003, name: "Notify Slack", run_attempt: 2})
  const exact = {...options, sourcePublicationAttempt: "1"}
  const request = await createRoutineRequest(exact)
  assert.equal(request.status, "ready")
  assert.equal(request.selection.producer.publicationAttempt, 1)
  await verifyCoordinatedReadyRequest({...exact, request})
  state.jobs[0].conclusion = "failure"
  await assert.rejects(verifyCoordinatedReadyRequest({...exact, request}), /did not publish immutable assets/)
})

test("a cloned retained finalizer does not make a later retry the producing attempt", async () => {
  const {state, options} = coordinatedFixture()
  Object.assign(state.jobs[0], {started_at: "2026-09-23T01:00:00Z", completed_at: "2026-09-23T01:10:00Z"})
  state.jobs.unshift({...structuredClone(state.jobs[0]), id: 999, run_attempt: 1})
  const request = await createRoutineRequest(options)
  assert.equal(request.status, "no-artifact")
  assert.match(request.reason, /retains an earlier publication/)
  assert.equal(state.calls.some(call => call.url), false)
})

test("the actual publishing retry remains selectable and callback verification repeats the job gate", async () => {
  const {state, options} = coordinatedFixture()
  state.jobs.unshift({...state.jobs[0], id: 999, run_attempt: 1, conclusion: "skipped", steps: []})
  const request = await createRoutineRequest(options)
  assert.equal(request.status, "ready")
  assert.equal(request.selection.producer.publicationAttempt, 2)
  await verifyCoordinatedReadyRequest({...options, request})
  state.jobs[1].steps[0].conclusion = "skipped"
  await assert.rejects(verifyCoordinatedReadyRequest({...options, request}), /did not publish immutable assets/)
})

test("incomplete publication job history cannot establish the producing attempt", async () => {
  for (const response of [{total_count: 2, jobs: []}, {total_count: 1000, jobs: []}, {jobs: []}]) {
    const {state, options} = coordinatedFixture()
    state.jobsResponse = response
    const request = await createRoutineRequest(options)
    assert.equal(request.status, "no-artifact")
    assert.match(request.reason, /job history is incomplete/)
    assert.equal(state.calls.some(call => call.url), false)
  }
})

test("changed or mismatched publication files cannot become ready", async () => {
  const mutations = [s => s.plan.sourceCommit = "f".repeat(40), s => s.plan.channel = "beta",
    s => s.receipt.app.buildSha = "f".repeat(40), s => s.receipt.app.backend = "staging",
    s => delete s.receipt.artifacts.install, s => s.receipt.artifacts.mac.name = "other.zip",
    s => s.ota.releaseVersion = "other", s => s.artifacts.push({...s.artifacts[0], id: 201}),
    s => s.artifacts[0].expired = true, s => s.changed = true]
  for (const mutate of mutations) {
    const {state, options} = coordinatedFixture(); mutate(state)
    assert.equal((await createRoutineRequest(options)).status, "no-artifact")
  }
})

test("malformed selectors, PR mixing, untrusted issuer and automatic OTA fail before selection", async () => {
  for (const override of [{number: 42}, {channel: "main"}, {sourceBuildRunId: ""}, {sourcePublicationAttempt: "1.2"},
    {sourcePublicationAttempt: "9007199254740992"}, {requestOrigin: "pr-label"},
    {requestOrigin: "successful-build", routine: "day1-ota"}, {requestOrigin: "successful-build", routine: "mentra-call"}])
    await assert.rejects(createRoutineRequest({...coordinatedFixture().options, ...override}))
  const {options} = coordinatedFixture()
  await assert.rejects(createRoutineRequest({...options, source: {...options.source, ref: "refs/heads/staging"}}))
  await assert.rejects(createRoutineRequest({...options, source: {...options.source, workflowSha: "c".repeat(40)}}))
})

for (const channel of ["dev", "staging"]) for (const routine of ["day1-ota", "mentra-call"])
  test(`explicit ${channel} ${routine} requests use the exact coordinated publication`, async () => {
    const {options} = coordinatedFixture(channel)
    const request = await createRoutineRequest({...options, routine})
    assert.equal(request.requestId, `routine-500-1-${channel}-${routine}`)
    assert.equal(request.status, "ready")
    assert.equal(request.routine.authorization, "workflow-dispatch")
    assert.equal(request.selection.producer.runId, 100)
    assert.equal(request.selection.producer.publicationAttempt, 2)
    await verifyCoordinatedReadyRequest({...options, request})
  })

test("ready callback revalidates the selected artifacts and exact trusted issuer", async () => {
  const {state, options} = coordinatedFixture()
  const request = await createRoutineRequest({...options, requestOrigin: "successful-build"})
  assert.equal(request.status, "ready")
  await verifyCoordinatedReadyRequest({...options, request})
  const changed = structuredClone(request); changed.selection.archive.sha256 = "f".repeat(64)
  await assert.rejects(verifyCoordinatedReadyRequest({...options, request: changed}), /differs/)
  state.run.conclusion = "failure"
  await verifyCoordinatedReadyRequest({...options, request})
  state.jobs[0].conclusion = "failure"
  await assert.rejects(verifyCoordinatedReadyRequest({...options, request}), /did not publish immutable assets/)
})

test("dev advancing during publication revalidation preserves the immutable request", async () => {
  const {state, options} = coordinatedFixture()
  const request = await createRoutineRequest(options), frozen = JSON.stringify(request)
  const nextDev = "f".repeat(40)
  await verifyCoordinatedReadyRequest({...options, request, fetchImpl: async (url, init) => {
    const response = await options.fetchImpl(url, init)
    state.devSha = nextDev
    return response
  }})
  assert.equal(JSON.stringify(request), frozen)
  assert.ok(state.calls.some(call => call.compare === `${request.trigger.sha}...${nextDev}`))
})


for (const channel of ["dev", "staging"]) test(`${channel} selects its exact Android APK from the coordinated manifest`, async () => {
  const {state, options, pin} = coordinatedAndroidFixture(channel)
  const request = await createRoutineRequest({...options, requestOrigin: "successful-build"})
  assert.equal(request.status, "ready", request.reason)
  assert.equal(request.selection.platform, "android")
  assert.equal(request.selection.archive.name, state.plan.artifactNames.androidApp)
  assert.equal(request.selection.receipt.sha256, pin(state.androidReceipt))
  assert.deepEqual(request.selection.app, {packageId: "com.mentra.mentra", version: "3.3.0", build: "303000223",
    headSha: state.plan.sourceCommit, buildSha: state.plan.sourceCommit, backend: channel,
    releaseIdentity: state.plan.releaseIdentity, otaManifestUrl: state.receipt.app.otaManifestUrl})
  await verifyCoordinatedReadyRequest({...options, request})
})

// A family number below Play's beta floor: finalization records the code the APK was built with.
function flooredAndroidFixture(recorded = {androidBuildNumber: 310000224}) {
  const f = coordinatedAndroidFixture("staging"), {plan} = f.state
  plan.native = {buildNumber: 302010043, marketingVersion: "3.3.0", playTrack: "beta",
    testflight: {audience: "external", group: "Mentra Staging Public"}}
  f.state.androidReceipt.native = {...structuredClone(plan.native), ...recorded}
  f.state.androidReceipt.releasePlanSha256 = f.pin(plan)
  return f
}

test("Android selection uses the version code its manifest records above the family number", async () => {
  const {state, options} = flooredAndroidFixture()
  const request = await createRoutineRequest({...options, requestOrigin: "successful-build"})
  assert.equal(request.status, "ready", request.reason)
  assert.equal(request.selection.app.build, "310000224")
  assert.equal(request.selection.app.version, "3.3.0")
  assert.deepEqual(request.selection.archive, {name: state.plan.artifactNames.androidApp, url: state.androidReceipt.artifacts[0].url,
    sha256: "2".repeat(64), size: 9999})
  await verifyCoordinatedReadyRequest({...options, request})
  const family = structuredClone(request); family.selection.app.build = "302010043"
  await assert.rejects(verifyCoordinatedReadyRequest({...options, request: family}), /differs/)
  state.androidReceipt.native.androidBuildNumber++
  await assert.rejects(verifyCoordinatedReadyRequest({...options, request}), /differs/)
})

test("Android selection keeps the family number when the manifest records no higher code", async () => {
  for (const recorded of [{}, {androidBuildNumber: 302010043}]) {
    const {state, options} = flooredAndroidFixture(recorded)
    assert.equal(state.androidReceipt.native.androidBuildNumber, recorded.androidBuildNumber)
    const request = await createRoutineRequest(options)
    assert.equal(request.status, "ready", request.reason)
    assert.equal(request.selection.app.build, "302010043")
    await verifyCoordinatedReadyRequest({...options, request})
  }
})

test("Android selection rejects a malformed, lower or out-of-range recorded version code before reading the APK", async () => {
  for (const code of [null, "310000224", 310000224.5, 302010042, 0, -1, 2100000001, 9007199254740993, true, {}, [310000224]]) {
    const {state, options} = flooredAndroidFixture({androidBuildNumber: code})
    const request = await createRoutineRequest(options)
    assert.equal(request.status, "no-artifact", JSON.stringify(code))
    assert.equal(request.selection, null)
    assert.match(request.reason, /androidBuildNumber/)
    assert.equal(state.calls.some(call => call.method === "HEAD"), false)
  }
  // Without a recorded code the family number itself must still be a Play version code.
  const {state, options, pin} = flooredAndroidFixture({})
  state.plan.native.buildNumber = state.androidReceipt.native.buildNumber = 2100000001
  state.androidReceipt.releasePlanSha256 = pin(state.plan)
  const request = await createRoutineRequest(options)
  assert.equal(request.status, "no-artifact")
  assert.match(request.reason, /exceeds Google Play's limit/)
})

test("Android selection accepts no other native, release or APK change beside the recorded version code", async () => {
  const repin = (s, pin) => { s.androidReceipt.releasePlanSha256 = pin(s.plan) }
  const changes = [s => s.androidReceipt.native.marketingVersion = "3.3.1", s => s.androidReceipt.native.buildNumber = 310000224,
    s => s.androidReceipt.native.buildNumber--, s => delete s.androidReceipt.native.playTrack,
    s => s.androidReceipt.native.playTrack = "internal", s => s.androidReceipt.native.testflight.group = "Other",
    s => s.androidReceipt.native.iosBuildNumber = 310000224, s => s.androidReceipt.native = null, s => delete s.androidReceipt.native,
    (s, pin) => { s.plan.native.androidBuildNumber = 310000224; repin(s, pin) },
    s => s.androidReceipt.sourceCommit = "f".repeat(40), s => s.androidReceipt.releasePlanSha256 = "0".repeat(64),
    s => s.androidReceipt.releaseIdentity = "3.3.0-beta.224", s => s.androidReceipt.releaseSetId = "mentra-other",
    s => s.androidReceipt.channel = "dev", s => s.androidReceipt.schemaVersion = 2,
    s => s.androidReceipt.artifacts[0].coordinate = "mentraos-3.3.0-beta.224-android.apk",
    s => s.androidReceipt.artifacts[0].url = s.androidReceipt.artifacts[0].url.replace("artifactscdn.mentraglass.com", "example.com"),
    s => s.androidReceipt.artifacts[0].sha256 = "bad", s => s.androidReceipt.artifacts[0].size = 0,
    s => s.androidReceipt.artifacts[0].status = "failed", s => s.androidReceipt.artifacts.push({...s.androidReceipt.artifacts[0]}),
    s => s.androidSize = 1]
  for (const change of changes) {
    const {state, options, pin} = flooredAndroidFixture(); change(state, pin)
    const request = await createRoutineRequest(options)
    assert.equal(request.status, "no-artifact", change.toString())
    assert.equal(request.selection, null)
  }
})

test("a recorded Android version code leaves the Mac selection on the family number", async () => {
  const {state, options} = coordinatedAndroidFixture("staging")
  state.androidReceipt.native.androidBuildNumber = 310000224
  const mac = {...options, routine: "no-glasses"}
  const request = await createRoutineRequest(mac)
  assert.equal(request.status, "ready", request.reason)
  assert.equal(request.selection.platform, "ios-on-mac")
  assert.equal(request.selection.app.build, "303000223")
  await verifyCoordinatedReadyRequest({...mac, request})
  state.receipt.app.build = "310000224"
  assert.equal((await createRoutineRequest(mac)).status, "no-artifact")
})

test("Android coordinated requests reject another release, mismatching native version and ambiguous or missing APK bytes", async () => {
  for (const change of [s => s.androidReceipt.sourceCommit = "f".repeat(40), s => s.androidReceipt.native.buildNumber++, s => s.androidReceipt.releasePlanSha256 = "0".repeat(64),
    s => s.androidReceipt.artifacts.push({...s.androidReceipt.artifacts[0]}), s => s.androidReceipt.artifacts[0].url += "other",
    s => s.androidReceipt.artifacts[0].sha256 = "bad", s => s.androidSize = 1, s => s.jobs[0].steps = []]) {
    const f = coordinatedAndroidFixture(); change(f.state)
    assert.equal((await createRoutineRequest(f.options)).status, "no-artifact")
  }
})
