import test from "node:test"
import assert from "node:assert/strict"
import {scheduledOccurrence, githubOccurrence, nightlyApi, reconcileNightlyOccurrence, nightlySummary, publishNightlyWebhook, NIGHTLY_WORKFLOW} from "./nightly-device-routines.mjs"
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
test("Slack summary reports ran and skipped counts and refuses rerun sends", async () => {
  const sends = [], options = {result: terminal(), webhook: "https://hooks.slack.com/services/fixture", attempt: 1,
    fetchImpl: async (_, options) => {sends.push(JSON.parse(options.body)); return new Response("ok")}}
  assert.equal((await publishNightlyWebhook(options)).status, "acknowledged")
  assert.match(sends[0].text, /^🟢 Dev nightly: pass; 1\/1 passed\n<https:\/\/admin\.dev\.mentraglass\.com\/\?testRun=example\|View nightly results>\nBuild: unavailable in the nightly receipt\n1\/1 Ran, 0 skipped$/)
  assert.equal(sends[0].unfurl_links, false)
  assert.equal(sends[0].unfurl_media, false)
  await assert.rejects(publishNightlyWebhook({...options, attempt: 2}), /reconciliation/)
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
  await publishNightlyWebhook({result, webhook: "https://hooks.slack.com/services/fixture", attempt: 1,
    fetchImpl: async (_, options) => {body = JSON.parse(options.body); return new Response("ok")}})
  assert.match(body.text, /^(?:🟢|🔴|⚪) Dev nightly:/)
  assert.match(body.text, /View nightly results>|Result link unavailable/)
  return body.text.split("\n").slice(2).join("\n")
}

test("Slack lists failed and unfinished members with per-run links and counts all recorded attempts", async () => {
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
    "Build: unavailable in the nightly receipt\n6/8 Ran, 2 skipped\n\n" +
    "- call (android) · failed - <https://admin.dev.mentraglass.com/?testRun=failed%3Arun%2F1|View result>\n" +
    "- ota (ios-on-mac) · setup-failed - <https://admin.dev.mentraglass.com/?testRun=setup|View result>\n" +
    "- notes&lt;&amp;&gt; (android) · teardown-failed - <https://admin.dev.mentraglass.com/?testRun=teardown|View result>\n" +
    "- cancelled (android) · cancelled - <https://admin.dev.mentraglass.com/?testRun=cancelled|View result>\n" +
    "- no-test-steps (android) · not-run - <https://admin.dev.mentraglass.com/?testRun=not-run|View result>\n" +
    "- unavailable (android) · incomplete - <https://admin.dev.mentraglass.com/?testRun=example|View result>\n" +
    "- never-started (android) · not-run - <https://admin.dev.mentraglass.com/?testRun=example|View result>")
})

test("empty selection is neutral and unfinished members are listed", async () => {
  assert.equal(await slackText({...terminal(), status: "skipped", expectedCount: 0, passed: 0, members: []}), "Build: unavailable in the nightly receipt\n0/0 Ran, 0 skipped")
  assert.equal(await slackText({...terminal(), status: "incomplete", passed: 0,
    members: [{memberId: "missing", routineId: "missing", platform: "android", status: "incomplete"}]}), "Build: unavailable in the nightly receipt\n0/1 Ran, 1 skipped\n\n- missing (android) · incomplete - <https://admin.dev.mentraglass.com/?testRun=example|View result>")
})

test("failure without a run ID uses the occurrence result link without inventing a run", async () => {
  const result = {...terminal(), status: "failed", passed: 0,
    members: [{memberId: "failure", routineId: "call", platform: "android", status: "failed"}]}
  assert.equal(await slackText(result), "Build: unavailable in the nightly receipt\n0/1 Ran, 1 skipped\n\n- call (android) · failed - <https://admin.dev.mentraglass.com/?testRun=example|View result>")
  result.resultUrl = undefined
  assert.equal(await slackText(result), "Build: unavailable in the nightly receipt\n0/1 Ran, 1 skipped\n\n- call (android) · failed - Result link unavailable")
})


test("Slack identifies the frozen release, commit and producer job", async () => {
  const result = terminal()
  result.members[0].build = {releaseIdentity: "dev.559<&>", headSha: "a".repeat(40),
    source: {channel: "dev", buildRunId: 21, publicationAttempt: 2}}
  assert.equal(await slackText(result), "Build: dev.559&lt;&amp;&gt; · aaaaaaaaaa · <https://github.com/Mentra-Community/MentraOS/actions/runs/21|Build job> (publication 2)\n1/1 Ran, 0 skipped")
  delete result.members[0].build.releaseIdentity
  assert.match(await slackText(result), /^Build: aaaaaaaaaa · <https:\/\/github.com/)
})


test("Slack uses the stable suite link and distinguishes success, failure and empty selection", async () => {
  const sends = [], result = {...terminal(), resultUrl: "https://admin.dev.mentraglass.com/?testSuite=nightly-example"}
  const send = value => publishNightlyWebhook({result: value, webhook: "https://hooks.slack.com/services/fixture", attempt: 1,
    fetchImpl: async (_, options) => {sends.push(JSON.parse(options.body)); return new Response("ok")}})
  await send(result)
  assert.match(sends[0].text, /^🟢 Dev nightly: pass; 1\/1 passed/)
  assert.match(sends[0].text, /<https:\/\/admin\.dev\.mentraglass\.com\/\?testSuite=nightly-example\|View nightly results>/)
  await send({...result, status: "failed", passed: 0, members: [{...result.members[0], status: "failed"}]})
  assert.match(sends[1].text, /^🔴 Dev nightly: failed; 0\/1 passed/)
  await send({...result, status: "skipped", passed: 0, expectedCount: 0, members: []})
  assert.match(sends[2].text, /^⚪ Dev nightly: skipped; 0\/0 passed/)
})
