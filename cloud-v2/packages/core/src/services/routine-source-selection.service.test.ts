import {expect, test} from 'bun:test';
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
