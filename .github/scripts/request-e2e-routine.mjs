import {submitRoutineRequest, routineLabelIds, routineId, routineRevision, platforms, exactSource, stableRequestId, ensure, positive} from "./routine-api.mjs"
import {ANDROID_PUBLICATION_STEP} from "./pr-android-artifacts.mjs"
import {selectedRoutinePlatforms, reportUnsupportedRoutinePlatforms} from './routine-platforms.mjs'

export const REQUEST_WORKFLOW = ".github/workflows/request-e2e-routine.yml"
export const PR_ROUTINE_BASES = Object.freeze(["dev", "staging"])
export const admittedPrBase = ref => PR_ROUTINE_BASES.includes(ref)
export const platformProducer = platform => platform === "android" ? ".github/workflows/mentra-app-android-build.yml" : ".github/workflows/mentra-app-ios-build.yml"
function firstExecution(all, job) {
  return Math.min(
    job.run_attempt,
    ...all
      .filter(
        (entry) =>
          entry.name === job.name &&
          positive(entry.run_attempt) &&
          entry.started_at &&
          entry.completed_at &&
          entry.started_at === job.started_at &&
          entry.completed_at === job.completed_at &&
          entry.conclusion === job.conclusion,
      )
      .map((entry) => entry.run_attempt),
  )
}

/** A notification retry can retain a successful publication from an earlier attempt. */
export function successfulMacPublication(run, all) {
  const latest = (name) =>
    all
      .filter((job) => job.name === name && positive(job.run_attempt) && job.run_attempt <= run.run_attempt)
      .sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id)[0]
  const build = latest("build")
  const publish = latest("publish")
  if (
    !positive(run.run_attempt) ||
    !build ||
    !publish ||
    [build, publish].some((job) => job.status !== "completed" || job.conclusion !== "success") ||
    build.run_attempt > publish.run_attempt ||
    (run.status !== "completed" && publish.run_attempt < run.run_attempt)
  )
    return null
  return {buildAttempt: firstExecution(all, build), publicationAttempt: firstExecution(all, publish)}
}

/** Android builds and publishes its signed APK in one job. Retained jobs keep their original receipt. */
export function successfulAndroidPublication(run, all) {
  const build = all.filter(job => job.name === "build" && positive(job.run_attempt) && job.run_attempt <= run.run_attempt)
    .sort((a, b) => b.run_attempt - a.run_attempt || b.id - a.id)[0]
  if (!positive(run.run_attempt) || !build || build.status !== "completed" || build.conclusion !== "success" ||
    !build.steps?.some(step => step.name === ANDROID_PUBLICATION_STEP && step.status === "completed" && step.conclusion === "success") ||
    (run.status !== "completed" && build.run_attempt < run.run_attempt)) return null
  const attempt = firstExecution(all, build)
  return {buildAttempt: attempt, publicationAttempt: attempt}
}


export async function authenticatedPr(github, context, number) {
  ensure(positive(number), "A PR number is required")
  const {data: pr} = await github.rest.pulls.get({...context.repo, pull_number: number})
  ensure(pr.number === number && pr.state === "open" && admittedPrBase(pr.base?.ref) &&
    pr.head?.repo?.full_name === "Mentra-Community/MentraOS" && /^[a-f0-9]{40}$/.test(pr.head.sha ?? ""),
    "PR routine requests require an open same-repository PR targeting dev or staging")
  return pr
}

export async function publicationForPlatform(github, context, run, platform) {
  ensure(run?.path === platformProducer(platform) && positive(run.id) && positive(run.run_attempt) &&
    run.event === "pull_request" && run.repository?.full_name === "Mentra-Community/MentraOS" &&
    run.head_repository?.full_name === "Mentra-Community/MentraOS", "Invalid app publication source")
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {...context.repo, run_id: run.id, filter: "all", per_page: 100})
  ensure(jobs.length < 1000 && new Set(jobs.map(job => job.id)).size === jobs.length, "App publication job history is incomplete")
  return platform === "android" ? successfulAndroidPublication(run, jobs) : successfulMacPublication(run, jobs)
}

async function currentPrSource(github, context, pr, platform) {
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {...context.repo,
    workflow_id: platformProducer(platform), head_sha: pr.head.sha, event: "pull_request", per_page: 100})
  ensure(runs.length < 1000 && new Set(runs.map(run => run.id)).size === runs.length, "PR publication history is incomplete")
  const run = runs.filter(run => run.head_sha === pr.head.sha && run.head_branch === pr.head.ref &&
    run.head_repository?.full_name === pr.head.repo.full_name).sort((a, b) => b.id - a.id)[0]
  if (!run) return null
  const publication = await publicationForPlatform(github, context, run, platform)
  return publication ? exactSource({channel: "pr", prNumber: pr.number, buildRunId: run.id, publicationAttempt: publication.publicationAttempt}) : null
}

export function planRoutineRequest(selection, source, {occurrenceId, routineRevision: revision} = {}) {
  const selected = exactSource(source)
  return {routineId: selection.routineId, platform: selection.platform, source: selected,
    ...(revision === undefined ? {} : {routineRevision: revision}),
    requestId: stableRequestId({occurrenceId: occurrenceId ?? `source-${selected.channel}-${selected.buildRunId}-${selected.publicationAttempt}`,
      routineId: selection.routineId, platform: selection.platform, source: selected, routineRevision: revision})}
}

/** Labels request IDs directly. The host checks exact source and platform support before grants. */
export async function createRoutineRequests({github, context, token, routine, platform, source, number, routineRevision: revision, fetchImpl = fetch}) {
  ensure(`${context.repo.owner}/${context.repo.repo}` === "Mentra-Community/MentraOS", "Unsupported request repository")
  const explicit = context.eventName === "workflow_dispatch"
  ensure(explicit ? context.ref === "refs/heads/dev" : context.eventName === "pull_request_target", "Requests require trusted workflow metadata")
  ensure(revision === undefined || routineRevision(revision), "Routine revision override must be an exact commit")
  const requests = [], requestIds = [], pending = [], outcomes = []
  const dispatch = async (selection, selected) => {
    const plan = planRoutineRequest(selection, selected, {routineRevision: selection.routineRevision ?? revision,
      ...(explicit ? {occurrenceId: `manual-${context.runId}`} : {})})
    const {request, ...outcome} = await submitRoutineRequest({token, request: plan, fetchImpl})
    if (request) requests.push(request)
    if (outcome.status === "accepted" || outcome.status === "uncertain") requestIds.push(plan.requestId)
    outcomes.push(outcome)
  }
  if (explicit) {
    ensure(positive(context.runId) && routineId(routine) && platforms.includes(platform), "An explicit request requires a routine ID, platform and workflow run")
    const selected = exactSource(source)
    if (selected.channel === "pr") await authenticatedPr(github, context, selected.prNumber)
    await dispatch({routineId: routine, platform}, selected)
    return {requests, requestIds, pending, outcomes}
  }
  const pr = await authenticatedPr(github, context, number)
  const ids = routineLabelIds(pr)
  if (!ids.length) return {requests, requestIds, pending, outcomes}
  ensure(ids.every(routineId), "Invalid routine label")
  const selections = ids.flatMap(routineId => platforms.map(platform => ({routineId, platform}))), sources = new Map(), unsupported = []
  let descriptions
  try {descriptions = await selectedRoutinePlatforms({token, routineIds: ids, revision, fetchImpl})}
  catch (error) {return {requests, requestIds, pending, outcomes: selections.map(selection => ({...selection, status: 'failed',
    reason: 'Exact routine platform description is unavailable', retryable: error.retryable === true}))}}
  for (const selection of selections) {
    try {
      const description = descriptions.find(row => row.routineId === selection.routineId)
      if (description.platforms && !description.platforms.includes(selection.platform)) {
        const row = {...description, platform: selection.platform}
        unsupported.push(row)
        outcomes.push({...selection, routineRevision: row.routineRevision, status: 'skipped', reason: 'Exact routine source does not support this platform'})
        continue
      }
      if (!sources.has(selection.platform)) sources.set(selection.platform, currentPrSource(github, context, pr, selection.platform))
      const selected = await sources.get(selection.platform)
      if (!selected) {
        const reason = "Current PR app publication is pending"
        pending.push({...selection, reason})
        outcomes.push({...selection, status: "pending", reason})
        continue
      }
      await dispatch({...selection, routineRevision: description.routineRevision}, selected)
    } catch (error) {
      outcomes.push({...selection, status: "failed",
        reason: "Current PR app publication could not be authenticated", retryable: error.retryable === true})
    }
  }
  let notificationError
  try {await reportUnsupportedRoutinePlatforms({github, context, pr, rows: unsupported})}
  catch {notificationError = 'Unsupported routine/platform comment could not be published; retained admission outcomes are unchanged'}
  return {requests, requestIds, pending, outcomes, ...(notificationError ? {notificationError} : {})}
}

/** Call only after accepted/uncertain selectors and all member outcomes have been retained. */
export function assertRoutineRequestOutcomes(outcomes) {
  const failures = outcomes.filter(outcome => outcome.status === "failed" || outcome.status === "uncertain")
  if (failures.length) throw new AggregateError(failures.map(outcome => new Error(`${outcome.routineId}/${outcome.platform}: ${outcome.reason}`)),
    `Routine request admission failed for ${failures.length} member(s): ${failures.map(outcome => `${outcome.routineId}/${outcome.platform}: ${outcome.reason}`).join("; ")}`)
}
