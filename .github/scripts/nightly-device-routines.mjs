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
  let response
  try {response = await fetchImpl(`${ENDPOINT}${suffix}`, {method: operation === "read" ? "GET" : "POST",
    redirect: "error", signal: AbortSignal.timeout(30_000), headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    ...(operation === "start" ? {body: JSON.stringify(occurrence)} : {})})}
  catch {const error = new Error(`Nightly API ${operation} response is unavailable`); error.retryable = true; throw error}
  if (!response.ok) {
    const error = new Error(`Nightly API ${operation} failed (${response.status})`)
    error.retryable = response.status >= 500 || response.status === 429
    throw error
  }
  const result = await response.json(), acknowledged = operation === "start" ? result.plan : result
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
  return {passed, skipped: result.status === "skipped", url: result.resultUrl,
    text: `Dev nightly: ${result.status}; ${result.passed}/${result.expectedCount} passed`,
    rows: result.members.map(member => [member.routineId, member.platform, member.status, member.unavailableReason ?? ""])}
}

/** One attempted send per original scheduler run. Reruns reconcile Core without replaying an uncertain webhook POST. */
export async function publishNightlyWebhook({result, webhook, attempt, fetchImpl = fetch}) {
  const summary = nightlySummary(result)
  requireThat(attempt === 1 && /^https:\/\/hooks\.slack\.com\/services\//.test(webhook ?? ""), "Nightly Slack replay requires reconciliation")
  const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const text = [summary.text, ...summary.rows.map(row => `${escape(row[0])} · ${row[1]} — ${row[2]}${row[3] ? ` (${escape(row[3])})` : ""}`),
    summary.url ? `<${summary.url}|Recorded nightly results>` : "Recorded result URL is unavailable"].join("\n")
  let response
  try {response = await fetchImpl(webhook, {method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: {"Content-Type": "application/json"}, body: JSON.stringify({text, unfurl_links: false, unfurl_media: false})})}
  catch {throw new Error("Nightly Slack acknowledgement is unavailable; inspect the send before retrying")}
  requireThat(response.ok, `Nightly Slack rejected the notification (${response.status})`)
  return {occurrenceId: result.occurrenceId, status: "acknowledged", passed: summary.passed}
}
