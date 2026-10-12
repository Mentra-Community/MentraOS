import test from 'node:test'
import assert from 'node:assert/strict'
import {selectedRoutinePlatforms, reportUnsupportedRoutinePlatforms} from './routine-platforms.mjs'

test('selected platform discovery binds explicit exact revision and refuses invalid known metadata', async () => {
  const revision = 'a'.repeat(40), calls = []
  const rows = await selectedRoutinePlatforms({token: 'fixture', routineIds: ['arbitrary'], revision, fetchImpl: async (url, init) => {
    calls.push({url, init}); return Response.json({routineRevision: revision, routines: [{routineId: 'arbitrary', platforms: ['android']}]})
  }})
  assert.deepEqual(rows, [{routineId: 'arbitrary', routineRevision: revision, platforms: ['android']}])
  assert.equal(new URL(calls[0].url).searchParams.get('revision'), revision)
  for (const platforms of [[], ['android', 'android'], ['unsupported']]) {
    await assert.rejects(selectedRoutinePlatforms({token: 'fixture', routineIds: ['arbitrary'], fetchImpl: async () =>
      Response.json({routineRevision: revision, routines: [{routineId: 'arbitrary', platforms}]})}), /description is unavailable/)
  }
  await assert.rejects(selectedRoutinePlatforms({token: 'fixture', routineIds: ['arbitrary'], revision, fetchImpl: async () =>
    Response.json({routineRevision: 'b'.repeat(40), routines: [{routineId: 'arbitrary'}]})}), /changed the exact/)
})

test('unknown support stays unknown, while stale PR heads and repeated dispositions do not post', async () => {
  const revision = 'a'.repeat(40), row = {routineId: 'arbitrary', platform: 'ios-on-mac', platforms: ['android'], routineRevision: revision}
  const unknown = await selectedRoutinePlatforms({token: 'fixture', routineIds: ['arbitrary'], fetchImpl: async () =>
    Response.json({routineRevision: revision, routines: [{routineId: 'arbitrary'}]})})
  assert.deepEqual(unknown, [{routineId: 'arbitrary', routineRevision: revision}])
  const pr = {number: 12, head: {sha: 'c'.repeat(40)}}, comments = [], current = {state: 'open', head: {sha: 'd'.repeat(40)}}
  const github = {rest: {pulls: {get: async () => ({data: current})}, issues: {listComments: 'comments', createComment: async input => comments.push(input)}},
    paginate: async () => comments.map(comment => ({...comment, user: {type: 'Bot', login: 'github-actions[bot]'}}))}
  const options = {github, context: {repo: {owner: 'Mentra-Community', repo: 'MentraOS'}}, pr, rows: [row]}
  await reportUnsupportedRoutinePlatforms(options); assert.equal(comments.length, 0)
  current.head.sha = pr.head.sha
  await reportUnsupportedRoutinePlatforms(options); await reportUnsupportedRoutinePlatforms(options)
  assert.equal(comments.length, 1); assert.match(comments[0].body, /not a device test result/)
})
