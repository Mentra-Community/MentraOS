import {expect, test} from 'bun:test';
import {routineEnrollmentSchema} from '../types/routine-definition.types';
import {requestInputDigest} from './test-request.service';
import {readRoutineCollection, writeRoutineCollection, ROUTINE_COLLECTION_BATCH_SIZE} from './routine-definition-detail.service';
import {TestingDetailStorage} from './testing-detail-storage.service';
import {StorageService, type StorageProvider} from './storage/storage.service';
import {testRoutineSource} from '../testing/framework-fixtures';

const unusedStorageOperations = {
  async deleteObject() {throw Error('Unexpected deletion');}, async putFile() {throw Error('Unexpected file upload');},
  async statObject() {throw Error('Unexpected stat');}, async streamObject() {throw Error('Unexpected stream');},
};

function smallCollection(count: number) {
  const revision = 'b'.repeat(40);
  return {commit: revision, version: 43, definitions: Array.from({length: count}, (_, index) => {
    const id = `small-${index}`, definition = {id, minimumRoutineApiVersion: 1, title: id, purpose: 'Verify collection publication',
      platforms: ['android'], entry: 'home', account: 'lane', requirements: [], resourceRequirements: [], fixtures: [],
      steps: [{id: 'home', instruction: 'Open Home', expected: 'Home is visible'}],
      source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision, path: `routines/${id}/routine.ts`}};
    return routineEnrollmentSchema.parse({routineId: id, platform: 'android', definitionRevision: revision,
      routineSource: testRoutineSource(revision), definitionSha256: requestInputDigest(definition), definition});
  })};
}

test('collection writes at most eight verified definitions together and retains input order', async () => {
  const objects = new Map<string, Uint8Array>(), pending: (() => void)[] = [], started: string[] = [], reads: string[] = [];
  let active = 0, maximum = 0, manifestWrites = 0;
  const waiting = new Map<number, () => void>();
  const waitFor = (count: number) => started.length >= count ? Promise.resolve() : new Promise<void>(resolve => waiting.set(count, resolve));
  const storage = new TestingDetailStorage(new StorageService({
    ...unusedStorageOperations,
    async putObject(input) {
      if (input.key.includes('/definition/')) {
        started.push(JSON.parse(Buffer.from(input.body).toString()).routineId);
        maximum = Math.max(maximum, ++active);
        const ready = new Promise<void>(resolve => pending.push(resolve));
        for (const [count, resolve] of waiting) if (started.length >= count) {waiting.delete(count); resolve();}
        await ready;
      } else {manifestWrites++; expect(active).toBe(0); expect(reads).toHaveLength(17);}
      objects.set(input.key, input.body); return {...input, sizeBytes: input.body.length, sha256: 'a'.repeat(64)};
    },
    async getObject(key) {
      if (key.includes('/definition/')) {active--; reads.push(key);}
      return objects.get(key)!;
    },
  }), 'dev');
  const collection = smallCollection(17), operation = writeRoutineCollection(collection, storage);
  await waitFor(8); expect(started).toHaveLength(8); expect(manifestWrites).toBe(0);
  pending.splice(0).reverse().forEach(resolve => resolve());
  await waitFor(16); expect(started).toHaveLength(16); expect(manifestWrites).toBe(0);
  pending.splice(0).reverse().forEach(resolve => resolve());
  await waitFor(17); pending.splice(0).forEach(resolve => resolve());
  const result = await operation;
  expect(maximum).toBe(ROUTINE_COLLECTION_BATCH_SIZE); expect(manifestWrites).toBe(1);
  expect(result.definitions.map(row => row.routineId)).toEqual(collection.definitions.map(row => row.routineId));
  expect(requestInputDigest(await readRoutineCollection(result.detail, storage))).toBe(requestInputDigest(collection));
});

test('failed definition readback settles its pending peers and never publishes a manifest or later batch', async () => {
  const objects = new Map<string, Uint8Array>();
  let writes = 0, manifestWrites = 0, settled = false, releasePeer!: () => void, peerStarted!: () => void;
  const pendingPeer = new Promise<void>(resolve => releasePeer = resolve), started = new Promise<void>(resolve => peerStarted = resolve);
  const storage = new TestingDetailStorage(new StorageService({
    ...unusedStorageOperations,
    async putObject(input) {
      if (input.key.includes('/collection/')) manifestWrites++; else writes++;
      objects.set(input.key, input.body); return {...input, sizeBytes: input.body.length, sha256: 'a'.repeat(64)};
    },
    async getObject(key) {
      const bytes = objects.get(key)!, row = JSON.parse(Buffer.from(bytes).toString());
      if (row.routineId === 'small-0') return new Uint8Array(bytes.length); // Right size, invalid JSON.
      if (row.routineId === 'small-1') {peerStarted(); await pendingPeer;}
      return bytes;
    },
  }), 'dev');
  const operation = writeRoutineCollection(smallCollection(9), storage).finally(() => settled = true);
  const outcome = operation.then(() => null, error => error);
  await started; await Promise.resolve(); expect(settled).toBe(false);
  releasePeer(); expect((await outcome).message).toContain('JSON is invalid');
  expect(writes).toBe(8); expect(manifestWrites).toBe(0); expect(settled).toBe(true);
});

test('a valid collection larger than the object cap keeps a bounded manifest and exact separate definitions', async () => {
  const objects = new Map<string, Uint8Array>();
  const storage = new TestingDetailStorage(new StorageService({
    async putObject(input) {objects.set(input.key, input.body); return {...input, sizeBytes: input.body.length, sha256: 'a'.repeat(64)};},
    async getObject(key) {return objects.get(key)!;}, async deleteObject() {}, async putFile() {},
    async statObject() {return {sizeBytes: 0};}, async streamObject() {throw Error('no media');},
  } as StorageProvider), 'dev');
  const revision = 'a'.repeat(40), definitions = Array.from({length: 20}, (_, index) => {
    const id = `large-${index}`, definition = {id, minimumRoutineApiVersion: 1, title: id, purpose: 'Verify exact collection',
      platforms: ['android'], entry: 'home', account: 'lane', requirements: [], resourceRequirements: [], fixtures: [],
      steps: Array.from({length: 500}, (_, step) => ({id: `step-${step}`, instruction: 'x'.repeat(2000), expected: 'y'.repeat(2000)})),
      source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision, path: `routines/${id}/routine.ts`}};
    return routineEnrollmentSchema.parse({routineId: id, platform: 'android', definitionRevision: revision,
      routineSource: testRoutineSource(revision), definitionSha256: requestInputDigest(definition), definition});
  });
  const collection = {commit: revision, version: 42, definitions};
  expect(Buffer.byteLength(JSON.stringify(collection))).toBeGreaterThan(32 * 1024 * 1024);
  const {detail: pointer} = await writeRoutineCollection(collection, storage);
  expect(pointer.sizeBytes).toBeLessThan(32 * 1024);
  const restored = await readRoutineCollection(pointer, storage);
  expect(requestInputDigest(restored)).toBe(requestInputDigest(collection));
  expect(objects.size).toBe(21);
});
