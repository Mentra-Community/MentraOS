import {slackCall} from "./release-slack-message.mjs"
import {DEV_FOUNDATION_NIGHTLY_ROUTINES} from "./nightly-device-routines.mjs"

const suiteEndpoint = "https://core.dev.us-west-2.mentraglass.com/api/internal/test-runs/suites"
const terminalStatuses = new Set(["passed", "failed", "blocked", "cancelled", "aborted", "interrupted", "infra-failed", "setup-failed", "incomplete"])

export function frozenNightlySuite({plan, runId, attempt, workflowSha}) {
  if (!plan.sourceRunId) return undefined
  const hashes = new Set(plan.requests.map(request => request.headSha))
  if (hashes.size > 1 || plan.requests.some(request => request.channel !== "dev" ||
    !DEV_FOUNDATION_NIGHTLY_ROUTINES.includes(request.routine))) throw new Error("Nightly build plan differs")
  const headSha = hashes.size ? [...hashes][0] : workflowSha
  if (!/^[a-f0-9]{40}$/.test(headSha ?? "") || !Number.isFinite(Date.parse(plan.startedAt ?? "")))
    throw new Error("Nightly build provenance is unavailable")
  return {suiteId: nightlySuiteId(runId, attempt), channel: "dev", trigger: "nightly", startedAt: plan.startedAt,
    build: {headSha, ...(plan.requests[0]?.releaseIdentity ? {release: plan.requests[0].releaseIdentity} : {}),
      producerUrl: `https://github.com/Mentra-Community/MentraOS/actions/runs/${runId}`},
    members: DEV_FOUNDATION_NIGHTLY_ROUTINES.map(routineId => ({memberId: routineId, routineId,
      platform: routineId.endsWith("android") ? "android" : "ios-mac"}))}
}

export async function suiteApi({token, suiteId, memberId, operation = "read", body, fetchImpl = fetch}) {
  if (!token || !["create", "read", "bind", "complete"].includes(operation)) throw new Error("Missing suite API capability")
  if (operation !== "create" && !/^nightly-[1-9]\d*-[1-9]\d*-dev$/.test(suiteId ?? "")) throw new Error("Invalid suite API identity")
  if (operation === "bind" && !DEV_FOUNDATION_NIGHTLY_ROUTINES.includes(memberId)) throw new Error("Invalid suite member")
  const suffix = operation === "create" ? "" : `/${encodeURIComponent(suiteId)}${operation === "bind" ? `/members/${encodeURIComponent(memberId)}` : operation === "complete" ? "/complete" : ""}`
  let response
  try {
    response = await fetchImpl(`${suiteEndpoint}${suffix}`, {method: operation === "read" ? "GET" : "POST",
      redirect: "error", signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      ...(operation === "read" ? {} : {body: JSON.stringify(body)})})
  } catch { throw new Error(`Suite API ${operation} response unavailable; reconcile before retrying writes`) }
  if (!response.ok) throw new Error(`Suite API ${operation} failed (${response.status})`)
  const result = await response.json()
  if (result.suiteId !== (operation === "create" ? body.suiteId : suiteId) || result.channel !== "dev")
    throw new Error("Suite API acknowledgement differs")
  return result
}

export function suiteMemberBinding(result) {
  if (!Number.isSafeInteger(result.runId) || result.runId < 1 || result.runAttempt !== 1 || result.channel !== "dev" ||
    !DEV_FOUNDATION_NIGHTLY_ROUTINES.includes(result.routine)) throw new Error("Invalid acknowledged nightly request")
  return {memberId: result.routine, body: {requestId: `routine-${result.runId}-1-dev-${result.routine}`}}
}

export async function reconcileNightlySuite({suiteId, token, expectedRoutineIds = DEV_FOUNDATION_NIGHTLY_ROUTINES,
  deadline, fetchImpl = fetch, now = Date.now, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  pollMilliseconds = 30_000}) {
  if (!Number.isFinite(deadline) || deadline > now() + 3 * 3600_000 || pollMilliseconds < 1)
    throw new Error("Invalid nightly reconciliation deadline")
  let current
  try {
    while (true) {
      try { current = await suiteApi({token, suiteId, fetchImpl}) }
      catch {
        if (now() >= deadline) break
        await sleep(Math.min(pollMilliseconds, deadline - now()))
        continue
      }
      if (!Array.isArray(current.members) || current.members.length !== expectedRoutineIds.length ||
        new Set(current.members.map(member => member.routineId)).size !== expectedRoutineIds.length ||
        current.members.some(member => !expectedRoutineIds.includes(member.routineId))) throw new Error("Suite membership differs")
      if (current.finishedAt || now() >= deadline || current.members.every(member => !member.requestId ||
        (terminalStatuses.has(member.status) && member.publicationComplete === true && member.runId &&
          Number.isFinite(Date.parse(member.finishedAt ?? ""))))) break
      await sleep(Math.min(pollMilliseconds, deadline - now()))
    }
  } finally {
    current = await suiteApi({token, suiteId, operation: "complete", body: {finishedAt: new Date(now()).toISOString()}, fetchImpl})
  }
  return current
}

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
  const passed = failed.length === 0 && suite.outcome === "passed" && suite.passed === expectedRoutineIds.length
  if (!passed && !failed.length) throw new Error("Suite aggregate contradicts member results")
  const singleRunId = expectedRoutineIds.length === 1 ? members.get(expectedRoutineIds[0])?.runId : undefined
  if (expectedRoutineIds.length === 1 && (typeof singleRunId !== "string" || !singleRunId))
    throw new Error("Single-routine result needs its direct published run")
  const url = singleRunId ? `https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(singleRunId)}`
    : `https://admin.dev.mentraglass.com/?testSuite=${encodeURIComponent(suite.suiteId)}`
  return {passed, failedRoutines: failed, url,
    text: `${passed ? "🟢" : "🔴"} Dev nightly ${singleRunId ? "routine" : "suite"}: ${passed ? "all routines passed" : `non-pass routines: ${failed.join(", ")}`}\n${url}`}
}

export async function publishSuiteResult({suite, expectedRoutineIds, channel, token, fetchImpl = fetch}) {
  if (!/^C[A-Z0-9]+$/.test(channel ?? "") || !token) throw new Error("Missing dev-builds Slack capability")
  const result = suiteResultMessage(suite, expectedRoutineIds)
  const posted = await slackCall("chat.postMessage", token, {channel, text: result.text,
    unfurl_links: false, unfurl_media: false, metadata: {event_type: "mentra_nightly_suite", event_payload: {suite_id: suite.suiteId}}}, fetchImpl)
  if (posted.channel !== channel || !/^\d+\.\d+$/.test(posted.ts ?? "")) throw new Error("Slack suite acknowledgement differs")
  return {suiteId: suite.suiteId, channel, ts: posted.ts, ...result}
}

export async function publishSuiteWebhook({suite, expectedRoutineIds, webhook, fetchImpl = fetch}) {
  let destination
  try { destination = new URL(webhook) } catch { throw new Error("Missing dev-builds webhook capability") }
  if (destination.origin !== "https://hooks.slack.com" || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(destination.pathname) ||
    destination.search || destination.hash || destination.username || destination.password)
    throw new Error("Invalid dev-builds webhook capability")
  const result = suiteResultMessage(suite, expectedRoutineIds)
  let response
  try {
    response = await fetchImpl(destination.href, {method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {"Content-Type": "application/json"}, body: JSON.stringify({text: result.text, unfurl_links: false, unfurl_media: false})})
    if (!response.ok || (await response.text()).trim() !== "ok") throw new Error("Rejected")
  } catch { throw new Error("Slack suite webhook acknowledgement unavailable; inspect before retrying") }
  return {suiteId: suite.suiteId, destination: "dev-builds-webhook", acknowledged: true, ...result}
}
