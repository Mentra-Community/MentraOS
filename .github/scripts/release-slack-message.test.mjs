import assert from "node:assert/strict"
import test from "node:test"
import {applyRoutineResult, postReleaseMessage, ROUTINE_BLOCK, slackDestination, updateReleaseMessage} from "./release-slack-message.mjs"

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
  assert.match(receipt.payload.blocks[1].text.text, /Terminal Slack updates unavailable/)
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
