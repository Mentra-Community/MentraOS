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
