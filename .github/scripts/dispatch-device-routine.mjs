import {readFile} from "node:fs/promises"
import {matchingBuildRun} from "./notify-pr-builds.mjs"
import {admittedPrBase, currentBaseSha, successfulRoutinePublication, routineProducer} from "./request-e2e-routine.mjs"
import {DEVICE_ROUTINES, deviceRoutine, hasRoutineLabel} from "./device-routines.mjs"
import {validateNightlyMarker, authenticateNightlyMarker} from "./nightly-device-routines.mjs"
import {COORDINATED_WORKFLOW, coordinatedPublicationAttempt, verifyCoordinatedReadyRequest} from "./coordinated-routine-request.mjs"

const REPOSITORY = "Mentra-Community/MentraOS"
const PRIVATE_REPOSITORY = "Mentra-Automated-Testing"
const REQUEST_WORKFLOW = ".github/workflows/request-e2e-routine.yml"
const CALLBACK_WORKFLOW = ".github/workflows/dispatch-device-routine.yml"
const SHA = /^[a-f0-9]{40}$/
const positive = (value) => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }
export const callbackRunName = (runId, attempt) => `Device request callback ${runId} / attempt ${attempt}`
export const publicationJobName = (runId, attempt, routine = "day1-ota", channel) => channel
  ? `Request coordinated source ${runId} / routine ${routine}`
  : `Request publication ${runId} / attempt ${attempt} / routine ${routine}`
export const PUBLICATION_SEND_STEP = "Send trusted publication request"
const callbackUrl = (id) => `https://github.com/${REPOSITORY}/actions/runs/${id}`
// The jobs API can briefly lag the step that is running this code. Bounded re-reads
// of this run's own jobs only; the send stays refused if its record never appears.
const OWN_SEND_REREAD_MS = [1000, 2000, 4000, 8000]
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The send step in a named, authenticated callback job is the pre-send fence.
 * Never delete its history to authorize replay. An unknown send or missing
 * history requires manual reconciliation, even if no child request is visible.
 * The current send must be observable under the exact job name that later
 * callbacks search. Other callbacks' jobs are read only after that observation,
 * so waiting for it never leaves their job reads older than the wait. Duplicate
 * prevention still relies on per-generation concurrency and earlier-send fences.
 */
async function automaticGenerationFence(github, context, plan, wait) {
  const {callbackAttempt, sourceCreatedAt} = plan
  requireThat(positive(context.runId) && positive(callbackAttempt) && SHA.test(context.sha ?? ""), "Missing callback identity")
  if (callbackAttempt !== 1) return {mode: "reconcile", callbackUrl: callbackUrl(context.runId),
    reason: "This callback was already attempted; inspect its retained outcome before manually requesting another generation"}
  requireThat(typeof sourceCreatedAt === "string" && Number.isFinite(Date.parse(sourceCreatedAt)), "Missing source creation time")
  const history = []
  let expectedTotal
  for (let page = 1; ; page++) {
    const {data} = await github.rest.actions.listWorkflowRuns({...context.repo, workflow_id: CALLBACK_WORKFLOW,
      event: "workflow_run", branch: "dev", created: `>=${sourceCreatedAt}`, per_page: 100, page})
    requireThat(Number.isSafeInteger(data.total_count) && data.total_count >= 0 && data.total_count < 1000 &&
      Array.isArray(data.workflow_runs), "Callback history is incomplete; reconcile manually")
    expectedTotal ??= data.total_count
    requireThat(data.total_count === expectedTotal, "Callback history changed while reading; reconcile manually")
    history.push(...data.workflow_runs)
    if (history.length >= expectedTotal) break
    requireThat(data.workflow_runs.length === 100, "Callback history page is incomplete; reconcile manually")
  }
  requireThat(history.length === expectedTotal && new Set(history.map((item) => item.id)).size === expectedTotal,
    "Callback history is incomplete; reconcile manually")
  requireThat(history.length && history.every((item) => positive(item.id) && positive(item.run_number) &&
    positive(item.run_attempt) && item.path === CALLBACK_WORKFLOW && item.event === "workflow_run" && item.head_branch === "dev" &&
    item.repository?.full_name === REPOSITORY && item.head_repository?.full_name === REPOSITORY), "Callback history is not authenticated")
  const current = history.find((item) => item.id === context.runId)
  const event = context.payload.workflow_run
  requireThat(current?.run_attempt === callbackAttempt && current.head_sha === context.sha &&
    current.display_title === callbackRunName(event.id, event.run_attempt),
    "Current callback is absent from authenticated history; reconcile manually")
  const name = publicationJobName(plan.sourceRunId, plan.publicationAttempt, plan.routine, plan.channel)
  const enteredSend = (job) => job.name === name && job.steps?.some((step) =>
    step.name === PUBLICATION_SEND_STEP && ["in_progress", "completed"].includes(step.status) &&
    step.conclusion !== "skipped" && typeof step.started_at === "string" && Number.isFinite(Date.parse(step.started_at)))
  const readJobs = (runId) => github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: runId, filter: "all", per_page: 100,
  })
  const ownSend = (jobs) => jobs.some((job) => enteredSend(job) &&
    job.run_attempt === callbackAttempt && job.status === "in_progress")
  let ownJobs = await readJobs(current.id)
  for (const delay of OWN_SEND_REREAD_MS) {
    if (ownSend(ownJobs)) break
    await wait(delay)
    ownJobs = await readJobs(current.id)
  }
  requireThat(ownSend(ownJobs), "Current publication send is absent from callback history")
  const matching = []
  for (const item of history) {
    const jobs = item.id === current.id ? ownJobs : await readJobs(item.id)
    // Earlier callback versions sent in their single "dispatch" job. Their
    // outcome cannot be reconstructed safely, so retain that legacy fence too.
    const legacy = !plan.channel && plan.routine === "day1-ota" &&
      ((item.display_title === callbackRunName(plan.sourceRunId, plan.publicationAttempt) &&
        jobs.some((job) => job.name === "dispatch")) || jobs.some((job) =>
        job.name === `Request publication ${plan.sourceRunId} / attempt ${plan.publicationAttempt}` &&
        job.steps?.some((step) => step.name === PUBLICATION_SEND_STEP &&
          ["in_progress", "completed"].includes(step.status) && step.conclusion !== "skipped")))
    if (legacy || jobs.some(enteredSend)) matching.push(item)
  }
  // Queued jobs cancelled by concurrency, or setup failures before this step,
  // have not sent anything. Once the send step starts, unknown sends stay fenced.
  const prior = matching.find((item) => item.id !== current.id)
  if (prior) return {mode: "reconcile", callbackUrl: callbackUrl(prior.id),
    reason: "An earlier automatic callback owns this publication generation; reuse or reconcile its request, never resend automatically"}
  return null
}

async function completedRun(github, context) {
  requireThat(context.eventName === "workflow_run" &&
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY, "Unsupported dispatch event")
  const event = context.payload.workflow_run
  requireThat(positive(event?.id) && positive(event?.run_attempt), "Missing workflow attempt")
  const {data: run} = await github.rest.actions.getWorkflowRunAttempt({
    ...context.repo, run_id: event.id, attempt_number: event.run_attempt,
  })
  requireThat(run.id === event.id && run.run_attempt === event.run_attempt &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY &&
    SHA.test(run.head_sha ?? ""), "Workflow attempt identity differs")
  return run.status === "completed" ? run : null
}

async function currentPr(github, context, number, headSha, routine, labelRequired = true) {
  if (!positive(number)) return null
  const {data: pr} = await github.rest.pulls.get({...context.repo, pull_number: number})
  return pr.number === number && pr.state === "open" && admittedPrBase(pr.base?.ref) &&
    pr.head?.repo?.full_name === REPOSITORY && pr.head.sha === headSha &&
    (!labelRequired || hasRoutineLabel(pr, routine)) ? pr : null
}

/** Runs only from the trusted default-branch workflow; reads PR metadata, never PR code. */
export async function planDeviceDispatch({github, context, callbackAttempt, routine = "day1-ota"}) {
  deviceRoutine(routine)
  const buildWorkflow = `.github/workflows/${routineProducer(routine)}`
  const run = await completedRun(github, context)
  if (!run) return {mode: "skip", reason: "Workflow has not completed"}
  if (run.path === COORDINATED_WORKFLOW) {
    if (!["no-glasses", "no-glasses-android"].includes(routine) || !["dev", "staging"].includes(run.head_branch) ||
      !["push", "workflow_dispatch"].includes(run.event) || run.conclusion !== "success")
      return {mode: "skip", reason: "Automatic coordinated requests require successful dev/staging builds and no-glasses"}
    if (callbackAttempt !== 1) return {mode: "reconcile", callbackUrl: callbackUrl(context.runId),
      reason: "This callback was already attempted; reconcile manually"}
    const publicationAttempt = await coordinatedPublicationAttempt(github, context, run)
    return {mode: "request", routine, channel: run.head_branch, sourceRunId: run.id, publicationAttempt,
      sourceCreatedAt: run.created_at, callbackRunId: context.runId, callbackAttempt}
  }
  const requestPlan = (build, publication, pr) => callbackAttempt !== 1
    ? {mode: "reconcile", callbackUrl: callbackUrl(context.runId), reason: "This callback was already attempted; reconcile manually"}
    : {mode: "request", routine, pr: pr.number, sourceRunId: build.id, publicationAttempt: publication.publicationAttempt,
      sourceCreatedAt: build.created_at, callbackRunId: context.runId, callbackAttempt}
  if (run.path === buildWorkflow && run.event === "pull_request") {
    // A Slack notification failure does not invalidate an already published app.
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo, run_id: run.id, filter: "all", per_page: 100,
    })
    const publication = successfulRoutinePublication(routine, run, jobs)
    if (!publication) return {mode: "skip", reason: "Build/publication has not succeeded"}
    if (publication.publicationAttempt !== run.run_attempt)
      return {mode: "skip", reason: "Notification-only retry retained an earlier publication; no new request generation"}
    const numbers = [...new Set((run.pull_requests ?? []).map((pr) => pr.number))]
    if (numbers.length !== 1) return {mode: "skip", reason: "Build has no unambiguous PR association"}
    const pr = await currentPr(github, context, numbers[0], run.head_sha, routine)
    if (!pr) return {mode: "skip", reason: "PR opt-in was removed or the build was superseded"}
    return requestPlan(run, publication, pr)
  }
  if (run.path === REQUEST_WORKFLOW && run.event === "pull_request") {
    // The PR workflow is only a wake-up signal. Its artifact, code and conclusion
    // are not evidence: select publication metadata here, then resolve on dev.
    const numbers = [...new Set((run.pull_requests ?? []).map((pr) => pr.number))]
    if (numbers.length !== 1) return {mode: "skip", reason: "Request wake-up has no unambiguous PR association"}
    const pr = await currentPr(github, context, numbers[0], run.head_sha, routine)
    if (!pr) return {mode: "skip", reason: "PR opt-in was removed or the wake-up was superseded"}
    const {data} = await github.rest.actions.listWorkflowRuns({...context.repo, workflow_id: buildWorkflow,
      event: "pull_request", head_sha: pr.head.sha, per_page: 100})
    let candidates = data.workflow_runs
    while (candidates.length) {
      const build = matchingBuildRun(candidates, pr, pr.head.sha)
      if (!build) break
      candidates = candidates.filter((item) => item.id !== build.id)
      if (build.path !== buildWorkflow || build.repository?.full_name !== REPOSITORY ||
        !positive(build.id) || build.status !== "completed") continue
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        ...context.repo, run_id: build.id, filter: "all", per_page: 100,
      })
      const publication = successfulRoutinePublication(routine, build, jobs)
      if (publication) return requestPlan(build, publication, pr)
    }
    return {mode: "skip", reason: "No successful compatible app publication for the current PR revision"}
  }
  // Only the trusted dev producer's artifact can reach private dispatch.
  if (run.path === REQUEST_WORKFLOW && run.event === "workflow_dispatch" && run.head_branch === "dev" && run.conclusion === "success") {
    const name = `mentra-routine-request-${run.id}-${run.run_attempt}`
    const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
      ...context.repo, run_id: run.id, per_page: 100,
    })
    const matches = artifacts.filter((artifact) => artifact.name === name && !artifact.expired)
    requireThat(matches.length === 1 && positive(matches[0].id) && matches[0].size_in_bytes <= 2 * 1024 * 1024 &&
      /^sha256:[a-f0-9]{64}$/.test(matches[0].digest ?? "") &&
      matches[0].workflow_run?.id === run.id && matches[0].workflow_run.head_sha === run.head_sha,
    "Request artifact is missing, ambiguous or not bound to the workflow")
    return {mode: "dispatch", runId: run.id, runAttempt: run.run_attempt,
      sourceSha: run.head_sha, artifactId: matches[0].id, artifactName: name}
  }
  return {mode: "skip", reason: "Not an eligible build or trusted dev request workflow"}
}

/** An automatic publication can request all registered routines. A completed
 * request already names one routine, so its private callback remains singular. */
export async function planDeviceDispatches(options) {
  const plans = []
  for (const routine of Object.keys(DEVICE_ROUTINES)) {
    const plan = await planDeviceDispatch({...options, routine})
    if (plan.mode === "dispatch") return [plan]
    plans.push(plan)
  }
  return plans
}

export async function requestAfterPublication({github, context, plan, wait = sleep}) {
  deviceRoutine(plan.routine)
  const coordinated = ["dev", "staging"].includes(plan.channel)
  requireThat(plan.mode === "request" && (coordinated ? !plan.pr && ["no-glasses", "no-glasses-android"].includes(plan.routine) : !plan.channel && positive(plan.pr)) && positive(plan.sourceRunId) && positive(plan.publicationAttempt)
    && plan.callbackRunId === context.runId && plan.callbackAttempt === 1, "Invalid request dispatch")
  const prior = await automaticGenerationFence(github, context, plan, wait)
  if (prior) return {status: "request-reconcile", ...prior}
  try {
    // The workflow disables SDK retry. The callback record already fences this send.
    const {status, data} = await github.rest.actions.createWorkflowDispatch({...context.repo,
      workflow_id: REQUEST_WORKFLOW, ref: "dev", return_run_details: true, inputs: {
        ...(coordinated ? {channel: plan.channel} : {pr: String(plan.pr)}), routine: plan.routine,
        request_origin: coordinated ? "successful-build" : "pr-label",
        source_build_run_id: String(plan.sourceRunId), source_publication_attempt: String(plan.publicationAttempt)}})
    requireThat(status === 200 && positive(data?.workflow_run_id) && data.html_url === callbackUrl(data.workflow_run_id)
      && data.run_url === `https://api.github.com/repos/${REPOSITORY}/actions/runs/${data.workflow_run_id}`, "Dispatch acknowledgement differs")
    return {status: "request-dispatched", ...(coordinated ? {channel: plan.channel} : {pr: plan.pr}),
      requestRunId: data.workflow_run_id, requestUrl: data.html_url}
  } catch {
    return {status: "request-dispatch-unknown", callbackUrl: callbackUrl(context.runId),
      reason: "The send may have succeeded. Preserve this callback history and reconcile manually; no automatic resend is authorized"}
  }
}

/** Read the downloaded JSON as data. The private worker independently authenticates it again. */
export async function dispatchReadyRequest({github, privateGithub, context, plan, bytes, fetchImpl = fetch}) {
  requireThat(plan.mode === "dispatch" && positive(plan.runId) && positive(plan.runAttempt) &&
    SHA.test(plan.sourceSha ?? ""), "Invalid private dispatch plan")
  requireThat(bytes.byteLength <= 1024 * 1024, "Request exceeds 1 MiB")
  const request = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))
  deviceRoutine(request.routine?.id)
  const coordinated = request.schemaVersion === 2
  requireThat(request.routine.authorization === undefined ||
    ["pr-label", "workflow-dispatch", ...(coordinated ? ["successful-build"] : [])].includes(request.routine.authorization), "Unsupported request authorization")
  const trigger = request.trigger
  requireThat([1, 2].includes(request.schemaVersion) && request.kind === "mentra-routine-request" &&
    trigger?.kind === "workflow_dispatch" && trigger.repository === REPOSITORY &&
    trigger.workflow === REQUEST_WORKFLOW && trigger.runId === plan.runId && trigger.runAttempt === plan.runAttempt &&
    trigger.ref === "refs/heads/dev" && trigger.sha === plan.sourceSha && trigger.workflowSha === plan.sourceSha &&
    trigger.workflowRef === `${REPOSITORY}/${REQUEST_WORKFLOW}@refs/heads/dev` &&
    request.routine.harnessRevision === plan.sourceSha && (coordinated
      ? request.source?.kind === "coordinated-release" && ["dev", "staging"].includes(request.source.channel) && !request.pullRequest &&
        request.requestId === `routine-${plan.runId}-${plan.runAttempt}-${request.source.channel}-${request.routine.id}`
      : positive(request.pullRequest?.number) &&
        request.requestId === `routine-${plan.runId}-${plan.runAttempt}-${request.pullRequest.number}-${request.routine.id}`),
  "Request does not match its trusted producer")
  const nightly = validateNightlyMarker(request)
  if (nightly?.kind === "nightly-ota-call") return {status: "not-dispatched", requestId: request.requestId,
    reason: "Nightly sequence member; only the scheduled source may dispatch the paired OTA then Call job"}
  if (nightly) await authenticateNightlyMarker({github, context, request})
  if (request.status === "no-artifact") return {status: "not-dispatched", reason: "No eligible artifact"}
  if (coordinated) {
    requireThat(request.status === "ready" && request.selection?.platform === deviceRoutine(request.routine.id).platform, "Invalid ready coordinated selection")
    await verifyCoordinatedReadyRequest({github, context, request, fetchImpl})
  } else {
    requireThat(request.status === "ready" && request.selection?.platform === deviceRoutine(request.routine.id).platform &&
      request.selection.build?.headSha === request.pullRequest.headSha &&
      request.selection.build?.baseSha === request.pullRequest.baseSha, "Invalid ready selection")
    // Every schema 1 request records its PR base and selected app backend; they must agree.
    const baseRef = request.pullRequest.baseRef
    requireThat(admittedPrBase(baseRef) && request.selection.app?.backend === baseRef, "Ready selection destination is not admitted")
    const pr = await currentPr(github, context, request.pullRequest.number, request.pullRequest.headSha,
      request.routine.id, request.routine.authorization !== "workflow-dispatch")
    if (!pr || pr.base.ref !== baseRef || await currentBaseSha(github, context, baseRef) !== request.pullRequest.baseSha)
      return {status: "not-dispatched", reason: "Request was superseded, retargeted or PR opt-in was removed"}
  }
  requireThat(privateGithub, "Missing short-lived GitHub App dispatch token")
  await privateGithub.rest.actions.createWorkflowDispatch({owner: context.repo.owner, repo: PRIVATE_REPOSITORY,
    workflow_id: "device-routine.yml", ref: "main", inputs: {
      source_repository: REPOSITORY, request_run_id: String(plan.runId), request_attempt: String(plan.runAttempt),
      routine_id: request.routine.id,
    }})
  return {status: "private-job-requested", requestId: request.requestId,
    reason: "GitHub accepted the workflow dispatch; device execution and results are not yet known"}
}

export async function readRequest(path) {
  // The workflow supplies a fixed local path, never a path from the PR/request.
  const {stat} = await import("node:fs/promises")
  requireThat((await stat(path)).size <= 1024 * 1024, "Request exceeds 1 MiB")
  return readFile(path)
}
