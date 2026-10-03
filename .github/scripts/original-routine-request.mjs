import {isDeepStrictEqual} from "node:util"
import {deviceRoutine} from "./device-routines.mjs"
import {readActionsJson} from "./release-routine-slack.mjs"
import {admittedPrBase, REQUEST_WORKFLOW, verifyPublishedPrBuild} from "./request-e2e-routine.mjs"

// Exact replay of an original PR request after its PR head/base moved, or it closed or merged.
// The replay names only the original request run. Its PR identity and build selection come
// from that request's immutable artifact, re-verified against the published build; never from
// the caller, the current PR or its current base.
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const positive = (value) => Number.isSafeInteger(value) && value > 0
function requireThat(value, message) {
  if (!value) throw new Error(message)
}

export function originalRequestRun(value) {
  if (value === undefined || value === "") return null
  requireThat(typeof value === "string" && /^[1-9]\d*$/.test(value) && positive(Number(value)),
    "Original request run ID must be a positive safe integer")
  return Number(value)
}

/** The original request generation, issued by the trusted dev workflow, from its authenticated artifact. */
export async function readOriginalRequest({github, context, requestRunId, routine, number, readZip}) {
  const repository = `${context.repo.owner}/${context.repo.repo}`
  requireThat(positive(requestRunId) && positive(number), "Invalid original request selectors")
  const {data: run} = await github.rest.actions.getWorkflowRunAttempt({...context.repo, run_id: requestRunId, attempt_number: 1})
  requireThat(run.id === requestRunId && run.run_attempt === 1 && run.path === REQUEST_WORKFLOW &&
    run.event === "workflow_dispatch" && run.head_branch === "dev" && run.status === "completed" && run.conclusion === "success" &&
    SHA.test(run.head_sha ?? "") && run.repository?.full_name === repository && run.head_repository?.full_name === repository,
  "The original request is not a completed request from the trusted dev workflow")
  const name = `mentra-routine-request-${run.id}-1`
  const listed = (await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {...context.repo, run_id: run.id, per_page: 100}))
    .filter(item => item.name === name)
  requireThat(listed.length === 1 && /^sha256:[a-f0-9]{64}$/.test(listed[0].digest ?? ""), "The original request artifact is missing or ambiguous")
  // Verifies the same artifact's digest, binding and bounded JSON contents.
  const request = (await readActionsJson(github, context.repo, run, name, ["request.json"], {readZip}))["request.json"]
  const pr = request?.pullRequest, selection = request?.selection
  requireThat(request?.schemaVersion === 1 && request.kind === "mentra-routine-request" && request.status === "ready" &&
    request.original === undefined && request.requestId === `routine-${run.id}-1-${number}-${routine}` &&
    request.trigger?.kind === "workflow_dispatch" && request.trigger.repository === repository &&
    request.trigger.workflow === REQUEST_WORKFLOW && request.trigger.runId === run.id && request.trigger.runAttempt === 1 &&
    request.trigger.ref === "refs/heads/dev" && request.trigger.sha === run.head_sha && request.routine?.id === routine &&
    pr?.number === number && pr.headRepository === repository && admittedPrBase(pr.baseRef) &&
    SHA.test(pr.headSha ?? "") && SHA.test(pr.baseSha ?? "") &&
    selection?.platform === deviceRoutine(routine).platform &&
    selection.build?.headSha === pr.headSha && selection.build.baseSha === pr.baseSha,
  "The original request is not a ready trusted PR request for this routine")
  return {run, request, artifactDigest: listed[0].digest.slice("sha256:".length)}
}

/** Re-verify the original's exact published build for its own PR identity; the result must be identical. */
export async function verifyOriginalSelection({github, context, routine, original, fetchImpl}) {
  const repository = `${context.repo.owner}/${context.repo.repo}`
  const pr = original.pullRequest, producer = original.selection.producer
  requireThat(positive(producer?.runId) && positive(producer.publicationAttempt), "Original producer is invalid")
  const {data: run} = await github.rest.actions.getWorkflowRunAttempt({...context.repo,
    run_id: producer.runId, attempt_number: producer.publicationAttempt})
  requireThat(run.id === producer.runId && run.run_attempt === producer.publicationAttempt && run.status === "completed" &&
    run.event === "pull_request" && run.head_sha === pr.headSha && run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository, "The original producer run differs from the recorded selection")
  const verified = await verifyPublishedPrBuild({github, context, routine, run, fetchImpl,
    pr: {number: pr.number, headSha: pr.headSha, baseSha: pr.baseSha, baseRef: pr.baseRef},
    publicationAttempt: producer.publicationAttempt})
  requireThat(verified.selection && isDeepStrictEqual(verified.selection, original.selection),
    verified.skip ?? "The original published build changed; no substitute was selected")
  return verified.selection
}

/** A new trusted dev request that replays exactly the original's PR identity and build. */
export async function createOriginalReplayRequest({github, context, number, routine, source, requestRunId, fetchImpl, now, readZip}) {
  const repository = `${context.repo.owner}/${context.repo.repo}`
  const original = await readOriginalRequest({github, context, requestRunId, routine, number, readZip})
  const request = {
    schemaVersion: 1,
    kind: "mentra-routine-request",
    requestId: `routine-${context.runId}-${source.runAttempt}-${number}-${routine}`,
    createdAt: now().toISOString(),
    status: "no-artifact",
    reason: "The original published build could not be re-verified",
    trigger: {kind: context.eventName, repository, workflow: REQUEST_WORKFLOW, runId: context.runId, ...source},
    pullRequest: structuredClone(original.request.pullRequest),
    routine: {id: routine, authorization: "workflow-dispatch",
      reason: `Explicit workflow_dispatch replay of original request ${original.request.requestId}`, harnessRevision: source.sha},
    selection: null,
    attempts: [],
    original: {requestId: original.request.requestId, runId: original.run.id, runAttempt: 1, artifactDigest: original.artifactDigest},
  }
  const candidate = {runId: original.request.selection.producer.runId, reason: request.reason}
  request.attempts.push(candidate)
  try {
    request.selection = await verifyOriginalSelection({github, context, routine, original: original.request, fetchImpl})
    request.status = "ready"
    candidate.reason = request.reason = "Exact original PR build re-verified from its original request; hardware qualification has not run"
  } catch (error) {
    candidate.reason = request.reason = error instanceof Error ? error.message : String(error)
  }
  return request
}

/** Dispatch gate for a replay: re-read the same original request and require the identical PR identity and build. */
export async function verifyOriginalReplay({github, context, request, fetchImpl, readZip}) {
  const marker = request.original
  requireThat(marker && request.routine?.authorization === "workflow-dispatch" && marker.runAttempt === 1 &&
    positive(marker.runId) && HASH.test(marker.artifactDigest ?? ""), "Invalid original replay marker")
  const original = await readOriginalRequest({github, context, requestRunId: marker.runId, routine: request.routine.id,
    number: request.pullRequest?.number, readZip})
  requireThat(marker.requestId === original.request.requestId && marker.artifactDigest === original.artifactDigest &&
    isDeepStrictEqual(request.pullRequest, original.request.pullRequest) &&
    isDeepStrictEqual(request.selection, original.request.selection), "Replay differs from its original request")
  await verifyOriginalSelection({github, context, routine: request.routine.id, original: original.request, fetchImpl})
}
