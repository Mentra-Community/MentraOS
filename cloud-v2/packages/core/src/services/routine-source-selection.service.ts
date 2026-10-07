import {z} from 'zod';
import {createHash} from 'node:crypto';
import {routineRevisionSchema} from '../types/routine-dispatch.types';
import {TestRunGithubApp} from './test-run-github-app';
import {TestRunError} from './test-result-error';

/** Resolve main once per new selection; retries use the durable selected SHA. */
export class GithubRoutineSourceGateway {
  private readonly inventories = new Map<string, Promise<{commit: string; files: Array<{path: string; gitBlobSha1: string; size: number}>}>>();
  constructor(private readonly app: Pick<TestRunGithubApp, 'token'> = new TestRunGithubApp(),
    private readonly transport: (url: string, init: RequestInit) => Promise<Response> = fetch) {}
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
  private async get(path: string, maxBytes = 256 * 1024): Promise<unknown> {
    const deadline = AbortSignal.timeout(20_000);
    try {
      const response = await this.transport(`https://api.github.com/repos/Mentra-Community/Mentra-Automated-Testing/${path}`, {
        redirect: 'error', signal: deadline, headers: {
          Authorization: `Bearer ${await this.app.token('harness')}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'},
      });
      return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await this.bytes(response, maxBytes, deadline)));
    } catch {throw new TestRunError(503, 'Routine main source is unavailable; retry the same selection');}
  }
  async resolve(revision?: string): Promise<string> {
    if (revision && !routineRevisionSchema.safeParse(revision).success) throw new TestRunError(400, 'Invalid routine revision');
    const exact = z.object({sha: routineRevisionSchema}).parse(await this.get(revision ? `git/commits/${revision}` : 'commits/main')).sha;
    if (revision && exact !== revision) throw new TestRunError(503, 'GitHub commit differs from the exact requested routine revision');
    return exact;
  }
  async inventory(commit: string) {
    routineRevisionSchema.parse(commit);
    const cached = this.inventories.get(commit);
    if (cached) return cached;
    const work = this.readInventory(commit).catch(error => {this.inventories.delete(commit); throw error;});
    if (this.inventories.size >= 32) this.inventories.delete(this.inventories.keys().next().value!);
    this.inventories.set(commit, work);
    return work;
  }
  private async readInventory(commit: string) {
    const item = z.object({path: z.string(), mode: z.string(), type: z.enum(['blob', 'tree', 'commit']),
      sha: routineRevisionSchema, size: z.number().int().nonnegative().safe().optional()});
    const tree = z.object({truncated: z.literal(false), tree: z.array(item).max(10000)});
    const revision = z.object({sha: routineRevisionSchema, tree: z.object({sha: routineRevisionSchema})})
      .parse(await this.get(`git/commits/${commit}`));
    if (revision.sha !== commit) throw new TestRunError(503, 'GitHub source commit differs from the selected request');
    const parsedRoot = tree.safeParse(await this.get(`git/trees/${revision.tree.sha}`, 4 * 1024 ** 2));
    if (!parsedRoot.success) throw new TestRunError(422, 'Selected source root tree is incomplete or invalid');
    const root = parsedRoot.data;
    const routines = root.tree.find(value => value.path === 'routines' && value.type === 'tree');
    if (!routines) throw new TestRunError(422, 'Selected source has no routines directory');
    const parsedSource = tree.safeParse(await this.get(`git/trees/${routines.sha}?recursive=1`, 8 * 1024 ** 2));
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
    return {commit, files};
  }
  async blob(file: {gitBlobSha1: string; size: number}) {
    routineRevisionSchema.parse(file.gitBlobSha1);
    let bytes: Uint8Array;
    const deadline = AbortSignal.timeout(60_000);
    try {
      const response = await this.transport(`https://api.github.com/repos/Mentra-Community/Mentra-Automated-Testing/git/blobs/${file.gitBlobSha1}`, {
        redirect: 'error', signal: deadline, headers: {Authorization: `Bearer ${await this.app.token('harness')}`,
          Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28'},
      });
      bytes = await this.bytes(response, file.size + 1, deadline);
    } catch {throw new TestRunError(503, 'Exact routine source bytes are unavailable; retry preparation');}
    if (bytes.byteLength !== file.size || createHash('sha1').update(`blob ${file.size}\0`).update(bytes).digest('hex') !== file.gitBlobSha1)
      throw new TestRunError(503, 'GitHub routine blob differs from its exact inventory');
    return bytes;
  }
}
