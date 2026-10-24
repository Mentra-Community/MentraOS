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

const boundary = '2026-10-17T11:00:00Z', oldMain = '1'.repeat(40), nextMain = '2'.repeat(40), side = '3'.repeat(40);
const activity = (id: number, before: string, after: string, timestamp: string, changes = {}) => ({
  id, before, after, timestamp, ref: 'refs/heads/main', activity_type: 'pr_merge', ...changes});
function historyGateway(pages: unknown[][], changes: {tip?: string; finalTip?: string; comparison?: unknown; link?: string | null; fail?: string} = {}) {
  const calls: string[] = [], signals: AbortSignal[] = []; let mainReads = 0, page = 0;
  const service = new GithubRoutineSourceGateway({async token() {return 'private';}}, async (url, init) => {
    calls.push(url); signals.push(init.signal as AbortSignal);
    if (changes.fail && url.includes(changes.fail)) return new Response('PRIVATE_BODY', {status: 403});
    if (url.endsWith('/commits/main')) return Response.json({sha: ++mainReads === 1 ? changes.tip ?? nextMain : changes.finalTip ?? changes.tip ?? nextMain});
    if (url.includes('/activity?')) {
      const rows = pages[page++] ?? [];
      const link = changes.link !== undefined ? changes.link : page < pages.length
        ? `<https://api.github.com/repositories/123/activity?ref=refs%2Fheads%2Fmain&per_page=100&after=cursor-${page}>; rel="next"` : null;
      return Response.json(rows, {headers: link ? {link} : {}});
    }
    if (url.includes('/compare/')) return Response.json(changes.comparison ?? {status: 'ahead',
      base_commit: {sha: oldMain}, merge_base_commit: {sha: oldMain}});
    throw new Error(`Unexpected source URL ${url}`);
  });
  return {service, calls, signals};
}
const delayed = () => [activity(2, oldMain, nextMain, '2026-10-17T11:02:00Z'),
  activity(1, side, oldMain, '2026-10-17T10:58:00Z')];
test('delayed first delivery uses main branch transition time, not author or committer dates', async () => {
  const f = historyGateway([delayed().map(row => ({...row, commit: {committer: {date: '2026-01-01T00:00:00Z'}}}))]);
  expect(await f.service.resolve(undefined, boundary)).toBe(oldMain);
  expect(f.calls.filter(url => url.endsWith('/commits/main'))).toHaveLength(2);
  expect(f.calls.find(url => url.includes('/compare/'))).toContain(`${oldMain}...${nextMain}`);
  expect(new Set(f.signals).size).toBe(1); // auth, history, comparison and final ref share one budget.
});
test('already current main is selected from exact matching historical branch activity', async () => {
  const f = historyGateway([[activity(1, side, oldMain, '2026-10-17T10:58:00Z')]], {tip: oldMain});
  expect(await f.service.resolve(undefined, boundary)).toBe(oldMain);
  expect(f.calls.some(url => url.includes('/compare/'))).toBe(false);
});
test('cursor pages retain exact contiguous main ancestry and reject moving main', async () => {
  const f = historyGateway([[delayed()[0]!], [delayed()[1]!]]);
  expect(await f.service.resolve(undefined, boundary)).toBe(oldMain);
  expect(f.calls.filter(url => url.includes('/activity?'))[1]).toContain('after=cursor-1');
  await expect(historyGateway([delayed()], {finalTip: side}).service.resolve(undefined, boundary)).rejects.toMatchObject({status: 503});
});
test('missing, reordered, cyclic or wrong-ref branch history cannot fall back to current main', async () => {
  for (const rows of [[], [delayed()[1]!], delayed().reverse(),
    [delayed()[0]!, {...delayed()[1]!, after: side}],
    [{...delayed()[0]!, before: nextMain}],
    [{...delayed()[0]!, ref: 'refs/heads/other'}],
    [{...delayed()[0]!, id: 1}, delayed()[1]!]]) {
    await expect(historyGateway([rows]).service.resolve(undefined, boundary)).rejects.toMatchObject({status: 503});
  }
});
test('rewrites, deletion, creation and unknown activity cannot establish canonical historical main', async () => {
  for (const activity_type of ['force_push', 'branch_deletion', 'branch_creation', 'unknown']) {
    await expect(historyGateway([[{...delayed()[0]!, activity_type}, delayed()[1]!]])
      .service.resolve(undefined, boundary)).rejects.toMatchObject({status: 503});
  }
  for (const comparison of [{status: 'diverged', base_commit: {sha: oldMain}, merge_base_commit: {sha: side}},
    {status: 'ahead', base_commit: {sha: side}, merge_base_commit: {sha: oldMain}},
    {status: 'ahead', base_commit: {sha: oldMain}, merge_base_commit: {sha: side}}, {}]) {
    await expect(historyGateway([delayed()], {comparison}).service.resolve(undefined, boundary)).rejects.toMatchObject({status: 503});
  }
});
test('second-resolution boundary transitions fail closed, including later millisecond boundaries', async () => {
  for (const at of [boundary, '2026-10-17T11:00:00.900Z']) {
    await expect(historyGateway([[{...delayed()[0]!, timestamp: boundary}]]).service.resolve(undefined, at))
      .rejects.toMatchObject({status: 503});
  }
});
test('unavailable authority and unsafe or repeated cursor stop within bounded history', async () => {
  for (const fail of ['/commits/main', '/activity?', '/compare/'])
    await expect(historyGateway([delayed()], {fail}).service.resolve(undefined, boundary)).rejects.toMatchObject({status: 503});
  for (const link of [null, '<https://other.example/activity?after=cursor>; rel="next"',
    '<https://api.github.com/repos/Mentra-Community/Mentra-Automated-Testing/activity?ref=refs%2Fheads%2Fother&after=cursor>; rel="next"',
    '<https://api.github.com/repositories/123/activity?ref=refs%2Fheads%2Fmain>; rel="next"'])
    await expect(historyGateway([[delayed()[0]!]], {link}).service.resolve(undefined, boundary)).rejects.toMatchObject({status: 503});
  const rows = Array.from({length: 4}, (_, index) => activity(10 - index, String(index + 4).repeat(40),
    index ? String(index + 3).repeat(40) : nextMain, `2026-10-17T11:0${5-index}:00Z`));
  const f = historyGateway(rows.map(row => [row]));
  await expect(f.service.resolve(undefined, boundary)).rejects.toMatchObject({status: 503});
  expect(f.calls.filter(url => url.includes('/activity?'))).toHaveLength(3);
  const repeated = historyGateway([[rows[0]!], [rows[1]!]], {
    link: '<https://api.github.com/repositories/123/activity?ref=refs%2Fheads%2Fmain&after=same>; rel="next"'});
  await expect(repeated.service.resolve(undefined, boundary)).rejects.toMatchObject({status: 503});
});
test('invalid historical boundary or mixed exact source input is refused before GitHub reads', async () => {
  const f = historyGateway([delayed()]);
  await expect(f.service.resolve(undefined, 'invalid')).rejects.toMatchObject({status: 400});
  await expect(f.service.resolve(oldMain, boundary)).rejects.toMatchObject({status: 400});
  expect(f.calls).toHaveLength(0);
});
test('the shared source deadline bounds authentication and non-cooperative history responses', async () => {
  const controller = new AbortController(), timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    expect(ms).toBe(20_000); return controller.signal;
  });
  let entered!: () => void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  try {
    const service = new GithubRoutineSourceGateway({async token() {entered(); return new Promise<string>(() => {});}},
      async () => {throw new Error('No request is allowed after expired authentication');});
    const work = service.resolve(undefined, boundary); await started; controller.abort();
    await expect(work).rejects.toMatchObject({status: 503});
  } finally {timeout.mockRestore();}
  const remote = new AbortController(), second = spyOn(AbortSignal, 'timeout').mockReturnValue(remote.signal);
  let requested!: () => void;
  const request = new Promise<void>(resolve => {requested = resolve;});
  try {
    const service = new GithubRoutineSourceGateway({async token() {return 'private';}}, async (_url, init) => {
      expect(init.signal).toBe(remote.signal); requested(); return new Promise<Response>(() => {});
    });
    const work = service.resolve(undefined, boundary); await request; remote.abort();
    await expect(work).rejects.toMatchObject({status: 503});
  } finally {second.mockRestore();}
});
