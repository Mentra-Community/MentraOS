import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {randomUUID} from 'node:crypto'
import {connectMongo, disconnectMongo} from '../packages/core/src/connections/mongo.connection'
import {TestHostStateModel} from '../packages/core/src/models/test-host-state.model'
import {TestRequestModel} from '../packages/core/src/models/test-request.model'
import {resourceReservationRepository} from '../packages/core/src/services/resource-reservations.service'
import {routineJobRepository} from '../packages/core/src/services/routine-job.service'
import type {StoredRoutineJob} from '../packages/core/src/types/routine-job.types'
import {assertConnectedTo, localTestMongoUrl} from './support/local-mongo'

// The existing guard chooses a random loopback-only database and ignores live credentials.
describe.skipIf(!process.env.CLOUD_V2_TEST_MONGO_URL)('unused routine preparation Mongo transaction', () => {
  let databaseUrl: string, verified = false
  beforeAll(async () => {
    databaseUrl = localTestMongoUrl('unused_routine_preparation')
    await connectMongo(databaseUrl)
    assertConnectedTo(databaseUrl, TestHostStateModel.db.name); verified = true
  })
  afterAll(async () => {
    if (verified) {assertConnectedTo(databaseUrl, TestHostStateModel.db.name); await TestHostStateModel.db.dropDatabase()}
    await disconnectMongo()
  })

  async function claimedOriginal() {
    assertConnectedTo(databaseUrl, TestHostStateModel.db.name)
    const now = new Date(), hostId = randomUUID(), requestId = randomUUID(), inputSha256 = 'a'.repeat(64),
      laneId = 'android', poolId = `${hostId}:disk:1`, at = now.toISOString()
    const snapshot = {hostId, incarnation: 'current-controller', incarnationGeneration: 2, sequence: 3, observedAt: at,
      lanes: [{id: laneId, platform: 'android', state: 'idle', dispatchMode: 'automatic', resources: [
        {id: `${hostId}:phone`, kind: 'phone', capabilities: ['backend-connectivity']},
        {id: `${hostId}:recorder`, kind: 'recorder', storage: {poolId, observedAt: at, availableBytes: 64 * 1024 ** 3,
          stagingBudgetBytes: 10 * 1024 ** 3, pendingEvidenceBytes: 0, reservations: []}},
      ]}], resourceLifecycle: {subjects: []}}
    await TestHostStateModel.collection.insertOne({hostId, incarnation: snapshot.incarnation, incarnationGeneration: 2,
      sequence: 3, receivedAt: now, laneControlVersion: 0, resourceReservationVersion: 0, resourceReservations: [], snapshot})
    const row = {requestId, state: 'awaiting-runner', fleetInputSha256: inputSha256, fleetDeadline: new Date(now.getTime() + 60000),
      fleetSelection: {requestId, routineId: 'battery-status-android', platform: 'android', routineRevision: 'b'.repeat(40)},
      fleetPreparation: {routineSource: {commit: 'b'.repeat(40)}}} as unknown as StoredRoutineJob
    await TestRequestModel.collection.insertOne(row as never)
    const host = (await resourceReservationRepository.get(hostId))!,
      quota = {id: randomUUID(), requestId, fleetInputSha256: inputSha256, hostId, laneId, poolId,
        minimumAvailableBytes: 3 * 1024 ** 3, reservedAt: at},
      admission = {intent: {operationId: `run:${requestId}`, hostId, laneId, inputSha256,
        owner: {kind: 'run' as const, id: requestId}, controller: {incarnation: host.incarnation, generation: 2, sequence: 3},
        resources: [{id: `${hostId}:recorder`, capabilities: []}]}, dependencies: []}
    const claimed = (await resourceReservationRepository.claimFleet!(row, host, [quota], admission, {fleetResourceReservation: quota}, now))!
    expect(claimed.fleetResourceReservation).toEqual(quota)
    return {claimed, hostId}
  }

  test('returns its unused bytes and request receipt together, preserving the frozen original', async () => {
    const {claimed, hostId} = await claimedOriginal()
    expect(await routineJobRepository.releaseUnusedPreparation!(claimed)).toBe(true)
    const row = (await TestRequestModel.collection.findOne({requestId: claimed.requestId}))!,
      host = (await resourceReservationRepository.get(hostId))!
    expect(row.fleetResourceReservation).toBeUndefined()
    expect(row.fleetResourceAdmission).toBeUndefined()
    expect(row.fleetBinding).toBeUndefined()
    expect(host.resourceReservations).toEqual([])
    expect(host.resourceReservationVersion).toBe(2)
    for (const key of ['requestId', 'fleetSelection', 'fleetInputSha256', 'fleetPreparation', 'fleetDeadline'] as const)
      expect(row[key]).toEqual(claimed[key])
    const {_id: _storedId, fleetResourceReservation: _quota, fleetResourceAdmission: _admission, ...unclaimed} =
      claimed as StoredRoutineJob & {_id?: unknown}
    const nextId = randomUUID(), next = {...unclaimed, requestId: nextId, fleetInputSha256: 'c'.repeat(64),
      fleetSelection: {...unclaimed.fleetSelection, requestId: nextId}},
      nextQuota = {...claimed.fleetResourceReservation!, id: randomUUID(), requestId: next.requestId, fleetInputSha256: next.fleetInputSha256},
      nextAdmission = {...claimed.fleetResourceAdmission!, intent: {...claimed.fleetResourceAdmission!.intent,
        operationId: `run:${next.requestId}`, inputSha256: next.fleetInputSha256!, owner: {kind: 'run' as const, id: next.requestId}}}
    await TestRequestModel.collection.insertOne(next as never)
    expect((await resourceReservationRepository.claimFleet!(next, host, [nextQuota], nextAdmission,
      {fleetResourceReservation: nextQuota}, new Date()))?.fleetResourceReservation).toEqual(nextQuota)
  })

  for (const race of ['binding', 'cancellation', 'report'] as const) test(`loses concurrent ${race} without a partial return`, async () => {
    const {claimed, hostId} = await claimedOriginal(), get = resourceReservationRepository.get
    let raced = false
    resourceReservationRepository.get = async (id, options) => {
      const captured = await get(id, options)
      if (!raced && id === hostId) {
        raced = true; assertConnectedTo(databaseUrl, TestHostStateModel.db.name)
        if (race === 'report') await TestHostStateModel.collection.updateOne({hostId}, {$inc: {sequence: 1, 'snapshot.sequence': 1}})
        else await TestRequestModel.collection.updateOne({requestId: claimed.requestId}, {$set: race === 'binding'
          ? {fleetBinding: {hostId, laneId: 'android'}, hostId, state: 'preparing'}
          : {fleetCancellation: {requestedAt: new Date().toISOString(), reason: 'Original cancellation won'}}})
      }
      return captured
    }
    try {
      expect(await routineJobRepository.releaseUnusedPreparation!(claimed)).toBe(false)
      const row = (await TestRequestModel.collection.findOne({requestId: claimed.requestId}))!, host = (await get(hostId))!
      expect(raced).toBe(true)
      expect(row.fleetResourceReservation).toEqual(claimed.fleetResourceReservation)
      expect(row.fleetResourceAdmission).toEqual(claimed.fleetResourceAdmission)
      expect(host.resourceReservations).toEqual([claimed.fleetResourceReservation])
      if (race === 'binding') expect(row.fleetBinding).toBeDefined()
      if (race === 'cancellation') expect(row.fleetCancellation).toBeDefined()
    } finally {resourceReservationRepository.get = get}
  })
})
