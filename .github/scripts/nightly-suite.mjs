import {slackCall} from "./release-slack-message.mjs"

export function nightlySuiteId(runId, attempt) {
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error("Invalid nightly suite identity")
  return `nightly-${runId}-${attempt}-dev`
}

export function suiteResultMessage(suite, expectedRoutineIds) {
  if (!/^nightly-[1-9]\d*-[1-9]\d*-dev$/.test(suite?.suiteId ?? "") || suite.channel !== "dev" ||
    !["passed", "failed"].includes(suite.outcome) || !Number.isFinite(Date.parse(suite.finishedAt ?? "")) ||
    !Array.isArray(suite.members) || !expectedRoutineIds.length || new Set(expectedRoutineIds).size !== expectedRoutineIds.length)
    throw new Error("Suite is not a finalized dev nightly")
  const members = new Map()
  for (const member of suite.members) {
    if (!expectedRoutineIds.includes(member.routineId) || members.has(member.routineId))
      throw new Error("Suite membership differs from frozen nightly plan")
    members.set(member.routineId, member)
  }
  const failed = expectedRoutineIds.filter(routine => members.get(routine)?.status !== "passed")
  const passed = failed.length === 0 && suite.outcome === "passed" && suite.passed === true
  if (!passed && !failed.length) throw new Error("Suite aggregate contradicts member results")
  const url = `https://admin.dev.mentraglass.com/?testSuite=${encodeURIComponent(suite.suiteId)}`
  return {passed, failedRoutines: failed, url,
    text: `${passed ? "🟢" : "🔴"} Dev nightly suite: ${passed ? "all routines passed" : `non-pass routines: ${failed.join(", ")}`}\n${url}`}
}

export async function publishSuiteResult({suite, expectedRoutineIds, channel, token, fetchImpl = fetch}) {
  if (!/^C[A-Z0-9]+$/.test(channel ?? "") || !token) throw new Error("Missing dev-builds Slack capability")
  const result = suiteResultMessage(suite, expectedRoutineIds)
  const posted = await slackCall("chat.postMessage", token, {channel, text: result.text,
    unfurl_links: false, unfurl_media: false, metadata: {event_type: "mentra_nightly_suite", event_payload: {suite_id: suite.suiteId}}}, fetchImpl)
  if (posted.channel !== channel || !/^\d+\.\d+$/.test(posted.ts ?? "")) throw new Error("Slack suite acknowledgement differs")
  return {suiteId: suite.suiteId, channel, ts: posted.ts, ...result}
}
