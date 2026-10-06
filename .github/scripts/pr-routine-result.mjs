import {boundRoutineResult, requestIdentity, ensure, positive} from "./routine-api.mjs"
const REPOSITORY = "Mentra-Community/MentraOS"
const PUBLIC = `https://github.com/${REPOSITORY}`
export const resultMarker = row => `<!-- mentra-routine-result:${row.requestId} -->`
const plain = value => String(value).replace(/[\\`*_|<>\r\n]/g, " ").trim()

/** Render the frozen request or actual lifecycle, independent of the PR's current head. */
export function renderPrRoutineResult(detail) {
  const row = boundRoutineResult(detail)
  if (!row || row.source.channel !== "pr") return null
  const {request, result} = detail, run = result?.run, build = request.input.build, report = run?.result
  ensure(build.repository === REPOSITORY && build.prNumber === row.source.prNumber && /^[a-f0-9]{40}$/.test(build.headSha), "Invalid PR build binding")
  const body = [resultMarker(row), `### ${plain(row.title)} — ${plain(row.status)}`, "",
    `Candidate PR head: [\`${build.headSha}\`](${PUBLIC}/commit/${build.headSha}). Platform: \`${row.platform}\`.`, "",
    ...(report ? ["| Check | Result |", "| --- | --- |", `| Setup | ${report.setup.status} |`, `| Customer test | ${report.test} |`,
    `| Teardown ready | ${report.teardown.ready ? "Verified" : "Not verified"} |`, `| Evidence | ${result.evidenceStatus} |`,
    `| Uploads | ${result.uploadsComplete ? "Complete" : "Incomplete"} |`, "",
    `[Recording and full result](https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(row.resultRunId)})`, ""] :
      [`Request ${row.status === "not-run" ? "was rejected" : "was cancelled"}: ${plain(row.reason)}.`, "",
        "No framework result has been published for this request.", "",
        `[Request receipt](https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(row.requestId)})`, ""]),
    `[Build ${row.source.buildRunId}/${row.source.publicationAttempt}](${PUBLIC}/actions/runs/${row.source.buildRunId}/attempts/${row.source.publicationAttempt})`, "",
    `Routine: \`${row.routineId}\`; definition revision: \`${request.input.definitionRevision}\`; request: \`${row.requestId}\`.`, "",
    report ? "This result covers the recorded candidate. Notification retries retain the same request comment." :
      "This receipt covers the requested candidate. Notification retries retain the same request comment.",
  ].join("\n")
  return {pr: build.prNumber, requestId: row.requestId, routineId: row.routineId, marker: resultMarker(row), body}
}

export function resolvePrRoutineResults({details}) {return details.map(renderPrRoutineResult).filter(Boolean)}

/** An uncertain create is retried only after finding any existing bot-owned marker. */
export async function publishPrRoutineResult({github, context, plan}) {
  ensure(["workflow_dispatch", "workflow_run"].includes(context.eventName) && context.ref === "refs/heads/dev" &&
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY && positive(plan.pr) && requestIdentity(plan.requestId) &&
    plan.marker === resultMarker(plan) && plan.body.startsWith(`${plan.marker}\n`) && plan.body.length <= 30_000, "Invalid PR result publication")
  const comments = await github.paginate(github.rest.issues.listComments, {...context.repo, issue_number: plan.pr, per_page: 100})
  const owned = comments.filter(comment => comment.user?.type === "Bot" && comment.user.login === "github-actions[bot]" &&
    comment.body?.startsWith(`${plan.marker}\n`))
  ensure(owned.length <= 1, "Duplicate result comments require reconciliation")
  if (owned[0]) {
    if (owned[0].body === plan.body) return {status: "unchanged", commentId: owned[0].id}
    await github.rest.issues.updateComment({...context.repo, comment_id: owned[0].id, body: plan.body})
    return {status: "updated", commentId: owned[0].id}
  }
  const {data} = await github.rest.issues.createComment({...context.repo, issue_number: plan.pr, body: plan.body})
  return {status: "created", commentId: data.id}
}
