import {expect, test} from 'bun:test';
import mongoose from 'mongoose';
import {mkdtemp, readFile, readdir, rm, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {lifecycleRuns} from '../../testing/framework-lifecycle.fixture';
import {testRoutineSource} from '../../testing/framework-fixtures';
import {requestInputDigest} from '../../services/test-request.service';

const local = process.env.TESTING_STORAGE_MONGO_URI;
(local ? test : test.skip)('finite cutover preserves complete bytes and recovers a lost local acknowledgement, rejecting an unapproved delta', async () => {
  if (!local?.startsWith('mongodb://127.0.0.1:')) throw Error('Use isolated loopback Mongo');
  const dbName = `testing_storage_${randomUUID().replaceAll('-', '')}`, client = new mongoose.mongo.MongoClient(local);
  const directory = await mkdtemp(join(tmpdir(), 'testing-storage-cutover-'));
  const operation = join(directory, 'operation'), uri = `${local!.replace(/\/$/, '')}/${dbName}`;
  const run = structuredClone(lifecycleRuns[0]!.run);
  const bytes = Buffer.from('{"message":"original setup failure"}');
  run.assets = [{id: 'failure', kind: 'diagnostic', path: 'failure.json', mimeType: 'application/json', size: bytes.length,
    sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')}];
  const payloadSha256 = requestInputDigest(run), runId = run.result.runId;
  const definition = {id: 'nav', minimumRoutineApiVersion: 1, title: 'Navigate', purpose: 'Check navigation', platforms: ['android'],
    entry: 'home', account: 'lane', resourceRequirements: [], requirements: [], fixtures: [],
    steps: [{id: 'open', instruction: 'Open settings', expected: 'Settings visible'}],
    source: {repository: 'Mentra-Community/Mentra-Automated-Testing', revision: 'a'.repeat(40), path: 'routines/nav/routine.ts'}};
  const enrollment = {routineId: 'nav', platform: 'android', definitionRevision: 'a'.repeat(40), definitionSha256: requestInputDigest(definition),
    routineSource: testRoutineSource('a'.repeat(40)), definition};
  const reportId = 'rep_ORIGINAL', artifactId = 'art_ORIGINAL', date = new Date('2026-10-05T12:00:00Z');
  await client.connect(); const db = client.db(dbName);
  const exec = async (command: string, ...flags: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), command, operation, ...flags], {
      env: {...process.env, MONGO_URL: uri, CLOUD_CORE_ENVIRONMENT: 'dev', CLOUD_STORAGE_PROVIDER: 'local', CLOUD_STORAGE_LOCAL_DIR: join(directory, 'storage')},
      stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
    return {code: await child.exited, output, errors};
  };
  try {
    await db.collection('test_runs').insertOne({runId, requestId: run.requestId, payload: run, payloadSha256, uploadsComplete: true,
      originalFailures: ['do-not-alter'], outcome: 'failed'});
    await db.collection('test_assets').insertOne({runId, assetId: 'failure', storageKey: 'original/unchanged', sha256: run.assets[0]!.sha256, sizeBytes: bytes.length});
    await db.collection('routine_definitions').insertOne({...enrollment, ordinaryEnrolledAt: date});
    const collection = {commit: enrollment.definitionRevision, version: 22, definitions: [enrollment]};
    await db.collection('routine_collections').insertOne({commit: collection.commit, version: 22, manifestSha256: requestInputDigest(collection),
      members: [{routineId: 'nav', platform: 'android', definitionSha256: enrollment.definitionSha256}]});
    await db.collection('reports').insertOne({reportId, mentraUserId: 'trusted-user', artifacts: [{artifactId, createdAt: date,
      type: 'state_snapshot', source: 'framework-diagnostic', filename: 'failure.json', contentType: 'application/json', sizeBytes: bytes.length}]});
    await db.collection('report_assets').insertOne({reportId, mentraUserId: 'trusted-user', artifactId, sourceTestRunId: runId,
      sourceTestAssetId: 'failure', storageKey: 'original/unchanged', sha256: run.assets[0]!.sha256, sizeBytes: bytes.length,
      fileName: 'failure.json', contentType: 'application/json'});
    expect((await exec('plan')).code).toBe(0);
    expect((await exec('export')).code).toBe(0);
    const verification = await exec('verify'); expect(verification.errors).toBe(''); expect(verification.code).toBe(0);
    const scope = JSON.parse(await readFile(join(operation, 'scope.private.json'), 'utf8')), digest = requestInputDigest(scope);
    expect((await exec('apply', '--frozen', '--approved-scope-sha256=wrong')).code).not.toBe(0);
    await db.collection('test_runs').insertOne({runId: 'unapproved', payload: {...run}, uploadsComplete: true});
    expect((await exec('apply', '--frozen', `--approved-scope-sha256=${digest}`)).code).not.toBe(0);
    expect((await db.collection('test_runs').findOne({runId}))?.payload).toBeDefined();
    await db.collection('test_runs').deleteOne({runId: 'unapproved'});
    const applied = await exec('apply', '--frozen', `--approved-scope-sha256=${digest}`);
    expect(applied.errors).toBe(''); expect(applied.code).toBe(0);
    for (const file of await readdir(join(operation, 'applied'))) await unlink(join(operation, 'applied', file));
    const retried = await exec('apply', '--frozen', `--approved-scope-sha256=${digest}`);
    expect(retried.errors).toBe(''); expect(retried.code).toBe(0);
    expect((await exec('verify-applied')).code).toBe(0);
    const row = (await db.collection('test_runs').findOne({runId}))!;
    expect(row.payload).toBeUndefined(); expect(row.payloadSha256).toBe(payloadSha256); expect(row.originalFailures).toEqual(['do-not-alter']);
    expect(await db.collection('test_assets').countDocuments()).toBe(0);
    expect(await db.collection('report_assets').countDocuments()).toBe(0);
    expect((await db.collection('routine_definitions').findOne({routineId: 'nav'}))?.ordinaryEnrolledAt).toEqual(date);
    expect((await db.collection('reports').findOne({reportId}))?.nativeDiagnostics).toBeDefined();
  } finally {await db.dropDatabase(); await client.close(); await rm(directory, {recursive: true, force: true});}
}, 20_000);
