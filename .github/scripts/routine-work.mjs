import {isDeepStrictEqual} from 'node:util'
import {authenticatedPr, publicationForPlatform, platformProducer} from './request-e2e-routine.mjs'
import {ensure, positive, exactSource, routineId, requestInputDigest} from './routine-api.mjs'

const REPOSITORY = 'Mentra-Community/MentraOS'
const HARNESS = 'Mentra-Community/Mentra-Automated-Testing'
const API = 'https://core.dev.us-west-2.mentraglass.com/api/internal/routine-work'
export const briefMarker = '<!-- mentra-routine-work:v1 -->'
const identity = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,239}$/.test(value)
const keys = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((key) => Object.hasOwn(value, key))
const text = (value, maximum = 2000) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !value.includes('\0')
const texts = (value) =>
  Array.isArray(value) && value.length > 0 && value.length <= 100 && value.every((value) => text(value))
const identifiers = (value) => Array.isArray(value) && value.length <= 30 && value.every(routineId)
export const workDigest = requestInputDigest

/** Only a complete, versioned JSON brief is executable intake; surrounding English is not parsed as instructions. */
export function parseRoutineWorkBrief(body, kind) {
  ensure(
    typeof body === 'string' && Buffer.byteLength(body) <= 32_768 && body.startsWith(briefMarker + '\n'),
    'Invalid authoring request comment',
  )
  const match = /^```json\n([\s\S]+)\n```\s*$/.exec(body.slice(briefMarker.length + 1))
  ensure(match, 'Authoring request requires one JSON brief')
  let value
  try {
    value = JSON.parse(match[1])
  } catch {
    throw new Error('Authoring request JSON is invalid')
  }
  ensure(
    keys(value, ['schemaVersion', 'kind', 'routineId', 'brief', 'source', 'target', 'requirements']) &&
      value.schemaVersion === 1 &&
      value.kind === kind &&
      ['edit', 'create'].includes(kind) &&
      routineId(value.routineId),
    'Authoring request version, kind or routine is invalid',
  )
  ensure(
    keys(value.brief, ['goal', 'stepsOrChanges', 'expected']) &&
      text(value.brief.goal, 4000) &&
      texts(value.brief.stepsOrChanges) &&
      texts(value.brief.expected),
    'Authoring request needs a goal, concrete changes and expected results',
  )
  ensure(
    keys(value.source, ['repository', 'revision']) &&
      value.source.repository === HARNESS &&
      /^[a-f0-9]{40}$/.test(value.source.revision),
    'Authoring requires an exact harness revision',
  )
  ensure(
    keys(value.target, ['hostId', 'laneId']) && identity(value.target.hostId) && identity(value.target.laneId),
    'Authoring target must name a host and lane',
  )
  ensure(
    keys(value.requirements, ['platform', 'glasses', 'capabilities', 'environment']) &&
      ['mac', 'android'].includes(value.requirements.platform) &&
      identifiers(value.requirements.glasses) &&
      identifiers(value.requirements.capabilities) &&
      Array.isArray(value.requirements.environment) &&
      value.requirements.environment.length <= 20 &&
      value.requirements.environment.every(
        (requirement) =>
          keys(requirement, ['provider', 'input', 'description']) &&
          routineId(requirement.provider) &&
          text(requirement.description) &&
          Buffer.byteLength(JSON.stringify(requirement.input)) <= 32 * 1024,
      ),
    'Authoring platform requirements are invalid',
  )
  workDigest(value) // Reject non-finite JSON without converting it to a different request.
  value.brief = {
    goal: value.brief.goal.trim(),
    stepsOrChanges: value.brief.stepsOrChanges.map((value) => value.trim()),
    expected: value.brief.expected.map((value) => value.trim()),
  }
  value.requirements.environment = value.requirements.environment.map((requirement) => ({
    ...requirement,
    description: requirement.description.trim(),
  }))
  return value
}

/** A request comment must come from a collaborator and be selected by one unambiguous work label. */
export async function selectedRoutineWork({github, context, number}) {
  const pr = await authenticatedPr(github, context, number)
  const labels = (pr.labels ?? [])
    .map((value) => (typeof value === 'string' ? value : value.name))
    .filter((value) => ['routine-work:create', 'routine-work:edit'].includes(value))
  if (!labels.length) return null
  ensure(labels.length === 1, 'Select exactly one authoring work kind')
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...context.repo,
    issue_number: pr.number,
    per_page: 100,
  })
  ensure(
    comments.length < 1000 && new Set(comments.map((value) => value.id)).size === comments.length,
    'Authoring brief history is incomplete',
  )
  const candidates = comments.filter(
    (value) =>
      value.body?.startsWith(briefMarker + '\n') &&
      ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(value.author_association) &&
      positive(value.id) &&
      value.user?.type === 'User',
  )
  ensure(candidates.length === 1, 'Exactly one collaborator-authored request brief is required')
  const comment = candidates[0],
    brief = parseRoutineWorkBrief(comment.body, labels[0].slice('routine-work:'.length))
  return {pr, commentId: comment.id, brief}
}

/** Source/build changes make a new occurrence; Actions retries reuse this exact work identity. */
export function authoringDispatch(selected, source) {
  const buildSource = exactSource(source)
  ensure(
    buildSource.channel === 'pr' && buildSource.prNumber === selected.pr.number,
    'Authoring build must belong to the originating PR',
  )
  const input = {
    ...selected.brief,
    origin: {repository: REPOSITORY, prNumber: selected.pr.number, headSha: selected.pr.head.sha},
    buildSource,
  }
  return {workId: `routine-work-${workDigest(input)}`, ...input}
}

export async function planRoutineWork({github, context, number, source}) {
  ensure(
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY &&
      context.ref === 'refs/heads/dev' &&
      ['pull_request_target', 'issue_comment', 'workflow_run', 'workflow_dispatch'].includes(context.eventName),
    'Authoring requires trusted dev workflow metadata',
  )
  const selected = await selectedRoutineWork({github, context, number})
  if (!selected) return {status: 'unrequested'}
  const platform = selected.brief.requirements.platform === 'mac' ? 'ios-on-mac' : 'android'
  let buildSource = source
  if (!buildSource) {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      ...context.repo,
      workflow_id: platformProducer(platform),
      head_sha: selected.pr.head.sha,
      event: 'pull_request',
      per_page: 100,
    })
    ensure(
      runs.length < 1000 && new Set(runs.map((value) => value.id)).size === runs.length,
      'Authoring publication history is incomplete',
    )
    const run = runs
      .filter(
        (value) =>
          value.head_sha === selected.pr.head.sha &&
          value.head_branch === selected.pr.head.ref &&
          value.head_repository?.full_name === REPOSITORY,
      )
      .sort((a, b) => b.id - a.id)[0]
    const publication = run && (await publicationForPlatform(github, context, run, platform))
    if (!publication) return {status: 'waiting-for-build', pr: selected.pr.number, headSha: selected.pr.head.sha}
    buildSource = {
      channel: 'pr',
      prNumber: selected.pr.number,
      buildRunId: run.id,
      publicationAttempt: publication.publicationAttempt,
    }
  }
  return {status: 'ready', request: authoringDispatch(selected, buildSource)}
}

/** One POST; reconcile a lost reply by workId without changing source, build or brief. */
export async function routineWorkApi({token, operation, request, workId = request?.workId, fetchImpl = fetch}) {
  ensure(
    token && identity(workId) && ['submit', 'inspect'].includes(operation),
    'Authoring intake capability or identity is missing',
  )
  let response
  try {
    response = await fetchImpl(`${API}${operation === 'inspect' ? `/${encodeURIComponent(workId)}` : ''}`, {
      method: operation === 'submit' ? 'POST' : 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'},
      ...(operation === 'submit' ? {body: JSON.stringify(request)} : {}),
    })
  } catch {
    const error = new Error(`Authoring intake ${operation} response is unavailable`)
    error.retryable = true
    throw error
  }
  if (!response.ok) {
    const error = new Error(`Authoring intake ${operation} failed (${response.status})`)
    error.retryable = response.status >= 500 || response.status === 429
    error.httpStatus = response.status
    throw error
  }
  let row
  try {
    row = await response.json()
  } catch {
    const error = new Error(`Authoring intake ${operation} body is unavailable`)
    error.retryable = true
    throw error
  }
  ensure(
    row?.workId === workId && /^[a-f0-9]{64}$/.test(row.inputSha256 ?? '') && row.work?.workId === workId,
    'Authoring receipt changed its identity',
  )
  ensure(
    row.inputSha256 === workDigest(row.work) && row.hostId === row.work.target?.hostId,
    'Authoring receipt changed its frozen input digest or host',
  )
  if (request) {
    const {buildSource, ...input} = request
    ensure(
      isDeepStrictEqual(row.request, request) &&
        Object.keys(input).every((key) => isDeepStrictEqual(row.work[key], input[key])),
      'Authoring receipt changed its original brief/source/target',
    )
  }
  return row
}

export async function submitRoutineWork(options) {
  try {
    return await routineWorkApi({...options, operation: 'submit'})
  } catch (original) {
    if (!original.retryable) throw original
    try {
      return await routineWorkApi({...options, operation: 'inspect'})
    } catch (error) {
      if (!error.retryable && error.httpStatus === undefined) throw error
      throw new Error(`Authoring admission is uncertain for ${options.request.workId}; inspect this same occurrence`)
    }
  }
}

/** A producer callback selects only the PRs authenticated by that exact source run. */
export async function routineWorkPrNumbers({github, context, number}) {
  ensure(
    `${context.repo.owner}/${context.repo.repo}` === REPOSITORY && context.ref === 'refs/heads/dev',
    'Authoring requires trusted dev workflow metadata',
  )
  if (context.eventName !== 'workflow_run') {
    ensure(positive(number), 'An originating PR is required')
    return [number]
  }
  const callback = context.payload?.workflow_run
  ensure(positive(callback?.id), 'Authoring producer callback has no run identity')
  const {data: run} = await github.rest.actions.getWorkflowRun({...context.repo, run_id: callback.id})
  ensure(
    run.id === callback.id &&
      run.run_attempt === callback.run_attempt &&
      run.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY &&
      [platformProducer('android'), platformProducer('ios-on-mac')].includes(run.path) &&
      /^[a-f0-9]{40}$/.test(run.head_sha ?? ''),
    'Authoring producer callback differs from the authenticated app build',
  )
  if (run.event !== 'pull_request') return []
  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, {
    ...context.repo,
    commit_sha: run.head_sha,
    per_page: 100,
  })
  ensure(
    pulls.length < 1000 && new Set(pulls.map((value) => value.number)).size === pulls.length,
    'Authoring PR association is incomplete',
  )
  return pulls
    .filter(
      (pr) =>
        pr.state === 'open' &&
        pr.head?.sha === run.head_sha &&
        pr.head?.ref === run.head_branch &&
        pr.head?.repo?.full_name === REPOSITORY &&
        ['dev', 'staging'].includes(pr.base?.ref),
    )
    .map((pr) => pr.number)
}
