import test from "node:test"
import assert from "node:assert/strict"
import {scheduledOccurrence, githubOccurrence, nightlyApi, reconcileNightlyOccurrence, nightlySummary, publishNightlyWebhook, NIGHTLY_WORKFLOW} from "./nightly-device-routines.mjs"
const occurrence = {occurrenceId: "nightly-dev-2026-10-03", startedAt: "2026-10-03T11:00:00.000Z", trigger: "nightly"}
function terminal() {return {...occurrence, suiteId: "nightly-example", finishedAt: "2026-10-03T12:00:00.000Z", status: "pass", expectedCount: 1, passed: 1,
  resultUrl: "https://admin.dev.mentraglass.com/?testRun=example", members: [{memberId: "example", routineId: "never-listed-check", platform: "android", status: "pass", publicationComplete: true}]}}

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
test("generic Slack summary retains unexpected routine ID and refuses rerun sends", async () => {
  const sends = [], options = {result: terminal(), webhook: "https://hooks.slack.com/services/fixture", attempt: 1,
    fetchImpl: async (_, options) => {sends.push(JSON.parse(options.body)); return new Response("ok")}}
  assert.equal((await publishNightlyWebhook(options)).status, "acknowledged")
  assert.match(sends[0].text, /never-listed-check/)
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
