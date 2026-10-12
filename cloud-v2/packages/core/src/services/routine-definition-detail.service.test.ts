import {expect, test} from 'bun:test';
import {routineEnrollmentSchema} from '../types/routine-definition.types';
import {requestInputDigest} from './test-request.service';
import {readRoutineCollection, writeRoutineCollection} from './routine-definition-detail.service';
import {TestingDetailStorage} from './testing-detail-storage.service';
import {StorageService, type StorageProvider} from './storage/storage.service';
import {testRoutineSource} from '../testing/framework-fixtures';

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
