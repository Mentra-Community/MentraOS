import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, chmod, readdir, rename, open} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import mongoose from 'mongoose';
import {requestInputDigest} from '../../services/test-request.service';
import {createRecordedFrameworkRunSummaryProjection} from '../../services/framework-run-summary.service';
import {writeRunEnvelope, verifyRunEnvelope, readStoredRun} from '../../services/framework-run-detail.service';
import {readRoutineDefinition, writeRecordedRoutineDefinition, routineCollectionDetailSchema, routineCollectionManifestSchema, readRoutineCollection} from '../../services/routine-definition-detail.service';
import {TestingDetailStorage} from '../../services/testing-detail-storage.service';
import {reportNativeSnapshotSchema, expandNativeReportSnapshot} from '../../services/report-native-detail.service';
import {frameworkRunOutcome, frameworkEvidenceComplete, recordedFrameworkRunSchema} from '../../types/framework-run.types';
import {recordedRoutineEnrollmentSchema} from '../../types/routine-definition.types';

const [operation, directoryArgument, ...flags] = process.argv.slice(2);
if (!['plan', 'export', 'verify', 'apply', 'verify-applied'].includes(operation ?? '') || !directoryArgument)
  throw Error('Usage: cli.ts plan|export|verify|apply|verify-applied /private/operation [--approved-scope-sha256=...] [--frozen]');
const directory = resolve(directoryArgument), uri = process.env.MONGO_URL;
if (!uri) throw Error('MONGO_URL must be injected from the existing Core environment');
const client = new mongoose.mongo.MongoClient(uri, {serverSelectionTimeoutMS: 10_000, socketTimeoutMS: 120_000, promoteValues: false});
const details = new TestingDetailStorage();
const verifyBackup = async (path: string, database: string) => {
  const manifest = JSON.parse(await readFile(join(path, 'full-backup-manifest.private.json'), 'utf8'));
  const receipt = JSON.parse(await readFile(join(path, 'full-restore-verification.private.json'), 'utf8'));
  const digest = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
  if (manifest.database !== database || manifest.environment !== (process.env.CLOUD_CORE_ENVIRONMENT ?? 'local') ||
    receipt.database !== database || receipt.verified !== true || receipt.originalManifestSha256 !== manifest.manifestSha256 ||
    digest !== manifest.manifestSha256 || !manifest.files.length || !receipt.collections.length)
    throw Error('Full backup restore verification does not match this database and manifest');
  for (const file of manifest.files) {
    const bytes = await readFile(join(path, 'baseline-full-db', file.path));
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw Error('Full verified backup archive differs');
  }
  return {directory: path, manifestSha256: manifest.manifestSha256, verificationSha256: requestInputDigest(receipt)};
};
const write = async (path: string, value: unknown) => {
  const temporary = `${path}.tmp`, file = await open(temporary, 'w', 0o600);
  try {await file.writeFile(JSON.stringify(value, null, 2)); await file.sync();} finally {await file.close();}
  await rename(temporary, path); await chmod(path, 0o600);
};
const digestBson = (value: Record<string, unknown>) => createHash('sha256').update(mongoose.mongo.BSON.serialize(value)).digest('hex');
const digestJsonBson = (v: unknown) => requestInputDigest(mongoose.mongo.BSON.EJSON.serialize(v, {relaxed: false}));
const value = <T>(v: T): T => mongoose.mongo.BSON.EJSON.deserialize(mongoose.mongo.BSON.EJSON.serialize(v), {relaxed: true}) as T;
type ScopeRow = {collection: 'test_runs' | 'routine_definitions' | 'routine_collections' | 'reports'; id: string; bsonSha256: string; bsonBytes: number;
  receiptRows?: {collection: 'test_assets' | 'report_assets'; ids: string[]; count: number; bytes: number; sha256: string}};
type Scope = {version: 1; database: string; environment: string; capturedAt: string; rows: ScopeRow[]; backup: Awaited<ReturnType<typeof verifyBackup>>};
const backupPath = (row: ScopeRow) => join(directory, 'source', `${row.collection}-${row.id}.bson`);
const receiptPath = (row: ScopeRow) => join(directory, 'receipts', `${row.collection}-${row.id}.json`);
const appliedPath = (row: ScopeRow) => join(directory, 'applied', `${row.collection}-${row.id}.json`);
const readBson = async (row: ScopeRow) => mongoose.mongo.BSON.deserialize(await readFile(backupPath(row)), {promoteValues: false});

try {
  await client.connect(); const db = client.db();
  if (db.databaseName !== 'mentra-cloud-v2-dev-aws' && !/^testing_storage_[a-z0-9_]+$/.test(db.databaseName))
    throw Error('Database is outside the approved dev target or isolated rehearsal namespace');
  await mkdir(directory, {recursive: true, mode: 0o700}); await chmod(directory, 0o700);
  for (const folder of ['source', 'receipts', 'applied']) await mkdir(join(directory, folder), {recursive: true, mode: 0o700});
  if (operation === 'plan') {
    if ((await readdir(join(directory, 'source'))).length) throw Error('Plan requires a fresh operation directory');
    const backupDirectory = flags.find(flag => flag.startsWith('--backup-directory='))?.slice('--backup-directory='.length);
    if (!backupDirectory) throw Error('Plan requires --backup-directory with a full restore-verified backup');
    const backup = await verifyBackup(resolve(backupDirectory), db.databaseName);
    const rows: ScopeRow[] = [];
    const add = async (collection: ScopeRow['collection'], document: Record<string, unknown>, receiptFilter?: Record<string, unknown>, receiptCollection?: 'test_assets' | 'report_assets') => {
      const bson = mongoose.mongo.BSON.serialize(document), row: ScopeRow = {collection, id: String(document._id),
        bsonSha256: digestBson(document), bsonBytes: bson.length};
      await writeFile(backupPath(row), bson, {mode: 0o600});
      if (receiptCollection && receiptFilter) {
        const receipts = await db.collection(receiptCollection).find(receiptFilter).sort({_id: 1}).toArray();
        const bytes = Buffer.concat(receipts.map(receipt => mongoose.mongo.BSON.serialize(receipt)));
        await writeFile(join(directory, 'source', `${collection}-${row.id}-${receiptCollection}.bson`), bytes, {mode: 0o600});
        row.receiptRows = {collection: receiptCollection, ids: receipts.map(receipt => String(receipt._id)), count: receipts.length,
          bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
      }
      rows.push(row);
    };
    for await (const row of db.collection('test_runs').find({'payload.schemaVersion': 1, uploadsComplete: true}, {batchSize: 10}))
      await add('test_runs', row, {runId: row.runId}, 'test_assets');
    for await (const row of db.collection('routine_definitions').find({definition: {$exists: true}}, {batchSize: 50})) await add('routine_definitions', row);
    for await (const row of db.collection('routine_collections').find({detail: {$exists: false}}, {batchSize: 10})) await add('routine_collections', row);
    const reports = await db.collection('report_assets').distinct('reportId', {sourceTestRunId: {$exists: true}});
    for await (const row of db.collection('reports').find({reportId: {$in: reports}, nativeDiagnostics: {$exists: false}}, {batchSize: 10}))
      await add('reports', row, {reportId: row.reportId, sourceTestRunId: {$exists: true}}, 'report_assets');
    rows.sort((a, b) => a.collection.localeCompare(b.collection) || a.id.localeCompare(b.id));
    const scope: Scope = {version: 1, database: db.databaseName, environment: process.env.CLOUD_CORE_ENVIRONMENT ?? 'local', capturedAt: new Date().toISOString(), rows, backup};
    await write(join(directory, 'scope.private.json'), scope);
    console.log(JSON.stringify({operation, records: rows.length, scopeSha256: requestInputDigest(scope),
      bytes: rows.reduce((sum, row) => sum + row.bsonBytes + (row.receiptRows?.bytes ?? 0), 0)}));
  } else {
    const scope: Scope = JSON.parse(await readFile(join(directory, 'scope.private.json'), 'utf8'));
    if (scope.database !== db.databaseName || scope.environment !== (process.env.CLOUD_CORE_ENVIRONMENT ?? 'local')) throw Error('Scope database or storage environment differs');
    const scopeSha256 = requestInputDigest(scope);
    if (requestInputDigest(await verifyBackup(scope.backup.directory, db.databaseName)) !== requestInputDigest(scope.backup))
      throw Error('Full restore verification changed since scope preparation');
    const parseReceipts = async (row: ScopeRow) => {
      if (!row.receiptRows) return [];
      const bytes = await readFile(join(directory, 'source', `${row.collection}-${row.id}-${row.receiptRows.collection}.bson`));
      if (createHash('sha256').update(bytes).digest('hex') !== row.receiptRows.sha256) throw Error('Receipt backup digest differs');
      const out: Record<string, any>[] = [];
      for (let offset = 0; offset < bytes.length;) {const length = bytes.readInt32LE(offset);
        if (length < 5 || offset + length > bytes.length) throw Error('Receipt BSON boundary invalid');
        out.push(value(mongoose.mongo.BSON.deserialize(bytes.subarray(offset, offset + length)))); offset += length;}
      if (out.length !== row.receiptRows.count) throw Error('Receipt backup cardinality differs');
      return out;
    };
    const definitionRows = new Map<string, ScopeRow>();
    const runRows = new Map<string, ScopeRow>();
    for (const row of scope.rows) if (row.collection === 'routine_definitions' || row.collection === 'test_runs') {
      const doc: any = value(await readBson(row));
      if (row.collection === 'routine_definitions') definitionRows.set(`${doc.definitionRevision}:${doc.routineId}:${doc.platform}`, row);
      else runRows.set(doc.runId, row);
    }
    const originalRun = async (runId: string) => {
      const row = runRows.get(runId);
      if (!row) {
        const accepted: any = value(await db.collection('test_runs').findOne({runId, resultSchemaVersion: 1, uploadsComplete: true}));
        if (!accepted) throw Error('Report accepted result authority is unavailable');
        return readStoredRun(accepted, details);
      }
      const doc: any = value(await readBson(row)), assets = await parseReceipts(row);
      return verifyRunEnvelope({version: 1, payload: doc.payload, payloadSha256: doc.payloadSha256,
        acceptedAssets: assets.map(asset => ({runId: asset.runId, assetId: asset.assetId, storageKey: asset.storageKey,
          sizeBytes: asset.sizeBytes, sha256: asset.sha256}))}, true);
    };
    if (operation === 'export') {
      const exportRow = async (row: ScopeRow) => {
      const original = await readBson(row); if (digestBson(original) !== row.bsonSha256) throw Error('Source backup differs');
      const doc: any = value(original); let update: Record<string, unknown>, removed: string[];
      if (row.collection === 'test_runs') {
        const payload = recordedFrameworkRunSchema.parse(doc.payload), accepted = (await parseReceipts(row)).map(asset => ({runId: asset.runId,
          assetId: asset.assetId, storageKey: asset.storageKey, sizeBytes: asset.sizeBytes, sha256: asset.sha256}));
        verifyRunEnvelope({version: 1, payload, payloadSha256: doc.payloadSha256, acceptedAssets: accepted}, true);
        const detail = await writeRunEnvelope(payload, doc.payloadSha256, accepted, true, details);
        update = {resultSchemaVersion: 1, build: payload.build, detail, summaryProjection: createRecordedFrameworkRunSummaryProjection(payload, doc.payloadSha256),
          recordedPassingExample: frameworkRunOutcome(payload) === 'pass' && frameworkEvidenceComplete(payload) && !!payload.recordingAssetId,
          ...(payload.recordingAssetId ? {recordingAssetId: payload.recordingAssetId} : {})}; removed = ['payload'];
      } else if (row.collection === 'routine_definitions') {
        const input = recordedRoutineEnrollmentSchema.parse({routineId: doc.routineId, platform: doc.platform, definitionRevision: doc.definitionRevision,
          definitionSha256: doc.definitionSha256, ...(doc.routineSource ? {routineSource: doc.routineSource} : {}), definition: doc.definition});
        const {detail, card} = await writeRecordedRoutineDefinition(input, details); update = {detail, card}; removed = ['definition'];
      } else if (row.collection === 'routine_collections') {
        const definitions = [], references = [];
        for (const member of doc.members) {
          const source = definitionRows.get(`${doc.commit}:${member.routineId}:${member.platform}`);
          const definition: any = source ? value(await readBson(source)) : value(await db.collection('routine_definitions').findOne({definitionRevision: doc.commit, routineId: member.routineId, platform: member.platform}));
          if (!definition) throw Error('Collection exact member is unavailable');
          if (!source) {
            const found = await readRoutineDefinition(definition, details);
            if (found.definitionSha256 !== member.definitionSha256) throw Error('Collection exact member digest differs');
            definitions.push(found);
            references.push({routineId: found.routineId, platform: found.platform, definitionRevision: found.definitionRevision,
              definitionSha256: found.definitionSha256, ...(found.routineSource ? {routineSource: found.routineSource} : {}), detail: definition.detail});
            continue;
          }
          const found = recordedRoutineEnrollmentSchema.parse({routineId: definition.routineId, platform: definition.platform,
            definitionRevision: definition.definitionRevision, definitionSha256: definition.definitionSha256,
            definition: definition.definition, ...(definition.routineSource ? {routineSource: definition.routineSource} : {})});
          if (found.definitionSha256 !== member.definitionSha256) throw Error('Collection exact member digest differs');
          definitions.push(found);
          const exported = JSON.parse(await readFile(receiptPath(source), 'utf8'));
          if (exported.scopeSha256 !== scopeSha256 || exported.sourceSha256 !== source.bsonSha256) throw Error('Collection definition receipt differs');
          references.push({routineId: found.routineId, platform: found.platform, definitionRevision: found.definitionRevision,
            definitionSha256: found.definitionSha256, ...(found.routineSource ? {routineSource: found.routineSource} : {}), detail: exported.update.detail});
        }
        const collection = routineCollectionDetailSchema.parse({commit: doc.commit, version: doc.version, definitions});
        if (requestInputDigest(collection) !== doc.manifestSha256) throw Error('Collection original manifest differs');
        update = {detail: await details.write('collection', doc.commit, routineCollectionManifestSchema.parse({commit: doc.commit, version: doc.version, definitions: references}))}; removed = [];
      } else {
        const assets = await parseReceipts(row), runIds = [...new Set(assets.map(asset => asset.sourceTestRunId))];
        if (runIds.length !== 1) throw Error('Native report references more than one result');
        if (assets.some(asset => asset.reportId !== doc.reportId || asset.mentraUserId !== doc.mentraUserId))
          throw Error('Native report receipt ownership differs');
        const sourceRun = await originalRun(runIds[0]);
        const byId = new Map(assets.map(asset => [asset.artifactId, asset]));
        const nativeArtifacts = doc.artifacts.filter((artifact: any) => byId.has(artifact.artifactId));
        if (nativeArtifacts.length !== assets.length) throw Error('Report original source inventory differs');
        const snapshot = reportNativeSnapshotSchema.parse({version: 1, reportId: doc.reportId, mentraUserId: doc.mentraUserId,
          runId: runIds[0], payloadSha256: sourceRun.payloadSha256, artifacts: nativeArtifacts.map((artifact: any) => ({
            artifactId: artifact.artifactId, assetId: byId.get(artifact.artifactId)!.sourceTestAssetId,
            createdAt: new Date(artifact.createdAt).toISOString(), type: artifact.type, source: artifact.source}))});
        const expanded = expandNativeReportSnapshot(snapshot, sourceRun);
        for (const asset of expanded.assets) {
          const original = byId.get(asset.artifactId)!;
          if (asset.storageKey !== original.storageKey || asset.sizeBytes !== original.sizeBytes || asset.sha256 !== original.sha256 ||
            asset.contentType !== original.contentType || asset.fileName !== original.fileName)
            throw Error('Report attachment bytes or type differ from the accepted run authority');
        }
        const detail = await details.write('report-native', doc.reportId, snapshot);
        update = {nativeDiagnostics: {runId: snapshot.runId, payloadSha256: snapshot.payloadSha256, count: snapshot.artifacts.length, detail},
          artifacts: doc.artifacts.filter((artifact: any) => !byId.has(artifact.artifactId))}; removed = [];
      }
      await write(receiptPath(row), {version: 1, scopeSha256, sourceSha256: row.bsonSha256, update, removed, verifiedAt: new Date().toISOString()});
      };
      // Definition receipts precede collection references; within each phase bounded independent exports run together.
      for (const collection of ['test_runs', 'routine_definitions', 'routine_collections', 'reports']) {
        const rows = scope.rows.filter(row => row.collection === collection);
        for (let offset = 0; offset < rows.length; offset += 8) {
          await Promise.all(rows.slice(offset, offset + 8).map(exportRow));
          console.log(JSON.stringify({operation, collection, verified: Math.min(offset + 8, rows.length), total: rows.length}));
        }
      }
    }
    else if (operation === 'verify') {
      const verifyRow = async (row: ScopeRow) => {
        const receipt = JSON.parse(await readFile(receiptPath(row), 'utf8'));
        if (receipt.scopeSha256 !== scopeSha256 || receipt.sourceSha256 !== row.bsonSha256) throw Error('Export receipt differs');
        const doc: any = value(await readBson(row));
        if (row.collection === 'test_runs') await readStoredRun({...doc, ...receipt.update}, details);
        else if (row.collection === 'routine_definitions') await readRoutineDefinition({...doc, ...receipt.update}, details);
        else if (row.collection === 'routine_collections') {
          const body = await readRoutineCollection(receipt.update.detail, details);
          if (requestInputDigest(body) !== doc.manifestSha256) throw Error('Collection digest differs');
        } else {
          const snapshot = await details.read(receipt.update.nativeDiagnostics.detail, reportNativeSnapshotSchema);
          if (snapshot.reportId !== doc.reportId || snapshot.mentraUserId !== doc.mentraUserId) throw Error('Report association differs');
          expandNativeReportSnapshot(snapshot, await originalRun(snapshot.runId));
        }
      };
      for (let offset = 0; offset < scope.rows.length; offset += 8) {
        await Promise.all(scope.rows.slice(offset, offset + 8).map(verifyRow));
        console.log(JSON.stringify({operation, verified: Math.min(offset + 8, scope.rows.length), total: scope.rows.length}));
      }
      await write(join(directory, 'verified.json'), {scopeSha256, records: scope.rows.length, verifiedAt: new Date().toISOString()});
    } else if (operation === 'apply') {
      if (!flags.includes('--frozen') || !flags.includes(`--approved-scope-sha256=${scopeSha256}`)) throw Error('Apply requires exact approved scope and confirmed write freeze');
      const verification = JSON.parse(await readFile(join(directory, 'verified.json'), 'utf8'));
      if (verification.scopeSha256 !== scopeSha256) throw Error('Scope has not been fully verified');
      // Coverage is checked before any mutation; late completions/definitions/incidents require a new approved delta.
      const ids = (collection: string) => scope.rows.filter(row => row.collection === collection).map(row => new mongoose.mongo.ObjectId(row.id));
      const incomplete = await db.collection('test_runs').countDocuments({'payload.schemaVersion': 1, uploadsComplete: {$ne: true}});
      if (incomplete) throw Error('Accepted result publication must drain before cutover');
      for (const [collection, filter] of [
        ['test_runs', {'payload.schemaVersion': 1}], ['routine_definitions', {definition: {$exists: true}}],
        ['routine_collections', {detail: {$exists: false}}], ['reports', {reportId: {$in: await db.collection('report_assets').distinct('reportId', {sourceTestRunId: {$exists: true}})}, nativeDiagnostics: {$exists: false}}],
      ] as const) if (await db.collection(collection).countDocuments({...filter, _id: {$nin: ids(collection)}})) throw Error('Post-drain coverage delta requires verified export and approval');
      for (const row of scope.rows) {
        const doc = await db.collection(row.collection).findOne({_id: new mongoose.mongo.ObjectId(row.id)});
        const receipt = JSON.parse(await readFile(receiptPath(row), 'utf8'));
        if (!doc || receipt.scopeSha256 !== scopeSha256 || receipt.sourceSha256 !== row.bsonSha256)
          throw Error('Approved record or export receipt is unavailable');
        const expected: any = await readBson(row);
        for (const [key, setting] of Object.entries(receipt.update)) expected[key] = setting;
        for (const key of receipt.removed) delete expected[key];
        const committed = digestJsonBson(value(doc)) === digestJsonBson(value(expected));
        if (!committed && digestBson(doc) !== row.bsonSha256)
          throw Error('Approved original record changed; re-export and approval required');
        if (row.receiptRows) {
          const approved = await parseReceipts(row), hashes = new Map(approved.map(doc => [String(doc._id), digestJsonBson(doc)]));
          const current = await db.collection(row.receiptRows.collection).find({_id: {$in: row.receiptRows.ids.map(id => new mongoose.mongo.ObjectId(id))}}).toArray();
          if ((!committed && current.length !== approved.length) || current.some(doc => hashes.get(String(doc._id)) !== digestJsonBson(value(doc))))
            throw Error('Approved receipt rows changed before cutover');
        }
      }
      for (const row of [...scope.rows].sort((a,b) => ['test_runs', 'routine_definitions', 'routine_collections', 'reports'].indexOf(a.collection) - ['test_runs', 'routine_definitions', 'routine_collections', 'reports'].indexOf(b.collection))) {
        const doc = await db.collection(row.collection).findOne({_id: new mongoose.mongo.ObjectId(row.id)});
        if (!doc) throw Error('Approved original record is missing');
        const receipt = JSON.parse(await readFile(receiptPath(row), 'utf8'));
        if (receipt.scopeSha256 !== scopeSha256 || receipt.sourceSha256 !== row.bsonSha256) throw Error('Export receipt differs');
        const expected: any = await readBson(row);
        for (const [key, setting] of Object.entries(receipt.update)) expected[key] = setting;
        for (const key of receipt.removed) delete expected[key];
        // Reconcile the exact projection even when its local acknowledgement already exists.
        const committed = digestJsonBson(value(doc)) === digestJsonBson(value(expected));
        if (!committed && digestBson(doc) !== row.bsonSha256)
          throw Error('Approved original record changed; re-export and approval required');
        if (!committed) await db.collection(row.collection).updateOne({_id: doc._id}, {$set: receipt.update,
          ...(receipt.removed.length ? {$unset: Object.fromEntries(receipt.removed.map((field: string) => [field, '']))} : {})});
        await write(appliedPath(row), {scopeSha256, at: new Date().toISOString()});
      }
      // Readers must see accepted pointers before redundant source receipt rows are removed.
      for (const row of scope.rows.filter(row => row.receiptRows)) {
        const receipts = row.receiptRows!;
        if (row.collection === 'test_runs') {
          const doc: any = await db.collection('test_runs').findOne({_id: new mongoose.mongo.ObjectId(row.id)});
          await readStoredRun(value(doc), details);
        } else {
          const doc: any = await db.collection('reports').findOne({_id: new mongoose.mongo.ObjectId(row.id)});
          // Runtime authorization/read parity is verified separately using the activated typed models.
          await details.read(value(doc.nativeDiagnostics.detail), reportNativeSnapshotSchema);
        }
        const current = await db.collection(receipts.collection).find({_id: {$in: receipts.ids.map(id => new mongoose.mongo.ObjectId(id))}}).sort({_id: 1}).toArray();
        if (current.length) {
          const approved = await parseReceipts(row), hashes = new Map(approved.map(doc => [String(doc._id), digestBson(doc)]));
          if (current.some(doc => hashes.get(String(doc._id)) !== digestBson(value(doc)))) throw Error('Approved receipt rows changed');
          // A delete interrupted after some rows committed may safely resume with only the exact approved remainder.
          await db.collection(receipts.collection).deleteMany({_id: {$in: current.map(doc => doc._id)}});
        }
      }
    } else {
      if (await db.collection('test_runs').countDocuments({'payload.schemaVersion': 1}) || await db.collection('routine_definitions').countDocuments({definition: {$exists: true}}))
        throw Error('Old completed detail remains; admission must stay closed');
      for (const row of scope.rows) {
        const doc: any = value(await db.collection(row.collection).findOne({_id: new mongoose.mongo.ObjectId(row.id)}));
        if (!doc) throw Error('Converted record is missing');
        if (row.collection === 'test_runs') await readStoredRun(doc, details);
        else if (row.collection === 'routine_definitions') await readRoutineDefinition(doc, details);
        else if (row.collection === 'routine_collections') await readRoutineCollection(doc.detail, details);
        else await details.read(value(doc.nativeDiagnostics.detail), reportNativeSnapshotSchema);
        if (row.receiptRows && await db.collection(row.receiptRows.collection).countDocuments({_id: {$in: row.receiptRows.ids.map(id => new mongoose.mongo.ObjectId(id))}}))
          throw Error('Approved redundant receipt rows remain');
      }
    }
    console.log(JSON.stringify({operation, scopeSha256, records: scope.rows.length, complete: true}));
  }
} finally {await client.close();}
