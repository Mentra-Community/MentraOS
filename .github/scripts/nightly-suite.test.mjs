import assert from "node:assert/strict"
import test from "node:test"
import {nightlySuiteId, suiteResultMessage, publishSuiteResult, frozenNightlySuite,
  suiteMemberBinding, suiteApi, reconcileNightlySuite, publishSuiteWebhook} from "./nightly-suite.mjs"

const expected = ["no-glasses", "ota-roundtrip-android"]
const suite = {suiteId: nightlySuiteId(5000, 1), channel: "dev", outcome: "passed", passed: 2,
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
  const single = {...suite, passed: 1, members: [{...suite.members[0], runId: "routine-100-1-dev-no-glasses"}]}
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

test("freeze includes unavailable members before any request receives its ID", () => {
  const frozen = frozenNightlySuite({plan: {sourceRunId: 5000, startedAt: suite.finishedAt,
    requests: [{channel: "dev", routine: "no-glasses", headSha: "a".repeat(40)}]}, runId: 5000, attempt: 1})
  assert.equal(frozen.members.length, 5)
  assert.equal(frozen.members.at(-1).routineId, "ota-roundtrip-android")
  assert.equal(frozen.members[0].platform, "ios-mac")
  assert.ok(frozen.members.every(member => !member.requestId))
  const unavailable = frozenNightlySuite({plan: {sourceRunId: 5000, startedAt: suite.finishedAt, requests: [],
    unavailable: [{routine: "no-glasses", reason: "No verified publication"}]}, runId: 5000, attempt: 1, workflowSha: "b".repeat(40)})
  assert.equal(unavailable.members.length, 5)
  assert.equal(unavailable.build.headSha, "b".repeat(40))
  assert.ok(unavailable.members.every(member => !member.requestId))
  assert.equal(frozenNightlySuite({plan: {requests: []}}), undefined)
  assert.throws(() => frozenNightlySuite({plan: {sourceRunId: 5000, startedAt: suite.finishedAt,
    requests: [{channel: "staging", routine: "no-glasses", headSha: "a".repeat(40)}]}, runId: 5000, attempt: 1}))
})

test("member binding derives only exact acknowledged dev request IDs", () => {
  assert.deepEqual(suiteMemberBinding({runId: 6000, runAttempt: 1, channel: "dev", routine: "no-glasses"}),
    {memberId: "no-glasses", body: {requestId: "routine-6000-1-dev-no-glasses"}})
  assert.throws(() => suiteMemberBinding({runId: 6000, runAttempt: 2, channel: "dev", routine: "no-glasses"}))
})

test("suite API fixes host, sanitizes failures and never retries uncertain writes", async () => {
  let requests = 0
  await assert.rejects(suiteApi({token: "synthetic", suiteId: suite.suiteId, operation: "complete", body: {},
    fetchImpl: async (url, options) => {requests++; assert.ok(url.startsWith("https://core.dev.us-west-2.mentraglass.com/api/internal/test-runs/suites/"));
      assert.equal(options.redirect, "error"); return Response.json({error: "sensitive"}, {status: 409})}}), /failed \(409\)/)
  assert.equal(requests, 1)
})

test("reconciler waits for terminal publication, not request send or partial failed evidence", async () => {
  let clock = Date.parse(suite.finishedAt), reads = 0, completed = false
  const initial = {...suite, outcome: "running", finishedAt: undefined,
    members: expected.map(routineId => ({routineId, requestId: routineId, status: "failed", runId: routineId,
      finishedAt: suite.finishedAt, publicationComplete: false}))}
  const result = await reconcileNightlySuite({suiteId: suite.suiteId, token: "synthetic", expectedRoutineIds: expected,
    deadline: clock + 100, pollMilliseconds: 10, now: () => clock, sleep: async duration => {clock += duration},
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") {completed = true; return Response.json({...initial, finishedAt: suite.finishedAt, outcome: "failed"})}
      reads++
      return Response.json(completed ? {...initial, outcome: "failed", finishedAt: suite.finishedAt}
        : {...initial, members: initial.members.map(member => ({...member, publicationComplete: reads > 1}))})
    }})
  assert.equal(reads, 2)
  assert.equal(clock, Date.parse(suite.finishedAt) + 10)
  assert.equal(result.outcome, "failed")
})

test("deadline completes missing bound results as non-pass; unbound members do not block others", async () => {
  let clock = Date.parse(suite.finishedAt), completed = false
  const pending = {...suite, finishedAt: undefined, outcome: "running", members: [
    {routineId: expected[0], requestId: "pending", status: "waiting"}, {routineId: expected[1], status: "waiting"}]}
  const result = await reconcileNightlySuite({suiteId: suite.suiteId, token: "synthetic", expectedRoutineIds: expected,
    deadline: clock + 20, pollMilliseconds: 10, now: () => clock, sleep: async duration => {clock += duration},
    fetchImpl: async (_url, options) => {
      if (options.method === "POST") completed = true
      return Response.json(completed ? {...pending, outcome: "failed", passed: 0, finishedAt: suite.finishedAt,
        members: pending.members.map(member => ({...member, status: "not-run"}))} : pending)
    }})
  assert.equal(clock, Date.parse(suite.finishedAt) + 20)
  assert.deepEqual(suiteResultMessage(result, expected).failedRoutines, expected)
})

test("read outages retry only reads until deadline, then use frozen completion response", async () => {
  let clock = Date.parse(suite.finishedAt), writes = 0
  const result = await reconcileNightlySuite({suiteId: suite.suiteId, token: "synthetic", expectedRoutineIds: expected,
    deadline: clock + 20, pollMilliseconds: 10, now: () => clock, sleep: async duration => {clock += duration},
    fetchImpl: async (_url, options) => {
      if (options.method === "GET") throw new Error("synthetic outage")
      writes++
      return Response.json({...suite, outcome: "failed", passed: 0, members: expected.map(routineId => ({routineId, status: "not-run"}))})
    }})
  assert.equal(writes, 1)
  assert.equal(result.outcome, "failed")
  assert.equal(clock, Date.parse(suite.finishedAt) + 20)
})

test("dev webhook acknowledges exactly one final post without leaking or retrying", async () => {
  let posts = 0
  const webhook = "https://hooks.slack.com/services/TEST/TEST/synthetic"
  const receipt = await publishSuiteWebhook({suite, expectedRoutineIds: expected, webhook,
    fetchImpl: async (_url, options) => {posts++; assert.equal(options.redirect, "error");
      assert.ok(JSON.parse(options.body).text.includes("testSuite=")); return new Response("ok")}})
  assert.equal(receipt.acknowledged, true)
  assert.equal(posts, 1)
  await assert.rejects(publishSuiteWebhook({suite, expectedRoutineIds: expected, webhook,
    fetchImpl: async () => {throw new Error(webhook)}}), error => !error.message.includes(webhook))
  await assert.rejects(publishSuiteWebhook({suite, expectedRoutineIds: expected, webhook: "https://example.org/services/TEST/TEST/synthetic"}))
})
