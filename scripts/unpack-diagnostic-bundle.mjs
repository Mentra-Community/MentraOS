#!/usr/bin/env node
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, mkdir, open, readFile, realpath, rename, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const maxBytes = 8 * 1024 * 1024;

export function verifyEvidenceBytes(bytes, {size, sha256}) {
  if (!Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{64}$/.test(sha256 ?? '') ||
    bytes.length !== size || hash(bytes) !== sha256) throw Error('Evidence size/digest differs from its declared manifest.');
}

/** Verify every member before extracting; ordinary JSON is not a diagnostic archive. */
export async function unpackDiagnosticBundle(bytes, out) {
  let bundle;
  try {bundle = JSON.parse(bytes.toString('utf8'));} catch {return;}
  if (bundle?.kind !== 'setup-diagnostic-bundle') return;
  if (bytes.length > maxBytes || bundle.schemaVersion !== 1 || bundle.encoding !== 'base64' ||
    !Array.isArray(bundle.files) || !bundle.files.length || bundle.files.length > 256)
    throw Error('Invalid or oversized diagnostic bundle.');
  const ids = new Set(), paths = new Set();
  const members = bundle.files.map((entry, index) => {
    if (typeof entry?.id !== 'string' || !entry.id || ids.has(entry.id) ||
      typeof entry.path !== 'string' || !entry.path.startsWith('setup-evidence/') || !entry.path.endsWith('.json') ||
      /[\\\0]/.test(entry.path) || entry.path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(entry.path) ||
      !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > maxBytes ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '') || typeof entry.bytesBase64 !== 'string')
      throw Error('Invalid diagnostic bundle member identity.');
    const data = Buffer.from(entry.bytesBase64, 'base64');
    if (data.toString('base64') !== entry.bytesBase64 || data.length !== entry.size || hash(data) !== entry.sha256)
      throw Error('Diagnostic bundle member size or digest differs.');
    ids.add(entry.id); paths.add(entry.path);
    return {data, receipt: {id: entry.id, path: entry.path, size: entry.size, sha256: entry.sha256,
      filename: `${String(index + 1).padStart(3, '0')}-${entry.sha256}.json`}};
  });
  await mkdir(resolve(out), {recursive: true, mode: 0o700});
  const root = await realpath(resolve(out));
  const directory = join(root, `diagnostic-bundle-${hash(bytes)}`);
  const receipt = {schemaVersion: 1, bundleSha256: hash(bytes), files: members.map(member => member.receipt)};
  const files = [...members.map(member => ({filename: member.receipt.filename, data: member.data})),
    {filename: 'manifest.json', data: Buffer.from(JSON.stringify(receipt, null, 2) + '\n')}];
  const verifyExisting = async () => {
    let stat;
    try {stat = await lstat(directory);} catch (error) {if (error.code === 'ENOENT') return false; throw error;}
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || await realpath(directory) !== directory)
      throw Error('Diagnostic extraction directory must be owned and not a symlink.');
    for (const {filename, data} of files) {
      const file = await open(join(directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size !== data.length ||
          !(await file.readFile()).equals(data)) throw Error('Extracted diagnostic has different ownership or bytes.');
      } finally {await file.close();}
    }
    return true;
  };
  const syncDirectory = async path => {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {await file.sync();} finally {await file.close();}
  };
  if (!await verifyExisting()) {
    // Publish the complete directory once. Interrupted writes cannot poison the immutable final path.
    const staging = `${directory}-${randomUUID()}.tmp`;
    await mkdir(staging, {mode: 0o700});
    try {
      for (const {filename, data} of files) {
        const file = await open(join(staging, filename), 'wx', 0o600);
        try {await file.writeFile(data); await file.sync();} finally {await file.close();}
      }
      await syncDirectory(staging);
      try {await rename(staging, directory);} catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !await verifyExisting()) throw error;
      }
      await syncDirectory(root);
    } finally {await rm(staging, {recursive: true, force: true});}
    await verifyExisting();
  } else await syncDirectory(root);
  return {...receipt, directory};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, out, size, sha256, extra] = process.argv.slice(2);
  if (!input || !out || extra) {console.error('Usage: node scripts/unpack-diagnostic-bundle.mjs FILE OUTPUT_DIRECTORY [SIZE SHA256]'); process.exitCode = 1;}
  else Promise.resolve().then(async () => {
    const bytes = await readFile(input);
    if (size !== undefined || sha256 !== undefined) verifyEvidenceBytes(bytes, {size: Number(size), sha256});
    return unpackDiagnosticBundle(bytes, out);
  }).then(receipt => {
    if (receipt) console.error(`Verified ${receipt.files.length} diagnostics in ${receipt.directory}`);
  }).catch(error => {console.error(error.message); process.exitCode = 1;});
}
