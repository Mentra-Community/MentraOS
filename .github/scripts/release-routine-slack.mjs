import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {writeFile} from "node:fs/promises"
import {isDeepStrictEqual} from "node:util"
import {routineApi, requestIdentity, boundRoutineResult, waitForRoutineResult} from "./routine-api.mjs"
import {applyRoutineResult, assertNotification, positive, receiptName, REPOSITORY, requireThat, sha} from "./release-slack-message.mjs"

export const WORKFLOW = ".github/workflows/notify-release-routine.yml"
export const jobName = plan => `Update release ${plan.notification.build.runId} / post ${plan.notification.producer.runAttempt} / ${plan.row.requestId}`
export const stateName = (runId, attempt, requestId) => `release-slack-state-${runId}-${attempt}-${requestId}`
async function artifacts(github, repo, runId) {
  const values = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {...repo, run_id: runId, per_page: 100})
  requireThat(values.length < 1000 && new Set(values.map(item => item.id)).size === values.length, "Artifact history is incomplete")
  return values
}

/** GitHub authenticates the ZIP; read bounded JSON only, never extract or execute it. */
export async function readActionsJson(github, repo, run, name, allowedFiles, {readZip, maxJsonBytes = 262144} = {}) {
  requireThat(Number.isSafeInteger(maxJsonBytes) && maxJsonBytes > 0 && maxJsonBytes <= 262144, "Invalid JSON byte limit")
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
    "assert 0 < len(files) <= 3 and sum(f.file_size for f in files) <= int(sys.argv[2])",
    "assert len(set(f.filename for f in files)) == len(files)",
    "assert all(not f.is_dir() and f.filename in json.loads(sys.argv[1]) for f in files)",
    "print(json.dumps({f.filename:json.loads(z.read(f).decode('utf-8')) for f in files}))",
  ].join("\n"), JSON.stringify(allowedFiles), String(maxJsonBytes)], {input: bytes, maxBuffer: 512 * 1024, timeout: 10_000}).toString())
  requireThat(Object.keys(values).length > 0 && Object.keys(values).every(name => allowedFiles.includes(name)), "Unexpected artifact entries")
  return values
}

function assertRun(run, repo, paths, branch, completed = true) {
  requireThat(positive(run?.id) && positive(run.run_attempt) && paths.includes(run.path) && run.head_branch === branch &&
    ["workflow_dispatch", "workflow_run"].includes(run.event) && sha(run.head_sha) && run.repository?.full_name === `${repo.owner}/${repo.repo}` &&
    run.head_repository?.full_name === `${repo.owner}/${repo.repo}` && (!completed || run.status === "completed"),
    "Workflow identity differs from trusted producer")
}

/** The artifact contains selectors only; execution and report identity are authenticated independently by Core. */
export async function resolveRoutineSelectors({github, context, requestId, read = readActionsJson}) {
  requireThat(`${context.repo.owner}/${context.repo.repo}` === REPOSITORY, "Invalid notification repository")
  if (context.eventName === "workflow_dispatch") {
    requireThat(context.ref === "refs/heads/dev" && requestIdentity(requestId), "Invalid explicit result selector")
    return [requestId]
  }
  const candidate = context.payload.workflow_run
  requireThat(context.eventName === "workflow_run" && positive(candidate?.id) && positive(candidate.run_attempt), "Invalid result callback")
  const {data: run} = await github.rest.actions.getWorkflowRunAttempt({...context.repo, run_id: candidate.id, attempt_number: candidate.run_attempt})
  requireThat(run.id === candidate.id && run.run_attempt === candidate.run_attempt && run.status === "completed" &&
    [".github/workflows/request-e2e-routine.yml", ".github/workflows/dispatch-device-routine.yml"].includes(run.path) &&
    ["workflow_dispatch", "pull_request_target", "workflow_run"].includes(run.event) &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
    "Result callback is not a trusted request producer")
  const suffix = `-${run.id}-${run.run_attempt}`
  const found = (await artifacts(github, context.repo, run.id)).filter(item => item.name === `routine-dispatches${suffix}` ||
    item.name.startsWith("routine-dispatch-routine-") && item.name.endsWith(suffix))
  const ids = []
  for (const artifact of found) {
    const values = await read(github, context.repo, run, artifact.name, ["routine-dispatch.json", "routine-dispatches.json"])
    for (const selector of Object.values(values)) {
      requireThat(Array.isArray(selector?.requestIds) && selector.requestIds.length <= 256 && selector.requestIds.every(requestIdentity), "Invalid Core request selectors")
      ids.push(...selector.requestIds)
    }
  }
  return [...new Set(ids)]
}

/** Result workflows resolve only their own request; fanout isolates neighboring waits. */
export async function resolveRoutineResults({token, requestIds, fetchImpl = fetch, wait = waitForRoutineResult}) {
  return Promise.all(requestIds.map(requestId => wait({token, requestId, fetchImpl})))
}

/** Fan out selectors without waiting for any device. Retried child publications reconcile the same request. */
export async function launchRoutineResultNotifications({github, context, requestIds}) {
  requireThat(context.eventName === "workflow_run" && context.ref === "refs/heads/dev" &&
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY && Array.isArray(requestIds) &&
    requestIds.length <= 256 && requestIds.every(requestIdentity) && new Set(requestIds).size === requestIds.length,
    "Result fanout requires trusted unique callback selectors")
  const candidate = context.payload.workflow_run
  requireThat(positive(candidate?.id) && positive(candidate.run_attempt), "Result producer identity is missing")
  const {data: producer} = await github.rest.actions.getWorkflowRunAttempt({...context.repo, run_id: candidate.id, attempt_number: candidate.run_attempt})
  requireThat(producer.id === candidate.id && producer.run_attempt === candidate.run_attempt && Number.isFinite(Date.parse(producer.created_at)) &&
    producer.status === "completed" && [".github/workflows/request-e2e-routine.yml", ".github/workflows/dispatch-device-routine.yml"].includes(producer.path) &&
    ["workflow_dispatch", "pull_request_target", "workflow_run"].includes(producer.event) && producer.repository?.full_name === REPOSITORY &&
    producer.head_repository?.full_name === REPOSITORY, "Result fanout producer differs from its authenticated source")
  const {data: current} = await github.rest.actions.getWorkflowRun({...context.repo, run_id: context.runId})
  assertRun(current, context.repo, [WORKFLOW], "dev", false)
  requireThat(current.id === context.runId && current.event === "workflow_run", "Result fanout run differs")
  const settled = await Promise.allSettled(requestIds.map(async requestId => {
    // An uncertain GitHub dispatch can be retried: duplicate notification runs
    // reconcile the same request through PR/Slack locks and durable post receipts.
    // This path never submits another Core request or starts another device run.
    await github.rest.actions.createWorkflowDispatch({...context.repo, workflow_id: WORKFLOW, ref: "dev",
      inputs: {request_id: requestId}})
    return {requestId, status: "launched"}
  }))
  const errors = settled.flatMap((result, index) => result.status === "rejected" ? [new Error(`${requestIds[index]}: ${result.reason.message}`, {cause: result.reason})] : [])
  if (errors.length) throw new AggregateError(errors, `Routine result fanout failed: ${errors.map(error => error.message).join("; ")}`)
  return settled.map(result => result.value)
}

/** Match a frozen Core build to a retained editable Slack post for that exact platform archive. */
export async function resolveRoutineNotifications({github, context, details, read = readActionsJson}) {
  const plans = []
  for (const detail of details) {
    const row = boundRoutineResult(detail)
    if (!row || row.source.channel === "pr") continue
    const build = detail.request.input.build
    const {data: buildRun} = await github.rest.actions.getWorkflowRunAttempt({...context.repo,
      run_id: row.source.buildRunId, attempt_number: row.source.publicationAttempt})
    requireThat(buildRun.id === row.source.buildRunId && buildRun.run_attempt === row.source.publicationAttempt &&
      buildRun.path === ".github/workflows/coordinated-release.yml" && buildRun.head_sha === build.headSha &&
      buildRun.head_branch === row.source.channel && buildRun.repository?.full_name === REPOSITORY &&
      buildRun.head_repository?.full_name === REPOSITORY, "Core release source differs from its producing workflow")
    const prefix = `release-slack-message-${buildRun.id}-`
    const found = (await artifacts(github, context.repo, buildRun.id)).filter(item => item.name.startsWith(prefix))
    const messages = []
    for (const artifact of found) {
      const attempt = Number(artifact.name.slice(prefix.length))
      requireThat(positive(attempt) && artifact.name === receiptName(buildRun.id, attempt), "Invalid release message attempt")
      const candidate = (await read(github, context.repo, buildRun, artifact.name, ["slack-release-message.json"]))["slack-release-message.json"]
      if (candidate.schemaVersion === 1) {
        // Cutover: old posts are not writable by this result contract. Leave them unchanged without blocking current posts.
        console.warn(`Release post ${artifact.name} predates the current result contract; use Admin for its results.`)
        continue
      }
      if (candidate.build === null) continue
      const message = assertNotification(candidate)
      requireThat(message.producer.runAttempt === attempt && message.build.runId === row.source.buildRunId &&
        message.build.channel === row.source.channel && message.build.headSha === build.headSha &&
        message.build.release === build.releaseIdentity, "Release post belongs to another tested build")
      if (!message.build.artifacts[row.platform]) continue
      requireThat(message.build.artifacts[row.platform] === build.archive.sha256, "Release post archive differs from the tested platform archive")
      messages.push(message)
    }
    if (!messages.length) continue
    const notification = messages.sort((a, b) => a.producer.runAttempt - b.producer.runAttempt)[0]
    plans.push({notification, row, sourceCreatedAt: buildRun.created_at})
  }
  return plans
}

export async function prepareRoutineUpdate({github, context, plan, read = readActionsJson,
  runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT), write = writeFile}) {
  assertNotification(plan.notification)
  requireThat(typeof plan.sourceCreatedAt === "string" && Number.isFinite(Date.parse(plan.sourceCreatedAt)), "Missing source creation time")
  const history = [], repo = context.repo
  let total
  for (let page = 1; ; page++) {
    const {data} = await github.rest.actions.listWorkflowRuns({...repo, workflow_id: WORKFLOW,
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
      requireThat(requestIdentity(routine), "Unexpected routine update job")
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
