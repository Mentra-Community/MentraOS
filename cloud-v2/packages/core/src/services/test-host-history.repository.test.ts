import {expect, test} from 'bun:test'
import {TestHostSampleModel} from '../models/test-host-health.model'
import {testHostHistoryRepository} from './test-host-history.repository'

test('debug delivery reuses existing immutable host samples without reading current state or refreshing retries', async () => {
  const original = TestHostSampleModel.collection.updateOne, calls: any[] = []
  try {
    TestHostSampleModel.collection.updateOne = (async (...args: any[]) => {calls.push(structuredClone(args)); return {upsertedCount: 1}}) as any
    const payload = {frameworkHistory: [{incarnation: 'original', arbitraryDebug: true}], resourceHistory: [{id: 'failed-original'}]}
    const receivedAt = new Date('2026-10-27T10:00:00Z')
    await testHostHistoryRepository.debug({hostId: 'mini', incarnationGeneration: 1, sequence: 1, receivedAt, payload})
    await testHostHistoryRepository.debug({hostId: 'mini', incarnationGeneration: 1, sequence: 2, receivedAt: new Date(+receivedAt + 60_000), payload})
    expect(calls[0][0]).toEqual(calls[1][0])
    expect(calls[0][0].sampleId).toStartWith('framework-debug:')
    expect(calls[0][1]).toHaveProperty('$setOnInsert')
    expect(calls[0][1]).not.toHaveProperty('$set')
    expect(calls[0][1].$setOnInsert).toMatchObject({kind: 'framework-debug', payload, receivedAt, sampledAt: receivedAt})
    expect(calls[0][2]).toEqual({upsert: true, writeConcern: {w: 'majority', j: true}, timeoutMS: 5000})
  } finally {TestHostSampleModel.collection.updateOne = original}
})

test('explicit debug detail uses the existing bounded sample index and never validates history as current authority', async () => {
  const original = TestHostSampleModel.collection.find, calls: Record<string, unknown> = {}
  const cursor = {sort(value: unknown) {calls.sort = value; return this}, hint(value: unknown) {calls.hint = value; return this},
    limit(value: number) {calls.limit = value; return this}, maxTimeMS(value: number) {calls.maxTimeMS = value; return this},
    async toArray() {return [{payload: {resourceHistory: [{id: 'second', arbitrary: 'debug'}]}},
      {payload: {resourceHistory: [{id: 'first', malformedPastObservation: true}]}}]}}
  try {
    TestHostSampleModel.collection.find = ((filter: unknown, options: unknown) => {calls.filter = filter; calls.options = options; return cursor}) as any
    const debug = await testHostHistoryRepository.detail('mini')
    expect(calls).toMatchObject({filter: {hostId: 'mini', kind: 'framework-debug'}, sort: {sampledAt: -1, sampleId: -1},
      hint: 'host_sample_history', limit: 100, maxTimeMS: 5000})
    expect(calls.options).toEqual({projection: {payload: 1, _id: 0}, readPreference: 'primary', readConcern: {level: 'majority'}, timeoutMS: 5000})
    expect(debug?.resourceHistory).toEqual([{id: 'first', malformedPastObservation: true}, {id: 'second', arbitrary: 'debug'}])
  } finally {TestHostSampleModel.collection.find = original}
})
