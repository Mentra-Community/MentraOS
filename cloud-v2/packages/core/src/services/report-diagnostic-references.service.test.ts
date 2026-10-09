import {afterEach, expect, spyOn, test} from 'bun:test'
import {createHash} from 'node:crypto'
import {ReportAssetModel} from '../models/report-asset.model'
import {ReportModel} from '../models/report.model'
import {TestAssetModel} from '../models/test-run.model'
import {testFrameworkBinding, testRoutineSource} from '../testing/framework-fixtures'
import {recordedFrameworkRunSchema, type RecordedFrameworkRun} from '../types/framework-run.types'
import {referenceTestRunDiagnostics} from './report.service'
import {requestInputDigest} from './test-request.service'

const mocks: Array<{mockRestore(): void}> = []
afterEach(() => mocks.splice(0).forEach(mock => mock.mockRestore()))
const owner = {reportId: 'rep_diagnostic_reference_fixture', mentraUserId: 'automation:test-run'}
const writeOptions = {writeConcern: {w: 'majority', j: true, wtimeout: 10_000}, timeoutMS: 10_000}
type Reference = {
  artifactId: string; reportId: string; mentraUserId: string; storageKey: string; sourceTestRunId: string
  sourceTestAssetId: string; fileName: string; contentType: string; sizeBytes: number; sha256: string
}
type Row = Reference & {createdAt: Date}
type Metadata = {artifactId: string; type: string; source: string; filename: string; contentType: string; sizeBytes: number; createdAt: Date}

function frozenRun(count: number): RecordedFrameworkRun {
  const hash = createHash('sha256').update('original diagnostic bytes').digest('hex')
  const assets = Array.from({length: count}, (_, index) => ({id: `diagnostic:${index}`, kind: index % 2 ? 'report' : 'diagnostic',
    path: `original/nested/diagnostic-${index}.json`, sha256: hash, size: index + 1, mimeType: 'application/json'}))
  return recordedFrameworkRunSchema.parse({schemaVersion: 1, requestId: 'diagnostic-reference-run', hostId: 'host', laneId: 'android',
    routineId: 'notes', routineSource: testRoutineSource(), frameworkBinding: testFrameworkBinding(), definitionRevision: 'a'.repeat(40),
    platform: 'android', build: {repository: 'Mentra-Community/MentraOS', channel: 'dev', headSha: 'b'.repeat(40)},
    startedAt: '2026-10-08T10:00:00Z', finishedAt: '2026-10-08T10:01:00Z', assets,
    result: {runId: 'diagnostic-reference-run', finishedAt: '2026-10-08T10:01:00Z', setup: {status: 'failed'}, test: 'not-run',
      steps: [{id: 'required', status: 'not-run', durationMs: 0, causedBy: 'original'}],
      teardown: {ready: true, outcomes: [], errors: [], unavailableResources: []},
      failures: [{phase: 'setup', actionId: 'original', message: 'Original setup failure'}], evidence: assets.map(asset => asset.id),
      timing: {startedAt: '2026-10-08T10:00:00Z', setupMs: 10, testMs: 0, teardownMs: 10}}})
}

function models(run: RecordedFrameworkRun) {
  const assets = new Map(run.assets.map(asset => [asset.id, {runId: run.result.runId, assetId: asset.id,
    storageKey: `test-runs/original/${asset.id}`, sha256: asset.sha256, sizeBytes: asset.size}]))
  const rows = new Map<string, Row>(), metadata = new Map<string, Metadata>()
  const assetReads: string[][] = [], referenceReads: string[][] = [], writes: Reference[][] = [], metadataWrites: Metadata[][] = []
  let serial = 0, failOnWrite: number | undefined, forbidWrites = false
  const committedError = new Error('Bulk acknowledgement was lost after commit')
  const query = <T>(readRows: () => T[]) => ({
    read(value: string) {expect(value).toBe('primary'); return this},
    readConcern(value: string) {expect(value).toBe('majority'); return this},
    setOptions(value: unknown) {expect(value).toEqual({timeoutMS: 10_000}); return this},
    async lean() {return readRows()},
  })
  mocks.push(spyOn(TestAssetModel, 'find').mockImplementation(((filter: {runId: string; assetId: {$in: string[]}}) => {
    expect(filter.runId).toBe(run.result.runId)
    expect(filter.assetId.$in.length).toBeGreaterThan(0)
    expect(filter.assetId.$in.length).toBeLessThanOrEqual(100)
    assetReads.push([...filter.assetId.$in])
    return query(() => filter.assetId.$in.flatMap(id => assets.has(id) ? [assets.get(id)!] : []))
  }) as never))
  mocks.push(spyOn(ReportAssetModel, 'find').mockImplementation(((filter: {artifactId: {$in: string[]}}) => {
    expect(Object.keys(filter)).toEqual(['artifactId'])
    expect(filter.artifactId.$in.length).toBeGreaterThan(0)
    expect(filter.artifactId.$in.length).toBeLessThanOrEqual(100)
    referenceReads.push([...filter.artifactId.$in])
    return query(() => filter.artifactId.$in.flatMap(id => rows.has(id) ? [rows.get(id)!] : []))
  }) as never))
  mocks.push(spyOn(ReportAssetModel, 'bulkWrite').mockImplementation((async (
    operations: Array<{updateOne: {filter: {artifactId: string}; update: {$setOnInsert: Reference}; upsert: boolean}}>, options: unknown,
  ) => {
    if (forbidWrites) throw new Error('Retry must reuse durable references without another upsert')
    expect(options).toEqual({...writeOptions, ordered: false})
    expect(operations.length).toBeGreaterThan(0)
    expect(operations.length).toBeLessThanOrEqual(100)
    const references = operations.map(({updateOne}) => {
      const reference = updateOne.update.$setOnInsert
      expect(updateOne.filter).toEqual({artifactId: reference.artifactId})
      expect(updateOne.upsert).toBe(true)
      if (rows.has(reference.artifactId)) throw new Error('Existing reference was submitted for another upsert')
      rows.set(reference.artifactId, {...reference, createdAt: new Date(Date.UTC(2026, 9, 8) + serial++)})
      return {...reference}
    })
    writes.push(references)
    if (writes.length === failOnWrite) throw committedError
    return {}
  }) as never))
  mocks.push(spyOn(ReportModel, 'updateOne').mockImplementation((async (
    selectedOwner: unknown, update: {$addToSet: {artifacts: {$each: Metadata[]}}}, options: unknown,
  ) => {
    expect(selectedOwner).toEqual(owner)
    expect(options).toEqual(writeOptions)
    const selected = update.$addToSet.artifacts.$each
    expect(selected.length).toBeGreaterThan(0)
    expect(selected.length).toBeLessThanOrEqual(100)
    for (const entry of selected) {
      const row = rows.get(entry.artifactId)!
      const screenshot = run.assets.find(asset => asset.id === row.sourceTestAssetId)!.kind === 'screenshot'
      expect(entry).toEqual({artifactId: row.artifactId, type: screenshot ? 'screenshot' : 'state_snapshot',
        source: screenshot ? 'framework-screenshot' : 'framework-diagnostic', filename: row.fileName,
        contentType: row.contentType, sizeBytes: row.sizeBytes, createdAt: row.createdAt})
      if (metadata.has(entry.artifactId)) expect(entry).toEqual(metadata.get(entry.artifactId)!)
      metadata.set(entry.artifactId, {...entry})
    }
    metadataWrites.push(selected.map(entry => ({...entry})))
    return {matchedCount: 1}
  }) as never))
  return {assets, rows, metadata, assetReads, referenceReads, writes, metadataWrites, committedError,
    failAfterCommit(write: number) {failOnWrite = write},
    allowWrites() {failOnWrite = undefined},
    forbidWrites() {forbidWrites = true},
    resetCalls() {assetReads.length = referenceReads.length = writes.length = metadataWrites.length = 0},
  }
}

for (const count of [1389, 4096]) {
  test(`${count} diagnostic and report references use bounded majority reads, writes and metadata without changing the frozen run`, async () => {
    const run = frozenRun(count), frozenDigest = requestInputDigest(run), f = models(run)
    expect(await referenceTestRunDiagnostics(owner, run)).toBe(count)
    expect(f.assetReads).toHaveLength(Math.ceil(count / 100))
    expect(f.referenceReads).toHaveLength(Math.ceil(count / 100) * 2)
    const batchLengths = [...Array(Math.floor(count / 100)).fill(100), count % 100]
    expect(f.writes.map(batch => batch.length)).toEqual(batchLengths)
    expect(f.metadataWrites.map(batch => batch.length)).toEqual(batchLengths)
    expect(f.rows.size).toBe(count)
    expect(f.metadata.size).toBe(count)
    expect(requestInputDigest(run)).toBe(frozenDigest)
  })
}

test('all durable references are verified and reused with zero bulk writes on completion retry', async () => {
  const run = frozenRun(1389), f = models(run)
  await referenceTestRunDiagnostics(owner, run)
  const timestamps = new Map([...f.rows].map(([id, row]) => [id, row.createdAt]))
  f.resetCalls()
  f.forbidWrites()
  expect(await referenceTestRunDiagnostics(owner, run)).toBe(1389)
  expect(f.writes).toHaveLength(0)
  expect(f.referenceReads).toHaveLength(14)
  expect(f.metadata.size).toBe(1389)
  expect(new Map([...f.rows].map(([id, row]) => [id, row.createdAt]))).toEqual(timestamps)
})

for (const interruptedBatch of [1, 2, 14]) {
  test(`a committed batch ${interruptedBatch} with lost acknowledgement retries only missing references and retains original timestamps`, async () => {
    const run = frozenRun(1389), frozenDigest = requestInputDigest(run), f = models(run)
    f.failAfterCommit(interruptedBatch)
    await expect(referenceTestRunDiagnostics(owner, run)).rejects.toBe(f.committedError)
    expect(f.rows.size).toBe(Math.min(1389, interruptedBatch * 100))
    expect(f.metadata.size).toBe((interruptedBatch - 1) * 100)
    const committed = new Map([...f.rows].map(([id, row]) => [id, row.createdAt]))
    f.resetCalls()
    f.allowWrites()
    expect(await referenceTestRunDiagnostics(owner, run)).toBe(1389)
    expect(f.writes.flat()).toHaveLength(1389 - committed.size)
    expect(f.writes.flat().some(reference => committed.has(reference.artifactId))).toBe(false)
    for (const [id, timestamp] of committed) expect(f.rows.get(id)!.createdAt).toBe(timestamp)
    expect(f.rows.size).toBe(1389)
    expect(f.metadata.size).toBe(1389)
    expect(requestInputDigest(run)).toBe(frozenDigest)
  })
}

for (const [field, value] of Object.entries({reportId: 'rep_foreign', mentraUserId: 'foreign-owner', storageKey: 'foreign-blob',
  sha256: 'f'.repeat(64), sizeBytes: 999, sourceTestRunId: 'foreign-run', sourceTestAssetId: 'foreign-asset',
  fileName: 'different.json', contentType: 'text/plain'})) {
  test(`a durable reference with conflicting ${field} rejects before metadata or upserts`, async () => {
    const run = frozenRun(1), f = models(run)
    await referenceTestRunDiagnostics(owner, run)
    const row = [...f.rows.values()][0]!
    Object.assign(row, {[field]: value})
    f.metadata.clear()
    f.resetCalls()
    await expect(referenceTestRunDiagnostics(owner, run)).rejects.toMatchObject({status: 409})
    expect(f.writes).toHaveLength(0)
    expect(f.metadataWrites).toHaveLength(0)
    expect(f.metadata.size).toBe(0)
  })
}

test('missing original asset custody rejects before references or metadata can be published', async () => {
  const run = frozenRun(1), f = models(run)
  f.assets.clear()
  await expect(referenceTestRunDiagnostics(owner, run)).rejects.toMatchObject({status: 503})
  expect(f.writes).toHaveLength(0)
  expect(f.metadataWrites).toHaveLength(0)
})

function screenshotRun(): RecordedFrameworkRun {
  const run = frozenRun(2)
  run.assets.push(...(['png', 'jpeg'] as const).map(extension => ({
    id: `screenshots/original.${extension}`, kind: 'screenshot' as const, path: `screenshots/original.${extension}`,
    sha256: createHash('sha256').update(`original ${extension} bytes`).digest('hex'), size: 123,
    mimeType: `image/${extension}` as 'image/png' | 'image/jpeg',
  })))
  run.assets.push({id: 'recording', kind: 'recording', path: 'recordings/original.mp4', sha256: 'a'.repeat(64), size: 456, mimeType: 'video/mp4'})
  return recordedFrameworkRunSchema.parse(run)
}

test('screenshots reference original bytes with screenshot metadata, retain JSON diagnostics and reuse exact receipts on retry', async () => {
  const run = screenshotRun(), before = requestInputDigest(run), f = models(run)
  f.failAfterCommit(1)
  await expect(referenceTestRunDiagnostics(owner, run)).rejects.toBe(f.committedError)
  const originals = new Map([...f.rows].map(([id, row]) => [id, {...row}]))
  f.allowWrites(); f.resetCalls(); f.forbidWrites()
  expect(await referenceTestRunDiagnostics(owner, run)).toBe(4)
  expect(f.writes).toHaveLength(0)
  expect(f.rows).toEqual(originals)
  expect([...f.metadata.values()].map(entry => entry.type)).toEqual(['state_snapshot', 'state_snapshot', 'screenshot', 'screenshot'])
  expect([...f.rows.values()].map(row => row.storageKey)).toEqual(run.assets.slice(0, 4).map(asset => `test-runs/original/${asset.id}`))
  expect([...f.rows.values()].map(row => row.sourceTestAssetId)).not.toContain('recording')
  expect(requestInputDigest(run)).toBe(before)
})

for (const [field, value] of Object.entries({sha256: 'f'.repeat(64), sizeBytes: 999, storageKey: 'different/original', contentType: 'text/plain'})) {
  test(`a screenshot reference with conflicting ${field} refuses reuse`, async () => {
    const run = screenshotRun(), f = models(run)
    await referenceTestRunDiagnostics(owner, run)
    const row = [...f.rows.values()].find(row => row.contentType === 'image/png')!
    Object.assign(row, {[field]: value})
    f.resetCalls()
    await expect(referenceTestRunDiagnostics(owner, run)).rejects.toMatchObject({status: 409})
    expect(f.writes).toHaveLength(0); expect(f.metadataWrites).toHaveLength(0)
  })
}

for (const [field, value] of Object.entries({sha256: 'f'.repeat(64), sizeBytes: 999})) {
  test(`screenshot custody with a different ${field} refuses attachment`, async () => {
    const run = screenshotRun(), f = models(run)
    Object.assign(f.assets.get('screenshots/original.png')!, {[field]: value})
    await expect(referenceTestRunDiagnostics(owner, run)).rejects.toMatchObject({status: 503})
    expect(f.writes).toHaveLength(0); expect(f.metadataWrites).toHaveLength(0)
  })
}

test('a screenshot without acknowledged original custody is not attached', async () => {
  const run = screenshotRun(), f = models(run)
  f.assets.delete('screenshots/original.png')
  await expect(referenceTestRunDiagnostics(owner, run)).rejects.toMatchObject({status: 503})
  expect(f.writes).toHaveLength(0); expect(f.metadataWrites).toHaveLength(0)
})
