import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {RoutineSourceBundleService} from './routine-source-bundle.service';
import {StorageService, type StorageProvider} from './storage/storage.service';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(bytes); controller.close();}});
function fixture() {
  const objects = new Map<string, Uint8Array>();
  const provider: StorageProvider = {
    async putObject(input) {objects.set(input.key, input.body); return {key: input.key, contentType: input.contentType, sizeBytes: input.body.byteLength, sha256: digest(input.body)};},
    async getObject(key) {return objects.get(key)!;}, async deleteObject(key) {objects.delete(key);}, async putFile() {throw Error('unused');},
    async statObject(key) {return {sizeBytes: objects.get(key)!.byteLength};}, async streamObject(key) {return stream(objects.get(key)!);},
  };
  return {objects, service: new RoutineSourceBundleService(() => new StorageService(provider)), provider};
}
const metadata = (bytes: Uint8Array) => ({commit: 'a'.repeat(40), routineId: 'an-arbitrary-routine', minimumRoutineApiVersion: 2, definitionSha256: 'd'.repeat(64), size: bytes.byteLength});
test('verified immutable routine archive uses existing authenticated storage and retries identical bytes', async () => {
  const f = fixture(), bytes = gzipSync('fixture source archive'), hash = digest(bytes), info = metadata(bytes);
  const first = await f.service.publish(hash, info, stream(bytes), 'https://core.example/api/internal/routine-definitions');
  expect(first).toEqual({repository: 'Mentra-Community/Mentra-Automated-Testing', commit: info.commit, minimumRoutineApiVersion: 2,
    bundle: {url: `https://core.example/api/internal/routine-definitions/bundles/${hash}`, sha256: hash, size: bytes.byteLength}});
  expect(await f.service.publish(hash, info, stream(bytes), 'https://core.example')).toEqual(first);
  expect(f.objects.size).toBe(1);
  const response = await f.service.download(hash);
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(bytes));
  expect(response.headers.get('cache-control')).toBe('private, immutable');
});
test('bad digest, incomplete and oversized archives never reach storage', async () => {
  const f = fixture(), bytes = gzipSync('fixture');
  await expect(f.service.publish('b'.repeat(64), metadata(bytes), stream(bytes), 'https://core.example')).rejects.toThrow('digest differs');
  await expect(f.service.publish(digest(bytes), {...metadata(bytes), size: bytes.length + 1}, stream(bytes), 'https://core.example')).rejects.toThrow('size or digest');
  await expect(f.service.publish(digest(bytes), {...metadata(bytes), size: bytes.length - 1}, stream(bytes), 'https://core.example')).rejects.toThrow('exceeds');
  const plain = Buffer.from('not gzip');
  await expect(f.service.publish(digest(plain), metadata(plain), stream(plain), 'https://core.example')).rejects.toThrow('gzip');
  expect(f.objects.size).toBe(0);
});
test('storage acknowledgement must match verified bytes', async () => {
  const f = fixture(), bytes = gzipSync('fixture');
  f.provider.putObject = async input => ({key: input.key, contentType: input.contentType, sizeBytes: input.body.byteLength, sha256: 'f'.repeat(64)});
  await expect(f.service.publish(digest(bytes), metadata(bytes), stream(bytes), 'https://core.example')).rejects.toThrow('receipt differs');
});
