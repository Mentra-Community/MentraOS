import assert from "node:assert/strict"
import test from "node:test"
import {nightlySuiteId, suiteResultMessage, publishSuiteResult} from "./nightly-suite.mjs"

const expected = ["no-glasses", "ota-roundtrip-android"]
const suite = {suiteId: nightlySuiteId(5000, 1), channel: "dev", outcome: "passed", passed: true,
  finishedAt: "2026-10-01T12:00:00Z", members: expected.map(routineId => ({routineId, status: "passed"}))}

test("suite identity and complete green require every frozen member", () => {
  assert.equal(suiteResultMessage(suite, expected).passed, true)
  assert.throws(() => nightlySuiteId(0, 1))
  for (const status of ["failed", "blocked", "cancelled", "not-run", "running", "unknown"]) {
    const result = suiteResultMessage({...suite, outcome: "failed", passed: false,
      members: [suite.members[0], {...suite.members[1], status}]}, expected)
    assert.equal(result.passed, false)
    assert.deepEqual(result.failedRoutines, ["ota-roundtrip-android"])
  }
  assert.equal(suiteResultMessage({...suite, outcome: "failed", passed: false, members: [suite.members[0]]}, expected).passed, false)
})

test("running, staging, duplicate and contradictory aggregates refuse posting", () => {
  for (const changed of [{outcome: "running"}, {channel: "staging"}, {finishedAt: undefined},
    {members: [suite.members[0], suite.members[0]]}, {outcome: "failed", passed: false}])
    assert.throws(() => suiteResultMessage({...suite, ...changed}, expected))
})

test("single-routine jobs link to their published run, not the suite", () => {
  const single = {...suite, members: [{...suite.members[0], runId: "routine-100-1-dev-no-glasses"}]}
  const result = suiteResultMessage(single, ["no-glasses"])
  assert.ok(result.url.includes("?testRun="))
  assert.ok(!result.text.includes("nightly suite"))
  assert.throws(() => suiteResultMessage({...single, members: [suite.members[0]]}, ["no-glasses"]))
})

test("suite Slack send binds destination and receipt without retry", async () => {
  let sends = 0
  const receipt = await publishSuiteResult({suite, expectedRoutineIds: expected, channel: "CDEV", token: "synthetic",
    fetchImpl: async (_url, options) => {sends++; const body = JSON.parse(options.body);
      assert.equal(body.metadata.event_payload.suite_id, suite.suiteId)
      return Response.json({ok: true, channel: "CDEV", ts: "100.1"})}})
  assert.equal(receipt.passed, true)
  assert.equal(sends, 1)
})
