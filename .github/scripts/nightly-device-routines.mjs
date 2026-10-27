import {createHash} from "node:crypto"
import {slackCall} from "./release-slack-message.mjs"

const ENDPOINT = "https://core.dev.us-west-2.mentraglass.com/api/internal/nightly-routines"
export const NIGHTLY_WORKFLOW = ".github/workflows/nightly-device-routines.yml"
export const NIGHTLY_CRONS = Object.freeze(["0 11 * * *", "0 12 * * *"])
const positive = value => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => {if (!value) throw new Error(message)}

/** Select the intended 04:00 Pacific occurrence from GitHub's original run creation time. */
export function scheduledOccurrence(cron, createdAt) {
  requireThat(NIGHTLY_CRONS.includes(cron), "Unexpected nightly schedule")
  const created = new Date(createdAt), hour = Number(cron.split(" ")[1])
  requireThat(Number.isFinite(created.getTime()), "Invalid nightly creation time")
  const intended = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate(), hour))
  requireThat(created >= intended && created - intended < 6 * 3600_000, "Nightly trigger is outside its delivery window")
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"})
    .formatToParts(intended).map(part => [part.type, part.value]))
  if (parts.hour !== "04") return null
  return {occurrenceId: `nightly-dev-${parts.year}-${parts.month}-${parts.day}`, startedAt: intended.toISOString(), trigger: "nightly"}
}

export async function githubOccurrence({github, context, attempt}) {
  requireThat(positive(context.runId) && positive(attempt) &&
    `${context.repo.owner}/${context.repo.repo}` === "Mentra-Community/MentraOS", "Invalid scheduler identity")
  const {data: run} = await github.rest.actions.getWorkflowRun({...context.repo, run_id: context.runId})
  requireThat(run.id === context.runId && run.path === NIGHTLY_WORKFLOW && run.head_branch === "dev" &&
    run.repository?.full_name === "Mentra-Community/MentraOS" && run.head_repository?.full_name === "Mentra-Community/MentraOS" &&
    ["schedule", "workflow_dispatch"].includes(run.event) && run.event === context.eventName &&
    Number.isFinite(Date.parse(run.created_at)), "Scheduler source differs from trusted dev workflow")
  if (run.event === "schedule") return scheduledOccurrence(context.payload.schedule, run.created_at)
  return {occurrenceId: `manual-dev-${run.id}`, startedAt: new Date(run.created_at).toISOString(), trigger: "manual"}
}

/** Core freezes catalog preferences, definitions, builds and independent requests once for this identity. */
export async function nightlyApi({token, occurrence, occurrenceId = occurrence?.occurrenceId, operation = "start", fetchImpl = fetch}) {
  requireThat(token && ["start", "read", "complete"].includes(operation) &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(occurrenceId ?? ""), "Invalid nightly API capability or identity")
  const suffix = operation === "start" ? "" : `/${encodeURIComponent(occurrenceId)}${operation === "complete" ? "/complete" : ""}`
  let response, result
  try {response = await fetchImpl(`${ENDPOINT}${suffix}`, {method: operation === "read" ? "GET" : "POST",
    redirect: "error", signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    ...(operation === "start" ? {body: JSON.stringify(occurrence)} : {})})
    if (response.ok) result = await response.json()}
  catch (cause) {
    if (cause instanceof SyntaxError) throw cause
    const error = new Error(`Nightly API ${operation} response is unavailable`); error.retryable = true; throw error
  }
  if (!response.ok) {
    const error = new Error(`Nightly API ${operation} failed (${response.status})`)
    error.retryable = response.status >= 500 || response.status === 429
    throw error
  }
  const acknowledged = operation === "start" ? result.plan : result
  requireThat(acknowledged?.occurrenceId === occurrenceId && Array.isArray(acknowledged.members), "Nightly API acknowledgement differs")
  if (operation === "start") requireThat(acknowledged.startedAt === occurrence.startedAt && acknowledged.trigger === occurrence.trigger,
    "Nightly API changed the original occurrence boundary")
  return result
}

export async function reconcileNightlyOccurrence({token, occurrence, deadline, fetchImpl = fetch, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), pollMilliseconds = 30_000}) {
  requireThat(Number.isFinite(deadline) && deadline <= now() + 3 * 3600_000 && pollMilliseconds >= 1, "Invalid reconciliation deadline")
  let current
  for (;;) {
    // Repeating the same frozen occurrence retries only failed admissions with their original request identities.
    try {
      await nightlyApi({token, occurrence, fetchImpl})
      current = await nightlyApi({token, occurrenceId: occurrence.occurrenceId, operation: "complete", fetchImpl})
      if (current.finishedAt) return current
    } catch (error) {if (!error.retryable) throw error}
    requireThat(now() < deadline, "Nightly Core did not return a terminal receipt before the reconciliation deadline")
    await sleep(Math.min(pollMilliseconds, deadline - now()))
  }
}

export function nightlySummary(result) {
  requireThat(result?.finishedAt && Array.isArray(result.members) && result.expectedCount === result.members.length &&
    new Set(result.members.map(member => member.memberId)).size === result.expectedCount &&
    ["pass", "failed", "incomplete", "cancelled", "skipped"].includes(result.status) &&
    (result.status !== "skipped" || result.expectedCount === 0), "Nightly result is not a complete frozen receipt")
  const passed = result.status === "pass" && result.passed === result.expectedCount && result.members.every(member =>
    member.status === "pass" && member.publicationComplete === true)
  requireThat(result.status !== "pass" || passed, "Nightly aggregate contradicts its member evidence")
  // Match the nightly suite projection and Test history row: incomplete receipts
  // project to not-run, and only execution/setup/teardown failures count as failed.
  const skippedCount = result.members.filter(member => ["not-run", "incomplete"].includes(member.status)).length
  const failedCount = result.members.filter(member => ["failed", "setup-failed", "teardown-failed"].includes(member.status)).length
  const status = failedCount > 0 ? "failed" : result.status === "failed" ? "incomplete" : result.status
  const label = {pass: "Passed", failed: "Failed", incomplete: "Incomplete", cancelled: "Cancelled", skipped: "Skipped"}[status]
  return {passed, skipped: result.status === "skipped", displayStatus: status, url: result.resultUrl,
    text: `Dev nightly: ${label}`,
    counts: `${failedCount}/${result.expectedCount - skippedCount} failed${skippedCount ? `, ${skippedCount} skipped` : ""}`,
    rows: result.members.map(member => [member.routineId, member.platform, member.status, member.unavailableReason ?? ""])}
}

const identity = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value)
const resourceKinds = new Set(["app", "phone", "glasses", "recorder", "audio", "browser", "network", "fixture-data", "workspace"])
const unknownContext = () => ({machine: "unknown", lane: "unknown", resources: ["unknown"]})
function inputDigest(value) {
  const canonical = value => {
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value
    if (Array.isArray(value)) return value.map(canonical)
    if (value && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    throw new Error("Invalid recorded input")
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
}

/** Display only the original member's validated assignment, never a current fleet or rerun. */
export function nightlyMemberContext(member) {
  if (member.assignmentEvidence === "invalid") return unknownContext()
  if (!member.binding && !member.hostId && !member.dispatchIntent) {
    const kinds = member.requiredResourceKinds
    return {machine: "unassigned", lane: ["android", "ios-on-mac"].includes(member.platform) ? member.platform : "unknown",
      resources: Array.isArray(kinds) && kinds.length > 0 && kinds.length <= 9 && new Set(kinds).size === kinds.length &&
        kinds.every(kind => resourceKinds.has(kind)) ? kinds : ["unknown"]}
  }
  const {binding, input, dispatchIntent: intent} = member
  if (!binding || !intent || !identity(member.requestId) || binding.jobId !== member.requestId ||
      binding.requestId !== member.requestId || !identity(binding.hostId) || member.hostId !== binding.hostId ||
      !identity(binding.laneId) || intent.laneId !== binding.laneId ||
      !/^[a-f0-9]{64}$/.test(binding.descriptorRevision ?? "") || !/^[1-9][0-9]{0,19}$/.test(binding.actionsRunId ?? "") ||
      !/^[1-9][0-9]{0,19}$/.test(binding.actionsJobId ?? "") || !Number.isFinite(Date.parse(binding.boundAt)) ||
      intent.requestId !== member.requestId || intent.routineId !== member.routineId || intent.platform !== member.platform ||
      intent.routineRevision !== member.routineRevision) return unknownContext()
  const assigned = {machine: binding.hostId, lane: binding.laneId, resources: ["unknown"]}
  try {
    // Core validates executable source/build. The sender checks only the frozen resource payload's provenance.
    if (!input || input.laneId !== binding.laneId || input.routineId !== member.routineId || input.platform !== member.platform ||
      input.definitionRevision !== member.routineRevision ||
      !/^[a-f0-9]{64}$/.test(member.inputSha256 ?? "") || inputDigest(input) !== member.inputSha256 ||
      !Array.isArray(input.resources) || input.resources.length === 0) return assigned
    const resources = []
    for (const resource of input.resources) {
      if (!identity(resource.id) || !resourceKinds.has(resource.kind) || resource.exclusiveDependencies !== undefined &&
        (!Array.isArray(resource.exclusiveDependencies) || resource.exclusiveDependencies.length === 0 || resource.exclusiveDependencies.length > 30)) return assigned
      for (const dependency of resource.exclusiveDependencies ?? []) {
        if (!dependency || typeof dependency !== "object" || !identity(dependency.authorityHostId) ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(dependency.capability ?? "")) return assigned
      }
      for (const id of [resource.id, ...(resource.exclusiveDependencies ?? []).map(dependency => dependency.resourceId)]) {
        // Dependency IDs use the recorded resource contract; refuse line/control injection and escape Slack markup at rendering.
        if (typeof id !== "string" || id.length === 0 || id.length > 240 || /[\u0000-\u001f\u007f]/.test(id)) return assigned
        if (!resources.includes(id)) resources.push(id)
      }
    }
    return {machine: binding.hostId, lane: binding.laneId, resources}
  } catch {return assigned}
}

/** One attempted send per original scheduler run. Reruns reconcile Core without replaying an uncertain Slack POST. */
export async function publishNightlyMessage({result, token, channel, attempt, fetchImpl = fetch}) {
  const summary = nightlySummary(result)
  requireThat(attempt === 1 && token && /^C[A-Z0-9]+$/.test(channel ?? ""), "Nightly Slack replay requires reconciliation and a configured channel")
  const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const failures = result.members.filter(member => member.status !== "pass" || member.publicationComplete !== true)
  const build = result.members.find(member => member.build)?.build
  const buildText = build ? `Build: ${build.releaseIdentity ? `${escape(build.releaseIdentity)} · ` : ""}${escape(build.headSha.slice(0, 10))}` +
    (positive(build.source?.buildRunId) ? ` · <https://github.com/Mentra-Community/MentraOS/actions/runs/${build.source.buildRunId}|Build job> (publication ${build.source.publicationAttempt})` : "")
    : "Build: unavailable in the nightly receipt"
  const heading = `${summary.passed ? "🟢" : summary.displayStatus === "failed" ? "🔴" : "⚪"} ${summary.text}`
  const resultsLink = summary.url ? `<${summary.url}|View nightly results>` : "Result link unavailable"
  const text = [heading, resultsLink, buildText, summary.counts,
    ...(failures.length ? ["", ...failures.map(member => {
      const url = member.runId ? `https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(member.runId)}` : summary.url
      const status = member.status === "pass" ? "execution passed; evidence incomplete" : member.status
      const context = nightlyMemberContext(member)
      return `- ${escape(member.routineId)} (machine=${escape(context.machine)}, lane=${escape(context.lane)}, resources=${context.resources.map(escape).join(", ")}) · ${escape(status)} - ${url ? `<${url}|View result>` : "Result link unavailable"}`
    })] : [])].join("\n")
  const posted = await slackCall("chat.postMessage", token,
    {channel, text, unfurl_links: false, unfurl_media: false}, fetchImpl)
  requireThat(posted.channel === channel && /^\d+\.\d+$/.test(posted.ts ?? "") && /^B[A-Z0-9]+$/.test(posted.message?.bot_id ?? ""),
    "Nightly Slack acknowledgement differs from the requested channel")
  return {occurrenceId: result.occurrenceId, status: "acknowledged", passed: summary.passed,
    channel: posted.channel, ts: posted.ts, botId: posted.message.bot_id}
}
