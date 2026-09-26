import {deviceRoutine} from "./device-routines.mjs"
import {admittedPrBase, routineProducer} from "./request-e2e-routine.mjs"
import {resolveRoutineResults} from "./release-routine-slack.mjs"
import {hash, positive, REPOSITORY, requireThat, sha} from "./release-slack-message.mjs"

const PUBLIC = `https://github.com/${REPOSITORY}`
const PRIVATE = "https://github.com/Mentra-Community/Mentra-Automated-Testing"
const outcomeNames = {passed: "Passed", failed: "Failed", "not-run": "Not run", cancelled: "Cancelled", unknown: "Unknown"}
const statusNames = {passed: "Passed", failed: "Failed", blocked: "Blocked", aborted: "Aborted", "upload-incomplete": "Upload incomplete"}
const attemptUrl = (repository, runId, attempt) => `${repository}/actions/runs/${runId}/attempts/${attempt}`
export const resultMarker = row => `<!-- mentra-routine-result:${row.privateRunId}:${row.privateAttempt}:${row.routineId} -->`

function assertPrRequest(request) {
  const pr = request.pullRequest, selection = request.selection, trigger = request.trigger
  const routine = deviceRoutine(request.routine.id)
  requireThat(request.kind === "mentra-routine-request" && request.schemaVersion === 1 &&
    trigger.kind === "workflow_dispatch" && trigger.ref === "refs/heads/dev" &&
    trigger.workflowRef === `${REPOSITORY}/${trigger.workflow}@refs/heads/dev` &&
    request.routine.harnessRevision === trigger.workflowSha &&
    positive(pr?.number) && pr.url === `${PUBLIC}/pull/${pr.number}` && pr.headRepository === REPOSITORY && admittedPrBase(pr.baseRef) &&
    sha(pr.headSha) && sha(pr.baseSha) && request.requestId === `routine-${trigger.runId}-${trigger.runAttempt}-${pr.number}-${request.routine.id}` &&
    selection?.platform === routine.platform && selection.build?.headSha === pr.headSha && selection.build.baseSha === pr.baseSha &&
    sha(selection.build.buildSha) && selection.producer?.workflow === `.github/workflows/${routineProducer(request.routine.id)}` &&
    [selection.producer.runId, selection.producer.buildAttempt, selection.producer.publicationAttempt].every(positive) &&
    [selection.archive?.sha256, selection.receipt?.sha256, selection.otaManifest?.sha256].every(hash) &&
    /^[A-Za-z0-9._-]{1,200}$/.test(selection.archive?.name ?? ""), "PR result inputs differ from the trusted request")
}

export function renderPrRoutineResult({request, terminal, row}) {
  assertPrRequest(request)
  const {pullRequest: pr, selection} = request
  const outcome = terminal.testOutcome ?? (terminal.checks.test ? "passed" : "unknown")
  const worker = attemptUrl(PRIVATE, row.privateRunId, row.privateAttempt)
  const source = attemptUrl(PUBLIC, row.requestRunId, row.requestAttempt)
  const build = attemptUrl(PUBLIC, selection.producer.runId, selection.producer.publicationAttempt)
  const body = [resultMarker(row),
    `### ${deviceRoutine(row.routineId).name} — test ${outcomeNames[outcome].toLowerCase()}`,
    "", `**Run result: ${statusNames[row.status]}.** Candidate PR head: [\`${pr.headSha}\`](${PUBLIC}/commit/${pr.headSha}).`,
    "", "| Check | Result |", "| --- | --- |", `| Customer test | ${outcomeNames[outcome]} |`,
    ...[["Teardown", "teardown"], ["Return verification", "returnVerification"], ["Evidence verification", "evidence"],
      ["Fixture ready", "fixture"], ["Result published", "publication"], ["Claim settled", "settlement"]]
      .map(([label, key]) => `| ${label} | ${terminal.checks[key] ? "Verified" : "Not verified"} |`),
    "", row.resultRunId
      ? `[Recording and full result](https://admin.dev.mentraglass.com/?testRun=${encodeURIComponent(row.resultRunId)})`
      : "Recording/result publication is unavailable. The worker attempt retains its terminal receipt; this does not imply the test passed.",
    "", `[Request ${row.requestRunId}/${row.requestAttempt}](${source}) · [Worker ${row.privateRunId}/${row.privateAttempt}](${worker}) · [Build ${selection.producer.runId}/${selection.producer.publicationAttempt}](${build})`,
    "", "<details>", "<summary>Exact candidate and evidence identifiers</summary>", "",
    `- Platform: \`${selection.platform}\`; routine: \`${row.routineId}\`.`,
    // Dev bodies stay byte-identical so retained historical comments are not rewritten.
    `- PR base: ${pr.baseRef === "dev" ? "" : `\`${pr.baseRef}\` at `}\`${pr.baseSha}\`.`, `- Built merge: \`${selection.build.buildSha}\`.`,
    `- Archive: \`${selection.archive.name}\`, SHA256 \`${selection.archive.sha256}\`.`,
    `- Build receipt SHA256: \`${selection.receipt.sha256}\`.`,
    `- OTA manifest SHA256: \`${selection.otaManifest.sha256}\`.`,
    `- Worker revision: \`${terminal.privateRun.revision}\`.`,
    `- Terminal artifact: \`routine-terminal-${row.privateRunId}-${row.privateAttempt}\` / \`routine-terminal-${row.routineId}.json\`.`,
    "", "</details>", "", "This result covers the recorded candidate only. Each worker run/attempt keeps its own comment; notification retries reuse it.",
  ].join("\n")
  return {pr: pr.number, routineId: row.routineId, privateRunId: row.privateRunId, privateAttempt: row.privateAttempt,
    marker: resultMarker(row), body}
}

/** Historical results remain valid after the PR advances, closes or merges. */
export async function resolvePrRoutineResults(options) {
  // A cancellation before any runner has no terminal receipt to render; only release posts project it.
  return (await resolveRoutineResults(options)).filter(result => result.terminal && result.request.schemaVersion === 1).map(renderPrRoutineResult)
}

/** The workflow serializes this exact execution key. An uncertain POST is never
 * retried here; the next notification first finds the bot-owned retained comment. */
export async function publishPrRoutineResult({github, context, plan}) {
  requireThat(context.eventName === "workflow_dispatch" && context.ref === "refs/heads/dev" &&
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY && positive(plan.pr) &&
    positive(plan.privateRunId) && positive(plan.privateAttempt) && plan.marker === resultMarker(plan) &&
    plan.body.startsWith(`${plan.marker}\n`) && plan.body.length <= 30_000, "Invalid PR result publication")
  deviceRoutine(plan.routineId)
  const comments = await github.paginate(github.rest.issues.listComments, {...context.repo, issue_number: plan.pr, per_page: 100})
  const owned = comments.filter(comment => comment.user?.type === "Bot" && comment.user.login === "github-actions[bot]" &&
    comment.body?.startsWith(`${plan.marker}\n`))
  requireThat(owned.length <= 1, "Duplicate result comments require reconciliation")
  if (owned[0]) {
    if (owned[0].body === plan.body) return {status: "unchanged", commentId: owned[0].id}
    await github.rest.issues.updateComment({...context.repo, comment_id: owned[0].id, body: plan.body})
    return {status: "updated", commentId: owned[0].id}
  }
  const {data} = await github.rest.issues.createComment({...context.repo, issue_number: plan.pr, body: plan.body})
  return {status: "created", commentId: data.id}
}
