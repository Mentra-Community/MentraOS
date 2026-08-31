import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  generatePackageSigningKey,
  publisherKeyFingerprint,
  resolvePackageSigningKey,
  validatePackageSigningKey,
} from './package-signing-key';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('package publisher signing keys', () => {
  test('generates a valid package-scoped Ed25519 identity', () => {
    const key = generatePackageSigningKey('com.example.app');
    expect(() => validatePackageSigningKey(key)).not.toThrow();
    expect(publisherKeyFingerprint(key.publicKeyJwk)).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('loads an explicit CI secret without persisting it', async () => {
    const key = generatePackageSigningKey('com.example.app');
    await expect(resolvePackageSigningKey('com.example.app', { serialized: JSON.stringify(key) })).resolves.toEqual(
      key,
    );
    await expect(resolvePackageSigningKey('com.example.other', { serialized: JSON.stringify(key) })).rejects.toThrow(
      'belongs to com.example.app',
    );
  });

  test('retains the same identity when moved to another machine as a key file', async () => {
    const key = generatePackageSigningKey('com.example.app');
    const directory = mkdtempSync(join(tmpdir(), 'mentra-publisher-key-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'publisher-key.json');
    writeFileSync(path, JSON.stringify(key), { mode: 0o600 });

    const restored = await resolvePackageSigningKey('com.example.app', { inputPath: path });
    expect(restored && publisherKeyFingerprint(restored.publicKeyJwk)).toBe(publisherKeyFingerprint(key.publicKeyJwk));
  });

  test('rejects a mismatched private key', () => {
    const key = generatePackageSigningKey('com.example.app');
    const other = generatePackageSigningKey('com.example.app');
    expect(() => validatePackageSigningKey({ ...key, privateKeyJwk: other.privateKeyJwk })).toThrow(
      'public and private keys do not match',
    );
  });
});
