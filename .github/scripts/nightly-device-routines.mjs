import {isDeepStrictEqual} from "node:util"
import {COORDINATED_WORKFLOW, resolveCoordinatedSelection, verifyCoordinatedReadyRequest} from "./coordinated-routine-request.mjs"

export const NIGHTLY_WORKFLOW = ".github/workflows/nightly-device-routines.yml"
export const NIGHTLY_SEND_STEP = "Send the nightly routine sequence"
export const NIGHTLY_ROUTINES = Object.freeze(["day1-ota", "mentra-call"])
const REPOSITORY = "Mentra-Community/MentraOS"
const REQUEST_WORKFLOW = ".github/workflows/request-e2e-routine.yml"
const SHA = /^[a-f0-9]{40}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }
export const nightlyJobName = ({date, channel}) => `Nightly ${date} / ${channel} / OTA then Call`

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
        const publication = await resolveCoordinatedSelection({github, context, source, fetchImpl})
        selected = {sourceRunId: candidate.id, publicationAttempt: candidate.run_attempt,
          releaseIdentity: publication.build.releaseIdentity}
        break
      } catch (error) {
        rejected.push({runId: candidate.id, reason: error instanceof Error ? error.message : "Publication unavailable"})
      }
    }
    if (!selected) unavailable.push({channel, reason: "No retained verified Mac publication in the latest 20 successful runs", rejected})
    else requests.push({date, channel, ...selected})
  }
  return {requests, unavailable, sourceRunId: run.id, reason: "Exact coordinated publications selected; no device test has run"}
}

/** The started send step is the durable pre-send fence, even after a lost response. */
export async function sendNightlySequence({github, context, attempt, plan}) {
  const {run, date} = await scheduledRun(github, context, attempt)
  requireThat(attempt === 1 && date && plan.date === date && ["dev", "staging"].includes(plan.channel) &&
    plan.routine === undefined && positive(plan.sourceRunId) && positive(plan.publicationAttempt),
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
    const matchingJobs = jobs.filter(job => job.name === jobName || NIGHTLY_ROUTINES.some(routine =>
      job.name === `Nightly ${date} / ${plan.channel} / ${routine}`))
    requireThat(matchingJobs.every(job => Array.isArray(job.steps)),
      "Nightly send step history is missing; reconcile manually")
    const sends = matchingJobs.filter(job => job.steps.some(step =>
      [NIGHTLY_SEND_STEP, "Send the nightly routine request"].includes(step.name) &&
      ["in_progress", "completed"].includes(step.status) && step.conclusion !== "skipped" &&
      typeof step.started_at === "string" && Number.isFinite(Date.parse(step.started_at))))
    if (item.id !== run.id && sends.length) throw new Error("An earlier nightly owns this date/channel; reconcile its request instead of resending")
    if (item.id === run.id) currentSend = sends.length === 1 && sends[0].name === jobName && sends[0].run_attempt === attempt && sends[0].status === "in_progress"
  }
  requireThat(currentSend, "Current nightly send is absent from authenticated job history")
  const members = []
  for (const routine of NIGHTLY_ROUTINES) {
    try {
      const response = await github.rest.actions.createWorkflowDispatch({...context.repo,
        workflow_id: REQUEST_WORKFLOW, ref: "dev", return_run_details: true, inputs: {
          channel: plan.channel, routine, request_origin: "workflow-dispatch",
          source_build_run_id: String(plan.sourceRunId), source_publication_attempt: String(plan.publicationAttempt),
          nightly_run_id: String(run.id), nightly_run_attempt: String(attempt),
        }})
      const sent = response.data
      requireThat(response.status === 200 && positive(sent?.workflow_run_id) &&
        sent.html_url === `https://github.com/${REPOSITORY}/actions/runs/${sent.workflow_run_id}` &&
        sent.run_url === `https://api.github.com/repos/${REPOSITORY}/actions/runs/${sent.workflow_run_id}` &&
        !members.some(member => member.runId === sent.workflow_run_id), "Dispatch acknowledgement differs")
      members.push({routine, runId: sent.workflow_run_id, runAttempt: 1})
    } catch {
      throw new Error("Nightly send outcome is unknown; reconcile manually and do not rerun")
    }
  }
  return {date, channel: plan.channel, status: "requests-dispatched", members,
    reason: "Both marked requests queued; no private device job has been dispatched"}
}

/** Optional schema-2 marker. A malformed marker must never degrade to standalone. */
export function validateNightlyMarker(request) {
  if (request.sequence === undefined) return null
  const marker = request.sequence
  requireThat(request.schemaVersion === 2 && request.source?.kind === "coordinated-release" &&
    ["dev", "staging"].includes(request.source.channel) && request.routine?.authorization === "workflow-dispatch" &&
    marker && Object.keys(marker).sort().join(",") === "kind,member,runAttempt,runId" &&
    marker.kind === "nightly-ota-call" && positive(marker.runId) && marker.runAttempt === 1 &&
    NIGHTLY_ROUTINES.includes(marker.member) && marker.member === request.routine.id,
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
  const matches = jobs.filter(job => job.name === nightlyJobName({date: dates[0], channel: request.source.channel}) &&
    job.run_attempt === marker.runAttempt && job.steps?.some(step => step.name === NIGHTLY_SEND_STEP &&
      ["in_progress", "completed"].includes(step.status) && step.conclusion !== "skipped" &&
      Number.isFinite(Date.parse(step.started_at))))
  requireThat(matches.length === 1, "Nightly sequence sender is absent or ambiguous")
}

/** Request runs are acknowledged once, then polled read-only with a fixed deadline. */
export async function waitForNightlyRequests({github, context, attempt, sent,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 480_000}) {
  const {run, date} = await scheduledRun(github, context, attempt)
  requireThat(attempt === 1 && date === sent.date && ["dev", "staging"].includes(sent.channel) &&
    sent.status === "requests-dispatched" && sent.members?.length === 2 &&
    sent.members.every((member, i) => member.routine === NIGHTLY_ROUTINES[i] && positive(member.runId) && member.runAttempt === 1) &&
    sent.members[0].runId !== sent.members[1].runId && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 480_000,
  "Invalid nightly request acknowledgements")
  const deadline = now() + timeoutMs
  const ready = []
  while (ready.length !== 2) {
    for (const member of sent.members) {
      if (ready.some(item => item.runId === member.runId)) continue
      const {data: requestRun} = await github.rest.actions.getWorkflowRun({...context.repo, run_id: member.runId})
      requireThat(requestRun.id === member.runId && requestRun.run_attempt === 1 && requestRun.event === "workflow_dispatch" &&
        requestRun.path === REQUEST_WORKFLOW && requestRun.head_branch === "dev" && SHA.test(requestRun.head_sha ?? "") &&
        requestRun.repository?.full_name === REPOSITORY && requestRun.head_repository?.full_name === REPOSITORY,
      "Nightly request run identity changed; reconcile manually")
      if (requestRun.status !== "completed") continue
      requireThat(requestRun.conclusion === "success", "Nightly request failed; no private sequence was dispatched")
      const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
        ...context.repo, run_id: member.runId, per_page: 100})
      const name = `mentra-routine-request-${member.runId}-1`
      const matches = artifacts.filter(item => item.name === name && !item.expired)
      requireThat(matches.length === 1 && positive(matches[0].id) && matches[0].size_in_bytes > 0 &&
        matches[0].size_in_bytes <= 2 * 1024 * 1024 && /^sha256:[a-f0-9]{64}$/.test(matches[0].digest ?? "") &&
        matches[0].workflow_run?.id === member.runId && matches[0].workflow_run.head_sha === requestRun.head_sha,
      "Nightly request artifact is missing or ambiguous")
      ready.push({...member, sourceSha: requestRun.head_sha, artifactId: matches[0].id})
    }
    if (ready.length === 2) break
    requireThat(now() < deadline, "Nightly requests did not become ready within the deadline; reconcile, do not resend")
    await sleep(Math.min(15_000, deadline - now()))
  }
  return {date, channel: sent.channel, sequenceRunId: run.id, sequenceRunAttempt: attempt,
    members: NIGHTLY_ROUTINES.map(routine => ready.find(item => item.routine === routine))}
}

/** Both immutable producer selections must agree before one private sequence is queued. */
export async function dispatchNightlySequence({github, privateGithub, context, attempt, plan, ready, bytes, fetchImpl = fetch}) {
  const {run, date} = await scheduledRun(github, context, attempt)
  requireThat(attempt === 1 && date === plan.date && ready.date === date && ready.channel === plan.channel &&
    ready.sequenceRunId === run.id && ready.sequenceRunAttempt === attempt && ready.members?.length === 2 && bytes?.length === 2,
  "Nightly sequence dispatch coordinates differ")
  const requests = []
  for (let i = 0; i < 2; i++) {
    const member = ready.members[i]
    requireThat(member.routine === NIGHTLY_ROUTINES[i] && member.runAttempt === 1 && positive(member.runId) &&
      SHA.test(member.sourceSha ?? "") && bytes[i].byteLength <= 1024 * 1024, "Invalid nightly member")
    const request = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes[i]))
    const trigger = request.trigger
    const marker = validateNightlyMarker(request)
    requireThat(request.kind === "mentra-routine-request" && request.status === "ready" &&
      marker?.runId === run.id && marker.runAttempt === attempt && marker.member === member.routine &&
      trigger?.repository === REPOSITORY && trigger.kind === "workflow_dispatch" && trigger.workflow === REQUEST_WORKFLOW &&
      trigger.runId === member.runId && trigger.runAttempt === 1 && trigger.sha === member.sourceSha &&
      trigger.workflowSha === member.sourceSha && trigger.ref === "refs/heads/dev" &&
      trigger.workflowRef === `${REPOSITORY}/${REQUEST_WORKFLOW}@refs/heads/dev` &&
      request.routine.harnessRevision === member.sourceSha && request.source.channel === plan.channel &&
      request.source.buildRunId === plan.sourceRunId && request.source.publicationAttempt === plan.publicationAttempt &&
      request.selection?.build?.releaseIdentity === plan.releaseIdentity,
    "Nightly member differs from its scheduled source or selected publication")
    await verifyCoordinatedReadyRequest({github, context, request, fetchImpl})
    requests.push(request)
  }
  requireThat(ready.members[0].runId !== ready.members[1].runId &&
    isDeepStrictEqual(requests[0].source, requests[1].source) &&
    isDeepStrictEqual(requests[0].selection, requests[1].selection), "Nightly OTA and Call selections differ")
  requireThat(privateGithub, "Configure E2E_PRIVATE_DISPATCH_TOKEN with Actions write on the private test repo")
  try {
    const response = await privateGithub.rest.actions.createWorkflowDispatch({owner: context.repo.owner,
      repo: "Mentra-Automated-Testing", workflow_id: "nightly-device-routines.yml", ref: "main", inputs: {
        source_repository: REPOSITORY, ota_request_run_id: String(ready.members[0].runId), ota_request_attempt: "1",
        call_request_run_id: String(ready.members[1].runId), call_request_attempt: "1",
      }})
    requireThat(response.status === 204, "Private dispatch acknowledgement differs")
  } catch {
    throw new Error("Private nightly send outcome is unknown; reconcile manually and do not rerun")
  }
  return {status: "private-sequence-requested", requestIds: requests.map(request => request.requestId),
    reason: "One private OTA then Call job requested; execution and results are not yet known"}
}
