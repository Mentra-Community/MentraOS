import {expect, spyOn, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {gzipSync} from 'node:zlib'
import {Hono} from 'hono'
import {StorageService} from '../../services/storage/storage.service'
import {routineSourceRefSchema} from '../../types/framework-version.types'
import {createRoutineDefinitionsApi} from './routine-definitions.api'

test('routine publication behind TLS ingress returns an exact HTTPS receipt after verified storage', async () => {
  const token = 'synthetic-bundle-host-' + 'x'.repeat(32), bytes = gzipSync('fixture source archive')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let writes = 0
  const storage = spyOn(StorageService.prototype, 'putObject').mockImplementation(async input => {
    writes++
    expect(input.body).toEqual(new Uint8Array(bytes))
    return {key: input.key, contentType: input.contentType, sizeBytes: input.body.byteLength, sha256}
  })
  const app = new Hono()
  app.route('/api/internal/routine-definitions', createRoutineDefinitionsApi(undefined, () => JSON.stringify({mini: token})))
  const metadata = {commit: 'b'.repeat(40), routineId: 'fixture', minimumRoutineApiVersion: 1,
    definitionSha256: 'c'.repeat(64), size: bytes.length}
  const path = `/api/internal/routine-definitions/bundles/${sha256}?metadata=${encodeURIComponent(JSON.stringify(metadata))}`
  try {
    for (const [origin, forwarded] of [['http://core.example', 'https'], ['https://core.example', undefined]] as const) {
      const response = await app.request(origin + path, {method: 'POST', body: bytes,
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/gzip', ...(forwarded ? {'x-forwarded-proto': forwarded} : {})}})
      expect(response.status).toBe(200)
      const receipt = routineSourceRefSchema.parse(await response.json())
      expect(receipt.bundle).toEqual({url: `https://core.example/api/internal/routine-definitions/bundles/${sha256}`, sha256, size: bytes.length})
    }
    const insecure = await app.request('http://core.example' + path, {method: 'POST', body: bytes,
      headers: {authorization: `Bearer ${token}`, 'content-type': 'application/gzip'}})
    expect(insecure.status).toBe(400)
    expect(writes).toBe(2)
  } finally {storage.mockRestore()}
})

test('trusted offline credential may publish bounded bundles but cannot enroll definitions or collections', async () => {
  const previous = process.env.TEST_RUN_INGEST_TOKEN, token = 'offline-observer-' + 'x'.repeat(32)
  process.env.TEST_RUN_INGEST_TOKEN = token
  const bytes = gzipSync('offline exact archive'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const storage = spyOn(StorageService.prototype, 'putObject').mockImplementation(async input =>
    ({key: input.key, contentType: input.contentType, sizeBytes: input.body.byteLength, sha256}))
  const app = new Hono()
  app.route('/api/internal/routine-definitions', createRoutineDefinitionsApi(undefined, () => JSON.stringify({mini: 'host-only-' + 'y'.repeat(32)})))
  const metadata = {commit: 'b'.repeat(40), routineId: 'fixture', minimumRoutineApiVersion: 1,
    definitionSha256: 'c'.repeat(64), size: bytes.length}
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/gzip'}
  try {
    expect((await app.request(`https://core.example/api/internal/routine-definitions/bundles/${sha256}?metadata=${encodeURIComponent(JSON.stringify(metadata))}`,
      {method: 'POST', body: bytes, headers})).status).toBe(200)
    expect((await app.request('https://core.example/api/internal/routine-definitions/', {method: 'POST', body: '{}', headers})).status).toBe(401)
    expect((await app.request('https://core.example/api/internal/routine-definitions/collection', {method: 'POST', body: '{}', headers})).status).toBe(401)
  } finally {storage.mockRestore(); if(previous === undefined)delete process.env.TEST_RUN_INGEST_TOKEN;else process.env.TEST_RUN_INGEST_TOKEN=previous}
})
