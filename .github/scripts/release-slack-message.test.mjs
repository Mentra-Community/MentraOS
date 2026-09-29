import assert from "node:assert/strict"
import test from "node:test"
import {DEVICE_ROUTINES} from "./device-routines.mjs"
import {applyRoutineResult, assertNotification, postReleaseMessage, ROUTINE_BLOCK, slackDestination, updateReleaseMessage} from "./release-slack-message.mjs"

const env = {BRANCH: "dev", REPOSITORY: "Mentra-Community/MentraOS", RUN_ID: "100", RUN_ATTEMPT: "2",
  SHA: "a".repeat(40), RELEASE_IDENTITY: "3.3.0-dev.223", FINALIZE_RESULT: "success", MAC_URL: "https://example.com/mac.zip",
  SLACK_BUILDS_BOT_TOKEN: "synthetic-bot-token", SLACK_DEV_BUILDS_CHANNEL_ID: "CDEV", SLACK_STAGING_BUILDS_CHANNEL_ID: "CSTAGING"}
const payload = {blocks: [{type: "section", text: {type: "mrkdwn", text: "Download links and OTA firmware"}},
  {type: "section", block_id: ROUTINE_BLOCK, text: {type: "mrkdwn", text: "Pending"}}]}
export const notification = () => ({schemaVersion: 1, kind: "mentra-release-slack-message",
  build: {repository: env.REPOSITORY, channel: "dev", runId: 100, headSha: env.SHA, release: env.RELEASE_IDENTITY, archiveSha256: "e".repeat(64)},
  producer: {runId: 100, runAttempt: 2, headSha: env.SHA}, message: {channel: "CDEV", ts: "100.123", botId: "BBUILDS"}, payload, rows: {}})
export const row = (overrides = {}) => ({routineId: "no-glasses", requestRunId: 500, requestAttempt: 1,
  privateRunId: 600, privateAttempt: 1, status: "passed", resultRunId: "routine-500-1-dev-no-glasses", ...overrides})
const response = value => new Response(JSON.stringify({ok: true, ...value}), {headers: {"content-type": "application/json"}})

test("bot transport retains exact post and build identity", async () => {
  let call
  const result = await postReleaseMessage(env, payload, {
    select: async () => ({archive: {url: env.MAC_URL, sha256: "e".repeat(64)}}),
    fetchImpl: async (url, init) => { call = {url, body: JSON.parse(init.body)}; return response({channel: "CDEV", ts: "100.123", message: {bot_id: "BBUILDS"}}) },
  })
  assert.deepEqual(result, notification())
  assert.equal(call.url, "https://slack.com/api/chat.postMessage")
  assert.deepEqual(call.body.blocks, payload.blocks)
})
test("absence or malformed channel configuration leaves webhook fallback available", () => {
  assert.equal(slackDestination({...env, SLACK_BUILDS_BOT_TOKEN: ""}), null)
  assert.equal(slackDestination({...env, SLACK_DEV_BUILDS_CHANNEL_ID: "anything"}), null)
  assert.equal(slackDestination({...env, BRANCH: "staging"}), "CSTAGING")
})
test("metadata outage preserves release delivery and explicitly disables terminal updates", async () => {
  let calls = 0
  const receipt = await postReleaseMessage(env, payload, {
    select: async () => { throw new Error("CDN temporarily unavailable") },
    fetchImpl: async () => { calls++; return response({channel: "CDEV", ts: "100.123", message: {bot_id: "BBUILDS"}}) },
  })
  assert.equal(calls, 1)
  assert.equal(receipt.build, null)
  assert.deepEqual(receipt.payload.blocks[0], payload.blocks[0])
  assert.match(receipt.payload.blocks[1].text.text, /Test result updates are disabled.*Mac download could not be verified/)
  assert.doesNotMatch(receipt.payload.blocks[1].text.text, /archive receipt/)
})
test("failed release posts explain that no verified build is attached", async () => {
  const receipt = await postReleaseMessage({...env, FINALIZE_RESULT: "skipped", MAC_URL: ""}, payload, {
    select: async () => assert.fail("A failed release must not select an archive"),
    fetchImpl: async () => response({channel: "CDEV", ts: "100.123", message: {bot_id: "BBUILDS"}}),
  })
  assert.equal(receipt.build, null)
  assert.match(receipt.payload.blocks[1].text.text, /no verified Mac build to attach test results to/)
  assert.throws(() => assertNotification(receipt), /Invalid retained release message/)
})
test("initial ambiguous POST is attempted once", async () => {
  let calls = 0
  await assert.rejects(postReleaseMessage(env, payload, {
    select: async () => ({archive: {url: env.MAC_URL, sha256: "e".repeat(64)}}),
    fetchImpl: async () => { calls++; throw new Error("lost response") },
  }), /response unavailable/)
  assert.equal(calls, 1)
})
test("routine updates preserve original download and OTA blocks", () => {
  const result = applyRoutineResult(notification(), row())
  assert.deepEqual(result.payload.blocks[0], payload.blocks[0])
  assert.match(result.payload.blocks[1].text.text, /Passed.*Recording and result/)
  assert.equal(notification().payload.blocks[1].text.text, "Pending")
})
test("concurrent routine completions accumulate and a late old retry cannot regress them", () => {
  const first = applyRoutineResult(notification(), row())
  const second = applyRoutineResult(first, row({routineId: "day1-ota", requestRunId: 501, status: "failed", resultRunId: "routine-501-1-dev-day1-ota"}))
  const third = applyRoutineResult(second, row({requestRunId: 502, status: "blocked", resultRunId: "routine-502-1-dev-no-glasses"}))
  assert.equal(Object.keys(third.rows).length, 2)
  assert.match(third.payload.blocks[1].text.text, /No-glasses UI — \*Blocked\*/)
  assert.match(third.payload.blocks[1].text.text, /Day-one OTA — \*Failed\*/)
  assert.deepEqual(applyRoutineResult(third, row({privateAttempt: 99})), third)
  assert.deepEqual(applyRoutineResult(third, row({requestRunId: 502, status: "blocked", resultRunId: "routine-502-1-dev-no-glasses"})), third)
})
test("every catalogued routine renders with its catalog name in the historical order; unknown IDs refuse as rows and as retained state", () => {
  // Historical display order first (unchanged for existing posts), then the Phone routines.
  const order = ["no-glasses", "no-glasses-android", "day1-ota", "mentra-call", "account-miniapps", "connected-glasses", "livestreamer",
    "captions-phone", "notes-phone"]
  assert.deepEqual([...order].sort(), Object.keys(DEVICE_ROUTINES).sort())
  let value = notification()
  for (const [index, routineId] of [...order].reverse().entries())
    value = applyRoutineResult(value, row({routineId, requestRunId: 500 + index, resultRunId: `routine-${500 + index}-1-dev-${routineId}`}))
  const lines = value.payload.blocks[1].text.text.split("\n").slice(1, -1)
  assert.deepEqual(lines.map(line => line.split(" — ")[0]), order.map(id => DEVICE_ROUTINES[id].name))
  assert.equal(value.payload.blocks[0], payload.blocks[0])
  for (const [routineId, name, runId] of [["captions-phone", "Captions with simulated glasses", 501], ["notes-phone", "Notes with simulated glasses", 500]])
    assert.ok(lines.includes(`${name} — *Passed* · <https://admin.dev.mentraglass.com/?testRun=routine-${runId}-1-dev-${routineId}|Recording and result>` +
      ` · <https://github.com/Mentra-Community/MentraOS/actions/runs/${runId}/attempts/1|Request>`), routineId)
  assert.deepEqual(assertNotification(value), value)
  // A routine outside the shared catalog is refused as a new row and as a retained row.
  assert.throws(() => applyRoutineResult(value, row({routineId: "arbitrary-routine"})), /Invalid routine result row/)
  const forged = {...value, rows: {...value.rows, "arbitrary-routine": row({routineId: "arbitrary-routine"})}}
  assert.throws(() => assertNotification(forged), /Invalid retained release message/)
  assert.throws(() => applyRoutineResult(forged, row({routineId: "captions-phone", requestRunId: 900})), /Invalid retained release message/)
  // Phone rows keep the ordinary row validation.
  for (const invalid of [{status: "unknown"}, {requestAttempt: 0}, {resultRunId: "bad id"}, {status: "cancelled"}])
    assert.throws(() => applyRoutineResult(notification(), row({routineId: "notes-phone", ...invalid})), /Invalid routine result row/)
})
test("updater checks bot ownership and never creates a replacement post", async () => {
  const calls = []
  await assert.rejects(updateReleaseMessage(notification(), env, async url => {
    calls.push(url); return response({bot_id: "BOTHER"})
  }), /does not own/)
  assert.deepEqual(calls, ["https://slack.com/api/auth.test"])
})
test("identical full update is retryable after a lost response", async () => {
  const state = applyRoutineResult(notification(), row()), bodies = []
  for (let attempt = 0; attempt < 2; attempt++) {
    const operation = updateReleaseMessage(state, env, async (url, init) => {
      if (url.endsWith("auth.test")) return response({bot_id: "BBUILDS"})
      bodies.push(JSON.parse(init.body))
      if (!attempt) throw new Error("unknown response")
      return response({channel: "CDEV", ts: "100.123"})
    })
    if (!attempt) await assert.rejects(operation, /response unavailable/); else await operation
  }
  assert.deepEqual(bodies[0], bodies[1])
})
