import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unpackDiagnosticBundle, verifyEvidenceBytes} from './unpack-diagnostic-bundle.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const raw = Buffer.from(' {"original": "raw UTF-8 é"} \n');
const entry = {id: 'opaque:original', path: 'setup-evidence/firmware-command-result-123.json',
  size: raw.length, sha256: hash(raw), bytesBase64: raw.toString('base64')};
const archive = files => Buffer.from(JSON.stringify({schemaVersion: 1, kind: 'setup-diagnostic-bundle', encoding: 'base64', files}));
const temp = async () => realpath(await mkdtemp(join(tmpdir(), 'diagnostic-unpack-')));

test('extracts exact member bytes and identities, retaining the verified archive and immutable repeat result', async () => {
  const out = await temp(), bytes = archive([entry]);
  try {
    verifyEvidenceBytes(bytes, {size: bytes.length, sha256: hash(bytes)});
    const receipt = await unpackDiagnosticBundle(bytes, out);
    assert.equal(receipt.bundleSha256, hash(bytes));
    assert.deepEqual(receipt.files[0], {id: entry.id, path: entry.path, size: raw.length,
      sha256: hash(raw), filename: `001-${hash(raw)}.json`});
    assert.deepEqual(await readFile(join(receipt.directory, receipt.files[0].filename)), raw);
    assert.deepEqual(JSON.parse(await readFile(join(receipt.directory, 'manifest.json'))).files, receipt.files);
    assert.deepEqual(await unpackDiagnosticBundle(bytes, out), receipt);
    await writeFile(join(receipt.directory, receipt.files[0].filename), 'changed');
    await assert.rejects(unpackDiagnosticBundle(bytes, out), /ownership or bytes/);
  } finally {await rm(out, {recursive: true, force: true});}
});

test('validates all members before writing files, rejects traversal, duplicate identities and corruption', async () => {
  const invalid = [{...entry, path: 'setup-evidence/../escape.json'}, {...entry, path: 'setup-evidence/a\\b.json'},
    {...entry, sha256: '0'.repeat(64)}, {...entry, size: raw.length + 1}, {...entry, bytesBase64: entry.bytesBase64 + '\n'}];
  for (const member of invalid) {
    const out = await temp();
    try {
      await assert.rejects(unpackDiagnosticBundle(archive([entry, {...member, id: 'other'}]), out), /member/);
      assert.deepEqual(await readdir(out), []);
    } finally {await rm(out, {recursive: true, force: true});}
  }
  const out = await temp();
  try {
    await assert.rejects(unpackDiagnosticBundle(archive([entry, {...entry, path: 'setup-evidence/other.json'}]), out), /identity/);
    await assert.rejects(unpackDiagnosticBundle(archive(Array.from({length: 257}, (_, i) => ({...entry, id: `${i}`, path: `setup-evidence/${i}.json`}))), out), /oversized/);
    assert.deepEqual(await readdir(out), []);
  } finally {await rm(out, {recursive: true, force: true});}
});

test('ordinary JSON is untouched; a foreign extraction symlink and a mismatched outer receipt are rejected', async () => {
  const out = await temp(), foreign = await temp(), bytes = archive([entry]);
  try {
    assert.equal(await unpackDiagnosticBundle(Buffer.from('{"entries":[]}'), out), undefined);
    assert.equal(await unpackDiagnosticBundle(Buffer.from('not JSON'), out), undefined);
    assert.deepEqual(await readdir(out), []);
    assert.throws(() => verifyEvidenceBytes(bytes, {size: bytes.length, sha256: '0'.repeat(64)}), /digest/);
    await symlink(foreign, join(out, `diagnostic-bundle-${hash(bytes)}`));
    await assert.rejects(unpackDiagnosticBundle(bytes, out), /symlink/);
    assert.deepEqual(await readdir(foreign), []);
  } finally {await rm(out, {recursive: true, force: true}); await rm(foreign, {recursive: true, force: true});}
});

test('partial member or manifest writes do not poison a retry, and concurrent extraction sees only complete directories', async () => {
  const out = await temp(), probe = await open(join(out, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe), original = prototype.writeFile;
  await probe.close(); await rm(join(out, 'probe'));
  try {
    for (const failManifest of [false, true]) {
      let injected = false;
      prototype.writeFile = async function (data, ...args) {
        if (!injected && data.toString().includes('bundleSha256') === failManifest) {
          injected = true; await original.call(this, data.subarray(0, 5), ...args);
          throw Error('Injected partial extraction');
        }
        return original.call(this, data, ...args);
      };
      const bytes = archive([{...entry, id: `fault-${failManifest}`}]);
      await assert.rejects(unpackDiagnosticBundle(bytes, out), /partial extraction/);
      prototype.writeFile = original;
      assert.equal((await readdir(out)).some(name => name.endsWith('.tmp')), false);
      const [first, second] = await Promise.all([unpackDiagnosticBundle(bytes, out), unpackDiagnosticBundle(bytes, out)]);
      assert.deepEqual(first, second);
      assert.deepEqual(await readFile(join(first.directory, first.files[0].filename)), raw);
      assert.deepEqual(JSON.parse(await readFile(join(first.directory, 'manifest.json'))).files, first.files);
    }
  } finally {prototype.writeFile = original; await rm(out, {recursive: true, force: true});}
});
