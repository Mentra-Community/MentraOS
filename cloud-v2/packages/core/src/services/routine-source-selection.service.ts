import {z} from 'zod';
import {createHash} from 'node:crypto';
import {routineRevisionSchema} from '../types/routine-dispatch.types';
import {TestRunGithubApp} from './test-run-github-app';
import {TestRunError} from './test-result-error';
import {createLogger} from '@mentra/cloud-shared/logger';
import {configuredTestingTarget, testingRepositorySchema, testingTarget, type TestingRepository} from '../types/testing-source.types';

const logger = createLogger('core').child({service: 'routine-source-selection.service'});
const activitySchema = (ref: string) => z.array(z.object({id: z.number().int().positive().safe(), ref: z.literal(ref),
  before: routineRevisionSchema, after: routineRevisionSchema, timestamp: z.string().datetime({offset: true}),
  activity_type: z.enum(['push', 'pr_merge', 'merge_queue_merge', 'force_push', 'branch_creation', 'branch_deletion'])})).max(100);
type SourceDiagnostic = {phase: 'authentication' | 'request' | 'response' | 'body' | 'integrity';
  blobSha: string; expectedBytes: number; elapsedMs: number; status?: number; receivedBytes?: number;
  failure: 'unavailable' | 'deadline' | 'identity-mismatch'; upstream?: SourceDenial};
type SourceDenial = {
  kind: 'unknown' | 'primary-rate-limit' | 'secondary-rate-limit' | 'integration-access-denied' | 'bad-credentials';
  message: string; bodyState: 'unavailable' | 'empty' | 'json' | 'invalid' | 'oversize';
  githubRequestId?: string; retryAfter?: number | string; acceptedPermissions?: string;
  rateLimit?: {limit?: number; remaining?: number; reset?: number; used?: number; resource?: string};
};
export const ROUTINE_SOURCE_DOWNLOAD_UNAVAILABLE = 'Routine files could not be downloaded.';
const denialBodyBytes = 4096;
const denialMessages = [
  [/^API rate limit exceeded\b/, 'primary-rate-limit', 'GitHub reported an API rate limit.'],
  [/^You have exceeded a secondary rate limit(?:\.|$)/, 'secondary-rate-limit', 'GitHub reported a secondary rate limit.'],
  [/^Resource not accessible by integration\.?$/, 'integration-access-denied', 'GitHub reported that the integration cannot access this resource.'],
  [/^Bad credentials\.?$/, 'bad-credentials', 'GitHub reported invalid credentials.'],
] as const;

/** Provider text is untrusted: retain fixed messages and strictly parsed header values only. */
export function denialHeaders(headers: Headers): SourceDenial {
  const value: SourceDenial = {kind: 'unknown', message: 'GitHub refused the routine source download.', bodyState: 'unavailable'};
  const number = (name: string) => {
    const raw = headers.get(name);
    return raw !== null && /^(0|[1-9]\d{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : undefined;
  };
  const id = headers.get('x-github-request-id');
  if (id && id.length <= 128 && /^[\da-f]+(?::[\da-f]+)+$/i.test(id)) value.githubRequestId = id;
  const rateLimit: NonNullable<SourceDenial['rateLimit']> = {};
  for (const key of ['limit', 'remaining', 'reset', 'used'] as const) {
    const parsed = number(`x-ratelimit-${key}`); if (parsed !== undefined) rateLimit[key] = parsed;
  }
  const resource = headers.get('x-ratelimit-resource');
  if (resource && ['core', 'search', 'code_search', 'graphql', 'integration_manifest'].includes(resource)) rateLimit.resource = resource;
  if (Object.keys(rateLimit).length) value.rateLimit = rateLimit;
  const retryAfter = number('retry-after'), retryDate = headers.get('retry-after');
  if (retryAfter !== undefined) value.retryAfter = retryAfter;
  else if (retryDate && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryDate) && Number.isFinite(Date.parse(retryDate)))
    value.retryAfter = new Date(retryDate).toISOString();
  const permissions = headers.get('x-accepted-github-permissions');
  if (permissions && permissions.length <= 128 && permissions.split(/[,;]/).every(part =>
    /^(contents|pull_requests|actions|checks|metadata)=(read|write)$/.test(part.trim())))
    value.acceptedPermissions = permissions.split(/[,;]/).map(part => part.trim()).join(';');
  return value;
}

/** Resolve main once per new selection; retries use the durable selected SHA. */
export class GithubRoutineSourceGateway {
  private readonly inventories = new Map<string, Promise<{commit: string; repository?: TestingRepository; files: Array<{path: string; gitBlobSha1: string; size: number}>}>>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly blobFlights = new Map<string, {size: number; work: Promise<Uint8Array>}>();
  private blobBytes = 0;
  private pendingBlobBytes = 0;
  constructor(private readonly app: Pick<TestRunGithubApp, 'token'> = new TestRunGithubApp(),
    private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
    private readonly report: (value: SourceDiagnostic) => void = value => logger.error(value, 'Exact routine source download failed')) {}
  private async bytes(response: Response, maxBytes: number, signal: AbortSignal) {
    if (!response.ok || !response.body) throw new Error('Source response is unavailable');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const cancel = () => {void reader.cancel().catch(() => undefined);};
    signal.addEventListener('abort', cancel, {once: true});
    try {
      if (signal.aborted) throw new Error('Source download expired');
      while (true) {const value = await reader.read(); if (value.done) break;
        size += value.value.byteLength; if (size > maxBytes) throw new Error('Source response exceeds its bound');
        chunks.push(value.value);
      }
      if (signal.aborted) throw new Error('Source download expired');
      return Buffer.concat(chunks);
    } finally {signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock();}
  }
  private async withinDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new Error('Source selection expired');
    let abort!: () => void;
    const expired = new Promise<never>((_, reject) => {abort = () => reject(new Error('Source selection expired'));
      signal.addEventListener('abort', abort, {once: true});});
    try {return await Promise.race([work, expired]);} finally {signal.removeEventListener('abort', abort);}
  }
  private async denialBody(response: Response, metadata: SourceDenial, deadline: AbortSignal): Promise<SourceDenial> {
    if (!response.body) return {...metadata, bodyState: 'empty'};
    let bytes: Uint8Array;
    try {bytes = await this.bytes(new Response(response.body), denialBodyBytes, deadline);}
    catch (error) {return {...metadata, bodyState: error instanceof Error && error.message === 'Source response exceeds its bound' ? 'oversize' : 'unavailable'};}
    if (!bytes.length) return {...metadata, bodyState: 'empty'};
    try {
      const body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as {message?: unknown} | null;
      const known = typeof body?.message === 'string' ? denialMessages.find(([pattern]) => pattern.test(body.message as string)) : undefined;
      return {...metadata, bodyState: 'json', ...(known ? {kind: known[1], message: known[2]} : {})};
    } catch {return {...metadata, bodyState: 'invalid'};}
  }
  private async page(path: string, maxBytes: number, deadline: AbortSignal, repository: TestingRepository) {
    try {
      const token = await this.withinDeadline(this.app.token('harness', repository), deadline);
      const response = await this.withinDeadline(this.transport(`https://api.github.com/repos/${repository}/${path}`, {
        redirect: 'error', signal: deadline, headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'},
      }), deadline);
      const bytes = await this.withinDeadline(this.bytes(response, maxBytes, deadline), deadline);
      return {body: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)) as unknown, link: response.headers.get('link')};
    } catch {throw new TestRunError(503, 'Routine main source is unavailable; retry the same selection');}
  }
  private async get(path: string, repository: TestingRepository, maxBytes = 256 * 1024, deadline = AbortSignal.timeout(20_000)): Promise<unknown> {
    return (await this.page(path, maxBytes, deadline, repository)).body;
  }
  async resolve(revision?: string, before?: string, repository: TestingRepository = configuredTestingTarget().repository): Promise<string> {
    const target = testingTarget(repository), branch = target.ref.slice('refs/heads/'.length);
    if (revision && !routineRevisionSchema.safeParse(revision).success) throw new TestRunError(400, 'Invalid routine revision');
    if (before !== undefined) {
      if (revision || !z.string().datetime({offset: true}).safeParse(before).success)
        throw new TestRunError(400, 'Invalid routine source boundary');
      return this.resolveMainBefore(before, repository);
    }
    const exact = z.object({sha: routineRevisionSchema}).parse(await this.get(revision ? `git/commits/${revision}` : `commits/${branch}`, repository)).sha;
    if (revision && exact !== revision) throw new TestRunError(503, 'GitHub commit differs from the exact requested routine revision');
    return exact;
  }
  /** Repository activity records when main changed; commit dates do not prove branch membership. */
  private async resolveMainBefore(before: string, repository: TestingRepository): Promise<string> {
    const mainRef = testingTarget(repository).ref, branch = mainRef.slice('refs/heads/'.length);
    const deadline = AbortSignal.timeout(20_000), boundarySecond = Math.floor(Date.parse(before) / 1000);
    try {
      const exact = z.object({sha: routineRevisionSchema});
      const tip = exact.parse(await this.get(`commits/${branch}`, repository, 256 * 1024, deadline)).sha;
      let head = tip, previousTime = Infinity, previousId = Infinity, cursor: string | undefined;
      const seen = new Set<number>(), heads = new Set([tip]), cursors = new Set<string>();
      for (let page = 0; page < 3; page++) {
        const path = `activity?ref=${encodeURIComponent(mainRef)}&direction=desc&per_page=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`;
        const response = await this.page(path, 512 * 1024, deadline, repository), rows = activitySchema(mainRef).parse(response.body);
        if (!rows.length) throw new Error('Main history is incomplete');
        for (const row of rows) {
          const time = Date.parse(row.timestamp), second = Math.floor(time / 1000);
          if (seen.has(row.id) || time > previousTime || row.id >= previousId
            || row.after !== head || !['push', 'pr_merge', 'merge_queue_merge'].includes(row.activity_type))
            throw new Error('Main history is changed or incomplete');
          seen.add(row.id); previousTime = time; previousId = row.id;
          // GitHub activity is second-resolution; a transition in the boundary second is ambiguous.
          if (second === boundarySecond) throw new Error('Main boundary is ambiguous');
          if (second < boundarySecond) {
            if (head !== tip) {
              const comparison = z.object({status: z.literal('ahead'), base_commit: z.object({sha: routineRevisionSchema}),
                merge_base_commit: z.object({sha: routineRevisionSchema})})
                .parse(await this.get(`compare/${head}...${tip}?per_page=1`, repository, 4 * 1024 ** 2, deadline));
              if (comparison.base_commit.sha !== head || comparison.merge_base_commit.sha !== head)
                throw new Error('Selected main source is not an ancestor');
            }
            if (exact.parse(await this.get(`commits/${branch}`, repository, 256 * 1024, deadline)).sha !== tip)
              throw new Error('Main changed during selection');
            return head;
          }
          if (heads.has(row.before)) throw new Error('Main history is cyclic');
          head = row.before; heads.add(head);
        }
        const next = response.link?.split(',').find(value => /;\s*rel="next"/.test(value));
        const match = next?.match(/^\s*<([^>]+)>;\s*rel="next"\s*$/);
        if (!match) throw new Error('Main history is incomplete');
        const url = new URL(match[1]!);
        cursor = url.searchParams.get('after') ?? undefined;
        if (url.origin !== 'https://api.github.com' || (url.pathname !== `/repos/${repository}/activity`
          && !/^\/repositories\/\d+\/activity$/.test(url.pathname))
          || url.searchParams.get('ref') !== mainRef || !cursor || cursor.length > 4096 || cursors.has(cursor))
          throw new Error('Main history cursor is invalid');
        cursors.add(cursor);
      }
      throw new Error('Main history exceeds its bound');
    } catch {throw new TestRunError(503, 'Routine main history at the occurrence boundary is unavailable; retry the same selection');}
  }
  async inventory(commit: string, repository: TestingRepository = testingTarget().repository) {
    testingRepositorySchema.parse(repository);
    routineRevisionSchema.parse(commit);
    const key = `${repository}@${commit}`, cached = this.inventories.get(key);
    if (cached) return cached;
    const work = this.readInventory(commit, repository).catch(error => {this.inventories.delete(key); throw error;});
    if (this.inventories.size >= 32) this.inventories.delete(this.inventories.keys().next().value!);
    this.inventories.set(key, work);
    return work;
  }
  private async readInventory(commit: string, repository: TestingRepository) {
    const item = z.object({path: z.string(), mode: z.string(), type: z.enum(['blob', 'tree', 'commit']),
      sha: routineRevisionSchema, size: z.number().int().nonnegative().safe().optional()});
    const tree = z.object({truncated: z.literal(false), tree: z.array(item).max(10000)});
    const revision = z.object({sha: routineRevisionSchema, tree: z.object({sha: routineRevisionSchema})})
      .parse(await this.get(`git/commits/${commit}`, repository));
    if (revision.sha !== commit) throw new TestRunError(503, 'GitHub source commit differs from the selected request');
    const parsedRoot = tree.safeParse(await this.get(`git/trees/${revision.tree.sha}`, repository, 4 * 1024 ** 2));
    if (!parsedRoot.success) throw new TestRunError(422, 'Selected source root tree is incomplete or invalid');
    let root = parsedRoot.data;
    if (testingTarget(repository).sourceRoot) {
      const testing = root.tree.find(value => value.path === 'testing' && value.type === 'tree' && value.mode === '040000');
      if (!testing) throw new TestRunError(422, 'Selected source has no testing directory');
      const nested = tree.safeParse(await this.get(`git/trees/${testing.sha}`, repository, 4 * 1024 ** 2));
      if (!nested.success) throw new TestRunError(422, 'Selected testing tree is incomplete or invalid');
      root = nested.data;
    }
    const routines = root.tree.find(value => value.path === 'routines' && value.type === 'tree');
    if (!routines) throw new TestRunError(422, 'Selected source has no routines directory');
    const parsedSource = tree.safeParse(await this.get(`git/trees/${routines.sha}?recursive=1`, repository, 8 * 1024 ** 2));
    if (!parsedSource.success) throw new TestRunError(422, 'Selected routines tree is incomplete or exceeds its bound');
    const source = parsedSource.data;
    const files = source.tree.filter(value => value.type !== 'tree').map(value => {
      if (value.type !== 'blob' || !['100644', '100755'].includes(value.mode) || value.size === undefined || value.size > 64 * 1024 ** 2 ||
        value.path.split('/').some(part => !part || part === '.' || part === '..' || part === 'node_modules') || value.path.includes('\\'))
        throw new TestRunError(422, 'Routine source inventory contains an unsupported path or file');
      return {path: `routines/${value.path}`, gitBlobSha1: value.sha, size: value.size};
    }).sort((left, right) => left.path.localeCompare(right.path));
    if (!files.length || new Set(files.map(file => file.path)).size !== files.length || files.reduce((sum, file) => sum + file.size, 0) > 512 * 1024 ** 2)
      throw new TestRunError(422, 'Routine source inventory exceeds its bounded allowance');
    return {commit, files, ...(repository === testingTarget().repository ? {} : {repository})};
  }
  async blob(file: {gitBlobSha1: string; size: number}, repository: TestingRepository = testingTarget().repository) {
    testingRepositorySchema.parse(repository);
    routineRevisionSchema.parse(file.gitBlobSha1);
    const key = `${repository}@${file.gitBlobSha1}`, cached = this.blobs.get(key);
    if (cached) {
      if (cached.byteLength !== file.size) throw new TestRunError(503, 'GitHub routine blob differs from its exact inventory');
      return Uint8Array.from(cached);
    }
    const flight = this.blobFlights.get(key);
    if (flight) {
      if (flight.size !== file.size) throw new TestRunError(503, 'GitHub routine blob differs from its exact inventory');
      return Uint8Array.from(await flight.work);
    }
    if (this.blobFlights.size >= 512 || this.pendingBlobBytes + file.size > 64 * 1024 ** 2)
      throw new TestRunError(503, 'Routine source downloads exceed their concurrent bound');
    this.pendingBlobBytes += file.size;
    const work = this.readBlob(file, repository).then(bytes => {
      if (bytes.byteLength <= 16 * 1024 ** 2) {
        while (this.blobs.size >= 512 || this.blobBytes + bytes.byteLength > 16 * 1024 ** 2) {
          const first = this.blobs.keys().next().value!;
          this.blobBytes -= this.blobs.get(first)!.byteLength; this.blobs.delete(first);
        }
        this.blobs.set(key, bytes); this.blobBytes += bytes.byteLength;
      }
      return bytes;
    }).finally(() => {this.pendingBlobBytes -= file.size; this.blobFlights.delete(key);});
    this.blobFlights.set(key, {size: file.size, work});
    return Uint8Array.from(await work);
  }
  private async readBlob(file: {gitBlobSha1: string; size: number}, repository: TestingRepository) {
    let bytes: Uint8Array;
    let phase: SourceDiagnostic['phase'] = 'authentication', status: number | undefined;
    let upstream: SourceDenial | undefined;
    const startedAt = Date.now();
    const deadline = AbortSignal.timeout(60_000);
    try {
      const token = await this.app.token('harness', repository);
      phase = 'request';
      const response = await this.transport(`https://api.github.com/repos/${repository}/git/blobs/${file.gitBlobSha1}`, {
        redirect: 'error', signal: deadline, headers: {Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28'},
      });
      phase = 'response'; status = response.status;
      if (!response.ok) {
        upstream = denialHeaders(response.headers);
        upstream = await this.withinDeadline(this.denialBody(response, upstream, deadline), deadline);
        throw new Error('Source response is unavailable');
      }
      if (response.ok && response.body) phase = 'body';
      bytes = await this.bytes(response, file.size + 1, deadline);
    } catch {
      this.report({phase, blobSha: file.gitBlobSha1, expectedBytes: file.size, elapsedMs: Date.now() - startedAt,
        ...(status === undefined ? {} : {status}), ...(upstream ? {upstream} : {}), failure: deadline.aborted ? 'deadline' : 'unavailable'});
      throw new TestRunError(503, ROUTINE_SOURCE_DOWNLOAD_UNAVAILABLE);
    }
    if (bytes.byteLength !== file.size || createHash('sha1').update(`blob ${file.size}\0`).update(bytes).digest('hex') !== file.gitBlobSha1) {
      this.report({phase: 'integrity', blobSha: file.gitBlobSha1, expectedBytes: file.size, receivedBytes: bytes.byteLength,
        elapsedMs: Date.now() - startedAt, status, failure: 'identity-mismatch'});
      throw new TestRunError(503, 'GitHub routine blob differs from its exact inventory');
    }
    return bytes;
  }
}
