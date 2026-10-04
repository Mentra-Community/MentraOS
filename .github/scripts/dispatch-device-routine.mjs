import {routineApi, submitRoutineRequest, routineLabelIds, selectedCatalog, ensure, positive} from "./routine-api.mjs"
import {authenticatedPr, publicationForPlatform, platformProducer, planForDefinition} from "./request-e2e-routine.mjs"
import {COORDINATED_WORKFLOW} from "./coordinated-routine-request.mjs"

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
  const catalog = await routineApi({token, operation: "catalog", fetchImpl})
  // Validate every requested ID against the complete catalog before selecting this producer's platform.
  return selectedCatalog(catalog, ids).filter(definition => definition.platform === platform).map(definition =>
    planForDefinition(definition, {channel: "pr", prNumber: pr.number, buildRunId: run.id, publicationAttempt: publication.publicationAttempt}))
}

export async function dispatchRoutinePlan({token, plan, fetchImpl = fetch}) {
  return submitRoutineRequest({token, request: plan, fetchImpl})
}
