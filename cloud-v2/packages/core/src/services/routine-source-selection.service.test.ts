import {expect, spyOn, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {GithubRoutineSourceGateway} from './routine-source-selection.service';
const commit = 'a'.repeat(40), tree = 'b'.repeat(40), routines = 'c'.repeat(40);
const bytes = new TextEncoder().encode('export const routine = true\n');
const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function gateway(changes: {mode?: string; truncated?: boolean; wrongBytes?: boolean; status?: string; size?: number; missing?: boolean} = {}) {
  const calls: string[] = [];
  return {calls, service: new GithubRoutineSourceGateway({async token(scope) {expect(scope).toBe('harness'); return 'private';}}, async (url, init) => {
    calls.push(url); expect(init.redirect).toBe('error'); expect(init.headers).toMatchObject({Authorization: 'Bearer private'});
    if (url.endsWith('/commits/main')) return Response.json({sha: commit});
    if (url.endsWith(`/git/commits/${'d'.repeat(40)}`)) return Response.json({sha: changes.status === 'diverged' ? 'e'.repeat(40) : 'd'.repeat(40)});
    if (url.endsWith(`/git/commits/${commit}`)) return Response.json({sha: commit, tree: {sha: tree}});
    if (url.endsWith(`/git/trees/${tree}`)) return Response.json({truncated: false, tree: changes.missing ? [] : [{path: 'routines', mode: '040000', type: 'tree', sha: routines}]});
    if (url.endsWith(`/git/trees/${routines}?recursive=1`)) return Response.json({truncated: changes.truncated ?? false, tree: [
      {path: 'sample/routine.ts', type: 'blob', mode: changes.mode ?? '100644', sha: blob, size: changes.size ?? bytes.length}]});
    if (url.endsWith(`/git/blobs/${blob}`)) return new Response(changes.wrongBytes ? 'wrong' : bytes);
    throw Error('unexpected URL');
  })};
}
test('resolve main once or verify an explicit commit without consulting moving main', async () => {
  const f = gateway(); expect(await f.service.resolve()).toBe(commit); expect(await f.service.resolve('d'.repeat(40))).toBe('d'.repeat(40));
  const exact=gateway();expect(await exact.service.resolve('d'.repeat(40))).toBe('d'.repeat(40));expect(exact.calls).toHaveLength(1);expect(exact.calls[0]).not.toContain('/commits/main');
  await expect(gateway({status: 'diverged'}).service.resolve('d'.repeat(40))).rejects.toThrow('differs');
});
test('source inventory confines routines tree and raw blobs prove Git object identity', async () => {
  const f = gateway(), inventory = await f.service.inventory(commit);
  expect(inventory).toEqual({commit, files: [{path: 'routines/sample/routine.ts', gitBlobSha1: blob, size: bytes.length}]});
  expect(await f.service.blob(inventory.files[0]!)).toEqual(bytes);
  expect(await f.service.inventory(commit)).toEqual(inventory); expect(f.calls.filter(url => url.includes('/git/trees/'))).toHaveLength(2);
  await expect(gateway({wrongBytes: true}).service.blob(inventory.files[0]!)).rejects.toThrow('differs');
});
test('source inventory refuses symlinks and incomplete GitHub trees', async () => {
  await expect(gateway({mode: '120000'}).service.inventory(commit)).rejects.toThrow('unsupported');
  await expect(gateway({truncated: true}).service.inventory(commit)).rejects.toThrow();
});


test('source inventory reports invalid bounded source separately from a cancelled request', async () => {
  for (const changes of [{mode:'120000'},{truncated:true},{size:64*1024**2+1},{missing:true}])
    await expect(gateway(changes).service.inventory(commit)).rejects.toMatchObject({status:422});
  const f=gateway();await f.service.resolve();await f.service.inventory(commit);
  expect(f.calls.every(url=>url.startsWith('https://api.github.com/repos/Mentra-Community/Mentra-Automated-Testing/'))).toBe(true);
});

test('blob failures retain sanitized upstream phase and status without exposing provider material', async () => {
  const observations: unknown[] = [];
  const upstream = async () => new Response('PRIVATE_PROVIDER_BODY', {status: 403});
  const service = new GithubRoutineSourceGateway({async token() {return 'PRIVATE_TOKEN';}}, upstream, value => observations.push(value));
  await expect(service.blob({gitBlobSha1: blob, size: bytes.length})).rejects.toMatchObject({status: 503});
  expect(observations).toEqual([{phase: 'response', blobSha: blob, expectedBytes: bytes.length,
    elapsedMs: expect.any(Number), status: 403, failure: 'unavailable',
    upstream: {kind: 'unknown', message: 'GitHub refused the routine source download.', bodyState: 'invalid'}}]);
  expect(JSON.stringify(observations)).not.toContain('PRIVATE');

  observations.length = 0;
  const unauthenticated = new GithubRoutineSourceGateway({async token() {throw new Error('PRIVATE_KEY');}}, upstream, value => observations.push(value));
  await expect(unauthenticated.blob({gitBlobSha1: blob, size: bytes.length})).rejects.toMatchObject({status: 503});
  expect(observations).toEqual([{phase: 'authentication', blobSha: blob, expectedBytes: bytes.length,
    elapsedMs: expect.any(Number), failure: 'unavailable'}]);
  expect(JSON.stringify(observations)).not.toContain('PRIVATE');

  observations.length = 0;
  const corrupt = new GithubRoutineSourceGateway({async token() {return 'PRIVATE_TOKEN';}}, async () => new Response('wrong'), value => observations.push(value));
  await expect(corrupt.blob({gitBlobSha1: blob, size: bytes.length})).rejects.toThrow('differs');
  expect(observations).toEqual([{phase: 'integrity', blobSha: blob, expectedBytes: bytes.length,
    receivedBytes: 5, elapsedMs: expect.any(Number), status: 200, failure: 'identity-mismatch'}]);
});

test('a GitHub denial retains private classification and allowed headers, not its raw message', async () => {
  const observations: unknown[] = [];
  const service = new GithubRoutineSourceGateway({async token() {return 'PRIVATE_TOKEN';}}, async () =>
    Response.json({message: 'You have exceeded a secondary rate limit. PRIVATE_TOKEN', errors: [{token: 'PRIVATE_KEY'}]}, {
      status: 403, headers: {'x-github-request-id': 'ABCD:12:EF', 'x-ratelimit-remaining': '42',
        'x-ratelimit-reset': '1792843336', 'retry-after': '60', 'x-accepted-github-permissions': 'contents=read',
        'authorization': 'Bearer PRIVATE_TOKEN'},
    }), value => observations.push(value));
  await expect(service.blob({gitBlobSha1: blob, size: bytes.length})).rejects.toMatchObject({status: 503,
    message: 'Routine files could not be downloaded.'});
  expect(observations).toEqual([expect.objectContaining({phase: 'response', status: 403,
    upstream: {kind: 'secondary-rate-limit', message: 'GitHub reported a secondary rate limit.', bodyState: 'json',
      githubRequestId: 'ABCD:12:EF', rateLimit: {remaining: 42, reset: 1792843336}, retryAfter: 60, acceptedPermissions: 'contents=read'}})]);
  expect(JSON.stringify(observations)).not.toContain('PRIVATE');
});

test('recognized denial messages retain fixed provider claims without their identifying suffixes', async () => {
  for (const [message, kind] of [
    ['API rate limit exceeded for PRIVATE_ADDRESS. PRIVATE_TOKEN', 'primary-rate-limit'],
    ['Resource not accessible by integration', 'integration-access-denied'],
    ['Bad credentials', 'bad-credentials'],
  ]) {
    const observations: unknown[] = [];
    const service = new GithubRoutineSourceGateway({async token() {return 'PRIVATE_TOKEN';}}, async () =>
      Response.json({message}, {status: 403}), value => observations.push(value));
    await expect(service.blob({gitBlobSha1: blob, size: 1})).rejects.toMatchObject({status: 503});
    expect(observations).toEqual([expect.objectContaining({upstream: expect.objectContaining({kind, bodyState: 'json'})})]);
    expect(JSON.stringify(observations)).not.toContain('PRIVATE');
  }
});

test('unknown body text, nested fields and malformed allowed headers cannot enter private diagnostics', async () => {
  const secrets = ['PRIVATE_TOKEN', 'ghs_PRIVATE', 'github_pat_PRIVATE', 'Bearer PRIVATE',
    'msk_PRIVATE', 'eyJPRIVATE.eyJPRIVATE.PRIVATE', 'private@example.com', '/Users/private/key', 'https://private.example/?token=PRIVATE'];
  const observations: unknown[] = [];
  const service = new GithubRoutineSourceGateway({async token() {return secrets[0]!;}}, async () =>
    Response.json({message: secrets.join(' '), errors: [{privateKey: secrets.join(' ')}]}, {status: 403,
      headers: {'x-github-request-id': 'PRIVATE_TOKEN', 'x-ratelimit-limit': 'Bearer PRIVATE', 'x-ratelimit-remaining': '-1',
        'x-ratelimit-reset': 'Infinity', 'x-ratelimit-used': '9007199254740992', 'x-ratelimit-resource': 'PRIVATE',
        'retry-after': 'PRIVATE', 'x-accepted-github-permissions': 'contents=read;token=PRIVATE', 'x-extra': 'PRIVATE'}}),
    value => observations.push(value));
  const error = await service.blob({gitBlobSha1: blob, size: bytes.length}).catch(error => error);
  expect(error).toMatchObject({status: 503, message: 'Routine files could not be downloaded.'});
  expect(observations).toEqual([expect.objectContaining({upstream:
    {kind: 'unknown', message: 'GitHub refused the routine source download.', bodyState: 'json'}})]);
  for (const secret of secrets) expect(JSON.stringify(observations) + error.message).not.toContain(secret);
});

test('an oversized denial body is cancelled without consuming a stalled suffix or retaining its bytes', async () => {
  let cancelled = false;
  const observations: unknown[] = [];
  const service = new GithubRoutineSourceGateway({async token() {return 'PRIVATE_TOKEN';}}, async () =>
    new Response(new ReadableStream({start(controller) {
      controller.enqueue(new TextEncoder().encode('PRIVATE_BODY'.repeat(500)));
    }, cancel() {cancelled = true;}}), {status: 403, headers: {'x-ratelimit-remaining': '0'}}), value => observations.push(value));
  await expect(service.blob({gitBlobSha1: blob, size: bytes.length})).rejects.toMatchObject({status: 503});
  expect(cancelled).toBe(true);
  expect(observations).toEqual([expect.objectContaining({upstream: {kind: 'unknown',
    message: 'GitHub refused the routine source download.', bodyState: 'oversize', rateLimit: {remaining: 0}}})]);
  expect(JSON.stringify(observations)).not.toContain('PRIVATE');
});

test('empty and malformed denials retain safe headers, including a normalized HTTP retry date', async () => {
  for (const [body, bodyState] of [['', 'empty'], ['not JSON', 'invalid']] as const) {
    const observations: unknown[] = [];
    const service = new GithubRoutineSourceGateway({async token() {return 'private';}}, async () =>
      new Response(body, {status: 503, headers: {'x-github-request-id': 'AB:CD:12', 'retry-after': 'Sat, 24 Oct 2026 12:02:16 GMT'}}),
      value => observations.push(value));
    await expect(service.blob({gitBlobSha1: blob, size: bytes.length})).rejects.toMatchObject({status: 503});
    expect(observations).toEqual([expect.objectContaining({upstream: {kind: 'unknown',
      message: 'GitHub refused the routine source download.', bodyState, githubRequestId: 'AB:CD:12', retryAfter: '2026-10-24T12:02:16.000Z'}})]);
  }
});

test('a stalled denial body and non-cooperative cancellation cannot outlive the original source deadline', async () => {
  const controller = new AbortController(), timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    expect(ms).toBe(60_000); return controller.signal;
  });
  let entered!: () => void, settleCancellation!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;}), observations: unknown[] = [];
  try {
    const service = new GithubRoutineSourceGateway({async token() {return 'private';}}, async (_url, init) => {
      expect(init.signal).toBe(controller.signal);
      return new Response(new ReadableStream({pull() {entered(); return new Promise<void>(() => {});},
        cancel() {return new Promise<void>(resolve => {settleCancellation = resolve;});}}),
      {status: 403, headers: {'x-github-request-id': 'AB:CD:12'}});
    }, value => observations.push(value));
    const work = service.blob({gitBlobSha1: blob, size: bytes.length}); await started; controller.abort();
    await expect(work).rejects.toMatchObject({status: 503});
    expect(observations).toEqual([expect.objectContaining({phase: 'response', status: 403, failure: 'deadline',
      upstream: {kind: 'unknown', message: 'GitHub refused the routine source download.', bodyState: 'unavailable', githubRequestId: 'AB:CD:12'}})]);
    const original = JSON.stringify(observations); settleCancellation(); await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(observations)).toBe(original);
  } finally {timeout.mockRestore();}
});

test('successful raw blobs resembling denial JSON retain Git identity and the existing verified cache', async () => {
  const raw = new TextEncoder().encode('{"message":"Bad credentials"}\n'), observations: unknown[] = [];
  const sha = createHash('sha1').update(`blob ${raw.length}\0`).update(raw).digest('hex'); let reads = 0;
  const service = new GithubRoutineSourceGateway({async token() {return 'private';}}, async (_url, init) => {
    reads++; expect(init.headers).toMatchObject({Accept: 'application/vnd.github.raw+json'}); return new Response(raw);
  }, value => observations.push(value));
  const file = {gitBlobSha1: sha, size: raw.length}, first = await service.blob(file); first[0] = 0;
  expect(await service.blob(file)).toEqual(raw); expect(reads).toBe(1); expect(observations).toEqual([]);
});

test('26 concurrent members share verified immutable blobs and returned copies cannot poison the cache', async () => {
  let reads = 0;
  const service = new GithubRoutineSourceGateway({async token() {return 'private';}}, async () => {
    reads++; await Promise.resolve(); return new Response(bytes);
  });
  const file = {gitBlobSha1: blob, size: bytes.length};
  const results = await Promise.all(Array.from({length: 26}, () => service.blob(file)));
  expect(reads).toBe(1);
  for (const value of results) expect(value).toEqual(bytes);
  results[0]![0] = 0;
  expect(results[1]).toEqual(bytes); expect(await service.blob(file)).toEqual(bytes); expect(reads).toBe(1);
  await expect(service.blob({...file, size: file.size + 1})).rejects.toThrow('differs');
});

test('failed or corrupt downloads never populate the verified blob cache', async () => {
  let reads = 0;
  const service = new GithubRoutineSourceGateway({async token() {return 'private';}}, async () => {
    reads++; return new Response(reads === 1 ? 'wrong' : bytes);
  }, () => {});
  const file = {gitBlobSha1: blob, size: bytes.length};
  await expect(service.blob(file)).rejects.toThrow('differs');
  expect(await service.blob(file)).toEqual(bytes); expect(reads).toBe(2);
});

test('in-flight byte admission preserves one64MiB blob and releases failed capacity without evicting a shared download', async () => {
  let finish!: (value: Response) => void, reads = 0;
  const service = new GithubRoutineSourceGateway({async token() {return 'private';}}, async () => {
    reads++; return new Promise<Response>(resolve => {finish = resolve;});
  }, () => {});
  const large = {gitBlobSha1: 'a'.repeat(40), size: 64 * 1024 ** 2};
  const first = service.blob(large), shared = service.blob(large);
  const failed = Promise.allSettled([first, shared]);
  await expect(service.blob({gitBlobSha1: blob, size: bytes.length})).rejects.toThrow('concurrent bound');
  await Promise.resolve(); finish(new Response('unavailable', {status: 503}));
  expect(await failed).toEqual([{status: 'rejected', reason: expect.objectContaining({status: 503})},
    {status: 'rejected', reason: expect.objectContaining({status: 503})}]);
  expect(reads).toBe(1);
  const next = service.blob({gitBlobSha1: blob, size: bytes.length});
  await Promise.resolve(); finish(new Response(bytes));
  expect(await next).toEqual(bytes); expect(reads).toBe(2);
});


const workflowSource = 'f25da1aa5b15aca095c7b93a75f6a3e218c597f0';
const originalOccurrence = {occurrenceId: 'manual-dev-40924073359', startedAt: '2026-10-29T17:43:42Z', trigger: 'manual' as const};
const originalRun = {id: 40924073359, head_sha: workflowSource, path: '.github/workflows/nightly-device-routines.yml',
  head_branch: 'dev', event: 'workflow_dispatch', created_at: originalOccurrence.startedAt,
  repository: {full_name: 'Mentra-Community/Mentra'}, head_repository: {full_name: 'Mentra-Community/Mentra'}};
function nightlySource(changes: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const service = new GithubRoutineSourceGateway({async token(scope, repository) {
    expect(scope).toBe('private'); expect(repository).toBe('Mentra-Community/Mentra'); return 'private';
  }}, async url => {calls.push(url); expect(url).toBe('https://api.github.com/repos/Mentra-Community/Mentra/actions/runs/40924073359');
    return Response.json({...originalRun, ...changes});});
  return {service, calls};
}
test('same-second merge and later pushes cannot block or replace the exact original workflow source', async () => {
  const {service, calls} = nightlySource();
  expect(await service.resolveNightly(originalOccurrence, 'Mentra-Community/Mentra')).toBe(workflowSource);
  expect(calls).toHaveLength(1); // No activity, branch tip, comparison or commit-history request.
});
test('explicit scheduler run ID preserves the same manual source', async () => {
  expect(await nightlySource().service.resolveNightly({...originalOccurrence, workflowRunId: 40924073359}, 'Mentra-Community/Mentra')).toBe(workflowSource);
});
test('nightly source rejects foreign repository, branch, workflow, event, time and run identity', async () => {
  for (const changes of [{id: 1}, {head_sha: 'not-a-sha'}, {head_branch: 'other'}, {event: 'pull_request'},
    {path: '.github/workflows/release.yml'}, {created_at: '2026-10-29T17:43:43Z'},
    {repository: {full_name: 'other/repo'}}, {head_repository: {full_name: 'other/repo'}}])
    await expect(nightlySource(changes).service.resolveNightly(originalOccurrence, 'Mentra-Community/Mentra')).rejects.toMatchObject({status: 409});
});
test('missing or conflicting original identity and unsupported repository are rejected without branch history', async () => {
  const f = nightlySource();
  for (const occurrence of [{...originalOccurrence, workflowRunId: 1}, {...originalOccurrence, startedAt: 'invalid'},
    {...originalOccurrence, occurrenceId: 'not-a-run'}, {...originalOccurrence, workflowRunId: Number.MAX_SAFE_INTEGER + 1}])
    await expect(f.service.resolveNightly(occurrence, 'Mentra-Community/Mentra')).rejects.toMatchObject({status: expect.any(Number)});
  await expect(f.service.resolveNightly(originalOccurrence, 'Mentra-Community/Mentra-Automated-Testing')).rejects.toMatchObject({status: 400});
});
test('scheduled source uses the original workflow even when delivery is delayed', async () => {
  const f = nightlySource({event: 'schedule', created_at: '2026-10-29T13:14:00Z'});
  expect(await f.service.resolveNightly({occurrenceId: 'nightly-dev-2026-10-29', startedAt: '2026-10-29T13:00:00Z',
    trigger: 'nightly', workflowRunId: 40924073359}, 'Mentra-Community/Mentra')).toBe(workflowSource);
  for (const created_at of ['2026-10-29T12:59:59Z'])
    await expect(nightlySource({event: 'schedule', created_at}).service.resolveNightly({occurrenceId: 'nightly-dev-2026-10-29',
      startedAt: '2026-10-29T13:00:00Z', trigger: 'nightly', workflowRunId: 40924073359}, 'Mentra-Community/Mentra')).rejects.toMatchObject({status: 409});
});
test('late scheduled source remains resolvable; the original occurrence deadline decides not-run', async () => {
  expect(await nightlySource({event: 'schedule', created_at: '2026-10-29T19:00:00Z'}).service.resolveNightly({
    occurrenceId: 'nightly-dev-2026-10-29', startedAt: '2026-10-29T13:00:00Z', trigger: 'nightly',
    workflowRunId: 40924073359}, 'Mentra-Community/Mentra')).toBe(workflowSource);
});
test('nightly source token and response waits remain bounded', async () => {
  for (const phase of ['authentication', 'response']) {
    const controller = new AbortController(), timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let entered!: () => void; const started = new Promise<void>(resolve => {entered = resolve;});
    try {
      const service = new GithubRoutineSourceGateway({async token(scope) {
        expect(scope).toBe('private'); if (phase === 'authentication') {entered(); return new Promise<string>(() => {});} return 'private';
      }}, async () => {entered(); return new Promise<Response>(() => {});});
      const result = service.resolveNightly(originalOccurrence, 'Mentra-Community/Mentra'); await started; controller.abort();
      await expect(result).rejects.toMatchObject({status: 503});
    } finally {timeout.mockRestore();}
  }
});
