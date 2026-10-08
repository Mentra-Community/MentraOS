import {submitRoutineRequest, routineLabelIds, routineId, ensure, positive, automaticRoutineRequest} from "./routine-api.mjs"
import {authenticatedPr, publicationForPlatform, platformProducer} from "./request-e2e-routine.mjs"
import {COORDINATED_WORKFLOW} from "./coordinated-routine-request.mjs"
import {selectedRoutinePlatforms, reportUnsupportedRoutinePlatforms, retainedAutomaticPlan} from './routine-platforms.mjs'

/** Reauthenticate the completed public producer; application archives are resolved by Core. */
export async function planDeviceDispatches({github, context, token, fetchImpl = fetch}) {
  const candidate = context.payload.workflow_run
  ensure(context.eventName === "workflow_run" && positive(candidate?.id) && positive(candidate.run_attempt) &&
    `${context.repo.owner}/${context.repo.repo}` === "Mentra-Community/MentraOS", "Invalid public producer callback")
  const {data: run} = await github.rest.actions.getWorkflowRunAttempt({...context.repo, run_id: candidate.id, attempt_number: candidate.run_attempt})
  ensure(run.id === candidate.id && run.run_attempt === candidate.run_attempt && run.status === "completed" &&
    run.repository?.full_name === "Mentra-Community/MentraOS" && run.head_repository?.full_name === "Mentra-Community/MentraOS",
    "Completed producer differs from its callback")
  // Coordinated publication itself requests no coverage. Explicit exact-source requests and enabled nightlies use Core.
  if (run.path === COORDINATED_WORKFLOW) return []
  if (run.event !== "pull_request") return []
  const platform = ["android", "ios-on-mac"].find(value => run.path === platformProducer(value))
  ensure(platform, "Callback is not an app publication workflow")
  const publication = await publicationForPlatform(github, context, run, platform)
  if (!publication) return []
  const matching = (run.pull_requests ?? []).filter(pr => pr.head?.sha === run.head_sha || pr.head?.ref === run.head_branch)
  if (!matching.length) return []
  const numbers = [...new Set(matching.map(pr => pr.number))]
  ensure(numbers.length === 1 && positive(numbers[0]), "App publication has ambiguous PR metadata")
  const pr = await authenticatedPr(github, context, numbers[0])
  if (pr.head.sha !== run.head_sha || pr.head.ref !== run.head_branch) return []
  const ids = routineLabelIds(pr)
  if (!ids.length) return []
  ensure(ids.every(routineId), "Invalid routine label")
  const source = {channel: 'pr', prNumber: pr.number, buildRunId: run.id, publicationAttempt: publication.publicationAttempt}
  const retainedPlans = await Promise.all(ids.map(routineId => retainedAutomaticPlan({token, selection: {routineId, platform}, source, fetchImpl})))
  const newIds = ids.filter((_, index) => !retainedPlans[index])
  const descriptions = newIds.length ? await selectedRoutinePlatforms({token, routineIds: newIds, fetchImpl}) : []
  const plans = [], unsupported = []
  for (const [index, routineId] of ids.entries()) {
    const retained = retainedPlans[index]
    if (retained) {plans.push(retained); continue}
    const row = descriptions.find(row => row.routineId === routineId)
    if (row.platforms && !row.platforms.includes(platform)) unsupported.push({...row, platform})
    else plans.push(automaticRoutineRequest({routineId, platform}, source, row.routineRevision))
  }
  try {await reportUnsupportedRoutinePlatforms({github, context, pr, rows: unsupported})}
  catch {console.warn('Unsupported routine/platform comment could not be published; compatible plans are unchanged')}
  return plans
}

export async function dispatchRoutinePlan({token, plan, fetchImpl = fetch}) {
  return submitRoutineRequest({token, request: plan, fetchImpl, automatic: true})
}
