import test from 'node:test'
import assert from 'node:assert/strict'
import {explicitRoutinePr} from './prepare-explicit-routine-pr.mjs'
const head = 'a'.repeat(40), merge = 'b'.repeat(40)
const inputs = {routine_pr: '12', routine_head_sha: head, routine_base: 'dev'}
const pr = {number: 12, state: 'open', head: {sha: head, ref: 'feature', repo: {full_name: 'Mentra-Community/MentraOS'}},
  base: {ref: 'dev'}, merge_commit_sha: merge}
test('explicit build uses authenticated exact open head/base synthetic merge', () => {
  assert.deepEqual(explicitRoutinePr(pr, inputs, 'Mentra-Community/MentraOS'), {number: 12, headSha: head, headRef: 'feature', baseRef: 'dev', mergeSha: merge})
  for (const value of [{...pr, state: 'closed'}, {...pr, head: {...pr.head, sha: merge}}, {...pr, base: {ref: 'staging'}},
    {...pr, head: {...pr.head, repo: {full_name: 'outside/fork'}}}, {...pr, merge_commit_sha: null}])
    assert.throws(() => explicitRoutinePr(value, inputs, 'Mentra-Community/MentraOS'))
})

test('the Mentra monorepo builds its own same-repository PRs; other repositories are refused', () => {
  const monorepo = {...pr, head: {...pr.head, repo: {full_name: 'Mentra-Community/Mentra'}}}
  assert.equal(explicitRoutinePr(monorepo, inputs, 'Mentra-Community/Mentra').mergeSha, merge)
  assert.throws(() => explicitRoutinePr(pr, inputs, 'Mentra-Community/Mentra'))
  assert.throws(() => explicitRoutinePr({...pr, head: {...pr.head, repo: {full_name: 'outside/repo'}}}, inputs, 'outside/repo'))
})
