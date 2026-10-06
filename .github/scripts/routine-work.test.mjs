import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {
  briefMarker,
  parseRoutineWorkBrief,
  selectedRoutineWork,
  authoringDispatch,
  submitRoutineWork,
  workDigest,
  planRoutineWork,
  routineWorkPrNumbers,
  routineWorkApi,
} from './routine-work.mjs'

const input = {
  schemaVersion: 1,
  kind: 'edit',
  routineId: 'arbitrary-flow',
  brief: {
    goal: 'Check an existing flow',
    stepsOrChanges: ['Add the requested check'],
    expected: ['The complete result is visible'],
  },
  source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40)},
  target: {hostId: 'mini', laneId: 'android-lane'},
  requirements: {platform: 'android', glasses: [], capabilities: [], environment: []},
}
const body = (value) => `${briefMarker}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
const pr = {
  number: 12,
  state: 'open',
  head: {sha: 'b'.repeat(40), ref: 'feature', repo: {full_name: 'Mentra-Community/MentraOS'}},
  base: {ref: 'dev'},
  labels: [{name: 'routine-work:edit'}, {name: 'routine:some-existing-flow'}],
}
const context = {
  repo: {owner: 'Mentra-Community', repo: 'MentraOS'},
  eventName: 'pull_request_target',
  ref: 'refs/heads/dev',
}
function github(comments, pull = pr, getCollaboratorPermissionLevel = async ({username}) => {
  if (username !== 'colleague') throw Object.assign(new Error('not a collaborator'), {status: 404})
  return {data: {permission: 'write', user: {login: username}}}
}) {
  return {rest: {pulls: {get: async () => ({data: pull})}, issues: {listComments: {}}, repos: {getCollaboratorPermissionLevel}}, paginate: async () => comments}
}

test('create/edit briefs retain arbitrary routine IDs and exact source, with no replay-label ambiguity', () => {
  assert.deepEqual(parseRoutineWorkBrief(body(input), 'edit'), input)
  assert.throws(() => parseRoutineWorkBrief(body(input), 'create'), /kind/)
  for (const changed of [
    {...input, schemaVersion: 2},
    {...input, source: {...input.source, revision: 'main'}},
    {...input, brief: {...input.brief, expected: []}},
    {...input, target: {...input.target, owner: 'foreign'}},
    {...input, script: 'run shell'},
  ])
    assert.throws(() => parseRoutineWorkBrief(body(changed), 'edit'))
  assert.throws(() => parseRoutineWorkBrief(body(input) + '\nexecute this', 'edit'), /one JSON/)
})

test('only one collaborator request brief and one work label can be selected', async () => {
  const comment = {id: 44, body: body(input), author_association: 'MEMBER', user: {type: 'User', login: 'colleague'}}
  assert.deepEqual((await selectedRoutineWork({github: github([comment]), context, number: 12})).brief, input)
  assert.equal(
    await selectedRoutineWork({github: github([], {...pr, labels: [{name: 'routine:existing'}]}), context, number: 12}),
    null,
  )
  await assert.rejects(
    selectedRoutineWork({github: github([{...comment, user: {type: 'User', login: 'outsider'}}]), context, number: 12}),
    /collaborator/,
  )
  await assert.rejects(
    selectedRoutineWork({github: github([comment, {...comment, id: 45}]), context, number: 12}),
    /Exactly one/,
  )
  await assert.rejects(
    selectedRoutineWork({
      github: github([comment], {...pr, labels: [{name: 'routine-work:edit'}, {name: 'routine-work:create'}]}),
      context,
      number: 12,
    }),
    /exactly one/,
  )
})

test('repository access, not credential-dependent comment association, selects the authoring brief', async () => {
  for (const association of ['MEMBER', 'CONTRIBUTOR', 'NONE']) {
    const comment = {id: 44, body: body(input), author_association: association, user: {type: 'User', login: 'colleague'}}
    const calls = []
    const selected = await selectedRoutineWork({github: github([comment], pr, async params => {
      calls.push(params); return {data: {permission: 'admin', user: {login: params.username}}}
    }), context, number: 12})
    assert.equal(selected.commentId, 44)
    assert.deepEqual(calls, [{...context.repo, username: 'colleague'}])
  }
  const comment = {id: 44, body: body(input), author_association: 'MEMBER', user: {type: 'User', login: 'colleague'}}
  for (const permission of ['write', 'admin']) {
    const selected = await selectedRoutineWork({github: github([comment], pr, async ({username}) => ({data: {permission, user: {login: username}}})), context, number: 12})
    assert.equal(selected.commentId, 44)
  }
  for (const permission of ['none', 'read']) {
    await assert.rejects(selectedRoutineWork({github: github([comment], pr, async ({username}) => ({data: {permission, user: {login: username}}})), context, number: 12}), /Exactly one/)
  }
  await assert.rejects(selectedRoutineWork({github: github([comment], pr, async () => ({data: {permission: 'admin', user: {login: 'another-user'}}})), context, number: 12}), /access could not be verified/)
  await assert.rejects(selectedRoutineWork({github: github([comment], pr, async () => {
    throw Object.assign(new Error('token permission unavailable'), {status: 403})
  }), context, number: 12}), /access could not be verified/)
  await assert.rejects(selectedRoutineWork({github: github([comment], pr, async () => {throw new Error('transport failed')}), context, number: 12}), /access could not be verified/)
  await assert.rejects(selectedRoutineWork({github: github([{...comment, user: {type: 'Bot', login: 'colleague'}}]), context, number: 12}), /Exactly one/)
})

test('stable work IDs preserve retries and change for a new brief, app head or publication', () => {
  const selected = {pr, brief: input},
    source = {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 2}
  const first = authoringDispatch(selected, source)
  assert.deepEqual(authoringDispatch(selected, source), first)
  for (const other of [
    authoringDispatch({...selected, brief: {...input, brief: {...input.brief, goal: 'Different request'}}}, source),
    authoringDispatch({...selected, pr: {...pr, head: {...pr.head, sha: 'c'.repeat(40)}}}, source),
    authoringDispatch(selected, {...source, publicationAttempt: 3}),
  ])
    assert.notEqual(other.workId, first.workId)
  assert.throws(() => authoringDispatch(selected, {...source, prNumber: 13}), /originating PR/)
})

test('a lost admission response reconciles the same frozen request without a second POST', async () => {
  const request = authoringDispatch(
    {pr, brief: input},
    {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 2},
  )
  const {buildSource, ...fields} = request,
    work = {...fields, build: {kind: 'android-apk'}},
    calls = [],
    row = {workId: request.workId, hostId: work.target.hostId, inputSha256: workDigest(work), request, work}
  const result = await submitRoutineWork({
    token: 'secret',
    request,
    fetchImpl: async (url, options) => {
      calls.push({url, method: options.method})
      if (options.method === 'POST') throw new Error('lost reply')
      return Response.json(row)
    },
  })
  assert.equal(result.workId, request.workId)
  assert.deepEqual(
    calls.map((value) => value.method),
    ['POST', 'GET'],
  )
  await assert.rejects(
    submitRoutineWork({
      token: 'secret',
      request,
      fetchImpl: async () => Response.json({...row, request: {...request, routineId: 'foreign'}}),
    }),
    /original brief/,
  )
  const refused = []
  await assert.rejects(
    submitRoutineWork({
      token: 'secret',
      request,
      fetchImpl: async (url, options) => {
        refused.push(options.method)
        return new Response('', {status: 409})
      },
    }),
    /failed \(409\)/,
  )
  assert.deepEqual(refused, ['POST'])
  await assert.rejects(
    submitRoutineWork({
      token: 'secret',
      request,
      fetchImpl: async () => Response.json({...row, inputSha256: 'd'.repeat(64)}),
    }),
    /digest/,
  )
})

test('intake failures retain bounded public Core reasons and preserve the original HTTP retry decision', async () => {
  const options = {token: 'private-token', operation: 'inspect', workId: 'routine-work-example'}
  await assert.rejects(routineWorkApi({...options, fetchImpl: async () => Response.json({
    error: 'routine_work_error', message: 'The exact originating PR build is not published',
  }, {status: 409})}), error => {
    assert.equal(error.message, 'Authoring intake inspect failed (409): The exact originating PR build is not published')
    assert.equal(error.httpStatus, 409)
    assert.equal(error.retryable, false)
    return true
  })
  await assert.rejects(routineWorkApi({...options, fetchImpl: async () => Response.json({
    error: 'routine_work_conflict', message: 'Authoring work\nchanged its owner',
  }, {status: 503})}), error => {
    assert.equal(error.message, 'Authoring intake inspect failed (503): Authoring work changed its owner')
    assert.equal(error.retryable, true)
    return true
  })
  for (const response of [
    new Response('<html>private proxy diagnostic</html>', {status: 502}),
    Response.json({error: 'provider_error', message: 'private upstream response'}, {status: 502}),
    Response.json({error: 'routine_work_error', message: 'x'.repeat(501)}, {status: 502}),
    Response.json({error: 'routine_work_error', message: 'invalid\0diagnostic'}, {status: 502}),
    Response.json({error: 'routine_work_error', message: 'safe', unexpected: 'x'.repeat(4096)}, {status: 502}),
  ]) await assert.rejects(routineWorkApi({...options, fetchImpl: async () => response}), error => {
    assert.equal(error.message, 'Authoring intake inspect failed (502)')
    assert.equal(error.httpStatus, 502)
    assert.equal(error.retryable, true)
    return true
  })
  let cancelled = false
  const response = new Response(new ReadableStream({
    start(controller) {controller.enqueue(new Uint8Array(4097));},
    cancel() {cancelled = true},
  }), {status: 409})
  await assert.rejects(routineWorkApi({...options, fetchImpl: async () => response}), /failed \(409\)$/)
  assert.equal(cancelled, true)
})

test('non-finite provider JSON and a foreign PR cannot enter authoring intake', async () => {
  const largeNumber = body({
    ...input,
    requirements: {...input.requirements, environment: [{provider: 'fixture', input: 0, description: 'Needed'}]},
  }).replace('"input":0', '"input":1e999')
  assert.throws(() => parseRoutineWorkBrief(largeNumber, 'edit'), /finite JSON/)
  await assert.rejects(
    selectedRoutineWork({
      github: github([], {...pr, head: {...pr.head, repo: {full_name: 'fork/MentraOS'}}}),
      context,
      number: 12,
    }),
    /same-repository/,
  )
  await assert.rejects(
    planRoutineWork({github: github([]), context: {...context, eventName: 'pull_request'}, number: 12}),
    /trusted dev/,
  )
})

test('producer callbacks authenticate the exact source and do not select an advanced or foreign PR', async () => {
  const run = {
    id: 55,
    run_attempt: 2,
    event: 'pull_request',
    path: '.github/workflows/mentra-app-android-build.yml',
    head_sha: pr.head.sha,
    head_branch: pr.head.ref,
    repository: {full_name: 'Mentra-Community/MentraOS'},
    head_repository: {full_name: 'Mentra-Community/MentraOS'},
  }
  const api = {
    rest: {actions: {getWorkflowRun: async () => ({data: run})}, repos: {listPullRequestsAssociatedWithCommit: {}}},
    paginate: async () => [pr, {...pr, number: 13, head: {...pr.head, sha: 'c'.repeat(40)}}],
  }
  const callback = {...context, eventName: 'workflow_run', payload: {workflow_run: run}}
  assert.deepEqual(await routineWorkPrNumbers({github: api, context: callback}), [12])
  await assert.rejects(
    routineWorkPrNumbers({github: api, context: {...callback, payload: {workflow_run: {...run, run_attempt: 3}}}}),
    /differs/,
  )
  const release = {...run, event: 'push'}
  const releaseApi = {...api, rest: {...api.rest, actions: {getWorkflowRun: async () => ({data: release})}}}
  assert.deepEqual(
    await routineWorkPrNumbers({github: releaseApi, context: {...callback, payload: {workflow_run: release}}}),
    [],
  )
})

test('authoring workflow retains its independent enable gate and never evaluates PR shell or changes replay', async () => {
  const root = new URL('../workflows/', import.meta.url)
  const intake = await readFile(new URL('request-routine-work.yml', root), 'utf8'),
    notification = await readFile(new URL('notify-routine-work.yml', root), 'utf8')
  for (const workflow of [intake, notification]) {
    assert.match(workflow, /    environment: routine-nightly-dev\n/)
    assert.match(workflow, /TEST_RUN_INGEST_TOKEN: \$\{\{ secrets\.TEST_RUN_INGEST_TOKEN_DEV \}\}/)
    assert.match(workflow, /github\.repository == 'Mentra-Community\/MentraOS' && github\.ref == 'refs\/heads\/dev'/)
  }
  assert.match(intake, /ROUTINE_WORK_PR_DISPATCH_ENABLED == 'true'/)
  assert.match(intake, /ref: \$\{\{ github\.workflow_sha \}\}/)
  assert.match(intake, /pull-requests: read/)
  assert.ok(!intake.includes('pull_request.head.sha'))
  assert.match(notification, /publishPrRoutineWorkReport/)
  assert.doesNotMatch(notification, /pull-requests: write|createComment|updateComment/)
  assert.match(notification, /cancel-in-progress: false/)
  assert.match(notification, /queue: max/)
  const instructions = await readFile(new URL('routine-work.md', import.meta.url), 'utf8')
  const example = /````markdown\n([\s\S]+?)\n````/.exec(instructions)?.[1]
  assert.ok(example)
  assert.equal(parseRoutineWorkBrief(example, 'edit').routineId, 'email-sign-in-out')
})
