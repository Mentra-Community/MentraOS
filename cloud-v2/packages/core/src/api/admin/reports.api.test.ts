import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import {mkdtemp, open, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from 'hono';
import {createLogger} from '@mentra/cloud-shared';
import {ReportAssetModel} from '../../models/report-asset.model';
import {LocalStorageProvider} from '../../services/storage/providers/local-storage.provider';
import {StorageService} from '../../services/storage/storage.service';
import type {AppEnv} from '../../types/hono.types';
import reports from './reports.api';

const size = 128 * 1024 * 1024;
const sha256 = 'a'.repeat(64);
const signatures = {
  png: Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  jpeg: Uint8Array.of(0xff, 0xd8, 0xff, 0xe0),
};
let directory: string;
let provider: LocalStorageProvider;
let asset = {reportId: 'report', artifactId: 'screenshot', storageKey: 'png', sizeBytes: size,
  sha256, contentType: 'image/png', fileName: 'captured.png'};
let find: ReturnType<typeof spyOn>;
let stat: ReturnType<typeof spyOn>;
let stream: ReturnType<typeof spyOn>;
let buffer: ReturnType<typeof spyOn>;

const app = new Hono<AppEnv>();
app.use('*', async (c, next) => {c.set('logger', createLogger('report-artifact-test')); await next();});
app.route('/', reports);
const path = '/report/artifacts/screenshot';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'report-screenshot-stream-'));
  provider = new LocalStorageProvider({rootDir: directory});
  // Sparse files exercise the actual local stat/range provider at the largest
  // frozen screenshot size without allocating an image-sized test buffer.
  for (const [kind, signature] of Object.entries(signatures)) {
    const file = await open(join(directory, kind), 'w');
    try {await file.truncate(size); await file.write(signature, 0, signature.length, 0);}
    finally {await file.close();}
  }
});
beforeEach(() => {
  asset = {...asset, storageKey: 'png', sizeBytes: size, contentType: 'image/png', fileName: 'captured.png'};
  find = spyOn(ReportAssetModel, 'findOne').mockImplementation(() => ({lean: async () => asset}) as never);
  stat = spyOn(StorageService.prototype, 'statObject').mockImplementation(key => provider.statObject(key));
  stream = spyOn(StorageService.prototype, 'streamObject').mockImplementation((key, range) => provider.streamObject(key, range));
  buffer = spyOn(StorageService.prototype, 'getObject').mockImplementation(async () => {throw new Error('full-buffer retrieval is forbidden');});
});
afterEach(() => {find.mockRestore(); stat.mockRestore(); stream.mockRestore(); buffer.mockRestore();});
afterAll(async () => {await rm(directory, {recursive: true, force: true});});

describe('report artifact streaming', () => {
  test('large PNG and JPEG HEAD/probes use frozen metadata and only the requested storage range', async () => {
    for (const [kind, signature] of Object.entries(signatures)) {
      asset = {...asset, storageKey: kind, contentType: `image/${kind}`, fileName: `capture.${kind}`};
      const head = await app.request(path, {method: 'HEAD'});
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(size));
      expect(head.headers.get('content-type')).toBe(`image/${kind}`);
      expect(head.headers.get('etag')).toBe(`"${sha256}"`);
      expect(await head.text()).toBe('');
      expect(stream).not.toHaveBeenCalled();

      const headRange = await app.request(path, {method: 'HEAD', headers: {range: 'bytes=0-0'}});
      expect(headRange.status).toBe(206);
      expect(headRange.headers.get('content-length')).toBe('1');
      expect(stream).not.toHaveBeenCalled();

      const response = await app.request(path, {headers: {range: `bytes=0-${signature.length - 1}`}});
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes 0-${signature.length - 1}/${size}`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(signature);
      expect(stream).toHaveBeenLastCalledWith(kind, {start: 0, end: signature.length - 1});
      expect(buffer).not.toHaveBeenCalled();
      stream.mockClear();
    }
  });

  test('a full image response remains a lazy storage stream', async () => {
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(size));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('content-disposition')).toBe('inline; filename="captured.png"');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream).toHaveBeenCalledWith('png', undefined);
    expect(buffer).not.toHaveBeenCalled();
    await response.body!.cancel();
  });

  test('unsatisfiable and multipart ranges read no body', async () => {
    for (const range of [`bytes=${size}-`, 'bytes=0-1,4-5']) {
      const response = await app.request(path, {headers: {range}});
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe(`bytes */${size}`);
      expect(await response.text()).toBe('');
    }
    expect(stream).not.toHaveBeenCalled();
    expect(buffer).not.toHaveBeenCalled();
  });

  test('missing or changed original objects remain unavailable without opening a body', async () => {
    stat.mockResolvedValueOnce({sizeBytes: size - 1});
    expect((await app.request(path)).status).toBe(404);
    stat.mockRejectedValueOnce(new Error('object unavailable'));
    expect((await app.request(path, {method: 'HEAD'})).status).toBe(404);
    expect(stream).not.toHaveBeenCalled();
    expect(buffer).not.toHaveBeenCalled();
  });

  test('an unavailable stream keeps the existing missing-payload response', async () => {
    stream.mockRejectedValueOnce(new Error('stream unavailable'));
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({error: 'not_found', error_description: 'artifact payload unavailable'});
    expect(buffer).not.toHaveBeenCalled();
  });

  test('scriptable media stays an opaque attachment with a sanitized filename', async () => {
    asset = {...asset, contentType: 'image/svg+xml', fileName: '<unsafe>"\r\n.svg'};
    const response = await app.request(path, {method: 'HEAD'});
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="unsafe.svg"');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(stream).not.toHaveBeenCalled();
  });

  test('If-Range mismatch does not let Bun apply the original Range again to a full-file Blob', async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4);
    stat.mockResolvedValue({sizeBytes: bytes.length});
    asset = {...asset, sizeBytes: bytes.length};
    stream.mockImplementation(async (_key: string, range?: {start: number; end: number}) =>
      new Blob([range ? bytes.slice(range.start, range.end + 1) : bytes]));
    const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: request => app.fetch(request)});
    try {
      const url = new URL(path, server.url);
      const changed = await fetch(url, {headers: {range: 'bytes=0-0', 'if-range': '"old"'}});
      expect(changed.status).toBe(200);
      expect(changed.headers.get('content-range')).toBeNull();
      expect(new Uint8Array(await changed.arrayBuffer())).toEqual(bytes);
      expect(stream).toHaveBeenLastCalledWith('png', undefined);
      const current = await fetch(url, {headers: {range: 'bytes=0-0', 'if-range': `"${sha256}"`}});
      expect(current.status).toBe(206);
      expect(new Uint8Array(await current.arrayBuffer())).toEqual(bytes.slice(0, 1));
      expect(buffer).not.toHaveBeenCalled();
    } finally {await server.stop(true);}
  });
});
