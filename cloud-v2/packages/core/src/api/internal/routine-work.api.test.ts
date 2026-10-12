import {expect, test} from 'bun:test'
import {createRoutineWorkDeliveriesApi, createRoutineWorkIntakeApi} from './routine-work.api'
import type {RoutineWorkService} from '../../services/routine-work.service'

test('worker routes derive host from credential and reject URL/body identity mismatches', async () => {
  const calls: unknown[] = [],
    token = 'a'.repeat(40)
  const service = {
    async queued(host: string) {
      calls.push(host)
      return {jobs: [], nextCursor: null}
    },
    async accept(value: unknown, host: string) {
      calls.push({value, host})
      return value
    },
    async status(value: unknown, host: string) {
      calls.push({value, host})
      return value
    },
  }
  const app = createRoutineWorkDeliveriesApi(service as unknown as RoutineWorkService, () =>
    JSON.stringify({mini: token}),
  )
  expect((await app.request('/')).status).toBe(401)
  const headers = {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'}
  const result = await app.request('/', {headers})
  expect(result.status).toBe(200)
  expect(result.headers.get('cache-control')).toBe('no-store')
  expect(calls).toEqual(['mini'])
  const changed = await app.request('/one/accept', {method: 'POST', headers, body: JSON.stringify({workId: 'two'})})
  expect(changed.status).toBe(400)
  expect(calls).toEqual(['mini'])
  await app.request('/one/status', {method: 'POST', headers, body: JSON.stringify({workId: 'one'})})
  expect(calls[1]).toEqual({value: {workId: 'one'}, host: 'mini'})
})

test('intake requires the existing capability and bounds a complete JSON request before service calls', async () => {
  const previous = process.env.TEST_RUN_INGEST_TOKEN,
    token = 'b'.repeat(40),
    calls: unknown[] = []
  process.env.TEST_RUN_INGEST_TOKEN = token
  try {
    const app = createRoutineWorkIntakeApi({
      async submit(value: unknown) {
        calls.push(value)
        return value
      },
    } as RoutineWorkService)
    expect((await app.request('/', {method: 'POST', body: '{}'})).status).toBe(401)
    const headers = {'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json'}
    expect((await app.request('/', {method: 'POST', headers, body: '{'})).status).toBe(400)
    expect((await app.request('/', {method: 'POST', headers, body: ' '.repeat(256 * 1024 + 1)})).status).toBe(413)
    expect(calls).toHaveLength(0)
    const result = await app.request('/', {method: 'POST', headers, body: JSON.stringify({workId: 'one'})})
    expect(result.status).toBe(202)
    expect(result.headers.get('cache-control')).toBe('no-store')
    expect(calls).toEqual([{workId: 'one'}])
  } finally {
    if (previous === undefined) delete process.env.TEST_RUN_INGEST_TOKEN
    else process.env.TEST_RUN_INGEST_TOKEN = previous
  }
})

test('report wake retains existing ingest authority and never forwards credentials or caller report text', async () => {
  const previous = process.env.TEST_RUN_INGEST_TOKEN,
    token = 'c'.repeat(40)
  process.env.TEST_RUN_INGEST_TOKEN = token
  const calls: string[] = []
  try {
    const row = {workId: 'one', work: {origin: {prNumber: 12}}}
    const app = createRoutineWorkIntakeApi({
      async inspect(id: string) {
        calls.push(id)
        return row
      },
      async report(value: unknown) {
        expect(value).toBe(row)
        calls.push('report')
      },
    } as unknown as RoutineWorkService)
    expect((await app.request('/one/report', {method: 'POST'})).status).toBe(401)
    expect(calls).toHaveLength(0)
    const result = await app.request('/one/report', {method: 'POST', headers: {Authorization: `Bearer ${token}`}})
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({workId: 'one', retained: true})
    expect(calls).toEqual(['one', 'report'])
  } finally {
    if (previous === undefined) delete process.env.TEST_RUN_INGEST_TOKEN
    else process.env.TEST_RUN_INGEST_TOKEN = previous
  }
})
