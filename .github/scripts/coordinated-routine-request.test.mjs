import assert from "node:assert/strict"
import test from "node:test"
import {readFile} from "node:fs/promises"
import {createRoutineRequest} from "./request-e2e-routine.mjs"
import {verifyCoordinatedReadyRequest} from "./coordinated-routine-request.mjs"
import {coordinatedFixture} from "./coordinated-routine-fixture.mjs"

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
    {path: ".github/workflows/other.yml"}, {conclusion: "failure"}, {status: "in_progress"},
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
    {requestOrigin: "successful-build", routine: "day1-ota"}])
    await assert.rejects(createRoutineRequest({...coordinatedFixture().options, ...override}))
  const {options} = coordinatedFixture()
  await assert.rejects(createRoutineRequest({...options, source: {...options.source, ref: "refs/heads/staging"}}))
  await assert.rejects(createRoutineRequest({...options, source: {...options.source, workflowSha: "c".repeat(40)}}))
})

test("ready callback revalidates the selected artifacts and exact trusted issuer", async () => {
  const {state, options} = coordinatedFixture()
  const request = await createRoutineRequest({...options, requestOrigin: "successful-build"})
  assert.equal(request.status, "ready")
  await verifyCoordinatedReadyRequest({...options, request})
  const changed = structuredClone(request); changed.selection.archive.sha256 = "f".repeat(64)
  await assert.rejects(verifyCoordinatedReadyRequest({...options, request: changed}), /differs/)
  state.run.conclusion = "failure"
  await assert.rejects(verifyCoordinatedReadyRequest({...options, request}), /successfully/)
})
