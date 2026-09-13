import crypto from 'node:crypto';
import JSZip from 'jszip';

import {
  publisherKeyFingerprint,
  type Ed25519PublicJwk,
  type PackageSigningKey,
  validatePackageSigningKey,
} from './package-signing-key.js';

export const MENTRA_BUNDLE_SIGNATURE_PATH = 'META-INF/MENTRA.SIG';

export interface MentraBundleSignatureV1 {
  schemaVersion: 1;
  algorithm: 'Ed25519';
  publicKeyJwk: Ed25519PublicJwk;
  publisherKeyFingerprint: string;
  payload: {
    packageName: string;
    version: string;
    manifestSha256: string;
    contentSha256: string;
  };
  signature: string;
}

export interface VerifiedSignedBundle {
  packageName: string;
  version: string;
  manifest: Record<string, unknown>;
  manifestSha256: string;
  contentSha256: string;
  publisherKeyFingerprint: string;
  publicKeyJwk: Ed25519PublicJwk;
}

export async function signBundleArchive(unsignedArchive: Uint8Array, key: PackageSigningKey): Promise<Uint8Array> {
  validatePackageSigningKey(key);
  inspectRawZipNames(unsignedArchive);
  const zip = await loadZip(unsignedArchive);
  if (zip.file(MENTRA_BUNDLE_SIGNATURE_PATH)) {
    throw new Error(`Bundle already contains reserved entry ${MENTRA_BUNDLE_SIGNATURE_PATH}`);
  }
  const statement = await bundleStatement(zip);
  if (statement.packageName !== key.packageName) {
    throw new Error(`Publisher signing key belongs to ${key.packageName}, not ${statement.packageName}`);
  }
  const payload = {
    packageName: statement.packageName,
    version: statement.version,
    manifestSha256: statement.manifestSha256,
    contentSha256: statement.contentSha256,
  };
  const privateKey = crypto.createPrivateKey({
    key: key.privateKeyJwk,
    format: 'jwk',
  } as unknown as crypto.PrivateKeyInput);
  const envelope: MentraBundleSignatureV1 = {
    schemaVersion: 1,
    algorithm: 'Ed25519',
    publicKeyJwk: key.publicKeyJwk,
    publisherKeyFingerprint: publisherKeyFingerprint(key.publicKeyJwk),
    payload,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString('base64url'),
  };
  zip.file(MENTRA_BUNDLE_SIGNATURE_PATH, canonicalJson(envelope), {
    binary: false,
    createFolders: true,
    date: new Date(0),
  });
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
}

export async function verifySignedBundleArchive(archive: Uint8Array): Promise<VerifiedSignedBundle> {
  inspectRawZipNames(archive);
  const zip = await loadZip(archive);
  const signatureEntries = Object.values(zip.files).filter(
    entry => !entry.dir && entry.name.toLowerCase() === MENTRA_BUNDLE_SIGNATURE_PATH.toLowerCase(),
  );
  if (signatureEntries.length !== 1 || signatureEntries[0]?.name !== MENTRA_BUNDLE_SIGNATURE_PATH) {
    throw new Error(`Bundle must contain exactly one ${MENTRA_BUNDLE_SIGNATURE_PATH}`);
  }
  const signatureBytes = await signatureEntries[0].async('uint8array');
  let envelope: MentraBundleSignatureV1;
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(signatureBytes)) as unknown;
    envelope = validateEnvelope(parsed);
  } catch (error) {
    throw new Error(`Bundle signature entry is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const statement = await bundleStatement(zip);
  if (
    canonicalJson(envelope.payload) !==
    canonicalJson({
      packageName: statement.packageName,
      version: statement.version,
      manifestSha256: statement.manifestSha256,
      contentSha256: statement.contentSha256,
    })
  ) {
    throw new Error('Bundle signature payload does not match the archive contents');
  }
  const fingerprint = publisherKeyFingerprint(envelope.publicKeyJwk);
  if (envelope.publisherKeyFingerprint !== fingerprint) {
    throw new Error('Bundle publisher key fingerprint does not match its public key');
  }
  const publicKey = crypto.createPublicKey({
    key: envelope.publicKeyJwk,
    format: 'jwk',
  } as unknown as crypto.PublicKeyInput);
  const valid = crypto.verify(
    null,
    Buffer.from(canonicalJson(envelope.payload)),
    publicKey,
    decodeSignature(envelope.signature),
  );
  if (!valid) throw new Error('Bundle publisher signature is invalid');
  return { ...statement, publisherKeyFingerprint: fingerprint, publicKeyJwk: envelope.publicKeyJwk };
}

function decodeSignature(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Bundle publisher signature encoding is invalid');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== 64 || decoded.toString('base64url') !== value) {
    throw new Error('Bundle publisher signature encoding is invalid');
  }
  return decoded;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

async function bundleStatement(zip: JSZip): Promise<{
  packageName: string;
  version: string;
  manifest: Record<string, unknown>;
  manifestSha256: string;
  contentSha256: string;
}> {
  const entries = Object.values(zip.files);
  const seen = new Set<string>();
  const seenFolded = new Set<string>();
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  let manifest: Record<string, unknown> | undefined;
  for (const entry of entries) {
    const unsafeName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (!safePath(unsafeName) || !safePath(entry.name))
      throw new Error(`Bundle contains an unsafe path: ${unsafeName}`);
    if (isSymlink(entry)) throw new Error(`Bundle contains a symbolic link: ${entry.name}`);
    if (seen.has(entry.name)) throw new Error(`Bundle contains a duplicate path: ${entry.name}`);
    const folded = entry.name.toLowerCase();
    if (seenFolded.has(folded)) throw new Error(`Bundle contains a case-colliding path: ${entry.name}`);
    seen.add(entry.name);
    seenFolded.add(folded);
    if (entry.dir || entry.name === MENTRA_BUNDLE_SIGNATURE_PATH) continue;
    const bytes = await entry.async('uint8array');
    files.push({ path: entry.name, size: bytes.byteLength, sha256: sha256Hex(bytes) });
    if (entry.name === 'miniapp.json') {
      const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('miniapp.json must be an object');
      manifest = parsed as Record<string, unknown>;
    }
  }
  const manifestEntries = files.filter(file => file.path.toLowerCase().endsWith('miniapp.json'));
  if (manifestEntries.length !== 1 || manifestEntries[0]?.path !== 'miniapp.json' || !manifest) {
    throw new Error('Bundle must contain exactly one root miniapp.json');
  }
  const packageName = typeof manifest.packageName === 'string' ? manifest.packageName : '';
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName)) throw new Error('Invalid miniapp packageName');
  if (!version) throw new Error('Invalid miniapp version');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    packageName,
    version,
    manifest,
    manifestSha256: sha256Hex(Buffer.from(canonicalJson(manifest))),
    contentSha256: sha256Hex(Buffer.from(canonicalJson({ schemaVersion: 1, files }))),
  };
}

function validateEnvelope(value: unknown): MentraBundleSignatureV1 {
  const candidate = value as Partial<MentraBundleSignatureV1> | null;
  if (!candidate || candidate.schemaVersion !== 1 || candidate.algorithm !== 'Ed25519') {
    throw new Error('unsupported schema or algorithm');
  }
  if (
    !candidate.publicKeyJwk ||
    typeof candidate.publisherKeyFingerprint !== 'string' ||
    typeof candidate.signature !== 'string'
  ) {
    throw new Error('missing publisher identity');
  }
  const payload = candidate.payload;
  if (
    !payload ||
    typeof payload.packageName !== 'string' ||
    typeof payload.version !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.manifestSha256) ||
    !/^[a-f0-9]{64}$/.test(payload.contentSha256)
  ) {
    throw new Error('invalid signed payload');
  }
  return candidate as MentraBundleSignatureV1;
}

async function loadZip(bytes: Uint8Array): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch (error) {
    throw new Error(`Bundle is not a valid ZIP archive: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safePath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/') || /^[a-z]:/i.test(path)) return false;
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
  return normalized.length > 0 && normalized.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function isSymlink(entry: JSZip.JSZipObject): boolean {
  return typeof entry.unixPermissions === 'number' && (entry.unixPermissions & 0o170000) === 0o120000;
}

function sha256Hex(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function inspectRawZipNames(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const minimum = Math.max(0, bytes.byteLength - (0xffff + 22));
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (range(view, offset, 22) && view.getUint32(offset, true) === 0x06054b50) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === bytes.byteLength) {
        eocd = offset;
        break;
      }
    }
  }
  if (eocd < 0) throw new Error('Bundle ZIP end record was not found');
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('Bundle ZIP64 archives are not supported');
  }
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== count) {
    throw new Error('Multi-disk bundle ZIP archives are not supported');
  }
  if (centralOffset + centralSize !== eocd) throw new Error('Bundle ZIP central directory is malformed');
  const names = new Set<string>();
  const foldedNames = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (!range(view, cursor, 46) || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('Bundle ZIP central entry is malformed');
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const nameStart = cursor + 46;
    if (!range(view, nameStart, nameLength + extraLength + commentLength)) {
      throw new Error('Bundle ZIP central entry is truncated');
    }
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(nameStart, nameStart + nameLength));
    if (names.has(name)) throw new Error(`Bundle contains a duplicate path: ${name}`);
    if (foldedNames.has(name.toLowerCase())) throw new Error(`Bundle contains a case-colliding path: ${name}`);
    names.add(name);
    foldedNames.add(name.toLowerCase());
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('Bundle ZIP central directory size is inconsistent');
}

function range(view: DataView, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset + length <= view.byteLength
  );
}
