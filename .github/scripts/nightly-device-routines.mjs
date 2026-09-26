import {COORDINATED_WORKFLOW, coordinatedPublicationAttempt, resolveCoordinatedSelection} from "./coordinated-routine-request.mjs"

import {DEVICE_ROUTINES} from "./device-routines.mjs"

export const NIGHTLY_WORKFLOW = ".github/workflows/nightly-device-routines.yml"

export const NIGHTLY_SEND_STEP = "Send the nightly routine request"
const LEGACY_SEND_STEP = "Send the nightly routine sequence"
const LEGACY_ROUTINES = ["day1-ota", "mentra-call"]
// Required coverage is separate from executable registration. Missing author-owned
// workers stay unavailable; they must never fall back to the default walkthrough.
export const NIGHTLY_TARGETS = Object.freeze([
  {routine: "day1-ota", platform: "ios-on-mac"},
  {routine: "mentra-call", platform: "ios-on-mac"},
  {routine: "account-miniapps", platform: "ios-on-mac"},
  {routine: "connected-glasses", platform: "android"},
].map(Object.freeze))
export const NIGHTLY_ROUTINES = Object.freeze(NIGHTLY_TARGETS.map(target => target.routine))
const REPOSITORY = "Mentra-Community/MentraOS"
const REQUEST_WORKFLOW = ".github/workflows/request-e2e-routine.yml"
const SHA = /^[a-f0-9]{40}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }
export const nightlyJobName = ({date, channel, routine}) => `Nightly ${date} / ${channel} / ${routine}`
const legacyJobName = ({date, channel}) => `Nightly ${date} / ${channel} / OTA then Call`

/** GitHub job/run history is a send fence; an incomplete response is not absence. */
async function completePages(read, key) {
  const rows = []
  let expected
  for (let page = 1; ; page++) {
    const {data} = await read(page)
    requireThat(Number.isSafeInteger(data?.total_count) && data.total_count >= 1 && data.total_count < 1000 &&
      Array.isArray(data[key]), "Nightly history is incomplete; reconcile manually")
    expected ??= data.total_count
    requireThat(data.total_count === expected, "Nightly history changed; reconcile manually")
    rows.push(...data[key])
    if (rows.length >= expected) break
    requireThat(data[key].length === 100, "Nightly history page is incomplete; reconcile manually")
  }
  requireThat(rows.length === expected && rows.every(row => positive(row?.id)) &&
    new Set(rows.map(row => row.id)).size === expected, "Nightly history is incomplete; reconcile manually")
  return rows
}

const jobsFor = (github, context, runId) => completePages(page => github.rest.actions.listJobsForWorkflowRun({
  ...context.repo, run_id: runId, filter: "all", per_page: 100, page,
}), "jobs")

/** Two UTC triggers cover DST. Use the intended trigger, allowing queue delays. */
export function nightlyDate(cron, createdAt) {
  const hour = {"0 7 * * *": 7, "0 8 * * *": 8}[cron]
  requireThat(hour !== undefined, "Unexpected nightly schedule")
  const created = new Date(createdAt)
  requireThat(Number.isFinite(created.getTime()), "Invalid nightly creation time")
  const scheduled = new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), created.getUTCDate(), hour))
  requireThat(created >= scheduled && created - scheduled < 6 * 3600_000, "Nightly trigger is outside its delivery window")
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"})
    .formatToParts(scheduled).map(part => [part.type, part.value]))
  return parts.hour === "00" ? `${parts.year}-${parts.month}-${parts.day}` : null
}

async function scheduledRun(github, context, attempt) {
  requireThat(`${context.repo.owner}/${context.repo.repo}` === REPOSITORY && context.eventName === "schedule" &&
    positive(context.runId) && positive(attempt) && SHA.test(context.sha ?? ""), "Nightly must run in the trusted repository")
  const {data: run} = await github.rest.actions.getWorkflowRun({...context.repo, run_id: context.runId})
  requireThat(run.id === context.runId && run.run_attempt === attempt && run.event === "schedule" &&
    run.path === NIGHTLY_WORKFLOW && run.head_branch === "dev" && run.head_sha === context.sha &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
  "Nightly workflow identity differs from GitHub metadata")
  return {run, date: nightlyDate(context.payload.schedule, run.created_at)}
}

export async function planNightlyRequests({github, context, attempt, fetchImpl = fetch, routineCatalog = DEVICE_ROUTINES}) {
  const {run, date} = await scheduledRun(github, context, attempt)
  if (!date) return {requests: [], unavailable: [], reason: "The other UTC trigger covers local midnight today"}
  requireThat(attempt === 1, "Nightly reruns require reconciliation; do not repeat physical routines automatically")
  const requests = [], unavailable = []
  for (const channel of ["dev", "staging"]) {
    const targets = NIGHTLY_TARGETS.filter(target => {
      if (Object.hasOwn(routineCatalog, target.routine) && routineCatalog[target.routine].platform === target.platform) return true
      unavailable.push({date, channel, ...target, reason: "Required routine has no compatible registered worker; authoring and qualification are pending"})
      return false
    })
    if (!targets.length) continue
    let candidates
    try {
      const {data} = await github.rest.actions.listWorkflowRuns({...context.repo, workflow_id: COORDINATED_WORKFLOW,
        branch: channel, status: "success", per_page: 20})
      requireThat(Array.isArray(data.workflow_runs), "Missing coordinated workflow history")
      candidates = data.workflow_runs.filter(item => item.path === COORDINATED_WORKFLOW &&
        item.head_branch === channel && item.status === "completed" && item.conclusion === "success" &&
        ["push", "workflow_dispatch"].includes(item.event) && positive(item.id) && positive(item.run_attempt) &&
        Number.isFinite(Date.parse(item.created_at)))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)
    } catch {
      for (const target of targets) unavailable.push({date, channel, ...target, reason: "Coordinated workflow history could not be read"})
      continue
    }
    let selected
    const rejected = []
    for (const candidate of candidates) {
      try {
        const publicationAttempt = await coordinatedPublicationAttempt(github, context, candidate)
        const source = {kind: "coordinated-release", channel, buildRunId: candidate.id, publicationAttempt}
        const platforms = new Map(), errors = new Map()
        for (const platform of new Set(targets.map(target => target.platform))) {
          try { platforms.set(platform, await resolveCoordinatedSelection({github, context, source, platform, fetchImpl})) }
          catch (error) { errors.set(platform, error instanceof Error ? error.message : "Publication unavailable") }
        }
        requireThat(platforms.size, "No retained verified platform archive in this publication")
        const reference = platforms.values().next().value
        requireThat([...platforms.values()].every(selection => selection.build.sourceCommit === reference.build.sourceCommit &&
          selection.build.releaseIdentity === reference.build.releaseIdentity && selection.releasePlan.sha256 === reference.releasePlan.sha256 &&
          selection.otaManifest.sha256 === reference.otaManifest.sha256), "Platform selections disagree on their exact publication")
        selected = {sourceRunId: candidate.id, publicationAttempt, releaseIdentity: reference.build.releaseIdentity, platforms, errors}
        break
      } catch (error) {
        rejected.push({runId: candidate.id, reason: error instanceof Error ? error.message : "Publication unavailable"})
      }
    }
    for (const target of targets) {
      if (!selected) unavailable.push({date, channel, ...target, reason: "No retained verified publication in the latest 20 successful runs", rejected})
      else if (!selected.platforms.has(target.platform)) unavailable.push({date, channel, ...target,
        sourceRunId: selected.sourceRunId, publicationAttempt: selected.publicationAttempt, releaseIdentity: selected.releaseIdentity,
        reason: selected.errors.get(target.platform)})
      else requests.push({date, channel, ...target, sourceRunId: selected.sourceRunId,
        publicationAttempt: selected.publicationAttempt, releaseIdentity: selected.releaseIdentity})
    }
  }
  return {requests, unavailable, sourceRunId: run.id, reason: "One exact publication per channel; independent routine requests, not device results"}
}

/** One entered send step fences one date/channel/routine, even after a lost response. */
export async function sendNightlyRequest({github, context, attempt, plan}) {
  const {run, date} = await scheduledRun(github, context, attempt)
  requireThat(attempt === 1 && date && plan.date === date && ["dev", "staging"].includes(plan.channel) &&
    NIGHTLY_TARGETS.some(target => target.routine === plan.routine && target.platform === plan.platform) &&
    Object.hasOwn(DEVICE_ROUTINES, plan.routine) && DEVICE_ROUTINES[plan.routine].platform === plan.platform &&
    positive(plan.sourceRunId) && positive(plan.publicationAttempt), "Invalid nightly request coordinates")
  const since = new Date(Date.parse(run.created_at) - 26 * 3600_000).toISOString()
  const history = await completePages(page => github.rest.actions.listWorkflowRuns({...context.repo,
    workflow_id: NIGHTLY_WORKFLOW, event: "schedule", branch: "dev", created: `>=${since}`, per_page: 100, page,
  }), "workflow_runs")
  const current = history.find(item => item.id === run.id)
  requireThat(current?.run_attempt === attempt && current.head_sha === run.head_sha && current.created_at === run.created_at,
    "Current nightly is absent or history is incomplete")
  const jobName = nightlyJobName(plan)
  let currentSend = false
  for (const item of history) {
    requireThat(positive(item.id) && item.path === NIGHTLY_WORKFLOW && item.event === "schedule" &&
      item.head_branch === "dev" && item.repository?.full_name === REPOSITORY && item.head_repository?.full_name === REPOSITORY,
    "Nightly history is not authenticated")
    const jobs = await jobsFor(github, context, item.id)
    const matchingJobs = jobs.filter(job => job.name === jobName ||
      (LEGACY_ROUTINES.includes(plan.routine) && job.name === legacyJobName(plan)))
    requireThat(matchingJobs.every(job => Array.isArray(job.steps)), "Nightly send step history is missing; reconcile manually")
    const sends = matchingJobs.filter(job => job.steps.some(step =>
      [NIGHTLY_SEND_STEP, LEGACY_SEND_STEP].includes(step.name) &&
      ["in_progress", "completed"].includes(step.status) && step.conclusion !== "skipped" &&
      typeof step.started_at === "string" && Number.isFinite(Date.parse(step.started_at))))
    if (item.id !== run.id && sends.length) throw new Error("An earlier nightly owns this date/channel/routine; reconcile its request instead of resending")
    if (item.id === run.id) currentSend = sends.length === 1 && sends[0].name === jobName && sends[0].run_attempt === attempt && sends[0].status === "in_progress"
  }
  requireThat(currentSend, "Current nightly send is absent from authenticated job history")
  try {
    const response = await github.rest.actions.createWorkflowDispatch({...context.repo,
      workflow_id: REQUEST_WORKFLOW, ref: "dev", return_run_details: true, inputs: {
        channel: plan.channel, routine: plan.routine, request_origin: "workflow-dispatch",
        source_build_run_id: String(plan.sourceRunId), source_publication_attempt: String(plan.publicationAttempt),
        nightly_run_id: String(run.id), nightly_run_attempt: String(attempt), nightly_mode: "independent",
      }})
    const sent = response.data
    requireThat(response.status === 200 && positive(sent?.workflow_run_id) &&
      sent.html_url === `https://github.com/${REPOSITORY}/actions/runs/${sent.workflow_run_id}` &&
      sent.run_url === `https://api.github.com/repos/${REPOSITORY}/actions/runs/${sent.workflow_run_id}`, "Dispatch acknowledgement differs")
    return {date, channel: plan.channel, routine: plan.routine, status: "request-dispatched",
      runId: sent.workflow_run_id, runAttempt: 1,
      reason: "Marked request queued through the ordinary callback; execution and results are not yet known"}
  } catch {
    throw new Error("Nightly send outcome is unknown; reconcile manually and do not rerun")
  }
}

/** Optional schema-2 marker. A malformed marker must never degrade to standalone. */
export function validateNightlyMarker(request) {
  if (request.sequence === undefined) return null
  const marker = request.sequence
  requireThat(request.schemaVersion === 2 && request.source?.kind === "coordinated-release" &&
    ["dev", "staging"].includes(request.source.channel) && request.routine?.authorization === "workflow-dispatch" &&
    marker && Object.keys(marker).sort().join(",") === "kind,member,runAttempt,runId" &&
    ["nightly-ota-call", "nightly-routine"].includes(marker.kind) && positive(marker.runId) && marker.runAttempt === 1 &&
    (marker.kind === "nightly-ota-call" ? LEGACY_ROUTINES : NIGHTLY_ROUTINES).includes(marker.member) && marker.member === request.routine.id,
  "Invalid nightly sequence marker")
  return marker
}

/** The producer authenticates the scheduled sender, never caller-supplied text alone. */
export async function authenticateNightlyMarker({github, context, request}) {
  const marker = validateNightlyMarker(request)
  if (!marker) return
  const {data: run} = await github.rest.actions.getWorkflowRunAttempt({...context.repo,
    run_id: marker.runId, attempt_number: marker.runAttempt})
  requireThat(run.id === marker.runId && run.run_attempt === marker.runAttempt && run.event === "schedule" &&
    run.path === NIGHTLY_WORKFLOW && run.head_branch === "dev" && SHA.test(run.head_sha ?? "") &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
  "Nightly sequence source is not an authenticated scheduled workflow")
  const dates = ["0 7 * * *", "0 8 * * *"].flatMap(cron => {
    try { const date = nightlyDate(cron, run.created_at); return date ? [date] : [] } catch { return [] }
  })
  requireThat(dates.length === 1, "Nightly sequence source has no valid local-midnight date")
  const jobs = await jobsFor(github, context, run.id)
  const legacy = marker.kind === "nightly-ota-call"
  const expected = {date: dates[0], channel: request.source.channel, routine: marker.member}
  const matches = jobs.filter(job => job.name === (legacy ? legacyJobName(expected) : nightlyJobName(expected)) &&
    job.run_attempt === marker.runAttempt && job.steps?.some(step => step.name === (legacy ? LEGACY_SEND_STEP : NIGHTLY_SEND_STEP) &&
      ["in_progress", "completed"].includes(step.status) && step.conclusion !== "skipped" &&
      Number.isFinite(Date.parse(step.started_at))))
  requireThat(matches.length === 1, "Nightly sequence sender is absent or ambiguous")
}
