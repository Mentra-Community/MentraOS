import crypto from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SIGNING_KEY_SERVICE = 'mentra-miniapp-publisher-signing';

export interface Ed25519PublicJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
}

export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  d: string;
}

export interface PackageSigningKey {
  schemaVersion: 1;
  packageName: string;
  publicKeyJwk: Ed25519PublicJwk;
  privateKeyJwk: Ed25519PrivateJwk;
  createdAt: string;
}

export function generatePackageSigningKey(packageName: string): PackageSigningKey {
  assertPackageName(packageName);
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    schemaVersion: 1,
    packageName,
    publicKeyJwk: assertPublicJwk(pair.publicKey.export({ format: 'jwk' })),
    privateKeyJwk: assertPrivateJwk(pair.privateKey.export({ format: 'jwk' })),
    createdAt: new Date().toISOString(),
  };
}

export async function createAndSavePackageSigningKey(
  packageName: string,
  options: { overwrite?: boolean } = {},
): Promise<{ key: PackageSigningKey; storage: 'keychain' | 'file' }> {
  const existing = await loadPackageSigningKey(packageName);
  if (existing && !options.overwrite) {
    throw new Error(`A publisher signing key already exists for ${packageName}`);
  }
  const key = generatePackageSigningKey(packageName);
  return { key, storage: await savePackageSigningKey(key) };
}

export async function savePackageSigningKey(key: PackageSigningKey): Promise<'keychain' | 'file'> {
  validatePackageSigningKey(key);
  const payload = JSON.stringify(key);
  try {
    if (typeof Bun !== 'undefined' && Bun.secrets) {
      await Bun.secrets.set({ service: SIGNING_KEY_SERVICE, name: key.packageName, value: payload });
      rmSync(packageSigningKeyPath(key.packageName), { force: true });
      return 'keychain';
    }
  } catch {
    // Fall through to the secure file fallback.
  }

  const path = packageSigningKeyPath(key.packageName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${payload}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return 'file';
}

export async function loadPackageSigningKey(packageName: string): Promise<PackageSigningKey | null> {
  assertPackageName(packageName);
  let keychainValue: string | null = null;
  try {
    if (typeof Bun !== 'undefined' && Bun.secrets) {
      keychainValue = await Bun.secrets.get({ service: SIGNING_KEY_SERVICE, name: packageName });
    }
  } catch {
    // Fall through to the secure file fallback.
  }

  const path = packageSigningKeyPath(packageName);
  const fileKey = existsSync(path) ? parsePackageSigningKey(readFileSync(path, 'utf8'), packageName) : null;
  if (!keychainValue) return fileKey;
  const keychainKey = parsePackageSigningKey(keychainValue, packageName);
  if (fileKey && publisherKeyFingerprint(fileKey.publicKeyJwk) !== publisherKeyFingerprint(keychainKey.publicKeyJwk)) {
    throw new Error(`Conflicting publisher signing keys exist for ${packageName} in the keychain and file fallback`);
  }
  return keychainKey;
}

export async function resolvePackageSigningKey(
  packageName: string,
  options: { inputPath?: string; serialized?: string } = {},
): Promise<PackageSigningKey | null> {
  const inputPath = options.inputPath ?? process.env.MENTRA_MINIAPP_SIGNING_KEY_FILE?.trim();
  const serialized = options.serialized ?? process.env.MENTRA_MINIAPP_SIGNING_KEY_JSON?.trim();
  if (inputPath && serialized) {
    throw new Error('Configure only one of MENTRA_MINIAPP_SIGNING_KEY_FILE or MENTRA_MINIAPP_SIGNING_KEY_JSON');
  }
  if (inputPath) return parsePackageSigningKey(readFileSync(resolve(inputPath), 'utf8'), packageName);
  if (serialized) return parsePackageSigningKey(serialized, packageName);
  return loadPackageSigningKey(packageName);
}

export async function importPackageSigningKey(
  packageName: string,
  inputPath: string,
  options: { overwrite?: boolean } = {},
): Promise<{ key: PackageSigningKey; storage: 'keychain' | 'file' }> {
  const key = parsePackageSigningKey(readFileSync(resolve(inputPath), 'utf8'), packageName);
  const existing = await loadPackageSigningKey(packageName);
  if (existing && publisherKeyFingerprint(existing.publicKeyJwk) !== publisherKeyFingerprint(key.publicKeyJwk)) {
    if (!options.overwrite) {
      throw new Error(`Refusing to replace the existing publisher signing key for ${packageName}`);
    }
  }
  return { key, storage: await savePackageSigningKey(key) };
}

export async function exportPackageSigningKey(packageName: string, outputPath: string): Promise<string> {
  const key = await loadPackageSigningKey(packageName);
  if (!key) throw missingSigningKeyError(packageName);
  const path = resolve(outputPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(key, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return path;
}

export function packageSigningKeyPath(packageName: string): string {
  assertPackageName(packageName);
  const configuredRoot = process.env.MENTRA_CLI_HOME?.trim();
  const root = configuredRoot ? resolve(configuredRoot) : join(homedir(), '.mentra', 'cli-v2');
  return join(root, 'signing-keys', `${packageName}.json`);
}

export function publisherKeyFingerprint(publicKeyJwk: Ed25519PublicJwk): string {
  const key = assertPublicJwk(publicKeyJwk);
  const raw = decodeCanonicalBase64Url(key.x, 'Ed25519 public key');
  if (raw.byteLength !== 32) throw new Error('Ed25519 public key must contain 32 bytes');
  return `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

export function missingSigningKeyError(packageName: string): Error {
  return new Error(
    `No publisher signing key exists for ${packageName}. Run \`mentra miniapps keys create --package ${packageName}\` or import an existing key.`,
  );
}

export function validatePackageSigningKey(key: PackageSigningKey): void {
  if (!key || key.schemaVersion !== 1) throw new Error('Publisher signing key has an unsupported schema');
  assertPackageName(key.packageName);
  const publicKey = assertPublicJwk(key.publicKeyJwk);
  const privateKey = assertPrivateJwk(key.privateKeyJwk);
  if (publicKey.x !== privateKey.x) throw new Error('Publisher public and private keys do not match');
  const challenge = Buffer.from('mentra-miniapp-key-validation');
  const privateObject = crypto.createPrivateKey({
    key: privateKey,
    format: 'jwk',
  } as unknown as crypto.PrivateKeyInput);
  const publicObject = crypto.createPublicKey({ key: publicKey, format: 'jwk' } as unknown as crypto.PublicKeyInput);
  const signature = crypto.sign(null, challenge, privateObject);
  if (!crypto.verify(null, challenge, publicObject, signature)) {
    throw new Error('Publisher public and private keys do not form a valid Ed25519 pair');
  }
}

function parsePackageSigningKey(serialized: string, expectedPackageName: string): PackageSigningKey {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('Publisher signing key file is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Publisher signing key file must contain an object');
  }
  const candidate = value as PackageSigningKey;
  validatePackageSigningKey(candidate);
  if (candidate.packageName !== expectedPackageName) {
    throw new Error(`Publisher signing key belongs to ${candidate.packageName}, not ${expectedPackageName}`);
  }
  return candidate;
}

function assertPublicJwk(value: unknown): Ed25519PublicJwk {
  const candidate = value as Partial<Ed25519PublicJwk> | null;
  if (!candidate || candidate.kty !== 'OKP' || candidate.crv !== 'Ed25519' || typeof candidate.x !== 'string') {
    throw new Error('Publisher public key must be an Ed25519 public JWK');
  }
  const publicBytes = decodeCanonicalBase64Url(candidate.x, 'Ed25519 public key');
  if (publicBytes.byteLength !== 32) throw new Error('Ed25519 public key must contain 32 bytes');
  return { kty: 'OKP', crv: 'Ed25519', x: candidate.x };
}

function assertPrivateJwk(value: unknown): Ed25519PrivateJwk {
  const candidate = value as Partial<Ed25519PrivateJwk> | null;
  if (
    !candidate ||
    candidate.kty !== 'OKP' ||
    candidate.crv !== 'Ed25519' ||
    typeof candidate.x !== 'string' ||
    typeof candidate.d !== 'string'
  ) {
    throw new Error('Publisher private key must be an Ed25519 private JWK');
  }
  const privateBytes = decodeCanonicalBase64Url(candidate.d, 'Ed25519 private key');
  if (privateBytes.byteLength !== 32) throw new Error('Ed25519 private key must contain 32 bytes');
  return { kty: 'OKP', crv: 'Ed25519', x: candidate.x, d: candidate.d };
}

function decodeCanonicalBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} is not valid base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error(`${label} is not canonical base64url`);
  return decoded;
}

function assertPackageName(packageName: string): void {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(packageName)) {
    throw new Error('Package name must be normalized lowercase reverse-DNS text');
  }
}
