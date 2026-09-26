import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {writeFile} from "node:fs/promises"
import {isDeepStrictEqual} from "node:util"
import {publishedCoordinatedBuild, verifyCoordinatedReadyRequest} from "./coordinated-routine-request.mjs"
import {deviceRoutine} from "./device-routines.mjs"
import {callbackRunName} from "./dispatch-device-routine.mjs"
import {applyRoutineResult, assertNotification, positive, receiptName, REPOSITORY, requireThat, sha} from "./release-slack-message.mjs"

export const WORKFLOW = ".github/workflows/notify-release-routine.yml"
const PRIVATE = {owner: "Mentra-Community", repo: "Mentra-Automated-Testing"}
const REQUEST = ".github/workflows/request-e2e-routine.yml"
const routines = ["no-glasses", "no-glasses-android", "day1-ota", "mentra-call"]
export const jobName = plan => `Update release ${plan.notification.build.runId} / post ${plan.notification.producer.runAttempt} / ${plan.row.routineId}`
export const stateName = (runId, attempt, routine) => `release-slack-state-${runId}-${attempt}-${routine}`

async function artifacts(github, repo, runId) {
  const values = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {...repo, run_id: runId, per_page: 100})
  requireThat(values.length < 1000 && new Set(values.map(item => item.id)).size === values.length, "Artifact history is incomplete")
  return values
}

/** GitHub authenticates the ZIP; read bounded JSON only, never extract or execute it. */
export async function readActionsJson(github, repo, run, name, allowedFiles, {readZip} = {}) {
  const matches = (await artifacts(github, repo, run.id)).filter(item => item.name === name)
  requireThat(matches.length === 1, "Expected one retained notification artifact")
  const artifact = matches[0]
  requireThat(!artifact.expired && positive(artifact.id) && artifact.size_in_bytes <= 512 * 1024 &&
    /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") && artifact.workflow_run?.id === run.id &&
    artifact.workflow_run.head_sha === run.head_sha, "Artifact is expired or not bound to its workflow")
  const {data} = await github.rest.actions.downloadArtifact({...repo, artifact_id: artifact.id, archive_format: "zip"})
  const bytes = Buffer.from(data)
  requireThat(bytes.length <= 512 * 1024 && `sha256:${createHash("sha256").update(bytes).digest("hex")}` === artifact.digest,
    "Artifact download digest differs")
  const values = readZip ? await readZip(bytes) : JSON.parse(execFileSync("python3", ["-c", [
    "import io,json,sys,zipfile",
    "z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))",
    "files=z.infolist()",
    "assert 0 < len(files) <= 3 and sum(f.file_size for f in files) <= 262144",
    "assert len(set(f.filename for f in files)) == len(files)",
    "assert all(not f.is_dir() and f.filename in json.loads(sys.argv[1]) for f in files)",
    "print(json.dumps({f.filename:json.loads(z.read(f).decode('utf-8')) for f in files}))",
  ].join("\n"), JSON.stringify(allowedFiles)], {input: bytes, maxBuffer: 512 * 1024, timeout: 10_000}).toString())
  requireThat(Object.keys(values).length > 0 && Object.keys(values).every(name => allowedFiles.includes(name)), "Unexpected artifact entries")
  return values
}

function assertRun(run, repo, paths, branch, completed = true) {
  requireThat(positive(run?.id) && positive(run.run_attempt) && paths.includes(run.path) && run.head_branch === branch &&
    run.event === "workflow_dispatch" && sha(run.head_sha) && run.repository?.full_name === `${repo.owner}/${repo.repo}` &&
    run.head_repository?.full_name === `${repo.owner}/${repo.repo}` && (!completed || run.status === "completed"),
    "Workflow identity differs from trusted producer")
}

export function terminalRow(terminal, run, request) {
  requireThat(terminal?.schemaVersion === 1 && terminal.kind === "mentra-routine-terminal" &&
    terminal.privateRun?.repository === `${PRIVATE.owner}/${PRIVATE.repo}` && terminal.privateRun.runId === run.id &&
    terminal.privateRun.runAttempt === run.run_attempt && terminal.privateRun.revision === run.head_sha &&
    terminal.request?.repository === REPOSITORY && terminal.request.runId === request.trigger.runId &&
    terminal.request.runAttempt === request.trigger.runAttempt && terminal.request.routineId === request.routine.id &&
    routines.includes(request.routine.id) && ["passed", "failed", "blocked", "aborted", "upload-incomplete"].includes(terminal.status),
    "Terminal result does not match its private workflow and source request")
  const checks = ["test", "teardown", "returnVerification", "evidence", "fixture", "publication", "settlement"]
  // A skipped nightly Call publishes the existing intake export, not a device
  // lifecycle. Accept only its exact request-derived ID and explicit not-run verdict.
  const nightlyIntake = request.schemaVersion === 2 && request.routine.id === "mentra-call" &&
    request.sequence?.kind === "nightly-ota-call" && request.sequence.member === "mentra-call" &&
    terminal.status === "blocked" && terminal.testOutcome === "not-run" && terminal.checks?.test === false &&
    terminal.resultRunId === `${request.requestId}-intake`
  requireThat(terminal.checks && checks.every(key => typeof terminal.checks[key] === "boolean") &&
    (terminal.testOutcome === undefined || ["passed", "failed", "not-run", "cancelled", "unknown"].includes(terminal.testOutcome)) &&
    (terminal.testOutcome === undefined || (terminal.testOutcome === "passed") === terminal.checks.test) &&
    (terminal.status !== "passed" || checks.every(key => terminal.checks[key]) && terminal.resultRunId === request.requestId) &&
    (!terminal.resultRunId || terminal.checks.publication === true && (terminal.resultRunId === request.requestId || nightlyIntake)),
    "Terminal outcome contradicts verification or publication")
  return {routineId: request.routine.id, requestRunId: request.trigger.runId, requestAttempt: request.trigger.runAttempt,
    privateRunId: run.id, privateAttempt: run.run_attempt, status: terminal.status,
    ...(terminal.resultRunId ? {resultRunId: terminal.resultRunId} : {})}
}

async function trustedRequest(github, context, selector, read) {
  requireThat(selector?.repository === REPOSITORY && positive(selector.runId) && positive(selector.runAttempt), "Invalid source selector")
  const {data: source} = await github.rest.actions.getWorkflowRunAttempt({...context.repo, run_id: selector.runId, attempt_number: selector.runAttempt})
  assertRun(source, context.repo, [REQUEST], "dev")
  requireThat(source.id === selector.runId && source.run_attempt === selector.runAttempt && source.conclusion === "success", "Source request attempt did not succeed")
  const request = (await read(github, context.repo, source, `mentra-routine-request-${source.id}-${source.run_attempt}`, ["request.json"]))["request.json"]
  requireThat(request.trigger?.runId === source.id && request.trigger?.runAttempt === source.run_attempt &&
    request.trigger.sha === source.head_sha && request.trigger.workflowSha === source.head_sha && request.trigger.workflow === REQUEST &&
    request.trigger.repository === REPOSITORY && request.status === "ready", "Request differs from its trusted producer")
  return {source, request}
}

const WORKER = ".github/workflows/device-routine.yml"
const CALLBACK = ".github/workflows/dispatch-device-routine.yml"
const WORKER_JOB = "prepared-mac-routine"
const CALLBACK_JOB = "Dispatch trusted request"
const PRIVATE_SEND_STEP = "Queue the ready request in the private repository"
export const DISPATCHER = {workflow: CALLBACK, job: CALLBACK_JOB, step: PRIVATE_SEND_STEP}
// The trusted dispatcher queues private workers with the TEST_RUN GitHub App token
// (dispatch-device-routine.yml). GitHub records that App's bot as the worker run's
// creator; the numeric account ID is immutable. Actual receipt: worker 36218299907
// was created by this bot during callback 36218261570's private send.
const DISPATCHER_APP = Object.freeze({login: "mentra-release-coordinator[bot]", id: 321969383, type: "Bot"})
const createdByDispatcherApp = actor => actor?.id === DISPATCHER_APP.id && actor.login === DISPATCHER_APP.login &&
  actor.type === DISPATCHER_APP.type
// GitHub records run creation and step times on different services, in whole seconds.
const CLOCK_SKEW_MS = 5_000
const NOT_PROVEN = "No terminal receipt; only a cancelled attempt that never reached a runner can be reported without one"
const workerTitle = /^Device routine request ([1-9]\d{0,15}) \/ attempt ([1-9]\d{0,5})$/
const searchTime = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

async function completeRuns(github, repo, query, message) {
  const runs = []
  let total
  for (let page = 1; ; page++) {
    const {data} = await github.rest.actions.listWorkflowRuns({...repo, ...query, per_page: 100, page})
    requireThat(Number.isSafeInteger(data.total_count) && data.total_count >= 0 && data.total_count < 1000 &&
      Array.isArray(data.workflow_runs) && (total ?? data.total_count) === data.total_count, message)
    total = data.total_count
    runs.push(...data.workflow_runs)
    if (runs.length >= total) break
    requireThat(data.workflow_runs.length === 100, message)
  }
  requireThat(runs.length === total && new Set(runs.map(item => item.id)).size === total, message)
  return runs
}

/**
 * GitHub metadata, not worker code, is the only witness when an attempt is
 * cancelled before a runner accepts it. Private main's device-routine.yml (the
 * same trust root that writes ordinary terminal receipts) makes GitHub derive the
 * run name from the request_run_id/request_attempt inputs and the job labels from
 * routine_id; the digits-only title parse is unambiguous. Those inputs still only
 * name a candidate: the request must be the trusted dev producer, the run must be
 * created by the dispatcher App, the job must show no runner or step, and the
 * trusted dev callback for that request must be the single sender of exactly this
 * run. Private dispatch returns no run ID, so there is no stronger binding for
 * historical runs; anything ambiguous is refused.
 */
async function unexecutedCancellation({github, privateGithub, context, run, read}) {
  const title = workerTitle.exec(run.display_title ?? "")
  requireThat(run.path === WORKER && run.conclusion === "cancelled" && title, NOT_PROVEN)
  requireThat(createdByDispatcherApp(run.actor) && createdByDispatcherApp(run.triggering_actor),
    "Private run was not created by the trusted dispatcher App")
  // The dispatcher only ever creates first attempts. Any rerun, even by the same App,
  // may follow an attempt that executed without a receipt; that keeps its recovery path.
  // The latest run metadata must show that this first attempt is still the only one.
  const {data: latest} = await privateGithub.rest.actions.getWorkflowRun({...PRIVATE, run_id: run.id})
  requireThat(run.run_attempt === 1 && latest?.id === run.id && latest.run_attempt === 1 &&
    ["path", "head_branch", "head_sha", "event", "status", "conclusion", "display_title", "created_at"]
      .every(key => latest[key] === run[key]) && latest.repository?.full_name === run.repository.full_name &&
    createdByDispatcherApp(latest.actor) && createdByDispatcherApp(latest.triggering_actor),
  "Only an unrerun first dispatched attempt can be reported as cancelled before execution")
  const jobs = await privateGithub.paginate(privateGithub.rest.actions.listJobsForWorkflowRunAttempt,
    {...PRIVATE, run_id: run.id, attempt_number: run.run_attempt, per_page: 100})
  requireThat(jobs.length === 1, "Cancelled attempt jobs are ambiguous")
  const [job] = jobs
  const {source, request} = await trustedRequest(github, context,
    {repository: REPOSITORY, runId: Number(title[1]), runAttempt: Number(title[2])}, read)
  const routine = request.routine?.id
  requireThat(routines.includes(routine) && request.selection?.platform === deviceRoutine(routine).platform,
    "Request routine is not a device worker routine")
  requireThat(job.name === WORKER_JOB && job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === run.head_sha &&
    isDeepStrictEqual(job.labels, ["mentra-device-worker", request.selection.platform, `mentra-routine-${routine}`]),
  "Cancelled job differs from its requested routine")
  // A started, interrupted or crashed job keeps its own recovery/evidence contract.
  requireThat(job.status === "completed" && job.conclusion === "cancelled" && Array.isArray(job.steps) && job.steps.length === 0 &&
    !job.runner_id && !job.runner_name && !job.runner_group_id, "Cancelled attempt may have reached a runner; use its recovery evidence")
  const requested = Date.parse(source.created_at), created = Date.parse(run.created_at)
  requireThat(Number.isFinite(requested) && Number.isFinite(created) && requested < created, "Worker predates its request")
  const callbacks = (await completeRuns(github, context.repo, {workflow_id: CALLBACK, event: "workflow_run", branch: "dev",
    created: `${searchTime(requested)}..${searchTime(created)}`}, "Dispatcher history is unavailable or incomplete"))
    .filter(item => item.display_title === callbackRunName(source.id, source.run_attempt))
  requireThat(callbacks.length === 1 && callbacks[0].path === CALLBACK && callbacks[0].event === "workflow_run" &&
    callbacks[0].head_branch === "dev" && sha(callbacks[0].head_sha) && callbacks[0].repository?.full_name === REPOSITORY &&
    callbacks[0].head_repository?.full_name === REPOSITORY, "Trusted dispatcher for this request is absent or ambiguous")
  const sends = new Map()
  for (const item of await github.paginate(github.rest.actions.listJobsForWorkflowRun,
    {...context.repo, run_id: callbacks[0].id, filter: "all", per_page: 100})) {
    if (item.name !== CALLBACK_JOB) continue
    const step = item.steps?.find(value => value.name === PRIVATE_SEND_STEP)
    // Retries clone completed jobs with their original timestamps; that is one send.
    if (step && step.conclusion !== "skipped") sends.set(`${step.started_at}/${step.completed_at}`, step)
  }
  const [send] = sends.values(), start = Date.parse(send?.started_at), end = Date.parse(send?.completed_at)
  requireThat(sends.size === 1 && send.status === "completed" && send.conclusion === "success" &&
    Number.isFinite(start) && Number.isFinite(end) && start - CLOCK_SKEW_MS <= created && created <= end + CLOCK_SKEW_MS,
  "Trusted dispatcher did not send exactly this private run")
  const siblings = (await completeRuns(privateGithub, PRIVATE, {workflow_id: WORKER, event: "workflow_dispatch", branch: "main",
    created: `${searchTime(start - CLOCK_SKEW_MS)}..${searchTime(end + CLOCK_SKEW_MS)}`}, "Private dispatch history is unavailable or incomplete"))
    .filter(item => item.display_title === run.display_title)
  requireThat(siblings.length === 1 && siblings[0].id === run.id, "Private dispatch for this request is ambiguous")
  return {request, terminal: null, row: {routineId: routine, requestRunId: source.id, requestAttempt: source.run_attempt,
    privateRunId: run.id, privateAttempt: run.run_attempt, status: "cancelled"}}
}

/** Both destinations use the same exact private attempt and trusted dev request. */
export async function resolveRoutineResults({github, privateGithub, context, workerRunId, workerAttempt, read = readActionsJson}) {
  requireThat(context.eventName === "workflow_dispatch" && context.ref === "refs/heads/dev" &&
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY && positive(workerRunId) && positive(workerAttempt), "Unsupported result callback")
  const {data: run} = await privateGithub.rest.actions.getWorkflowRunAttempt({...PRIVATE, run_id: workerRunId, attempt_number: workerAttempt})
  assertRun(run, PRIVATE, [WORKER, ".github/workflows/nightly-device-routines.yml"], "main")
  requireThat(run.id === workerRunId && run.run_attempt === workerAttempt, "Private attempt changed")
  const receipt = `routine-terminal-${run.id}-${run.run_attempt}`
  // Any retained (even expired) receipt keeps the ordinary worker-attested path.
  if (run.conclusion === "cancelled" && !(await artifacts(privateGithub, PRIVATE, run.id)).some(item => item.name === receipt))
    return [await unexecutedCancellation({github, privateGithub, context, run, read})]
  const terminals = await read(privateGithub, PRIVATE, run, receipt, routines.map(id => `routine-terminal-${id}.json`))
  const results = []
  for (const [file, terminal] of Object.entries(terminals)) {
    requireThat(file === `routine-terminal-${terminal.request?.routineId}.json`, "Terminal filename differs from routine")
    const {request} = await trustedRequest(github, context, terminal.request, read)
    results.push({request, terminal, row: terminalRow(terminal, run, request)})
  }
  return results
}

export async function resolveRoutineNotifications({github, context, read = readActionsJson,
  verify = verifyCoordinatedReadyRequest, published = publishedCoordinatedBuild, ...options}) {
  const plans = []
  for (const {request, row} of await resolveRoutineResults({github, context, read, ...options})) {
    if (request.schemaVersion !== 2) continue
    await verify({github, context, request})
    // The original release post was pinned to its Mac download. Authenticate that
    // sibling archive for Android results; never compare the APK hash to a ZIP hash.
    const postArchive = request.selection.platform === "android"
      ? (await published({identity: request.selection.build.releaseIdentity, channel: request.source.channel,
          sourceCommit: request.selection.build.sourceCommit})).archive.sha256
      : request.selection.archive.sha256
    const {data: buildRun} = await github.rest.actions.getWorkflowRunAttempt({...context.repo,
      run_id: request.source.buildRunId, attempt_number: request.source.publicationAttempt})
    const prefix = `release-slack-message-${buildRun.id}-`
    const found = (await artifacts(github, context.repo, buildRun.id)).filter(item => item.name.startsWith(prefix))
    // Notification-only retries can post after the original publication attempt.
    // Preserve the first actual editable post for this exact build, not the latest retry.
    const messages = []
    for (const artifact of found) {
      const attempt = Number(artifact.name.slice(prefix.length))
      requireThat(positive(attempt) && artifact.name === receiptName(buildRun.id, attempt), "Invalid release message attempt")
      const candidate = (await read(github, context.repo, buildRun, artifact.name, ["slack-release-message.json"]))["slack-release-message.json"]
      if (candidate.build === null) continue // Incomplete release post without a verified archive.
      const message = assertNotification(candidate)
      requireThat(message.producer.runAttempt === attempt && message.build.runId === request.source.buildRunId &&
        message.build.channel === request.source.channel && message.build.headSha === request.selection.build.sourceCommit &&
        message.build.release === request.selection.build.releaseIdentity &&
        message.build.archiveSha256 === postArchive, "Release post belongs to another tested build")
      messages.push(message)
    }
    if (!messages.length) continue // Webhook-era/unconfigured posts have no editable receipt.
    const notification = messages.sort((a, b) => a.producer.runAttempt - b.producer.runAttempt)[0]
    plans.push({notification, row, sourceCreatedAt: buildRun.created_at})
  }
  return plans
}

/** Each state artifact is written BEFORE chat.update. A failed/unknown update is
 * harmless: the next serialized job reapplies the full desired state, not a delta. */
export async function prepareRoutineUpdate({github, context, plan, read = readActionsJson,
  runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT), write = writeFile}) {
  assertNotification(plan.notification)
  requireThat(typeof plan.sourceCreatedAt === "string" && Number.isFinite(Date.parse(plan.sourceCreatedAt)), "Missing source creation time")
  const history = [], repo = context.repo
  let total
  for (let page = 1; ; page++) {
    const {data} = await github.rest.actions.listWorkflowRuns({...repo, workflow_id: WORKFLOW, event: "workflow_dispatch",
      branch: "dev", created: `>=${plan.sourceCreatedAt}`, per_page: 100, page})
    requireThat(Number.isSafeInteger(data.total_count) && data.total_count > 0 && data.total_count < 1000,
      "Notification history unavailable; use Admin results and reconcile this post")
    total ??= data.total_count
    requireThat(total === data.total_count && Array.isArray(data.workflow_runs), "Notification history changed; retry this update")
    history.push(...data.workflow_runs)
    if (history.length >= total) break
    requireThat(data.workflow_runs.length === 100, "Notification history incomplete")
  }
  requireThat(history.length === total && new Set(history.map(run => run.id)).size === total, "Notification history incomplete")
  const prefix = `Update release ${plan.notification.build.runId} / post ${plan.notification.producer.runAttempt} / `
  const candidates = []
  let current
  for (const run of history) {
    assertRun(run, repo, [WORKFLOW], "dev", false)
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {...repo, run_id: run.id, filter: "all", per_page: 100})
    const matching = jobs.filter(job => job.name.startsWith(prefix))
    // GitHub clones retained successful jobs into later retry attempts. Their
    // execution and state artifact still belong to the first matching attempt.
    const originalExecutions = matching.filter(job => !matching.some(other => other.run_attempt < job.run_attempt &&
      job.status === "completed" && other.status === "completed" && other.name === job.name &&
      job.started_at && job.completed_at && other.started_at === job.started_at && other.completed_at === job.completed_at))
    for (const job of originalExecutions) {
      requireThat(positive(job.run_attempt) && positive(job.id), "Notification job identity missing")
      if (run.id === context.runId && job.run_attempt === runAttempt &&
        job.name === jobName(plan) && job.status === "in_progress") { current = job; continue }
      if (job.status !== "completed") continue
      const routine = job.name.slice(prefix.length)
      requireThat(routines.includes(routine), "Unexpected routine update job")
      const all = await artifacts(github, repo, run.id)
      const retained = all.find(item => item.name === stateName(run.id, job.run_attempt, routine))
      if (!retained) {
        requireThat(!job.steps?.some(step => step.name === "Update original Slack message" && step.started_at && step.conclusion !== "skipped"),
          "Applied notification state is no longer retained; refusing to erase prior results")
        continue
      }
      candidates.push({run: {...run, run_attempt: job.run_attempt}, job, routine})
    }
  }
  requireThat(current && Number.isFinite(Date.parse(current.started_at)), "Current serialized update job is absent")
  requireThat(candidates.every(item => item.job.started_at !== current.started_at), "Ambiguous retained update order")
  const earlier = candidates.filter(item => Date.parse(item.job.started_at) < Date.parse(current.started_at))
    .sort((a, b) => Date.parse(b.job.started_at) - Date.parse(a.job.started_at))
  requireThat(!earlier[1] || earlier[0].job.started_at !== earlier[1].job.started_at, "Ambiguous retained update order")
  let notification = plan.notification
  if (earlier[0]) {
    const previous = earlier[0]
    notification = assertNotification((await read(github, repo, previous.run,
      stateName(previous.run.id, previous.job.run_attempt, previous.routine), ["slack-update-state.json"]))["slack-update-state.json"])
    requireThat(isDeepStrictEqual(notification.build, plan.notification.build) && isDeepStrictEqual(notification.message, plan.notification.message),
      "Retained state belongs to a different release post")
  }
  const state = applyRoutineResult(notification, plan.row)
  await write("slack-update-state.json", JSON.stringify(state) + "\n", {flag: "wx"})
  return state
}
