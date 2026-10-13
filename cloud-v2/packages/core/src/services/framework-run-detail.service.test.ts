import {expect, test} from 'bun:test';
import {lifecycleRuns} from '../testing/framework-lifecycle.fixture';
import {verifyRunEnvelope, writeRunEnvelope, readStoredRun} from './framework-run-detail.service';
import {requestInputDigest} from './test-request.service';
import {TestingDetailStorage} from './testing-detail-storage.service';
import {StorageService, type StorageProvider} from './storage/storage.service';

test('completed manifest binds every original accepted asset and frozen failure without copying evidence', async () => {
  const payload = structuredClone(lifecycleRuns[0]!.run);
  payload.assets = [{id: 'failure-screen', kind: 'screenshot', path: 'failure.png', sha256: 'a'.repeat(64), size: 12, mimeType: 'image/png'}];
  const payloadSha256 = requestInputDigest(payload);
  const acceptedAssets = payload.assets.map(asset => ({runId: payload.result.runId, assetId: asset.id,
    storageKey: `original/${asset.id}`, sha256: asset.sha256, sizeBytes: asset.size}));
  const envelope = {version: 1, payload, payloadSha256, acceptedAssets};
  expect(verifyRunEnvelope(envelope, true).payload).toEqual(payload);
  expect(() => verifyRunEnvelope({...envelope, acceptedAssets: acceptedAssets.slice(1)}, true)).toThrow('manifest');
  expect(() => verifyRunEnvelope({...envelope, acceptedAssets: [...acceptedAssets, acceptedAssets[0]]}, true)).toThrow();
  expect(() => verifyRunEnvelope({...envelope, payloadSha256: 'f'.repeat(64)}, true)).toThrow('digest');
  expect(() => verifyRunEnvelope({...envelope, acceptedAssets: acceptedAssets.map(asset => ({...asset, runId: 'foreign'}))}, true)).toThrow('identity');
  const objects = new Map<string, Uint8Array>();
  const storage = new TestingDetailStorage(new StorageService({
    async putObject(input) {objects.set(input.key, input.body); return {...input, sizeBytes: input.body.length, sha256: payloadSha256};},
    async getObject(key) {return objects.get(key)!;}, async deleteObject() {}, async putFile() {},
    async statObject() {return {sizeBytes: 0};}, async streamObject() {throw Error('no raw evidence read');},
  } as StorageProvider), 'dev');
  const detail = await writeRunEnvelope(payload, payloadSha256, acceptedAssets, true, storage);
  expect((await readStoredRun({runId: payload.result.runId, payloadSha256, detail, uploadsComplete: true}, storage)).payload).toEqual(payload);
  await expect(readStoredRun({runId: 'foreign', payloadSha256, detail, uploadsComplete: true}, storage)).rejects.toThrow('identity');
  expect(objects.size).toBe(1);
});
