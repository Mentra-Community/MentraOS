import assert from "node:assert/strict"
import test from "node:test"
import {applyRoutineResult, assertNotification, postReleaseMessage, ROUTINE_BLOCK, slackDestination, updateReleaseMessage} from "./release-slack-message.mjs"

const env = {BRANCH: "dev", REPOSITORY: "Mentra-Community/MentraOS", RUN_ID: "100", RUN_ATTEMPT: "2",
  SHA: "a".repeat(40), RELEASE_IDENTITY: "3.3.0-dev.223", FINALIZE_RESULT: "success", MAC_URL: "https://example.com/mac.zip",
  SLACK_BUILDS_BOT_TOKEN: "synthetic-bot-token", SLACK_DEV_BUILDS_CHANNEL_ID: "CDEV", SLACK_STAGING_BUILDS_CHANNEL_ID: "CSTAGING"}
const payload = {blocks: [{type: "section", text: {type: "mrkdwn", text: "Download links and OTA firmware"}},
  {type: "section", block_id: ROUTINE_BLOCK, text: {type: "mrkdwn", text: "Available tests"}}]}
const notification = (artifacts = {"ios-on-mac": "e".repeat(64)}) => ({schemaVersion: 2, kind: "mentra-release-slack-message",
  build: {repository: env.REPOSITORY, channel: "dev", runId: 100, headSha: env.SHA, release: env.RELEASE_IDENTITY, artifacts},
  producer: {runId: 100, runAttempt: 2, headSha: env.SHA}, message: {channel: "CDEV", ts: "100.123", botId: "BBUILDS"}, payload, rows: {}})
const row = (overrides = {}) => ({routineId: "routine-from-definition", title: "A newly enrolled routine", platform: "ios-on-mac",
  requestId: "request-500", status: "passed", resultRunId: "request-500", finishedAt: "2026-10-03T01:00:00Z",
  source: {channel: "dev", buildRunId: 100, publicationAttempt: 1}, ...overrides})
const response = value => new Response(JSON.stringify({ok: true, ...value}), {headers: {"content-type": "application/json"}})
const posted = () => response({channel: "CDEV", ts: "100.123", message: {bot_id: "BBUILDS"}})

test("bot transport retains exact post and published platform identity", async () => {
  let call
  const result = await postReleaseMessage(env, payload, {
    select: async ({platform}) => {assert.equal(platform, "ios-on-mac"); return {archive: {url: env.MAC_URL, sha256: "e".repeat(64)}}},
    fetchImpl: async (url, init) => {call = {url, body: JSON.parse(init.body)}; return posted()},
  })
  assert.deepEqual(result, notification())
  assert.equal(call.url, "https://slack.com/api/chat.postMessage")
  assert.deepEqual(call.body.blocks, payload.blocks)
})
test("each release platform is independently verified, including an Android-only publication", async () => {
  const android = "https://example.com/app.apk"
  const receipt = await postReleaseMessage({...env, MOBILE_APK_URL: android}, payload, {
    select: async ({platform}) => {if (platform === "ios-on-mac") throw new Error("missing Mac"); return {archive: {url: android, sha256: "d".repeat(64)}}},
    fetchImpl: async () => posted(),
  })
  assert.deepEqual(receipt.build.artifacts, {android: "d".repeat(64)})
  assert.doesNotThrow(() => applyRoutineResult(receipt, row({platform: "android"})))
  assert.throws(() => applyRoutineResult(receipt, row()), /Invalid routine result row/)
})
test("absence or malformed channel configuration leaves webhook fallback available", () => {
  assert.equal(slackDestination({...env, SLACK_BUILDS_BOT_TOKEN: ""}), null)
  assert.equal(slackDestination({...env, SLACK_DEV_BUILDS_CHANNEL_ID: "anything"}), null)
  assert.equal(slackDestination({...env, BRANCH: "staging"}), "CSTAGING")
})
test("unverified publication preserves delivery and explicitly disables result attachment", async () => {
  for (const failed of [false, true]) {
    let calls = 0
    const receipt = await postReleaseMessage({...env, ...(failed ? {FINALIZE_RESULT: "skipped", MAC_URL: ""} : {})}, payload, {
      select: async () => {if (failed) assert.fail("Failed release must not select an archive"); throw new Error("private outage")},
      fetchImpl: async () => {calls++; return posted()},
    })
    assert.equal(calls, 1)
    assert.equal(receipt.build, null)
    assert.deepEqual(receipt.payload.blocks[0], payload.blocks[0])
    assert.match(receipt.payload.blocks[1].text.text, /no verified published platform artifact/)
    assert.throws(() => assertNotification(receipt), /Invalid retained release message/)
  }
})
test("initial ambiguous POST is attempted once", async () => {
  let calls = 0
  await assert.rejects(postReleaseMessage(env, payload, {
    select: async () => ({archive: {url: env.MAC_URL, sha256: "e".repeat(64)}}),
    fetchImpl: async () => {calls++; throw new Error("lost response")},
  }), /response unavailable/)
  assert.equal(calls, 1)
})
test("arbitrary definitions render their titles and separate results by platform without altering download blocks", () => {
  let result = applyRoutineResult(notification({"ios-on-mac": "e".repeat(64), android: "d".repeat(64)}), row({title: "<New> & useful"}))
  result = applyRoutineResult(result, row({platform: "android", status: "setup-failed"}))
  result = applyRoutineResult(result, row({routineId: "another.new_id", title: "Other routine", status: "teardown-failed"}))
  assert.equal(Object.keys(result.rows).length, 3)
  assert.deepEqual(result.payload.blocks[0], payload.blocks[0])
  assert.match(result.payload.blocks[1].text.text, /&lt;New&gt; &amp; useful · iOS on Mac — \*Passed\*/)
  assert.match(result.payload.blocks[1].text.text, /Android — \*Setup failed\*/)
  assert.match(result.payload.blocks[1].text.text, /Other routine · iOS on Mac — \*Teardown failed\*/)
  assert.equal(notification().payload.blocks[1].text.text, "Available tests")
})
test("completed-request ordering prevents late retries regressing rows and uses request ID only for tied timestamps", () => {
  const first = applyRoutineResult(notification(), row())
  const latest = applyRoutineResult(first, row({requestId: "request-600", status: "failed", finishedAt: "2026-10-03T02:00:00Z"}))
  assert.equal(applyRoutineResult(latest, row({requestId: "request-999"})), latest)
  assert.equal(applyRoutineResult(latest, row({requestId: "request-599", finishedAt: "2026-10-03T02:00:00Z"})), latest)
  assert.equal(applyRoutineResult(latest, latest.rows["routine-from-definition:ios-on-mac"]), latest)
  const tied = applyRoutineResult(latest, row({requestId: "request-601", status: "cancelled", finishedAt: "2026-10-03T02:00:00Z"}))
  assert.match(tied.payload.blocks[1].text.text, /Cancelled/)
})
test("delayed evidence can upgrade the same frozen request without changing its identity or regressing terminal results", () => {
  const incomplete = applyRoutineResult(notification(), row({status: "upload-incomplete"}))
  const complete = applyRoutineResult(incomplete, row())
  assert.match(complete.payload.blocks[1].text.text, /Passed/)
  assert.equal(applyRoutineResult(complete, row({status: "upload-incomplete"})), complete)
  assert.equal(applyRoutineResult(incomplete, row({title: "Changed definition"})), incomplete)
  assert.equal(applyRoutineResult(incomplete, row({resultRunId: "other-result"})), incomplete)
})
test("valid long enrolled titles are retained and safely shortened for Slack display", () => {
  const title = "Coverage ".repeat(200)
  const result = applyRoutineResult(notification(), row({title}))
  assert.equal(result.rows["routine-from-definition:ios-on-mac"].title, title)
  assert.ok(result.payload.blocks[1].text.text.length < title.length)
  assert.match(result.payload.blocks[1].text.text, /… · iOS on Mac/)
})
test("malformed or another-build rows and retained state are refused", () => {
  for (const invalid of [{routineId: "bad id"}, {platform: "ios-mac"}, {title: ""}, {requestId: "bad id"}, {resultRunId: "bad id"},
    {finishedAt: "invalid"}, {status: "blocked"}, {source: {channel: "staging", buildRunId: 100, publicationAttempt: 1}},
    {source: {channel: "dev", buildRunId: 101, publicationAttempt: 1}}, {source: {channel: "dev", buildRunId: 100, publicationAttempt: 0}}])
    assert.throws(() => applyRoutineResult(notification(), row(invalid)), /Invalid routine result row/)
  const forged = {...notification(), rows: {"routine-from-definition:ios-on-mac": row({finishedAt: "invalid"})}}
  assert.throws(() => assertNotification(forged), /Invalid retained release message/)
  assert.throws(() => assertNotification({...notification(), schemaVersion: 1}), /Invalid retained release message/)
})
test("updater checks bot ownership and never creates a replacement post", async () => {
  const calls = []
  await assert.rejects(updateReleaseMessage(notification(), env, async url => {calls.push(url); return response({bot_id: "BOTHER"})}), /does not own/)
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
