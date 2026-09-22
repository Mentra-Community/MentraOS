import {readFile} from "node:fs/promises"
import {successfulMacPublication} from "./request-e2e-routine.mjs"

const REPOSITORY = "Mentra-Community/MentraOS"
const PRIVATE_REPOSITORY = "Mentra-Automated-Testing"
const REQUEST_WORKFLOW = ".github/workflows/request-e2e-routine.yml"
const BUILD_WORKFLOW = ".github/workflows/mentra-app-ios-build.yml"
const SHA = /^[a-f0-9]{40}$/
const positive = (value) => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }

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

async function currentOptIn(github, context, number, headSha) {
  if (!positive(number)) return null
  const {data: pr} = await github.rest.pulls.get({...context.repo, pull_number: number})
  return pr.number === number && pr.state === "open" && pr.base?.ref === "dev" &&
    pr.head?.repo?.full_name === REPOSITORY && pr.head.sha === headSha &&
    pr.labels?.some((label) => label.name === "routine:day1-ota") ? pr : null
}

/** Runs only from the trusted default-branch workflow; reads PR metadata, never PR code. */
export async function planDeviceDispatch({github, context}) {
  const run = await completedRun(github, context)
  if (!run) return {mode: "skip", reason: "Workflow has not completed"}
  if (run.path === BUILD_WORKFLOW && run.event === "pull_request") {
    // A Slack notification failure does not invalidate an already published app.
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo, run_id: run.id, filter: "all", per_page: 100,
    })
    if (!successfulMacPublication(run, jobs)) return {mode: "skip", reason: "Build/publication has not succeeded"}
    const numbers = [...new Set((run.pull_requests ?? []).map((pr) => pr.number))]
    if (numbers.length !== 1) return {mode: "skip", reason: "Build has no unambiguous PR association"}
    const pr = await currentOptIn(github, context, numbers[0], run.head_sha)
    if (!pr) return {mode: "skip", reason: "PR opt-in was removed or the build was superseded"}
    return {mode: "request", pr: pr.number}
  }
  // Automatic dispatch accepts only the trusted dev request producer. Bootstrap
  // PR workflow artifacts remain available for explicitly enrolled local tests.
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

export async function requestAfterPublication({github, context, plan}) {
  requireThat(plan.mode === "request" && positive(plan.pr), "Invalid request dispatch")
  await github.rest.actions.createWorkflowDispatch({...context.repo,
    workflow_id: REQUEST_WORKFLOW, ref: "dev", inputs: {pr: String(plan.pr), routine: "day1-ota"}})
  return {status: "request-dispatched", pr: plan.pr}
}

/** Read the downloaded JSON as data. The private worker independently authenticates it again. */
export async function dispatchReadyRequest({github, privateGithub, context, plan, bytes}) {
  requireThat(plan.mode === "dispatch" && positive(plan.runId) && positive(plan.runAttempt) &&
    SHA.test(plan.sourceSha ?? ""), "Invalid private dispatch plan")
  requireThat(bytes.byteLength <= 1024 * 1024, "Request exceeds 1 MiB")
  const request = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))
  const trigger = request.trigger
  requireThat(request.schemaVersion === 1 && request.kind === "mentra-routine-request" &&
    trigger?.kind === "workflow_dispatch" && trigger.repository === REPOSITORY &&
    trigger.workflow === REQUEST_WORKFLOW && trigger.runId === plan.runId && trigger.runAttempt === plan.runAttempt &&
    trigger.ref === "refs/heads/dev" && trigger.sha === plan.sourceSha && trigger.workflowSha === plan.sourceSha &&
    trigger.workflowRef === `${REPOSITORY}/${REQUEST_WORKFLOW}@refs/heads/dev` &&
    request.routine?.id === "day1-ota" && request.routine.harnessRevision === plan.sourceSha &&
    positive(request.pullRequest?.number) &&
    request.requestId === `routine-${plan.runId}-${plan.runAttempt}-${request.pullRequest.number}-day1-ota`,
  "Request does not match its trusted producer")
  if (request.status === "no-artifact") return {status: "not-dispatched", reason: "No eligible artifact"}
  requireThat(request.status === "ready" && request.selection?.platform === "ios-on-mac" &&
    request.selection.build?.headSha === request.pullRequest.headSha &&
    request.selection.build?.baseSha === request.pullRequest.baseSha, "Invalid ready selection")
  const pr = await currentOptIn(github, context, request.pullRequest.number, request.pullRequest.headSha)
  const {data: base} = await github.rest.git.getRef({...context.repo, ref: "heads/dev"})
  if (!pr || base.object?.sha !== request.pullRequest.baseSha)
    return {status: "not-dispatched", reason: "Request was superseded or PR opt-in was removed"}
  requireThat(privateGithub, "Configure E2E_PRIVATE_DISPATCH_TOKEN with Actions write on the private test repo")
  await privateGithub.rest.actions.createWorkflowDispatch({owner: context.repo.owner, repo: PRIVATE_REPOSITORY,
    workflow_id: "device-routine.yml", ref: "main", inputs: {
      source_repository: REPOSITORY, request_run_id: String(plan.runId), request_attempt: String(plan.runAttempt),
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
