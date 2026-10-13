import {expect, test} from 'bun:test';
import mongoose from 'mongoose';
import {mkdtemp, readFile, readdir, rm, unlink, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {lifecycleRuns} from '../../testing/framework-lifecycle.fixture';
import {testRoutineSource} from '../../testing/framework-fixtures';
import {requestInputDigest} from '../../services/test-request.service';
import {readRoutineDefinition} from '../../services/routine-definition-detail.service';
import {TestingDetailStorage} from '../../services/testing-detail-storage.service';
import {StorageService} from '../../services/storage/storage.service';
import {LocalStorageProvider} from '../../services/storage/providers/local-storage.provider';
import {routineEnrollmentSchema} from '../../types/routine-definition.types';

const local = process.env.TESTING_STORAGE_MONGO_URI;
(local ? test : test.skip)('finite cutover preserves complete bytes and recovers a lost local acknowledgement, rejecting an unapproved delta', async () => {
  if (!local?.startsWith('mongodb://127.0.0.1:')) throw Error('Use isolated loopback Mongo');
  const dbName = `testing_storage_${randomUUID().replaceAll('-', '')}`, client = new mongoose.mongo.MongoClient(local);
  const directory = await mkdtemp(join(tmpdir(), 'testing-storage-cutover-'));
  const backup = join(directory, 'backup'), operation = join(directory, 'operation'), uri = `${local!.replace(/\/$/, '')}/${dbName}`;
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
  const {minimumRoutineApiVersion: _api, resourceRequirements: _resources, ...oldDefinition} = definition;
  const recordedDefinition = {...oldDefinition, id: 'recorded-nav', requires: ['no-glasses'],
    source: {...oldDefinition.source, revision: 'c'.repeat(40), path: 'routines/recorded-nav/routine.ts'}};
  const recorded = {routineId: 'recorded-nav', platform: 'android', definitionRevision: 'c'.repeat(40),
    definitionSha256: requestInputDigest(recordedDefinition), definition: recordedDefinition};
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
    await db.collection('routine_definitions').insertOne({...recorded, ordinaryEnrolledAt: date});
    const collection = {commit: enrollment.definitionRevision, version: 22, definitions: [enrollment]};
    await db.collection('routine_collections').insertOne({commit: collection.commit, version: 22, manifestSha256: requestInputDigest(collection),
      members: [{routineId: 'nav', platform: 'android', definitionSha256: enrollment.definitionSha256}]});
    const recordedCollection = {commit: recorded.definitionRevision, version: 21, definitions: [recorded]};
    await db.collection('routine_collections').insertOne({commit: recordedCollection.commit, version: 21,
      manifestSha256: requestInputDigest(recordedCollection), members: [{routineId: recorded.routineId, platform: 'android', definitionSha256: recorded.definitionSha256}]});
    await db.collection('reports').insertOne({reportId, mentraUserId: 'trusted-user', artifacts: [{artifactId, createdAt: date,
      type: 'state_snapshot', source: 'framework-diagnostic', filename: 'failure.json', contentType: 'application/json', sizeBytes: bytes.length}]});
    await db.collection('report_assets').insertOne({reportId, mentraUserId: 'trusted-user', artifactId, sourceTestRunId: runId,
      sourceTestAssetId: 'failure', storageKey: 'original/unchanged', sha256: run.assets[0]!.sha256, sizeBytes: bytes.length,
      fileName: 'failure.json', contentType: 'application/json'});
    expect((await exec('plan')).code).not.toBe(0);
    // Isolated fixture stands in for an operator's digest-bound full-backup proof.
    await mkdir(join(backup, 'baseline-full-db'), {recursive: true});
    const archive = Buffer.from('fixture full database archive'), archivePath = 'fixture.bson.gz';
    await writeFile(join(backup, 'baseline-full-db', archivePath), archive);
    const files = [{path: archivePath, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex')}];
    const manifestSha256 = createHash('sha256').update(JSON.stringify(files)).digest('hex');
    await writeFile(join(backup, 'full-backup-manifest.private.json'), JSON.stringify({database: dbName, environment: 'dev', files, manifestSha256}));
    const fullReceipt = {database: dbName, verified: true, originalManifestSha256: manifestSha256, collections: [{name: 'fixture'}]};
    await writeFile(join(backup, 'full-restore-verification.private.json'), JSON.stringify({...fullReceipt, verified: false}));
    expect((await exec('plan', `--backup-directory=${backup}`)).code).not.toBe(0);
    await writeFile(join(backup, 'full-restore-verification.private.json'), JSON.stringify(fullReceipt));
    expect((await exec('plan', `--backup-directory=${backup}`)).code).toBe(0);
    const exported = await exec('export'); expect(exported.errors).toBe(''); expect(exported.code).toBe(0);
    const verification = await exec('verify'); expect(verification.errors).toBe(''); expect(verification.code).toBe(0);
    const scope = JSON.parse(await readFile(join(operation, 'scope.private.json'), 'utf8')), digest = requestInputDigest(scope);
    expect((await exec('apply', '--frozen', '--approved-scope-sha256=wrong')).code).not.toBe(0);
    await db.collection('test_runs').insertOne({runId: 'unapproved', payload: {...run}, uploadsComplete: true});
    expect((await exec('apply', '--frozen', `--approved-scope-sha256=${digest}`)).code).not.toBe(0);
    expect((await db.collection('test_runs').findOne({runId}))?.payload).toBeDefined();
    await db.collection('test_runs').deleteOne({runId: 'unapproved'});
    await db.collection('reports').updateOne({reportId}, {$set: {lateUpdate: true}});
    expect((await exec('apply', '--frozen', `--approved-scope-sha256=${digest}`)).code).not.toBe(0);
    expect((await db.collection('test_runs').findOne({runId}))?.payload).toBeDefined();
    await db.collection('reports').updateOne({reportId}, {$unset: {lateUpdate: ''}});
    const applied = await exec('apply', '--frozen', `--approved-scope-sha256=${digest}`);
    expect(applied.errors).toBe(''); expect(applied.code).toBe(0);
    for (const file of await readdir(join(operation, 'applied'))) await unlink(join(operation, 'applied', file));
    const retried = await exec('apply', '--frozen', `--approved-scope-sha256=${digest}`);
    expect(retried.errors).toBe(''); expect(retried.code).toBe(0);
    expect((await exec('verify-applied')).code).toBe(0);
    // A finite approved delta can depend on already accepted run/definition pointers.
    const lateReportId = 'rep_LATE', lateArtifactId = 'art_LATE';
    await db.collection('reports').insertOne({reportId: lateReportId, mentraUserId: 'trusted-user', artifacts: [{artifactId: lateArtifactId,
      createdAt: date, type: 'state_snapshot', source: 'framework-diagnostic', filename: 'failure.json', contentType: 'application/json', sizeBytes: bytes.length}]});
    await db.collection('report_assets').insertOne({reportId: lateReportId, mentraUserId: 'trusted-user', artifactId: lateArtifactId,
      sourceTestRunId: runId, sourceTestAssetId: 'failure', storageKey: 'original/unchanged', sha256: run.assets[0]!.sha256,
      sizeBytes: bytes.length, fileName: 'failure.json', contentType: 'application/json'});
    await db.collection('routine_collections').updateOne({commit: collection.commit}, {$unset: {detail: ''}});
    const savedOperation = await readdir(operation);
    const delta = join(directory, 'delta'); await mkdir(delta);
    const runDelta = async (command: string, ...flags: string[]) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'cli.ts'), command, delta, ...flags], {
        env: {...process.env, MONGO_URL: uri, CLOUD_CORE_ENVIRONMENT: 'dev', CLOUD_STORAGE_PROVIDER: 'local', CLOUD_STORAGE_LOCAL_DIR: join(directory, 'storage')},
        stdout: 'pipe', stderr: 'pipe'});
      const output = await new Response(child.stdout).text(), errors = await new Response(child.stderr).text();
      return {code: await child.exited, output, errors};
    };
    expect((await runDelta('plan', `--backup-directory=${backup}`)).code).toBe(0);
    const deltaExport = await runDelta('export'); expect(deltaExport.errors).toBe(''); expect(deltaExport.code).toBe(0);
    expect((await runDelta('verify')).code).toBe(0);
    const deltaScope = JSON.parse(await readFile(join(delta, 'scope.private.json'), 'utf8'));
    expect((await runDelta('apply', '--frozen', `--approved-scope-sha256=${requestInputDigest(deltaScope)}`)).code).toBe(0);
    expect((await runDelta('verify-applied')).code).toBe(0);
    expect(await readdir(operation)).toEqual(savedOperation);
    const row = (await db.collection('test_runs').findOne({runId}))!;
    expect(row.payload).toBeUndefined(); expect(row.payloadSha256).toBe(payloadSha256); expect(row.originalFailures).toEqual(['do-not-alter']);
    expect(await db.collection('test_assets').countDocuments()).toBe(0);
    expect(await db.collection('report_assets').countDocuments()).toBe(0);
    expect((await db.collection('routine_definitions').findOne({routineId: 'nav'}))?.ordinaryEnrolledAt).toEqual(date);
    const archived = await db.collection('routine_definitions').findOne({routineId: recorded.routineId});
    const history = await readRoutineDefinition(archived as any, new TestingDetailStorage(new StorageService(
      new LocalStorageProvider({rootDir: join(directory, 'storage')})), 'dev'));
    expect(history).toEqual(recorded as any);
    expect(requestInputDigest(history.definition)).toBe(recorded.definitionSha256);
    expect(routineEnrollmentSchema.safeParse(history).success).toBe(false);
    expect((await db.collection('reports').findOne({reportId}))?.nativeDiagnostics).toBeDefined();
  } finally {await db.dropDatabase(); await client.close(); await rm(directory, {recursive: true, force: true});}
}, 20_000);
