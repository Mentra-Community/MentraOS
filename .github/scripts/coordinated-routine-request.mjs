import {isDeepStrictEqual} from "node:util"
import {downloadNames, validateDownloads} from "./coordinated-install-downloads.mjs"
import {deviceRoutine} from "./device-routines.mjs"
import {jsonArtifact, REQUEST_WORKFLOW, sourcePublication} from "./request-e2e-routine.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"
import {ANDROID_MAX_VERSION_CODE, androidBuildNumberOf} from "./release-family.mjs"

export const COORDINATED_WORKFLOW = ".github/workflows/coordinated-release.yml"
export const COORDINATED_FINALIZE_JOB = "Finalize immutable release bill of materials"
export const COORDINATED_PUBLISH_STEP = "Publish immutable plan, package, and manifest assets"
const REPOSITORY = "Mentra-Community/MentraOS"
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const positive = (value) => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }
const pin = ({url, sha256, size}) => ({url, sha256, size})

/** Return the actual finalizer execution, including retained jobs in a later retry. */
export async function coordinatedPublicationAttempt(github, context, run) {
  requireThat(positive(run?.id) && positive(run.run_attempt) && run.status === "completed" &&
    run.path === COORDINATED_WORKFLOW && ["dev", "staging"].includes(run.head_branch) &&
    ["push", "workflow_dispatch"].includes(run.event) && SHA.test(run.head_sha ?? "") &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
  "Invalid coordinated publication source")
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
  const finalizers = jobs.filter(job => job.name === COORDINATED_FINALIZE_JOB)
  requireThat(finalizers.every(job => positive(job.run_attempt)), "Coordinated finalizer attempt is missing")
  const effectiveAttempt = Math.max(...finalizers.filter(job => job.run_attempt <= run.run_attempt).map(job => job.run_attempt))
  const matched = finalizers.filter(job => job.run_attempt === effectiveAttempt)
  requireThat(matched.length === 1 && matched[0].status === "completed" && matched[0].conclusion === "success" &&
    matched[0].steps?.some(step => step.name === COORDINATED_PUBLISH_STEP &&
      step.status === "completed" && step.conclusion === "success"),
  "Selected coordinated attempt did not publish immutable assets; dry runs and retained artifacts are ineligible")
  const published = matched[0]
  return Math.min(effectiveAttempt, ...finalizers.filter(job => job.run_attempt <= effectiveAttempt &&
    published.started_at && published.completed_at && job.started_at === published.started_at &&
    job.completed_at === published.completed_at && job.conclusion === published.conclusion).map(job => job.run_attempt))
}

function releaseCoordinates(identity, channel) {
  const match = /^(\d+\.\d+\.\d+)-(dev|beta)\.([1-9]\d*)$/.exec(identity ?? "")
  requireThat(["dev", "staging"].includes(channel) && match && match[2] === (channel === "dev" ? "dev" : "beta"),
    "Release identity does not match its dev/staging channel")
  return {tag: `mentra-builds-v${match[1]}`, releaseChannel: match[2]}
}

/** Existing immutable publication files, read only as bounded JSON metadata. */
export async function publishedCoordinatedBuild({identity, channel, sourceCommit, platform = "ios-on-mac", fetchImpl = fetch}) {
  const {tag, releaseChannel} = releaseCoordinates(identity, channel)
  requireThat(SHA.test(sourceCommit ?? ""), "Invalid coordinated source commit")
  const plan = await jsonArtifact(artifactUrl(REPOSITORY, tag, `mentra-release-plan-${identity}.json`), fetchImpl)
  const value = plan.value
  requireThat(value.schemaVersion === 1 && value.releaseIdentity === identity && value.releaseSetId === `mentra-${identity}` &&
    value.sourceCommit === sourceCommit && value.channel === releaseChannel && value.artifactContainerTag === tag &&
    value.artifactNames?.otaManifest === `mentra-live-ota-${identity}.json` && positive(value.native?.buildNumber),
  "Published release plan differs from the selected source")
  requireThat(["ios-on-mac", "android"].includes(platform), "Unsupported app platform")
  const names = downloadNames(value)
  let receipt, app, archive
  const otaUrl = artifactUrl(REPOSITORY, tag, value.artifactNames.otaManifest)
  if (platform === "android") {
    requireThat(value.artifactNames.releaseManifest === `mentra-release-${identity}.json` &&
      value.artifactNames.androidApp === `mentraos-${identity}-android.apk` &&
      /^\d+\.\d+\.\d+$/.test(value.native.marketingVersion ?? ""), "Release plan has no Android publication")
    receipt = await jsonArtifact(artifactUrl(REPOSITORY, tag, value.artifactNames.releaseManifest), fetchImpl)
    const record = receipt.value
    // Finalization copies the plan's native identity and may add only the Android version code it built.
    const {androidBuildNumber: _, ...planNative} = record.native ?? {}
    requireThat(record.schemaVersion === 1 && record.releaseIdentity === identity && record.releaseSetId === value.releaseSetId &&
      record.sourceCommit === sourceCommit && record.channel === releaseChannel && record.releasePlanSha256 === plan.sha256 &&
      isDeepStrictEqual(planNative, value.native) && Array.isArray(record.artifacts), "Android release manifest differs from its plan")
    const versionCode = androidBuildNumberOf(value, record)
    requireThat(versionCode <= ANDROID_MAX_VERSION_CODE, "Android version code exceeds Google Play's limit")
    const assets = record.artifacts.filter(asset => asset.coordinate === value.artifactNames.androidApp)
    const url = artifactUrl(REPOSITORY, tag, value.artifactNames.androidApp)
    requireThat(assets.length === 1 && assets[0].url === url && HASH.test(assets[0].sha256 ?? "") &&
      positive(assets[0].size) && ["built", "published", "reused"].includes(assets[0].status), "Missing or ambiguous published Android APK")
    archive = {name: value.artifactNames.androidApp, url, sha256: assets[0].sha256, size: assets[0].size}
    app = {packageId: "com.mentra.mentra", version: value.native.marketingVersion, build: String(versionCode),
      headSha: sourceCommit, buildSha: sourceCommit, backend: channel, otaManifestUrl: otaUrl, releaseIdentity: identity}
  } else {
    receipt = await jsonArtifact(artifactUrl(REPOSITORY, tag, names.receipt), fetchImpl)
    validateDownloads(receipt.value, value, otaUrl)
    app = receipt.value.app
    requireThat(app.teamId === "T5XXXL6N36" && app.app === "Mentra.app" && app.buildSha === sourceCommit &&
      app.releaseIdentity === identity, "Mac app package identity differs")
    archive = {url: artifactUrl(REPOSITORY, tag, names.mac), ...receipt.value.artifacts.mac}
  }
  const available = await fetchImpl(archive.url, {method: "HEAD", redirect: "error", signal: AbortSignal.timeout(30_000)})
  requireThat(available.ok && Number(available.headers.get("content-length")) === archive.size,
    "Published app archive is missing or its size differs from the receipt")
  const ota = await jsonArtifact(otaUrl, fetchImpl)
  const asg = ota.value.apps?.["com.mentra.asg_client"]
  requireThat(ota.value.releaseVersion === identity && asg?.versionName && positive(asg.versionCode) &&
    HASH.test(asg.sha256 ?? "") && positive(asg.apkSize) && /^https:\/\//.test(asg.apkUrl ?? "") &&
    ota.value.bes_firmware?.version && ota.value.mtk_full_ota?.end_firmware,
  "OTA manifest does not identify the selected release and firmware targets")
  return {platform, releasePlan: pin(plan), receipt: pin(receipt), archive, otaManifest: pin(ota),
    app, build: {sourceCommit, releaseIdentity: identity, artifactContainerTag: tag}}
}

/** An exact successful run may be historical; it must remain in the chosen channel's ancestry. */
export async function coordinatedSourceRun(github, context, source) {
  requireThat(source?.kind === "coordinated-release" && ["dev", "staging"].includes(source.channel) &&
    positive(source.buildRunId) && positive(source.publicationAttempt), "Invalid coordinated source selection")
  const {data: run} = await github.rest.actions.getWorkflowRunAttempt({...context.repo,
    run_id: source.buildRunId, attempt_number: source.publicationAttempt})
  requireThat(run.id === source.buildRunId && run.run_attempt === source.publicationAttempt &&
    run.path === COORDINATED_WORKFLOW && run.status === "completed" &&
    ["push", "workflow_dispatch"].includes(run.event) && run.head_branch === source.channel && SHA.test(run.head_sha ?? "") &&
    run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY,
  "Selected coordinated workflow attempt does not match the completed source channel")
  // Notification or other downstream failure does not invalidate the independently
  // authenticated publication. The request workflow itself must still succeed.
  const publicationAttempt = await coordinatedPublicationAttempt(github, context, run)
  requireThat(publicationAttempt === run.run_attempt,
    "Selected coordinated attempt retains an earlier publication; select its original attempt")
  const {data: branch} = await github.rest.git.getRef({...context.repo, ref: `heads/${source.channel}`})
  requireThat(branch.ref === `refs/heads/${source.channel}` && branch.object?.type === "commit" && SHA.test(branch.object.sha ?? ""),
    "Missing authenticated release channel ref")
  const {data: ancestry} = await github.rest.repos.compareCommitsWithBasehead({...context.repo,
    basehead: `${run.head_sha}...${branch.object.sha}`})
  requireThat(["ahead", "identical"].includes(ancestry.status) && ancestry.base_commit?.sha === run.head_sha &&
    ancestry.merge_base_commit?.sha === run.head_sha, "Selected release is not an ancestor of the channel")
  return run
}

export async function resolveCoordinatedSelection({github, context, source, platform = "ios-on-mac", fetchImpl = fetch}) {
  const run = await coordinatedSourceRun(github, context, source)
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    ...context.repo, run_id: run.id, per_page: 100,
  })
  const plans = artifacts.filter(item => item.name.startsWith("coordinated-release-plan-"))
  requireThat(plans.length === 1 && !plans[0].expired && positive(plans[0].id) &&
    plans[0].workflow_run?.id === run.id && plans[0].workflow_run.head_sha === run.head_sha,
  "Producing run has no unambiguous immutable release plan")
  const identity = plans[0].name.replace(/^coordinated-release-plan-mentra-/, "")
  const selection = await publishedCoordinatedBuild({identity, channel: source.channel, sourceCommit: run.head_sha, platform, fetchImpl})
  // Reauthenticate after downloads without requiring this historical build to be the branch tip.
  const current = await coordinatedSourceRun(github, context, source)
  requireThat(current.head_sha === run.head_sha, "Producing run changed during selection")
  return {...selection, producer: {workflow: COORDINATED_WORKFLOW, runId: run.id,
    publicationAttempt: run.run_attempt, url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}`}}
}

export async function createCoordinatedRoutineRequest({github, context, number, channel, routine = "no-glasses",
  requestOrigin = "workflow-dispatch", source, sourceBuildRunId, sourcePublicationAttempt, nightlyRunId, nightlyRunAttempt, fetchImpl = fetch, now = () => new Date()}) {
  const registered = deviceRoutine(routine)
  const selected = sourcePublication(sourceBuildRunId, sourcePublicationAttempt)
  requireThat(!number && selected && ["dev", "staging"].includes(channel), "Coordinated requests require an exact run/attempt and no PR number")
  requireThat(requestOrigin === "workflow-dispatch" || (requestOrigin === "successful-build" && ["no-glasses", "no-glasses-android"].includes(routine)),
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
  const nightly = sourcePublication(nightlyRunId, nightlyRunAttempt)
  if (nightly) {
    request.sequence = {kind: "nightly-ota-call", runId: nightly.runId, runAttempt: nightly.publicationAttempt, member: routine}
    const {authenticateNightlyMarker} = await import("./nightly-device-routines.mjs")
    await authenticateNightlyMarker({github, context, request})
  }
  try {
    request.selection = await resolveCoordinatedSelection({github, context, source: request.source, platform: deviceRoutine(request.routine.id).platform, fetchImpl})
    request.status = "ready"
    request.reason = `Verified exact coordinated run, channel ancestry, immutable release plan, ${registered.platform === "android" ? "Android" : "Mac"} receipt and OTA pin`
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
      (request.routine.authorization === "successful-build" && ["no-glasses", "no-glasses-android"].includes(request.routine.id))), "Invalid coordinated request")
  const selection = await resolveCoordinatedSelection({github, context, source: request.source, platform: deviceRoutine(request.routine.id).platform, fetchImpl})
  requireThat(isDeepStrictEqual(selection, request.selection), "Ready coordinated selection differs from its published source")
  const {data: issuer} = await github.rest.git.getRef({...context.repo, ref: "heads/dev"})
  requireThat(issuer.ref === "refs/heads/dev" && issuer.object?.type === "commit" &&
    SHA.test(issuer.object.sha ?? "") && SHA.test(request.trigger.sha ?? ""), "Invalid authenticated request issuer ref")
  // The caller binds this immutable issuer SHA to the authenticated request run.
  // Later dev commits must not invalidate an otherwise unchanged queued request.
  const {data: ancestry} = await github.rest.repos.compareCommitsWithBasehead({...context.repo,
    basehead: `${request.trigger.sha}...${issuer.object.sha}`})
  requireThat(["ahead", "identical"].includes(ancestry?.status) &&
    ancestry.base_commit?.sha === request.trigger.sha && ancestry.merge_base_commit?.sha === request.trigger.sha,
  "Request issuer is not an ancestor of trusted dev")
}
