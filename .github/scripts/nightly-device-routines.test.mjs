import test from "node:test"
import assert from "node:assert/strict"
import {createHash} from "node:crypto"
import {scheduledOccurrence, githubOccurrence, nightlyApi, reconcileNightlyOccurrence, nightlySummary, nightlyMemberContext, publishNightlyMessage, NIGHTLY_WORKFLOW} from "./nightly-device-routines.mjs"
const occurrence = {occurrenceId: "nightly-dev-2026-10-03", startedAt: "2026-10-03T11:00:00.000Z", trigger: "nightly"}
function terminal() {return {...occurrence, suiteId: "nightly-example", finishedAt: "2026-10-03T12:00:00.000Z", status: "pass", expectedCount: 1, passed: 1,
  resultUrl: "https://admin.dev.mentraglass.com/?testRun=example", members: [{memberId: "example", routineId: "never-listed-check", platform: "android", status: "pass", publicationComplete: true, runId: "example"}]}}

test("04 Pacific DST occurrence stays stable through delayed trigger and run attempts", async () => {
  assert.deepEqual(scheduledOccurrence("0 11 * * *", "2026-10-03T11:12:00Z"), occurrence)
  assert.equal(scheduledOccurrence("0 12 * * *", "2026-10-03T12:00:00Z"), null)
  assert.equal(scheduledOccurrence("0 11 * * *", "2026-12-03T11:00:00Z"), null)
  assert.equal(scheduledOccurrence("0 12 * * *", "2026-12-03T12:05:00Z").startedAt, "2026-12-03T12:00:00.000Z")
  const run = {id: 100, path: NIGHTLY_WORKFLOW, head_branch: "dev", repository: {full_name: "Mentra-Community/MentraOS"},
    head_repository: {full_name: "Mentra-Community/MentraOS"}, event: "workflow_dispatch", created_at: "2026-10-03T11:12:00Z"}
  const options = {github: {rest: {actions: {getWorkflowRun: async () => ({data: run})}}}, context: {runId: 100, repo: {owner: "Mentra-Community", repo: "MentraOS"}, eventName: run.event}}
  assert.deepEqual(await githubOccurrence({...options, attempt: 1}), await githubOccurrence({...options, attempt: 7}))
})
test("scheduler repeats the exact occurrence for retries and trusts only final complete receipt", async () => {
  const calls = []; let now = 0, complete = 0
  const fetchImpl = async (url, options) => {calls.push({url, options}); return Response.json(url.endsWith("/complete")
    ? (++complete === 1 ? {...terminal(), status: "running", finishedAt: undefined} : terminal())
    : {plan: {...occurrence, members: terminal().members}, admissions: []})}
  const result = await reconcileNightlyOccurrence({token: "fixture", occurrence, deadline: 100, now: () => now, sleep: async ms => {now += ms}, pollMilliseconds: 10, fetchImpl})
  assert.equal(result.status, "pass"); assert.equal(calls.length, 4)
  assert.deepEqual(calls.filter(call => !call.url.endsWith("/complete")).map(call => JSON.parse(call.options.body)), [occurrence, occurrence])
  await assert.rejects(nightlyApi({token: "fixture", occurrence, fetchImpl: async () => Response.json({plan: {...occurrence, startedAt: "changed", members: []}})}), /boundary/)
})
test("dynamic expected members and publication evidence prevent a false pass", () => {
  const result = terminal(); assert.equal(nightlySummary(result).passed, true)
  result.members[0].publicationComplete = false; assert.throws(() => nightlySummary(result), /contradicts/)
  result.status = "incomplete"; assert.equal(nightlySummary(result).passed, false)
  result.expectedCount = 2; assert.throws(() => nightlySummary(result), /complete frozen/)
})
test("Slack summary matches history failure and skipped counts and refuses rerun sends", async () => {
  const sends = [], options = {result: terminal(), token: "fixture-bot-token", channel: "CNIGHTLY", attempt: 1,
    fetchImpl: async (_, options) => {sends.push(JSON.parse(options.body)); return Response.json({ok: true, channel: "CNIGHTLY", ts: "123.456", message: {bot_id: "BFIXTURE"}})}}
  assert.equal((await publishNightlyMessage(options)).status, "acknowledged")
  assert.match(sends[0].text, /^🟢 Dev nightly: Passed\n<https:\/\/admin\.dev\.mentraglass\.com\/\?testRun=example\|View nightly results>\nBuild: unavailable in the nightly receipt\n0\/1 failed$/)
  assert.equal(sends[0].unfurl_links, false)
  assert.equal(sends[0].unfurl_media, false)
  await assert.rejects(publishNightlyMessage({...options, attempt: 2}), /reconciliation/)
  assert.equal(sends.length, 1)
})

test("a transient admission or complete outage retries the original boundary and unfinished deadline refuses", async () => {
  let clock = 0, calls = 0
  const options = {token: "fixture", occurrence, deadline: 100, now: () => clock, sleep: async ms => {clock += ms}, pollMilliseconds: 10,
    fetchImpl: async url => {
      calls++; if (calls === 1) throw new Error("network fixture")
      return Response.json(url.endsWith("/complete") ? terminal() : {plan: {...occurrence, members: []}, admissions: []})
    }}
  assert.equal((await reconcileNightlyOccurrence(options)).status, "pass"); assert.equal(calls, 3)
  clock = 100
  await assert.rejects(reconcileNightlyOccurrence({...options, fetchImpl: async url => Response.json(url.endsWith("/complete")
    ? {...terminal(), status: "running", finishedAt: undefined} : {plan: {...occurrence, members: []}, admissions: []})}), /terminal receipt/)
})

for (const operation of ["start", "complete"]) test(`${operation} response-body timeout retries the original occurrence and preserves its failed receipt`, async () => {
  let clock = 0, interrupted = false
  const calls = [], receipt = {...terminal(), status: "failed", passed: 0,
    members: [{...terminal().members[0], status: "setup-failed", publicationComplete: false, assignmentEvidence: "invalid"}]}
  const result = await reconcileNightlyOccurrence({token: "fixture", occurrence, deadline: 100, now: () => clock,
    sleep: async ms => {clock += ms}, pollMilliseconds: 10, fetchImpl: async (url, options) => {
      calls.push({url, options})
      const currentOperation = url.endsWith("/complete") ? "complete" : "start"
      if (currentOperation === operation && !interrupted) {
        interrupted = true
        return new Response(new ReadableStream({pull(controller) {
          controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
        }}))
      }
      return Response.json(currentOperation === "complete" ? receipt : {plan: {...occurrence, members: receipt.members}, admissions: []})
    }})
  assert.deepEqual(result, receipt)
  assert.equal(clock, 10)
  assert.equal(calls.length, operation === "start" ? 3 : 4)
  assert.deepEqual(calls.filter(call => !call.url.endsWith("/complete")).map(call => JSON.parse(call.options.body)), [occurrence, occurrence])
  assert.equal(nightlySummary(result).passed, false)
  assert.deepEqual(nightlyMemberContext(result.members[0]), {machine: "unknown", lane: "unknown", resources: ["unknown"]})
})

test("invalid JSON remains a permanent response refusal", async () => {
  let calls = 0
  await assert.rejects(reconcileNightlyOccurrence({token: "fixture", occurrence, deadline: 100, now: () => 0,
    sleep: async () => assert.fail("Invalid JSON must not retry"), fetchImpl: async () => {
      calls++; return new Response('{"plan":')
    }}), error => error instanceof SyntaxError && !error.retryable)
  assert.equal(calls, 1)
})

test("HTTP and occurrence validation refusals remain permanent after response-body retry handling", async () => {
  for (const status of [400, 401, 403]) await assert.rejects(nightlyApi({token: "fixture", occurrence,
    fetchImpl: async () => new Response(null, {status})}), error => error.retryable === false && error.message.endsWith(`(${status})`))
  await assert.rejects(nightlyApi({token: "fixture", occurrence,
    fetchImpl: async () => Response.json({plan: {...occurrence, occurrenceId: "another-occurrence", members: []}})}),
  error => !error.retryable && /acknowledgement differs/.test(error.message))
})

test("response-body outages do not extend the reconciliation deadline or invent a terminal receipt", async () => {
  let clock = 0
  const boundaries = []
  await assert.rejects(reconcileNightlyOccurrence({token: "fixture", occurrence, deadline: 10, now: () => clock,
    sleep: async ms => {clock += ms}, pollMilliseconds: 30_000, fetchImpl: async (_, options) => {
      boundaries.push(JSON.parse(options.body))
      return new Response(new ReadableStream({pull(controller) {
        controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
      }}))
    }}), /terminal receipt before the reconciliation deadline/)
  assert.equal(clock, 10)
  assert.deepEqual(boundaries, [occurrence, occurrence])
})

test("expired trigger reconciles the original occurrence without resetting its start boundary", async () => {
  const delayed = scheduledOccurrence("0 11 * * *", "2026-10-03T14:30:00Z")
  assert.deepEqual(delayed, occurrence)
  const clock = Date.parse("2026-10-03T14:30:00Z"), calls = []
  const receipt = {...terminal(), status: "incomplete", passed: 0, finishedAt: new Date(clock).toISOString(),
    members: [{...terminal().members[0], status: "not-run", publicationComplete: false}]}
  const result = await reconcileNightlyOccurrence({token: "fixture", occurrence: delayed, now: () => clock, deadline: clock,
    sleep: async () => assert.fail("Expired terminal receipt must not start another wait"), fetchImpl: async (url, options) => {
      calls.push({url, options})
      return Response.json(url.endsWith("/complete") ? receipt : {plan: {...delayed, members: receipt.members}, admissions: []})
    }})
  assert.equal(result.status, "incomplete")
  assert.deepEqual(JSON.parse(calls[0].options.body), occurrence)
  assert.equal(calls.length, 2)
})

async function slackText(result) {
  let body
  await publishNightlyMessage({result, token: "fixture-bot-token", channel: "CNIGHTLY", attempt: 1,
    fetchImpl: async (_, options) => {body = JSON.parse(options.body); return Response.json({ok: true, channel: "CNIGHTLY", ts: "123.456", message: {bot_id: "BFIXTURE"}})}})
  assert.match(body.text, /^(?:🟢|🔴|⚪) Dev nightly:/)
  assert.match(body.text, /View nightly results>|Result link unavailable/)
  return body.text.split("\n").slice(2).join("\n")
}

function recordedDigest(value) {
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value
  return createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex")
}
function assignedMember() {
  const revision = "a".repeat(40), build = {repository: "Mentra-Community/MentraOS", channel: "dev", headSha: "b".repeat(40)}
  const input = {routineId: "bluetooth-toggle", platform: "android", definitionRevision: revision,
    routineSource: {commit: revision}, laneId: "testing-pro-1-android", build,
    resources: [{id: "pro1:phone", kind: "phone", exclusiveDependencies: [{resourceId: "shared:phone-link", authorityHostId: "testing-pro-1", capability: "backend-connectivity"}]},
      {id: "pro1:app", kind: "app"}, {id: "pro1:recorder", kind: "recorder", exclusiveDependencies: [{resourceId: "shared:phone-link", authorityHostId: "testing-pro-1", capability: "quiet-room"}]}]}
  return {memberId: "original-member", requestId: "original-request", routineId: input.routineId, platform: input.platform,
    routineRevision: revision, hostId: "testing-pro-1", binding: {jobId: "original-request", requestId: "original-request",
      hostId: "testing-pro-1", laneId: input.laneId, descriptorRevision: "c".repeat(64), actionsRunId: "10", actionsJobId: "20", boundAt: occurrence.startedAt},
    dispatchIntent: {requestId: "original-request", routineId: input.routineId, platform: input.platform, routineRevision: revision, laneId: input.laneId, build},
    input, inputSha256: recordedDigest(input), status: "not-run", publicationComplete: false, runId: "original-run"}
}

test("Slack context uses the original bound input and canonical dependencies without fleet or rerun substitution", async () => {
  const member = {...assignedMember(), requiredResourceKinds: ["workspace"], laterRerun: {hostId: "other-host"}}
  const expected = {machine: "testing-pro-1", lane: "testing-pro-1-android",
    resources: ["pro1:phone", "shared:phone-link", "pro1:app", "pro1:recorder"]}
  assert.deepEqual(nightlyMemberContext(member), expected)
  assert.match(await slackText({...terminal(), status: "incomplete", passed: 0, members: [member]}),
    /bluetooth-toggle \(machine=testing-pro-1, lane=testing-pro-1-android, resources=pro1:phone, shared:phone-link, pro1:app, pro1:recorder\) · not-run - <https:\/\/admin.dev.mentraglass.com\/\?testRun=original-run\|View result>/)
})

test("never-bound requirements remain explicit and missing or corrupt original assignment stays unknown", async () => {
  const unassigned = {platform: "android", requiredResourceKinds: ["phone", "app", "recorder"]}
  assert.deepEqual(nightlyMemberContext(unassigned), {machine: "unassigned", lane: "android", resources: ["phone", "app", "recorder"]})
  assert.deepEqual(nightlyMemberContext({...unassigned, requiredResourceKinds: ["phone", "phone"]}).resources, ["unknown"])
  assert.deepEqual(nightlyMemberContext({platform: "ios-on-mac"}), {machine: "unassigned", lane: "ios-on-mac", resources: ["unknown"]})
  assert.deepEqual(nightlyMemberContext({...unassigned, assignmentEvidence: "invalid"}), {machine: "unknown", lane: "unknown", resources: ["unknown"]})
  const kinds = ["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"]
  assert.deepEqual(nightlyMemberContext({platform: "android", requiredResourceKinds: kinds}).resources, kinds)
  assert.deepEqual(nightlyMemberContext({platform: "android", requiredResourceKinds: [...kinds, "other"]}).resources, ["unknown"])
  for (const change of [{hostId: "other-host"}, {dispatchIntent: undefined},
    {binding: {...assignedMember().binding, requestId: "later-request"}}, {binding: {...assignedMember().binding, laneId: "other-lane"}}])
    assert.deepEqual(nightlyMemberContext({...assignedMember(), ...change}), {machine: "unknown", lane: "unknown", resources: ["unknown"]})
  for (const change of [{input: undefined}, {inputSha256: "f".repeat(64)}, {input: {...assignedMember().input, laneId: "different-lane"}}])
    assert.deepEqual(nightlyMemberContext({...assignedMember(), ...change}), {machine: "testing-pro-1", lane: "testing-pro-1-android", resources: ["unknown"]})
  assert.match(await slackText({...terminal(), status: "incomplete", passed: 0, members: [{...assignedMember(), input: undefined}]}),
    /machine=testing-pro-1, lane=testing-pro-1-android, resources=unknown/)
})

test("Slack escapes recorded dependency markup and refuses control-bearing provenance", async () => {
  const member = assignedMember()
  member.input.resources[0].exclusiveDependencies[0].resourceId = "shared:<link>&"
  member.inputSha256 = recordedDigest(member.input)
  const text = await slackText({...terminal(), status: "incomplete", passed: 0, members: [member]})
  assert.ok(text.includes("resources=pro1:phone, shared:&lt;link&gt;&amp;, pro1:app, pro1:recorder"))
  member.input.resources[0].exclusiveDependencies[0].resourceId = "shared:\n<@everyone>"
  member.inputSha256 = recordedDigest(member.input)
  assert.deepEqual(nightlyMemberContext(member), {machine: "testing-pro-1", lane: "testing-pro-1-android", resources: ["unknown"]})
})

test("Slack lists failed and unfinished members with per-run links and history counts", async () => {
  const members = [
    {memberId: "pass", routineId: "passing", platform: "android", status: "pass", runId: "pass", publicationComplete: true},
    {memberId: "failure", routineId: "call", platform: "android", status: "failed", runId: "failed:run/1"},
    {memberId: "setup", routineId: "ota", platform: "ios-on-mac", status: "setup-failed", runId: "setup"},
    {memberId: "teardown", routineId: "notes<&>", platform: "android", status: "teardown-failed", runId: "teardown"},
    {memberId: "cancelled", routineId: "cancelled", platform: "android", status: "cancelled", runId: "cancelled"},
    {memberId: "not-run", routineId: "no-test-steps", platform: "android", status: "not-run", runId: "not-run"},
    {memberId: "missing", routineId: "unavailable", platform: "android", status: "incomplete", unavailableReason: "No host"},
    {memberId: "not-started", routineId: "never-started", platform: "android", status: "not-run"},
  ]
  assert.equal(await slackText({...terminal(), status: "incomplete", expectedCount: members.length, members}),
    "Build: unavailable in the nightly receipt\n3/5 failed, 3 skipped\n\n" +
    "- call (machine=unassigned, lane=android, resources=unknown) · failed - <https://admin.dev.mentraglass.com/?testRun=failed%3Arun%2F1|View result>\n" +
    "- ota (machine=unassigned, lane=ios-on-mac, resources=unknown) · setup-failed - <https://admin.dev.mentraglass.com/?testRun=setup|View result>\n" +
    "- notes&lt;&amp;&gt; (machine=unassigned, lane=android, resources=unknown) · teardown-failed - <https://admin.dev.mentraglass.com/?testRun=teardown|View result>\n" +
    "- cancelled (machine=unassigned, lane=android, resources=unknown) · cancelled - <https://admin.dev.mentraglass.com/?testRun=cancelled|View result>\n" +
    "- no-test-steps (machine=unassigned, lane=android, resources=unknown) · not-run - <https://admin.dev.mentraglass.com/?testRun=not-run|View result>\n" +
    "- unavailable (machine=unassigned, lane=android, resources=unknown) · incomplete - <https://admin.dev.mentraglass.com/?testRun=example|View result>\n" +
    "- never-started (machine=unassigned, lane=android, resources=unknown) · not-run - <https://admin.dev.mentraglass.com/?testRun=example|View result>")
})

test("empty selection is neutral and unfinished members are listed", async () => {
  assert.equal(await slackText({...terminal(), status: "skipped", expectedCount: 0, passed: 0, members: []}), "Build: unavailable in the nightly receipt\n0/0 failed")
  assert.equal(await slackText({...terminal(), status: "incomplete", passed: 0,
    members: [{memberId: "missing", routineId: "missing", platform: "android", status: "incomplete"}]}), "Build: unavailable in the nightly receipt\n0/0 failed, 1 skipped\n\n- missing (machine=unassigned, lane=android, resources=unknown) · incomplete - <https://admin.dev.mentraglass.com/?testRun=example|View result>")
})

test("Slack names execution passes with unpublished evidence as unsuccessful members", async () => {
  for (const publicationComplete of [false, undefined]) {
    const result = {...terminal(), status: "incomplete", passed: 0,
      members: [{...terminal().members[0], publicationComplete}]}
    assert.equal(await slackText(result), "Build: unavailable in the nightly receipt\n0/1 failed\n\n" +
      "- never-listed-check (machine=unassigned, lane=android, resources=unknown) · execution passed; evidence incomplete - <https://admin.dev.mentraglass.com/?testRun=example|View result>")
  }
})

test("failure without a run ID uses the occurrence result link without inventing a run", async () => {
  const result = {...terminal(), status: "failed", passed: 0,
    members: [{memberId: "failure", routineId: "call", platform: "android", status: "failed"}]}
  assert.equal(await slackText(result), "Build: unavailable in the nightly receipt\n1/1 failed\n\n- call (machine=unassigned, lane=android, resources=unknown) · failed - <https://admin.dev.mentraglass.com/?testRun=example|View result>")
  result.resultUrl = undefined
  assert.equal(await slackText(result), "Build: unavailable in the nightly receipt\n1/1 failed\n\n- call (machine=unassigned, lane=android, resources=unknown) · failed - Result link unavailable")
})


test("Slack identifies the frozen release, commit and producer job", async () => {
  const result = terminal()
  result.members[0].build = {releaseIdentity: "dev.559<&>", headSha: "a".repeat(40),
    source: {channel: "dev", buildRunId: 21, publicationAttempt: 2}}
  assert.equal(await slackText(result), "Build: dev.559&lt;&amp;&gt; · aaaaaaaaaa · <https://github.com/Mentra-Community/MentraOS/actions/runs/21|Build job> (publication 2)\n0/1 failed")
  delete result.members[0].build.releaseIdentity
  assert.match(await slackText(result), /^Build: aaaaaaaaaa · <https:\/\/github.com/)
})


test("Slack uses the stable suite link and distinguishes success, failure and empty selection", async () => {
  const sends = [], result = {...terminal(), resultUrl: "https://admin.dev.mentraglass.com/?testSuite=nightly-example"}
  const send = value => publishNightlyMessage({result: value, token: "fixture-bot-token", channel: "CNIGHTLY", attempt: 1,
    fetchImpl: async (_, options) => {sends.push(JSON.parse(options.body)); return Response.json({ok: true, channel: "CNIGHTLY", ts: "123.456", message: {bot_id: "BFIXTURE"}})}})
  await send(result)
  assert.match(sends[0].text, /^🟢 Dev nightly: Passed/)
  assert.match(sends[0].text, /<https:\/\/admin\.dev\.mentraglass\.com\/\?testSuite=nightly-example\|View nightly results>/)
  await send({...result, status: "failed", passed: 0, members: [{...result.members[0], status: "failed"}]})
  assert.match(sends[1].text, /^🔴 Dev nightly: Failed/)
  await send({...result, status: "skipped", passed: 0, expectedCount: 0, members: []})
  assert.match(sends[2].text, /^⚪ Dev nightly: Skipped/)
})

test('history-style summary keeps cancellations and evidence-only incompleteness neutral without pass ratios', async () => {
  const cases = [
    {status: 'cancelled', members: [{...terminal().members[0], status: 'cancelled'}], heading: 'Cancelled', counts: '0/1 failed'},
    {status: 'failed', members: [{...terminal().members[0], status: 'not-run'}], heading: 'Incomplete', counts: '0/0 failed, 1 skipped'},
    {status: 'incomplete', members: [{...terminal().members[0], publicationComplete: false}], heading: 'Incomplete', counts: '0/1 failed'},
  ]
  for (const {status, members, heading, counts} of cases) {
    let text
    await publishNightlyMessage({result: {...terminal(), status, members, passed: 0}, token: 'fixture-bot-token', channel: 'CNIGHTLY', attempt: 1,
      fetchImpl: async (_, options) => {text = JSON.parse(options.body).text; return Response.json({ok: true, channel: 'CNIGHTLY', ts: '123.456', message: {bot_id: 'BFIXTURE'}})}})
    assert.ok(text.startsWith(`⚪ Dev nightly: ${heading}\n`)); assert.ok(text.includes(`\n${counts}\n`))
    assert.doesNotMatch(text, /\d+\/\d+ passed|\d+\/\d+ Ran/)
  }
})

test('mixed failed and incomplete receipts retain the red Failed history heading', async () => {
  for (const neighbor of [
    {...terminal().members[0], memberId: 'missing', status: 'incomplete', runId: undefined},
    {...terminal().members[0], memberId: 'unpublished', publicationComplete: false},
  ]) {
    let text
    const result = {...terminal(), status: 'incomplete', passed: 0, expectedCount: 2,
      members: [{...terminal().members[0], status: 'setup-failed'}, neighbor]}
    await publishNightlyMessage({result, token: 'fixture-bot-token', channel: 'CNIGHTLY', attempt: 1,
      fetchImpl: async (_, options) => {text = JSON.parse(options.body).text; return Response.json({ok: true, channel: 'CNIGHTLY', ts: '123.456', message: {bot_id: 'BFIXTURE'}})}})
    assert.ok(text.startsWith('🔴 Dev nightly: Failed\n'))
    assert.ok(text.includes(neighbor.status === 'incomplete' ? '\n1/1 failed, 1 skipped\n' : '\n1/2 failed\n'))
  }
})


test("nightly delivery retains the actual channel and message identity through the existing bot", async () => {
  const sends = []
  const receipt = await publishNightlyMessage({result: terminal(), token: "fixture-bot-token", channel: "CNIGHTLY", attempt: 1,
    fetchImpl: async (url, options) => {
      sends.push({url, options})
      return Response.json({ok: true, channel: "CNIGHTLY", ts: "123.456", message: {bot_id: "BFIXTURE"}})
    }})
  assert.deepEqual(receipt, {occurrenceId: occurrence.occurrenceId, status: "acknowledged", passed: true,
    channel: "CNIGHTLY", ts: "123.456", botId: "BFIXTURE"})
  assert.equal(sends[0].url, "https://slack.com/api/chat.postMessage")
  assert.equal(sends[0].options.headers.Authorization, "Bearer fixture-bot-token")
  assert.equal(sends[0].options.redirect, "error")
  assert.equal(JSON.parse(sends[0].options.body).channel, "CNIGHTLY")
})

test("nightly refuses missing configuration and never blindly retries an ambiguous or rejected post", async () => {
  let calls = 0
  const base = {result: terminal(), token: "fixture-bot-token", channel: "CNIGHTLY", attempt: 1}
  for (const invalid of [{token: undefined}, {channel: undefined}, {channel: "nightly-builds"}, {attempt: 2}]) {
    await assert.rejects(publishNightlyMessage({...base, ...invalid, fetchImpl: async () => {calls++; assert.fail("Invalid configuration must not send")}}))
  }
  assert.equal(calls, 0)
  for (const fetchImpl of [
    async () => {calls++; throw new Error("Lost response")},
    async () => {calls++; return new Response('{"ok":', {status: 200})},
    async () => {calls++; return Response.json({ok: false, error: "not_in_channel"})},
    async () => {calls++; return Response.json({ok: true, channel: "COTHER", ts: "123.456", message: {bot_id: "BFIXTURE"}})},
    async () => {calls++; return Response.json({ok: true, channel: "CNIGHTLY", ts: "bad", message: {bot_id: "BFIXTURE"}})},
    async () => {calls++; return Response.json({ok: true, channel: "CNIGHTLY", ts: "123.456", message: {}})},
  ]) {
    const before = calls
    await assert.rejects(publishNightlyMessage({...base, fetchImpl}))
    assert.equal(calls, before + 1)
  }
})
