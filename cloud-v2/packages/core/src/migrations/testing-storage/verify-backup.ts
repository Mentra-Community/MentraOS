import mongoose from 'mongoose';
import {createHash} from 'node:crypto';
import {readFile, writeFile, chmod} from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {join, resolve} from 'node:path';
import {requestInputDigest} from '../../services/test-request.service';

const directory = resolve(process.argv[2] ?? '');
if (!directory || !process.argv[2]) throw Error('Pass the protected full backup directory');
const manifest = JSON.parse(await readFile(join(directory, 'full-backup-manifest.private.json'), 'utf8'));
const client = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:27183/mentra-cloud-v2-dev-aws', {promoteValues: false});
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const indexIdentity = (index: Record<string, unknown>) => {
  const {ns: _ns, ...identity} = index;
  return requestInputDigest(mongoose.mongo.BSON.EJSON.serialize(identity, {relaxed: false}));
};
try {
  await client.connect(); const db = client.db();
  const collections = [];
  for (const file of manifest.files.filter((file: any) => file.path.endsWith('.bson.gz'))) {
    const compressed = await readFile(join(directory, 'baseline-full-db', file.path));
    if (hash(compressed) !== file.sha256 || compressed.length !== file.bytes) throw Error('Backup archive byte digest differs');
    const data = gunzipSync(compressed), recordHashes: string[] = [];
    for (let offset = 0; offset < data.length;) {
      const length = data.readInt32LE(offset); if (length < 5 || offset + length > data.length) throw Error('Backup BSON boundary differs');
      recordHashes.push(hash(data.subarray(offset, offset + length))); offset += length;
    }
    const name = file.path.split('/').at(-1).slice(0, -8);
    const restoredHashes: string[] = [];
    for await (const doc of db.collection(name).find({}).batchSize(1000)) restoredHashes.push(hash(mongoose.mongo.BSON.serialize(doc)));
    if (recordHashes.length !== restoredHashes.length || hash(Buffer.from(recordHashes.sort().join('\n'))) !== hash(Buffer.from(restoredHashes.sort().join('\n'))))
      throw Error(`Recovered records differ in ${name}`);
    const metaPath = file.path.replace(/\.bson\.gz$/, '.metadata.json.gz');
    const metadataBytes = await readFile(join(directory, 'baseline-full-db', metaPath));
    const metadataManifest = manifest.files.find((candidate: any) => candidate.path === metaPath);
    if (hash(metadataBytes) !== metadataManifest.sha256) throw Error('Index metadata archive digest differs');
    const metadata = JSON.parse(gunzipSync(metadataBytes).toString());
    const indexes = await db.collection(name).listIndexes().toArray();
    if (requestInputDigest(metadata.indexes.map(indexIdentity).sort()) !== requestInputDigest(indexes.map(indexIdentity).sort()))
      throw Error(`Recovered indexes differ in ${name}`);
    collections.push({name, records: recordHashes.length, indexes: indexes.length, recordDigest: hash(Buffer.from(recordHashes.join('\n')))});
  }
  const actual = await db.listCollections().toArray();
  if (actual.length !== collections.length) throw Error('Recovered collection count differs');
  const receipt = {database: db.databaseName, loopback: '127.0.0.1:27183', originalManifestSha256: manifest.manifestSha256,
    verifiedAt: new Date().toISOString(), collections, records: collections.reduce((sum, row) => sum + row.records, 0),
    indexes: collections.reduce((sum, row) => sum + row.indexes, 0), verified: true};
  const path = join(directory, 'full-restore-verification.private.json'); await writeFile(path, JSON.stringify(receipt, null, 2), {mode: 0o600}); await chmod(path, 0o600);
  console.log(JSON.stringify({verified: true, collections: collections.length, records: receipt.records, indexes: receipt.indexes}));
} finally {await client.close();}
