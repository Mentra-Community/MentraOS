import {expect, test} from 'bun:test';
import {z} from 'zod';
import {TestingDetailStorage} from './testing-detail-storage.service';
import {StorageService, type StorageProvider} from './storage/storage.service';
import {requestInputDigest} from './test-request.service';

function fixture() {
  const objects = new Map<string, Uint8Array>();
  const provider: StorageProvider = {
    async putObject(value) {objects.set(value.key, value.body); return {key: value.key, contentType: value.contentType,
      sizeBytes: value.body.byteLength, sha256: requestInputDigest(JSON.parse(Buffer.from(value.body).toString()))};},
    async getObject(key) {const value = objects.get(key); if (!value) throw new Error('missing'); return value;},
    async deleteObject(key) {objects.delete(key);}, async putFile() {throw new Error('not used');},
    async statObject() {throw new Error('not used');}, async streamObject() {throw new Error('not used');},
  };
  return {objects, service: new TestingDetailStorage(new StorageService(provider), 'dev')};
}
test('immutable detail uses environment-scoped canonical bytes and verifies readback', async () => {
  const {objects, service} = fixture();
  const first = await service.write('run', 'a/run', {z: 1, a: 2});
  const retry = await service.write('run', 'a/run', {a: 2, z: 1});
  expect(retry).toEqual(first); expect(objects.size).toBe(1);
  expect(first.key).toStartWith('testing-detail/dev/run/'); expect(first.key).not.toContain('a/run');
  expect(Buffer.from(objects.get(first.key)!).toString()).toBe('{"a":2,"z":1}');
  expect(await service.read(first, z.object({a: z.number(), z: z.number()}).strict())).toEqual({a: 2, z: 1});
});
test('missing, corrupt, wrong-sized or differently typed detail fails without fabricated empty results', async () => {
  const {objects, service} = fixture(), pointer = await service.write('run', 'run', {status: 'failed'});
  await expect(service.read(pointer, z.object({pass: z.boolean()}))).rejects.toMatchObject({status: 503});
  const bytes = objects.get(pointer.key)!;
  objects.set(pointer.key, Buffer.from('{"status":"passed"}'));
  await expect(service.read(pointer, z.unknown())).rejects.toMatchObject({status: 503});
  objects.set(pointer.key, Buffer.from('{"status":"wrong!"}'));
  await expect(service.read(pointer, z.unknown())).rejects.toMatchObject({status: 503});
  objects.delete(pointer.key);
  await expect(service.read(pointer, z.unknown())).rejects.toMatchObject({status: 503});
  objects.set(pointer.key, bytes);
  expect(await service.read(pointer, z.object({status: z.literal('failed')}))).toEqual({status: 'failed'});
});
