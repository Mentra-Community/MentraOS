import {test} from 'node:test'
import assert from 'node:assert/strict'
import {workDigest} from './routine-work.mjs'
import {renderPrRoutineWork, publishPrRoutineWork} from './pr-routine-work.mjs'

const work = {
  schemaVersion: 1,
  workId: 'work-one',
  kind: 'create',
  routineId: 'new.generic-flow',
  source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40)},
  target: {hostId: 'mini', laneId: 'mac'},
  origin: {repository: 'Mentra-Community/MentraOS', prNumber: 12, headSha: 'b'.repeat(40)},
  build: {
    repository: 'Mentra-Community/MentraOS',
    headSha: 'b'.repeat(40),
    prNumber: 12,
    source: {channel: 'pr', prNumber: 12, buildRunId: 55, publicationAttempt: 2},
  },
}
const row = {workId: work.workId, work, hostId: 'mini', inputSha256: workDigest(work)}
const acceptance = {
  workId: row.workId,
  hostId: row.hostId,
  inputSha256: row.inputSha256,
  acceptedAt: '2026-10-05T10:00:00Z',
}
const status = {
  workId: row.workId,
  hostId: row.hostId,
  inputSha256: row.inputSha256,
  eventId: 'event-one',
  sequence: 3,
  state: 'needs-input',
  details: {
    ...acceptance,
    state: 'needs-input',
    sequence: 3,
    work,
    details: {workspace: 'PRIVATE-PATH', modelText: 'PRIVATE-MODEL'},
    events: [],
  },
}
const context = {
  eventName: 'workflow_dispatch',
  ref: 'refs/heads/dev',
  repo: {owner: 'Mentra-Community', repo: 'MentraOS'},
}

test('reports exact work/build and real state without private machine details or a false passing claim', () => {
  const queued = renderPrRoutineWork(row),
    held = renderPrRoutineWork({...row, acceptance, status})
  assert.match(queued.body, /create — queued/)
  assert.match(held.body, /create — needs-input/)
  assert.match(held.body, /ordinary passing routine result/)
  assert.match(held.body, /attempts\/2/)
  assert.ok(!held.body.includes('PRIVATE'))
  const publicDetails = {
    ...status.details,
    details: {
      questionId: 'question-one',
      question: 'Choose the expected destination',
      prUrl: 'https://github.com/Mentra-Community/Mentra-Automated-Testing/pull/527',
      resultUrl: 'https://admin.dev.mentraglass.com/?testRun=run-one',
    },
  }
  const requested = renderPrRoutineWork({...row, acceptance, status: {...status, details: publicDetails}})
  assert.match(requested.body, /Choose the expected destination/)
  assert.match(requested.body, /pull\/527/)
  assert.match(requested.body, /testRun=run-one/)
  assert.throws(
    () =>
      renderPrRoutineWork({
        ...row,
        acceptance,
        status: {
          ...status,
          details: {
            ...publicDetails,
            details: {...publicDetails.details, resultUrl: 'https://other.example/?testRun=run-one'},
          },
        },
      }),
    /result URL/,
  )
  assert.throws(
    () => renderPrRoutineWork({...row, acceptance, status: {...status, hostId: 'foreign'}}),
    /contradictory/,
  )
  assert.throws(
    () => renderPrRoutineWork({...row, work: {...work, origin: {...work.origin, headSha: 'c'.repeat(40)}}}),
    /frozen PR/,
  )
})

test('lost comment creation is reconciled by the existing bot marker on retry', async () => {
  const comments = [],
    plan = renderPrRoutineWork(row),
    calls = []
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        listComments: {},
        createComment: async (value) => {
          calls.push('create')
          comments.push({id: 1, body: value.body, user: {type: 'Bot', login: 'github-actions[bot]'}})
          throw new Error('lost reply')
        },
        updateComment: async (value) => {
          calls.push('update')
          comments[0].body = value.body
        },
      },
    },
  }
  await assert.rejects(publishPrRoutineWork({github, context, plan}), /lost reply/)
  assert.deepEqual(await publishPrRoutineWork({github, context, plan}), {status: 'unchanged', commentId: 1})
  await publishPrRoutineWork({github, context, plan: renderPrRoutineWork({...row, acceptance, status})})
  assert.deepEqual(calls, ['create', 'update'])
  comments.push({...comments[0], id: 2})
  await assert.rejects(publishPrRoutineWork({github, context, plan}), /Duplicate/)
})
