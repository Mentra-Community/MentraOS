import {createHash} from 'node:crypto';
import {z} from 'zod';
import {createStorageService, type StorageService} from './storage/storage.service';
import {TestRunError} from './test-result-error';
import {routineIdentitySchema} from '../types/routine-definition.types';
import {ROUTINE_BUNDLE_BODY_BYTES, routineSourceRefSchema} from '../types/framework-version.types';

export const routineBundleMetadataSchema = z.object({commit: z.string().regex(/^[a-f0-9]{40}$/),
  routineId: routineIdentitySchema, minimumRoutineApiVersion: z.number().int().positive().safe(),
  definitionSha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(ROUTINE_BUNDLE_BODY_BYTES)}).strict();
/** Existing storage owns immutable routine bytes; no per-host clone or source registry. */
export class RoutineSourceBundleService {
  constructor(private storage: () => StorageService = createStorageService) {}
  private key(digest: string) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TestRunError(400, 'Invalid routine bundle digest');
    return `routine-source/${digest}.tar.gz`;
  }
  async publish(digest: string, metadata: unknown, body: ReadableStream<Uint8Array> | null, origin: string) {
    const key = this.key(digest), row = routineBundleMetadataSchema.parse(metadata);
    if (!body) throw new TestRunError(400, 'Routine source requires archive bytes');
    const reader = body.getReader(), chunks: Uint8Array[] = [], hash = createHash('sha256'); let size = 0;
    let expired = false;
    const deadline = setTimeout(() => {expired = true; void reader.cancel().catch(() => undefined);}, 60_000);
    try {
      while (true) {const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > row.size) throw new TestRunError(413, 'Routine bundle exceeds declared size');
        hash.update(next.value); chunks.push(next.value);
      }
    } finally {clearTimeout(deadline); await reader.cancel().catch(() => undefined); try {reader.releaseLock();} catch {}}
    if (expired) throw new TestRunError(503, 'Routine source upload exceeded its deadline');
    if (size !== row.size || hash.digest('hex') !== digest) throw new TestRunError(400, 'Routine bundle size or digest differs');
    const bytes = Buffer.concat(chunks);
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new TestRunError(400, 'Routine bundle must be a gzip archive');
    // A content-addressed key only accepts verified identical bytes, so retries cannot replace another source.
    const receipt = await this.storage().putObject({key, body: bytes, contentType: 'application/gzip'});
    if (receipt.sha256 !== digest || receipt.sizeBytes !== size) throw new TestRunError(503, 'Routine source storage receipt differs');
    return routineSourceRefSchema.parse({repository: 'Mentra-Community/Mentra-Automated-Testing', commit: row.commit,
      minimumRoutineApiVersion: row.minimumRoutineApiVersion, bundle: {
        url: `${new URL(origin).origin}/api/internal/routine-definitions/bundles/${digest}`, sha256: digest, size}});
  }
  async download(digest: string) {
    const storage = this.storage(), key = this.key(digest), stat = await storage.statObject(key);
    return new Response(await storage.streamObject(key), {headers: {'Content-Type': 'application/gzip',
      'Content-Length': String(stat.sizeBytes), 'Cache-Control': 'private, immutable', 'X-Content-Type-Options': 'nosniff'}});
  }
}
