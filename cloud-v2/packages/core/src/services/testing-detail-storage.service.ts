import {createHash} from 'node:crypto';
import {z} from 'zod';
import {createStorageService, type StorageService} from './storage/storage.service';
import {requestInputDigest, requestInputJson} from './test-request.service';
import {TestRunError} from './test-result-error';

export const testingDetailPointerSchema = z.object({key: z.string().min(1).max(1000), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(32 * 1024 * 1024)}).strict();
export type TestingDetailPointer = z.infer<typeof testingDetailPointerSchema>;

/** Private immutable detail; Mongo stores only this verified pointer and indexed projections. */
export class TestingDetailStorage {
  constructor(private readonly storage: StorageService = createStorageService(),
    private readonly environment = process.env.CLOUD_CORE_ENVIRONMENT ?? 'local') {}

  async write<T>(kind: 'run' | 'definition' | 'collection' | 'report-native', identity: string, value: T): Promise<TestingDetailPointer> {
    const sha256 = requestInputDigest(value), bytes = Buffer.from(requestInputJson(value));
    const environment = this.environment;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(environment)) throw new TestRunError(503, 'Testing detail environment is invalid');
    const key = `testing-detail/${environment}/${kind}/${createHash('sha256').update(identity).digest('hex')}/${sha256}.json`;
    const pointer = testingDetailPointerSchema.parse({key, sha256, sizeBytes: bytes.byteLength});
    // Identical identity/content produces identical bytes; a race never overwrites different content.
    await this.storage.putObject({key, body: bytes, contentType: 'application/json', signal: AbortSignal.timeout(30_000)});
    await this.read(pointer, z.unknown());
    return pointer;
  }

  async read<T>(input: unknown, schema: z.ZodType<T>): Promise<T> {
    const pointer = testingDetailPointerSchema.parse(input);
    let bytes: Uint8Array;
    try {bytes = await this.storage.getObject(pointer.key, AbortSignal.timeout(30_000));}
    catch {throw new TestRunError(503, 'Immutable testing detail is unavailable');}
    if (bytes.byteLength !== pointer.sizeBytes) throw new TestRunError(503, 'Immutable testing detail size differs');
    let value: unknown;
    try {value = JSON.parse(Buffer.from(bytes).toString('utf8'));}
    catch {throw new TestRunError(503, 'Immutable testing detail JSON is invalid');}
    if (requestInputDigest(value) !== pointer.sha256) throw new TestRunError(503, 'Immutable testing detail digest differs');
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new TestRunError(503, 'Immutable testing detail schema differs');
    return parsed.data;
  }
}
