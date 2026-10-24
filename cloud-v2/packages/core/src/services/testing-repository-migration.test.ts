import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {configuredTestingTarget, retainedTestingTarget, testingTarget, testingTargetSchema} from '../types/testing-source.types';
import {frameworkBindingSchema} from '../types/framework-version.types';
import {stepSourceSchema} from '../types/framework-run.types';
import {routineEnrollmentSchema} from '../types/routine-definition.types';
import {routineFixComponents} from '../types/routine-fix-provenance.types';
import {testRoutineSource} from '../testing/framework-fixtures';
import {GithubRoutineJobActions, cancelRoutineActions} from './routine-job-actions.service';
import {GithubRoutineSourceGateway} from './routine-source-selection.service';
import {GithubRoutineMergeGateway} from './routine-merge-eligibility.service';
import {RoutineSourceBundleService} from './routine-source-bundle.service';
import {readRoutineCollection, writeRoutineCollection} from './routine-definition-detail.service';
import {RoutineDefinitionService} from './routine-definition.service';
import {TestingDetailStorage} from './testing-detail-storage.service';
import {StorageService, type StorageProvider} from './storage/storage.service';
import {requestInputDigest} from './test-request.service';

const legacy = testingTarget(), canonical = testingTarget('Mentra-Community/Mentra');
const revision = 'a'.repeat(40), root = 'b'.repeat(40), testing = 'c'.repeat(40), routines = 'd'.repeat(40);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(bytes); controller.close();}});
function storageFixture() {
  const objects = new Map<string, Uint8Array>();
  const provider: StorageProvider = {
    async putObject(input) {objects.set(input.key, input.body); return {key: input.key, contentType: input.contentType, sizeBytes: input.body.length, sha256: sha256(input.body)};},
    async getObject(key) {return objects.get(key)!;}, async deleteObject(key) {objects.delete(key);}, async putFile() {throw Error('Unexpected file upload');},
    async statObject(key) {return {sizeBytes: objects.get(key)!.length};}, async streamObject(key) {return stream(objects.get(key)!);},
  };
  return {objects, storage: new StorageService(provider)};
}
function enrolled(repository: string = canonical.repository, path = 'testing/routines/sample/routine.ts') {
  const definition = {id: 'sample', minimumRoutineApiVersion: 1, title: 'Sample', purpose: 'Check sample', platforms: ['android'], entry: 'home', account: 'lane',
    resourceRequirements: [], requirements: [], fixtures: [], steps: [{id: 'check', instruction: 'Check', expected: 'Checked'}],
    source: {repository, revision, path}};
  return {routineId: 'sample', platform: 'android', definitionRevision: revision, definitionSha256: requestInputDigest(definition), definition,
    routineSource: {...testRoutineSource(revision), repository}};
}

test('one selector derives only allowlisted tuples and absent originals ignore the current setting', () => {
  expect(configuredTestingTarget({})).toEqual(legacy);
  expect(configuredTestingTarget({TESTING_REPOSITORY: canonical.repository})).toEqual(canonical);
  expect(retainedTestingTarget()).toEqual(legacy);
  for (const repository of ['foreign/repository', 'Mentra-Community/MentraOS', 'Mentra-Community/Mentra/'])
    expect(() => configuredTestingTarget({TESTING_REPOSITORY: repository})).toThrow();
  for (const changed of [{ref: 'refs/heads/main'}, {sourceRoot: '../testing/'}, {workflow: `${canonical.repository}/testing/.github/workflows/routine-device.yml@refs/heads/dev`}])
    expect(testingTargetSchema.safeParse({...canonical, ...changed}).success).toBe(false);
});

test('simultaneous old and canonical Actions discovery keeps caches, filters and cancellation in the original repository', async () => {
  const calls: string[] = [], grants: string[] = [];
  const actions = new GithubRoutineJobActions({async token(_scope, repository) {grants.push(repository!); return 'token';}}, async (url, init) => {
    calls.push(url);
    if (init.method === 'POST') return new Response(null, {status: 204});
    const monorepo = url.includes('/repos/Mentra-Community/Mentra/'), branch = monorepo ? 'dev' : 'main';
    return Response.json({workflow_runs: [{id: monorepo ? 22 : 11, display_title: 'routine-job:original', event: 'workflow_dispatch', head_branch: branch,
      path: `.github/workflows/routine-device.yml@refs/heads/${branch}`, created_at: '2026-10-24T00:00:00Z', status: 'queued', conclusion: null},
      {id: 99, display_title: 'routine-job:original', event: 'workflow_dispatch', head_branch: branch,
        path: 'testing/.github/workflows/routine-device.yml', created_at: '2026-10-24T00:00:00Z', status: 'queued', conclusion: null}]});
  });
  const [old, current] = await Promise.all([actions.runs('original', '2026-10-24T00:00:00Z'), actions.runs('original', '2026-10-24T00:00:00Z', canonical)]);
  expect(old.map(row => row.actionsRunId)).toEqual(['11']); expect(current.map(row => row.actionsRunId)).toEqual(['22']);
  expect(calls).toHaveLength(2);
  await actions.dispatch('original', canonical);
  await cancelRoutineActions({transport: actions, jobId: 'original', dispatch: {attempts: 1, lastAttemptAt: '2026-10-24T00:00:00Z'}, known: ['11'],
    now: Date.parse('2026-10-24T00:03:00Z'), async retain() {}});
  expect(calls.at(-1)).toContain(`/repos/${legacy.repository}/actions/runs/11/cancel`);
  expect(grants).toContain(canonical.repository); expect(grants.at(-1)).toBe(legacy.repository);
  const before = calls.length;
  await expect(actions.dispatch('original', {...canonical, ref: 'refs/heads/main'} as never)).rejects.toThrow();
  expect(calls).toHaveLength(before);
});

test('canonical inventory descends testing and keeps verified archive paths and repository-isolated caches', async () => {
  const bytes = new TextEncoder().encode('export const sample = true;'), blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const calls: string[] = [], grants: string[] = [];
  let testingMode = '040000';
  const source = new GithubRoutineSourceGateway({async token(_scope, repository) {grants.push(repository!); return 'token';}}, async url => {
    calls.push(url);
    if (url.includes('/git/commits/')) return Response.json({sha: url.split('/').at(-1), tree: {sha: root}});
    if (url.endsWith(`/git/trees/${root}`)) return Response.json({truncated: false, tree: url.includes(`/repos/${canonical.repository}/`) ?
      [{path: 'testing', type: 'tree', mode: testingMode, sha: testing}, {path: 'routines', type: 'tree', mode: '040000', sha: '9'.repeat(40)}] :
      [{path: 'routines', type: 'tree', mode: '040000', sha: routines}]});
    if (url.endsWith(`/git/trees/${testing}`)) return Response.json({truncated: false, tree: [{path: 'routines', type: 'tree', mode: '040000', sha: routines}]});
    if (url.endsWith(`/git/trees/${routines}?recursive=1`)) return Response.json({truncated: false, tree: [{path: 'sample/routine.ts', type: 'blob', mode: '100644', sha: blob, size: bytes.length}]});
    if (url.endsWith(`/git/blobs/${blob}`)) return new Response(bytes);
    throw Error('Unexpected source path');
  });
  const current = await source.inventory(revision, canonical.repository), old = await source.inventory(revision);
  expect(current).toMatchObject({repository: canonical.repository, files: [{path: 'routines/sample/routine.ts'}]});
  expect(old).not.toHaveProperty('repository');
  await source.blob(current.files[0]!, canonical.repository); await source.blob(old.files[0]!);
  expect(calls.filter(url => url.includes('/git/blobs/'))).toHaveLength(2);
  expect(grants).toContain(canonical.repository); expect(grants).toContain(legacy.repository);
  const before = calls.length;
  await expect(source.inventory(revision, 'foreign/repo' as never)).rejects.toThrow(); expect(calls).toHaveLength(before);
  testingMode = '120000';
  await expect(source.inventory('e'.repeat(40), canonical.repository)).rejects.toThrow('testing directory');
});

test('historical canonical selection uses dev activity and refuses another branch', async () => {
  const calls: string[] = []; let ref = canonical.ref;
  const source = new GithubRoutineSourceGateway({async token() {return 'token';}}, async url => {
    calls.push(url);
    if (url.endsWith('/commits/dev')) return Response.json({sha: revision});
    return Response.json([{id: 2, ref, before: 'e'.repeat(40), after: revision, timestamp: '2026-10-24T00:00:00Z', activity_type: 'push'}]);
  });
  expect(await source.resolve(undefined, '2026-10-24T00:01:00Z', canonical.repository)).toBe(revision);
  expect(calls.some(url => url.includes('activity?ref=refs%2Fheads%2Fdev'))).toBe(true);
  ref = 'refs/heads/main' as typeof ref;
  await expect(source.resolve(undefined, '2026-10-24T00:01:00Z', canonical.repository)).rejects.toThrow('history');
});

test('explicit canonical bundle and collection provenance survives legacy default without relabeling omitted metadata', async () => {
  const f = storageFixture(), publisher = new RoutineSourceBundleService(() => f.storage), bytes = gzipSync('sample archive'), digest = sha256(bytes);
  const metadata = {commit: revision, routineId: 'sample', minimumRoutineApiVersion: 1, definitionSha256: 'f'.repeat(64), size: bytes.length};
  expect((await publisher.publish(digest, {...metadata, repository: canonical.repository}, stream(bytes), 'https://core.example')).repository).toBe(canonical.repository);
  expect((await publisher.publish(digest, metadata, stream(bytes), 'https://core.example')).repository).toBe(legacy.repository);
  const collection = {repository: canonical.repository, commit: revision, version: 2000, definitions: [routineEnrollmentSchema.parse(enrolled())]};
  const details = new TestingDetailStorage(f.storage, 'dev'), receipt = await writeRoutineCollection(collection, details);
  expect(await readRoutineCollection(receipt.detail, details)).toEqual(collection);
  await expect(new RoutineDefinitionService().publishCollection({...collection, repository: legacy.repository})).rejects.toThrow('identity');
  await expect(publisher.publish(digest, {...metadata, repository: 'foreign/repo'}, stream(bytes), 'https://core.example')).rejects.toThrow();
});

test('definition and step provenance reject foreign repositories, traversal and mixed repository roots', () => {
  expect(routineEnrollmentSchema.safeParse(enrolled()).success).toBe(true);
  for (const [repository, path] of [[canonical.repository, 'routines/sample/routine.ts'], [legacy.repository, 'testing/routines/sample/routine.ts'],
    [canonical.repository, 'testing/routines/../routine.ts'], ['foreign/repo', 'routines/sample/routine.ts']])
    expect(routineEnrollmentSchema.safeParse(enrolled(repository, path)).success).toBe(false);
  const source = {id: 'step', repository: canonical.repository, revision, path: 'testing/framework/check.ts', line: 1};
  expect(stepSourceSchema.safeParse(source).success).toBe(true);
  expect(stepSourceSchema.safeParse({...source, path: 'public/mentraos/framework/check.ts'}).success).toBe(false);
  expect(stepSourceSchema.safeParse({...source, repository: legacy.repository}).success).toBe(false);
});

test('merge enrollment follows exact source repository and canonical dev without adopting foreign PRs', async () => {
  const calls: string[] = []; let base = 'dev';
  const gateway = new GithubRoutineMergeGateway({async token(_scope: string, repository: string) {expect(repository).toBe(canonical.repository); return 'token';}} as never,
    async url => {calls.push(url); return Response.json({merged: true, merge_commit_sha: revision, head: {sha: revision, repo: {full_name: canonical.repository}}, base: {ref: base}});});
  expect(await gateway.merged(`https://github.com/${canonical.repository}/pull/126`, revision, revision, canonical.repository)).toBe(true);
  base = 'main'; expect(await gateway.merged(`https://github.com/${canonical.repository}/pull/126`, revision, revision, canonical.repository)).toBe(false);
  const before = calls.length;
  expect(await gateway.merged(`https://github.com/${legacy.repository}/pull/126`, revision, revision, canonical.repository)).toBe(false);
  expect(await gateway.merged('https://github.com/foreign/repo/pull/126', revision, revision)).toBe(false); expect(calls).toHaveLength(before);
});

test('framework and routine fix inclusion use explicit observed repository while legacy bindings retain their identity', () => {
  const binding = {version: 2000, revision, installationId: 'installed', configurationSha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64), routineApiVersion: 89, publicApiSha256: 'd'.repeat(64)};
  expect(frameworkBindingSchema.parse(binding)).toEqual(binding);
  expect(frameworkBindingSchema.parse({...binding, repository: canonical.repository}).repository).toBe(canonical.repository);
  expect(frameworkBindingSchema.safeParse({...binding, repository: 'foreign/repo'}).success).toBe(false);
  const input = {requestId: 'original', observed: true, app: {repository: canonical.repository, headSha: revision, artifactSha256: 'a'.repeat(64)},
    routine: {repository: canonical.repository, revision, bundleSha256: 'b'.repeat(64)}, framework: {repository: canonical.repository, revision, version: 2000, runtimeSha256: 'c'.repeat(64), apiVersion: 89}, glasses: null, execution: null, backend: null};
  expect(routineFixComponents(input, canonical.repository).map(row => row.component)).toEqual(['app artifact', 'routine bundle', 'framework']);
  expect(routineFixComponents(input, legacy.repository)).toEqual([]);
  const {repository: _repository, ...oldFramework} = input.framework;
  expect(routineFixComponents({...input, framework: oldFramework}, canonical.repository).map(row => row.component)).toEqual(['app artifact', 'routine bundle']);
});
