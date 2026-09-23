import {COORDINATED_WORKFLOW, resolveCoordinatedSelection} from "./coordinated-routine-request.mjs"

export const NIGHTLY_WORKFLOW = ".github/workflows/nightly-device-routines.yml"
export const NIGHTLY_SEND_STEP = "Send the nightly routine request"
export const NIGHTLY_ROUTINES = Object.freeze(["day1-ota", "mentra-call"])
export const COORDINATED_FINALIZE_JOB = "Finalize immutable release bill of materials"
export const COORDINATED_PUBLISH_STEP = "Publish immutable plan, package, and manifest assets"
const REPOSITORY = "Mentra-Community/MentraOS"
const REQUEST_WORKFLOW = ".github/workflows/request-e2e-routine.yml"
const SHA = /^[a-f0-9]{40}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }
export const nightlyJobName = ({date, channel, routine}) => `Nightly ${date} / ${channel} / ${routine}`

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

async function publishedAttempt(github, context, candidate) {
  const jobs = await jobsFor(github, context, candidate.id)
  const matched = jobs.filter(job => job.name === COORDINATED_FINALIZE_JOB && job.run_attempt === candidate.run_attempt)
  return matched.length === 1 && matched[0].status === "completed" && matched[0].conclusion === "success" &&
    matched[0].steps?.some(step => step.name === COORDINATED_PUBLISH_STEP &&
      step.status === "completed" && step.conclusion === "success")
}

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

export async function planNightlyRequests({github, context, attempt, fetchImpl = fetch}) {
  const {run, date} = await scheduledRun(github, context, attempt)
  if (!date) return {requests: [], unavailable: [], reason: "The other UTC trigger covers local midnight today"}
  requireThat(attempt === 1, "Nightly reruns require reconciliation; do not repeat physical routines automatically")
  const requests = [], unavailable = []
  for (const channel of ["dev", "staging"]) {
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
      unavailable.push({channel, reason: "Coordinated workflow history could not be read", rejected: []})
      continue
    }
    let selected
    const rejected = []
    for (const candidate of candidates) {
      const source = {kind: "coordinated-release", channel, buildRunId: candidate.id, publicationAttempt: candidate.run_attempt}
      try {
        requireThat(await publishedAttempt(github, context, candidate),
          "This attempt did not publish immutable assets; dry runs and retained earlier attempts are ineligible")
        const publication = await resolveCoordinatedSelection({github, context, source, fetchImpl})
        selected = {sourceRunId: candidate.id, publicationAttempt: candidate.run_attempt,
          releaseIdentity: publication.build.releaseIdentity}
        break
      } catch (error) {
        rejected.push({runId: candidate.id, reason: error instanceof Error ? error.message : "Publication unavailable"})
      }
    }
    if (!selected) unavailable.push({channel, reason: "No retained verified Mac publication in the latest 20 successful runs", rejected})
    else for (const routine of NIGHTLY_ROUTINES) requests.push({date, channel, routine, ...selected})
  }
  return {requests, unavailable, sourceRunId: run.id, reason: "Exact coordinated publications selected; no device test has run"}
}

/** The started send step is the durable pre-send fence, even after a lost response. */
export async function sendNightlyRequest({github, context, attempt, plan}) {
  const {run, date} = await scheduledRun(github, context, attempt)
  requireThat(attempt === 1 && date && plan.date === date && ["dev", "staging"].includes(plan.channel) &&
    NIGHTLY_ROUTINES.includes(plan.routine) && positive(plan.sourceRunId) && positive(plan.publicationAttempt),
  "Invalid nightly request coordinates")
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
    requireThat(jobs.filter(job => job.name === jobName).every(job => Array.isArray(job.steps)),
      "Nightly send step history is missing; reconcile manually")
    const sends = jobs.filter(job => job.name === jobName && job.steps?.some(step => step.name === NIGHTLY_SEND_STEP &&
      ["in_progress", "completed"].includes(step.status) && step.conclusion !== "skipped" &&
      typeof step.started_at === "string" && Number.isFinite(Date.parse(step.started_at))))
    if (item.id !== run.id && sends.length) throw new Error("An earlier nightly owns this date/routine/channel; reconcile its request instead of resending")
    if (item.id === run.id) currentSend = sends.length === 1 && sends[0].run_attempt === attempt && sends[0].status === "in_progress"
  }
  requireThat(currentSend, "Current nightly send is absent from authenticated job history")
  let sent
  try {
    const response = await github.rest.actions.createWorkflowDispatch({...context.repo,
      workflow_id: REQUEST_WORKFLOW, ref: "dev", return_run_details: true, inputs: {
        channel: plan.channel, routine: plan.routine, request_origin: "workflow-dispatch",
        source_build_run_id: String(plan.sourceRunId), source_publication_attempt: String(plan.publicationAttempt),
      }})
    sent = response.data
    requireThat(response.status === 200 && positive(sent?.workflow_run_id) &&
      sent.html_url === `https://github.com/${REPOSITORY}/actions/runs/${sent.workflow_run_id}` &&
      sent.run_url === `https://api.github.com/repos/${REPOSITORY}/actions/runs/${sent.workflow_run_id}`, "Dispatch acknowledgement differs")
  } catch {
    throw new Error("Nightly send outcome is unknown; reconcile manually and do not rerun")
  }
  return {date, channel: plan.channel, routine: plan.routine, status: "request-dispatched", requestRunId: sent.workflow_run_id,
    requestUrl: sent.html_url, reason: "Request queued; physical execution and result are not yet known"}
}
