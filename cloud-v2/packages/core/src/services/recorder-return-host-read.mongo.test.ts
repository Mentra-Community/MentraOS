import {afterAll, beforeAll, describe, expect, test} from 'bun:test';
import {randomUUID} from 'node:crypto';
import mongoose from 'mongoose';
import {TestHostStateModel} from '../models/test-host-state.model';
import {TestRequestModel} from '../models/test-request.model';
import {resourceReservationRepository} from './resource-reservations.service';
import {routineJobRepository} from './routine-job.service';

const uri = process.env.TEST_ROUTINE_MONGO_URI;
describe.skipIf(!uri)('Mongo recorder return reads a bounded host view', () => {
  let connected = false;
  beforeAll(async () => {
    const url = new URL(uri!);
    if (url.protocol !== 'mongodb:' || url.hostname !== '127.0.0.1' || url.username || url.password)
      throw new Error('Recorder return integration tests require plain loopback Mongo');
    url.pathname = `/recorder_return_${randomUUID().replaceAll('-', '')}`;
    await mongoose.connect(url.href, {autoIndex: false, serverSelectionTimeoutMS: 5_000}); connected = true;
  });
  afterAll(async () => {if (connected) {await mongoose.connection.dropDatabase(); await mongoose.disconnect();}});

  test('a host with large journals and history still returns its recorder claim through the CAS fence', async () => {
    const now = Date.now(), at = (offset: number) => new Date(now + offset).toISOString(), hostId = 'mini';
    const offer = {poolId: 'mini:disk:1', observedAt: at(-1_000), availableBytes: 8 * 1024 ** 3, stagingBudgetBytes: 10 * 1024 ** 3,
      pendingEvidenceBytes: 0, reservations: []};
    const claim = {id: randomUUID(), requestId: 'cancelled-before-binding', fleetInputSha256: 'a'.repeat(64), hostId, laneId: 'mac',
      poolId: offer.poolId, minimumAvailableBytes: 3 * 1024 ** 3, reservedAt: at(-10_000)};
    // Shaped like dev's host documents: bounded journals and histories add ~500 KB that return reconciliation never reads.
    const filler = (count: number, bytes: number) => Array.from({length: count}, (_, index) => ({index, detail: 'x'.repeat(bytes)}));
    await TestHostStateModel.collection.insertOne({hostId, incarnation: 'controller-1', incarnationGeneration: 4, sequence: 17,
      receivedAt: new Date(now - 1_000), laneControlVersion: 3, resourceReservationVersion: 9, resourceReservations: [claim],
      laneControls: filler(20, 1_500), resourceLifecycleCursor: {schemaVersion: 12, subjects: [], history: filler(200, 400)},
      frameworkHistory: filler(100, 700), frameworkStopReceipts: filler(10, 1_500),
      snapshot: {hostId, incarnation: 'controller-1', incarnationGeneration: 4, sequence: 17, observedAt: at(-1_000),
        lanes: [{id: 'mac', platform: 'ios-on-mac', state: 'idle', dispatchMode: 'automatic', descriptorRevision: 'r1',
          resources: [{id: 'recorder', kind: 'recorder', storage: offer}]}],
        resourceReservations: {resourceChecks: filler(100, 2_300)}, resourceLifecycle: {subjects: [], history: filler(200, 400)},
        restoration: {attempts: filler(50, 1_000)}, frameworkHistory: filler(100, 700)}});
    await TestRequestModel.collection.insertOne({requestId: claim.requestId, fleetInputSha256: claim.fleetInputSha256,
      state: 'terminal', fleetCancellation: {requestedAt: at(-5_000), reason: 'Cancelled before binding'}});

    const full = await TestHostStateModel.collection.findOne({hostId});
    const narrow = await resourceReservationRepository.get(hostId, {recorderReturn: true});
    expect(mongoose.mongo.BSON.calculateObjectSize(full!)).toBeGreaterThan(500_000);
    expect(mongoose.mongo.BSON.calculateObjectSize(narrow as object)).toBeLessThan(4_000);
    expect(narrow!.snapshot.lanes[0]!.resources[0]).toEqual({id: 'recorder', kind: 'recorder', storage: offer} as never);

    let returned = 0;
    expect(await routineJobRepository.reconcileRecorderHost!(hostId, new Date(now), undefined, () => {returned++})).toBe(true);
    expect(returned).toBe(1);
    const after = await TestHostStateModel.collection.findOne({hostId});
    expect(after!.resourceReservations).toEqual([]);
    expect(after!.resourceReservationVersion).toBe(10);
    expect(after!.laneControlVersion).toBe(3);
  });
});
