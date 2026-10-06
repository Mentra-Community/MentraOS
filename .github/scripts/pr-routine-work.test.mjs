import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {publishPrRoutineWorkReport} from './pr-routine-work.mjs'

test('manual reporting wake retains Core ownership and sends only the same work identity', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({url, init})
    return Response.json({workId: 'work-one', retained: true})
  }
  assert.deepEqual(await publishPrRoutineWorkReport({token: 'secret', workId: 'work-one', fetchImpl}), {
    workId: 'work-one',
    retained: true,
  })
  assert.match(calls[0].url, /routine-work\/work-one\/report$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.body, undefined)
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret')
  const workflow = await readFile(new URL('../workflows/notify-routine-work.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(workflow, /pull-requests: write|issues: write|schedule:|createComment|updateComment/)
  assert.match(workflow, /publishPrRoutineWorkReport/)
})
test('lost report response retries the same identity and changed receipts never succeed', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (calls.length === 1) throw new Error('lost response')
    return Response.json({workId: 'work-one', retained: true})
  }
  await assert.rejects(publishPrRoutineWorkReport({token: 'secret', workId: 'work-one', fetchImpl}), /lost response/)
  await publishPrRoutineWorkReport({token: 'secret', workId: 'work-one', fetchImpl})
  assert.equal(calls[0], calls[1])
  await assert.rejects(
    publishPrRoutineWorkReport({
      token: 'secret',
      workId: 'work-one',
      fetchImpl: async () => Response.json({workId: 'other', retained: true}),
    }),
    /changed/,
  )
  await assert.rejects(
    publishPrRoutineWorkReport({
      token: 'secret',
      workId: 'work-one',
      fetchImpl: async () => new Response(null, {status: 403}),
    }),
    /retains/,
  )
})
