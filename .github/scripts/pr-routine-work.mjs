import {ensure, positive, requestIdentity, exactSource} from './routine-api.mjs'
import {workDigest} from './routine-work.mjs'

const repository = 'Mentra-Community/MentraOS'
const states = [
  'queued',
  'preparing',
  'waiting-for-lane',
  'authoring',
  'needs-input',
  'stopped',
  'awaiting-review',
  'awaiting-installation',
  'verifying',
  'passed',
  'failed',
  'cancelled',
]
const plain = (value) =>
  String(value)
    .replace(/[\\`*_|<>\r\n]/g, ' ')
    .trim()
export const routineWorkResultMarker = (workId) => `<!-- mentra-routine-work-result:${workId} -->`

/** Report only public binding and actual state; private job details and model text never enter the PR. */
export function renderPrRoutineWork(row) {
  const {work, status, acceptance} = row ?? {},
    origin = work?.origin,
    build = work?.build
  ensure(
    requestIdentity(row?.workId) &&
      work?.workId === row.workId &&
      row.inputSha256 === workDigest(work) &&
      row.hostId === work.target?.hostId &&
      origin?.repository === repository &&
      positive(origin.prNumber) &&
      /^[a-f0-9]{40}$/.test(origin.headSha ?? '') &&
      build.repository === repository &&
      build.headSha === origin.headSha &&
      build.prNumber === origin.prNumber &&
      exactSource(build.source).prNumber === origin.prNumber,
    'Authoring report differs from its frozen PR/build',
  )
  if (acceptance)
    ensure(
      acceptance.workId === row.workId &&
        acceptance.hostId === row.hostId &&
        acceptance.inputSha256 === row.inputSha256 &&
        Number.isFinite(Date.parse(acceptance.acceptedAt)),
      'Authoring report has an invalid host acceptance',
    )
  if (status)
    ensure(
      acceptance &&
        status.workId === row.workId &&
        status.hostId === row.hostId &&
        status.inputSha256 === row.inputSha256 &&
        positive(status.sequence) &&
        states.includes(status.state) &&
        status.details?.sequence === status.sequence &&
        status.details.state === status.state &&
        status.details.workId === row.workId &&
        status.details.hostId === row.hostId &&
        status.details.inputSha256 === row.inputSha256 &&
        status.details.acceptedAt === acceptance.acceptedAt &&
        workDigest(status.details.work) === row.inputSha256,
      'Authoring report has a contradictory machine status',
    )
  const state = status?.state ?? 'queued',
    marker = routineWorkResultMarker(row.workId),
    publicDetails = status?.details?.details ?? {}
  if (publicDetails.prUrl)
    ensure(
      /^https:\/\/github\.com\/Mentra-Community\/Mentra-Automated-Testing\/pull\/[1-9]\d*$/.test(publicDetails.prUrl),
      'Invalid authoring source PR',
    )
  if (publicDetails.resultUrl) {
    const url = new URL(publicDetails.resultUrl)
    ensure(
      ['https://admin.dev.mentraglass.com', 'https://admin.mentraglass.com'].includes(url.origin) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.pathname === '/' &&
        [...url.searchParams.keys()].every((key) => key === 'testRun') &&
        requestIdentity(url.searchParams.get('testRun')),
      'Invalid authoring result URL',
    )
  }
  return {
    workId: row.workId,
    pr: origin.prNumber,
    marker,
    body: [
      marker,
      `### Routine ${plain(work.kind)} — ${state}`,
      '',
      `Routine: \`${plain(work.routineId)}\`. Host/lane: \`${plain(work.target.hostId)}/${plain(work.target.laneId)}\`.`,
      '',
      `App head: [\`${origin.headSha}\`](https://github.com/${repository}/commit/${origin.headSha}).`,
      `Harness source: [\`${work.source.revision}\`](https://github.com/${work.source.repository}/commit/${work.source.revision}).`,
      `[Exact app build ${build.source.buildRunId}/${build.source.publicationAttempt}](https://github.com/${repository}/actions/runs/${build.source.buildRunId}/attempts/${build.source.publicationAttempt}).`,
      '',
      `Work: \`${row.workId}\`; input SHA-256: \`${row.inputSha256}\`; machine sequence: ${status?.sequence ?? 0}.`,
      '',
      ...(publicDetails.question
        ? [
            `Input needed (${plain(publicDetails.questionId ?? '')}): ${plain(publicDetails.question).slice(0, 4000)}`,
            '',
          ]
        : []),
      ...(publicDetails.prUrl ? [`[Routine source PR](${publicDetails.prUrl})`, ''] : []),
      ...(publicDetails.resultUrl ? [`[Ordinary result and recording](${publicDetails.resultUrl})`, ''] : []),
      state === 'passed'
        ? 'The machine reports the final verified state for this recorded work.'
        : 'Authoring progress is separate from an ordinary passing routine result.',
    ].join('\n'),
  }
}

export async function publishPrRoutineWork({github, context, plan}) {
  ensure(
    ['pull_request_target', 'issue_comment', 'workflow_run', 'workflow_dispatch'].includes(context.eventName) &&
      context.ref === 'refs/heads/dev' &&
      `${context.repo.owner}/${context.repo.repo}` === repository &&
      positive(plan.pr) &&
      requestIdentity(plan.workId) &&
      plan.marker === routineWorkResultMarker(plan.workId) &&
      plan.body.startsWith(`${plan.marker}\n`) &&
      plan.body.length <= 30000,
    'Invalid authoring PR publication',
  )
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: plan.pr,
    per_page: 100,
  })
  ensure(
    comments.length < 1000 && new Set(comments.map((value) => value.id)).size === comments.length,
    'Authoring comment history is incomplete',
  )
  const owned = comments.filter(
    (comment) =>
      comment.user?.type === 'Bot' &&
      comment.user.login === 'github-actions[bot]' &&
      comment.body?.startsWith(`${plan.marker}\n`),
  )
  ensure(owned.length <= 1, 'Duplicate authoring comments require reconciliation')
  if (owned[0]) {
    if (owned[0].body === plan.body) return {status: 'unchanged', commentId: owned[0].id}
    await github.rest.issues.updateComment({...context.repo, comment_id: owned[0].id, body: plan.body})
    return {status: 'updated', commentId: owned[0].id}
  }
  const {data} = await github.rest.issues.createComment({...context.repo, issue_number: plan.pr, body: plan.body})
  return {status: 'created', commentId: data.id}
}
