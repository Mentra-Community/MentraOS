import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {writeFile} from "node:fs/promises"
import {isDeepStrictEqual} from "node:util"
import {publishedCoordinatedBuild, verifyCoordinatedReadyRequest} from "./coordinated-routine-request.mjs"
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
  requireThat(terminal.checks && checks.every(key => typeof terminal.checks[key] === "boolean") &&
    (terminal.testOutcome === undefined || ["passed", "failed", "not-run", "cancelled", "unknown"].includes(terminal.testOutcome)) &&
    (terminal.testOutcome === undefined || (terminal.testOutcome === "passed") === terminal.checks.test) &&
    (terminal.status !== "passed" || checks.every(key => terminal.checks[key]) && terminal.resultRunId === request.requestId) &&
    (!terminal.resultRunId || terminal.checks.publication === true && terminal.resultRunId === request.requestId),
    "Terminal outcome contradicts verification or publication")
  return {routineId: request.routine.id, requestRunId: request.trigger.runId, requestAttempt: request.trigger.runAttempt,
    privateRunId: run.id, privateAttempt: run.run_attempt, status: terminal.status,
    ...(terminal.resultRunId ? {resultRunId: terminal.resultRunId} : {})}
}

/** Both destinations use the same exact private attempt and trusted dev request. */
export async function resolveRoutineResults({github, privateGithub, context, workerRunId, workerAttempt, read = readActionsJson}) {
  requireThat(context.eventName === "workflow_dispatch" && context.ref === "refs/heads/dev" &&
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY && positive(workerRunId) && positive(workerAttempt), "Unsupported result callback")
  const {data: run} = await privateGithub.rest.actions.getWorkflowRunAttempt({...PRIVATE, run_id: workerRunId, attempt_number: workerAttempt})
  assertRun(run, PRIVATE, [".github/workflows/device-routine.yml", ".github/workflows/nightly-device-routines.yml"], "main")
  requireThat(run.id === workerRunId && run.run_attempt === workerAttempt, "Private attempt changed")
  const terminals = await read(privateGithub, PRIVATE, run, `routine-terminal-${run.id}-${run.run_attempt}`,
    routines.map(id => `routine-terminal-${id}.json`))
  const results = []
  for (const [file, terminal] of Object.entries(terminals)) {
    requireThat(file === `routine-terminal-${terminal.request?.routineId}.json`, "Terminal filename differs from routine")
    const selector = terminal.request
    requireThat(selector?.repository === REPOSITORY && positive(selector.runId) && positive(selector.runAttempt), "Invalid source selector")
    const {data: source} = await github.rest.actions.getWorkflowRunAttempt({...context.repo, run_id: selector.runId, attempt_number: selector.runAttempt})
    assertRun(source, context.repo, [REQUEST], "dev")
    requireThat(source.id === selector.runId && source.run_attempt === selector.runAttempt && source.conclusion === "success", "Source request attempt did not succeed")
    const request = (await read(github, context.repo, source, `mentra-routine-request-${source.id}-${source.run_attempt}`, ["request.json"]))["request.json"]
    requireThat(request.trigger?.runId === source.id && request.trigger?.runAttempt === source.run_attempt &&
      request.trigger.sha === source.head_sha && request.trigger.workflowSha === source.head_sha && request.trigger.workflow === REQUEST &&
      request.trigger.repository === REPOSITORY && request.status === "ready", "Request differs from its trusted producer")
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
