import {isDeepStrictEqual} from "node:util"
import {downloadNames, validateDownloads} from "./coordinated-install-downloads.mjs"
import {deviceRoutine} from "./device-routines.mjs"
import {jsonArtifact, REQUEST_WORKFLOW, sourcePublication} from "./request-e2e-routine.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"

export const COORDINATED_WORKFLOW = ".github/workflows/coordinated-release.yml"
export const COORDINATED_FINALIZE_JOB = "Finalize immutable release bill of materials"
export const COORDINATED_PUBLISH_STEP = "Publish immutable plan, package, and manifest assets"
const REPOSITORY = "Mentra-Community/MentraOS"
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const positive = (value) => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }
const pin = ({url, sha256, size}) => ({url, sha256, size})

/** Artifacts belong to a run, so authenticate the actual publication attempt separately. */
async function requirePublishedAttempt(github, context, run) {
  const jobs = []
  let expected
  for (let page = 1; ; page++) {
    const {data} = await github.rest.actions.listJobsForWorkflowRun({...context.repo,
      run_id: run.id, filter: "all", per_page: 100, page})
    requireThat(Number.isSafeInteger(data?.total_count) && data.total_count >= 1 && data.total_count < 1000 &&
      Array.isArray(data.jobs), "Coordinated publication job history is incomplete")
    expected ??= data.total_count
    requireThat(data.total_count === expected, "Coordinated publication job history changed")
    jobs.push(...data.jobs)
    if (jobs.length >= expected) break
    requireThat(data.jobs.length === 100, "Coordinated publication job history is incomplete")
  }
  requireThat(jobs.length === expected && jobs.every(job => positive(job?.id)) &&
    new Set(jobs.map(job => job.id)).size === expected, "Coordinated publication job history is incomplete")
  const matched = jobs.filter(job => job.name === COORDINATED_FINALIZE_JOB && job.run_attempt === run.run_attempt)
  requireThat(matched.length === 1 && matched[0].status === "completed" && matched[0].conclusion === "success" &&
    matched[0].steps?.some(step => step.name === COORDINATED_PUBLISH_STEP &&
      step.status === "completed" && step.conclusion === "success"),
  "Selected coordinated attempt did not publish immutable assets; dry runs and retained artifacts are ineligible")
}

function releaseCoordinates(identity, channel) {
  const match = /^(\d+\.\d+\.\d+)-(dev|beta)\.([1-9]\d*)$/.exec(identity ?? "")
  requireThat(["dev", "staging"].includes(channel) && match && match[2] === (channel === "dev" ? "dev" : "beta"),
    "Release identity does not match its dev/staging channel")
  return {tag: `mentra-builds-v${match[1]}`, releaseChannel: match[2]}
}

/** Existing immutable publication files, read only as bounded JSON metadata. */
export async function publishedCoordinatedBuild({identity, channel, sourceCommit, fetchImpl = fetch}) {
  const {tag, releaseChannel} = releaseCoordinates(identity, channel)
  requireThat(SHA.test(sourceCommit ?? ""), "Invalid coordinated source commit")
  const plan = await jsonArtifact(artifactUrl(REPOSITORY, tag, `mentra-release-plan-${identity}.json`), fetchImpl)
  const value = plan.value
  requireThat(value.schemaVersion === 1 && value.releaseIdentity === identity && value.releaseSetId === `mentra-${identity}` &&
    value.sourceCommit === sourceCommit && value.channel === releaseChannel && value.artifactContainerTag === tag &&
    value.artifactNames?.otaManifest === `mentra-live-ota-${identity}.json` && positive(value.native?.buildNumber),
  "Published release plan differs from the selected source")
  const names = downloadNames(value)
  const receipt = await jsonArtifact(artifactUrl(REPOSITORY, tag, names.receipt), fetchImpl)
  const otaUrl = artifactUrl(REPOSITORY, tag, value.artifactNames.otaManifest)
  validateDownloads(receipt.value, value, otaUrl)
  const app = receipt.value.app
  requireThat(app.teamId === "T5XXXL6N36" && app.app === "Mentra.app" && app.buildSha === sourceCommit &&
    app.releaseIdentity === identity, "Mac app package identity differs")
  const archive = {url: artifactUrl(REPOSITORY, tag, names.mac), ...receipt.value.artifacts.mac}
  const available = await fetchImpl(archive.url, {method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30_000)})
  requireThat(available.ok && Number(available.headers.get("content-length")) === archive.size,
    "Published Mac archive is missing or its size differs from the receipt")
  const ota = await jsonArtifact(otaUrl, fetchImpl)
  const asg = ota.value.apps?.["com.mentra.asg_client"]
  requireThat(ota.value.releaseVersion === identity && asg?.versionName && positive(asg.versionCode) &&
    HASH.test(asg.sha256 ?? "") && positive(asg.apkSize) && /^https:\/\//.test(asg.apkUrl ?? "") &&
    ota.value.bes_firmware?.version && ota.value.mtk_full_ota?.end_firmware,
  "OTA manifest does not identify the selected release and firmware targets")
  return {platform: "ios-on-mac", releasePlan: pin(plan), receipt: pin(receipt), archive, otaManifest: pin(ota),
    app, build: {sourceCommit, releaseIdentity: identity, artifactContainerTag: tag}}
}

/** An exact successful run may be historical; it must remain in the chosen channel's ancestry. */
export async function coordinatedSourceRun(github, context, source) {
  requireThat(source?.kind === "coordinated-release" && ["dev", "staging"].includes(source.channel) &&
    positive(source.buildRunId) && positive(source.publicationAttempt), "Invalid coordinated source selection")
  const {data: run} = await github.rest.actions.getWorkflowRunAttempt({...context.repo,
    run_id: source.buildRunId, attempt_number: source.publicationAttempt})
  requireThat(run.id === source.buildRunId && run.run_attempt === source.publicationAttempt &&
    run.path === COORDINATED_WORKFLOW && run.status === "completed" && run.conclusion === "success" &&
    ["push", "workflow_dispatch"].includes(run.event) && run.head_branch === source.channel && SHA.test(run.head_sha ?? "") &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
  "Selected coordinated workflow attempt did not successfully publish this channel")
  await requirePublishedAttempt(github, context, run)
  const {data: branch} = await github.rest.git.getRef({...context.repo, ref: `heads/${source.channel}`})
  requireThat(branch.ref === `refs/heads/${source.channel}` && branch.object?.type === "commit" && SHA.test(branch.object.sha ?? ""),
    "Missing authenticated release channel ref")
  const {data: ancestry} = await github.rest.repos.compareCommitsWithBasehead({...context.repo,
    basehead: `${run.head_sha}...${branch.object.sha}`})
  requireThat(["ahead", "identical"].includes(ancestry.status) && ancestry.base_commit?.sha === run.head_sha &&
    ancestry.merge_base_commit?.sha === run.head_sha, "Selected release is not an ancestor of the channel")
  return run
}

export async function resolveCoordinatedSelection({github, context, source, fetchImpl = fetch}) {
  const run = await coordinatedSourceRun(github, context, source)
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo, run_id: run.id, per_page: 100,
  })
  const plans = artifacts.filter(item => item.name.startsWith("coordinated-release-plan-"))
  requireThat(plans.length === 1 && !plans[0].expired && positive(plans[0].id) &&
    plans[0].workflow_run?.id === run.id && plans[0].workflow_run.head_sha === run.head_sha,
  "Producing run has no unambiguous immutable release plan")
  const identity = plans[0].name.replace(/^coordinated-release-plan-mentra-/, "")
  const selection = await publishedCoordinatedBuild({identity, channel: source.channel, sourceCommit: run.head_sha, fetchImpl})
  // Reauthenticate after downloads without requiring this historical build to be the branch tip.
  const current = await coordinatedSourceRun(github, context, source)
  requireThat(current.head_sha === run.head_sha, "Producing run changed during selection")
  return {...selection, producer: {workflow: COORDINATED_WORKFLOW, runId: run.id,
    publicationAttempt: run.run_attempt, url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}`}}
}

export async function createCoordinatedRoutineRequest({github, context, number, channel, routine = "no-glasses",
  requestOrigin = "workflow-dispatch", source, sourceBuildRunId, sourcePublicationAttempt, fetchImpl = fetch, now = () => new Date()}) {
  deviceRoutine(routine)
  const selected = sourcePublication(sourceBuildRunId, sourcePublicationAttempt)
  requireThat(!number && selected && ["dev", "staging"].includes(channel), "Coordinated requests require an exact run/attempt and no PR number")
  requireThat(requestOrigin === "workflow-dispatch" || (requestOrigin === "successful-build" && routine === "no-glasses"),
    "Unsupported coordinated routine authorization")
  requireThat(`${context.repo.owner}/${context.repo.repo}` === REPOSITORY && context.eventName === "workflow_dispatch" &&
    positive(context.runId) && positive(source?.runAttempt) && source.ref === "refs/heads/dev" && SHA.test(source.sha ?? "") &&
    source.workflowSha === source.sha && source.workflowRef === `${REPOSITORY}/${REQUEST_WORKFLOW}@refs/heads/dev`,
  "Coordinated requests require the trusted dev workflow")
  const request = {schemaVersion: 2, kind: "mentra-routine-request",
    requestId: `routine-${context.runId}-${source.runAttempt}-${channel}-${routine}`, createdAt: now().toISOString(),
    status: "no-artifact", reason: "Selected coordinated publication is unavailable",
    trigger: {kind: context.eventName, repository: REPOSITORY, workflow: REQUEST_WORKFLOW, runId: context.runId, ...source},
    source: {kind: "coordinated-release", channel, buildRunId: selected.runId, publicationAttempt: selected.publicationAttempt},
    routine: {id: routine, authorization: requestOrigin, reason: requestOrigin === "successful-build"
      ? "Automatic no-glasses test after successful coordinated publication" : "Explicit workflow_dispatch opt-in", harnessRevision: source.sha},
    selection: null, attempts: []}
  try {
    request.selection = await resolveCoordinatedSelection({github, context, source: request.source, fetchImpl})
    request.status = "ready"
    request.reason = "Verified exact coordinated run, channel ancestry, immutable release plan, Mac receipt and OTA pin"
  } catch (error) {
    request.reason = error instanceof Error ? error.message : "Coordinated publication could not be verified"
  }
  request.attempts.push({runId: selected.runId, reason: request.reason})
  return request
}

export async function verifyCoordinatedReadyRequest({github, context, request, fetchImpl = fetch}) {
  requireThat(request.schemaVersion === 2 && request.source?.kind === "coordinated-release" && !request.pullRequest &&
    request.requestId === `routine-${request.trigger.runId}-${request.trigger.runAttempt}-${request.source.channel}-${request.routine.id}` &&
    (request.routine.authorization === "workflow-dispatch" ||
      (request.routine.authorization === "successful-build" && request.routine.id === "no-glasses")), "Invalid coordinated request")
  const selection = await resolveCoordinatedSelection({github, context, source: request.source, fetchImpl})
  requireThat(isDeepStrictEqual(selection, request.selection), "Ready coordinated selection differs from its published source")
  const {data: issuer} = await github.rest.git.getRef({...context.repo, ref: "heads/dev"})
  requireThat(issuer.ref === "refs/heads/dev" && issuer.object?.sha === request.trigger.sha,
    "Request issuer is no longer the trusted dev revision")
}
