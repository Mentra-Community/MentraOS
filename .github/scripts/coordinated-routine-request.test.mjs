import assert from "node:assert/strict"
import test from "node:test"
import {publishedCoordinatedBuild, resolveCoordinatedSelection, coordinatedPublicationAttempt} from "./coordinated-routine-request.mjs"
import {coordinatedAndroidFixture, coordinatedFixture} from "./coordinated-routine-fixture.mjs"
const selection = (f, platform = "ios-on-mac") => resolveCoordinatedSelection({...f.options, platform,
  source: {kind: "coordinated-release", channel: f.options.channel, buildRunId: 100, publicationAttempt: 2}})
for (const channel of ["dev", "staging"]) test(`${channel} immutable Mac/Android publication parsers remain exact`, async () => {
  const f = coordinatedFixture(channel), mac = await selection(f)
  assert.equal(mac.archive.sha256, f.state.receipt.artifacts.mac.sha256)
  assert.equal(mac.receipt.sha256, f.pin(f.state.receipt))
  const android = coordinatedAndroidFixture(channel), apk = await selection(android, "android")
  assert.equal(apk.archive.name, android.state.plan.artifactNames.androidApp)
  assert.equal(apk.app.build, String(android.state.plan.native.buildNumber))
})
test("publication parser refuses dry-run, ambiguous and incomplete job histories before CDN reads", async () => {
  for (const mutate of [s => {s.jobs[0].steps[0].conclusion = "skipped"}, s => {s.jobs.push({...s.jobs[0], id: 1002})},
    s => {s.jobsResponse = {total_count: 2, jobs: []}}]) {
    const f = coordinatedFixture(); mutate(f.state)
    await assert.rejects(selection(f), /did not publish|incomplete/)
    assert.equal(f.state.calls.some(call => call.url), false)
  }
})
test("historical selection refuses changed source, receipt, archive, manifest and ancestry", async () => {
  for (const mutate of [s => {s.receipt.app.buildSha = "f".repeat(40)}, s => {s.ota.releaseVersion = "other"},
    s => {s.plan.sourceCommit = "f".repeat(40)}, s => {s.artifacts[0].expired = true}, s => {s.ancestry = "diverged"}, s => {s.changed = true}]) {
    const f = coordinatedFixture(); mutate(f.state); await assert.rejects(selection(f))
  }
})
test("retained finalizer clones resolve original execution, not notification retry", async () => {
  const f = coordinatedFixture(); Object.assign(f.state.jobs[0], {started_at: "2026-10-03T01:00:00Z", completed_at: "2026-10-03T01:10:00Z"})
  f.state.jobs.unshift({...f.state.jobs[0], id: 999, run_attempt: 1})
  assert.equal(await coordinatedPublicationAttempt(f.options.github, f.options.context, f.state.run), 1)
  await assert.rejects(selection(f), /retains an earlier publication/)
})
test("Android parser uses recorded Play-floor version and refuses a malformed lower code", async () => {
  const f = coordinatedAndroidFixture("staging"), {plan} = f.state
  plan.native = {buildNumber: 302010043, marketingVersion: "3.3.0", playTrack: "beta"}
  f.state.androidReceipt.native = {...plan.native, androidBuildNumber: 310000224}
  f.state.androidReceipt.releasePlanSha256 = f.pin(plan)
  const apk = await selection(f, "android"); assert.equal(apk.app.build, "310000224")
  f.state.androidReceipt.native.androidBuildNumber = 302010042
  await assert.rejects(selection(f, "android"), /androidBuildNumber/)
})
