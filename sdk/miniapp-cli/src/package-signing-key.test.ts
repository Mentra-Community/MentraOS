import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

type KeychainOutcome = { ok: boolean; name?: string; message?: string; setCalls: number; fingerprint?: string };

/**
 * Run one key operation in a child Bun process whose keychain is stubbed, so
 * the developer's real keychain is never read or written.
 */
function withStubbedKeychain(
  keychain: 'unreadable' | 'empty',
  operation: 'create' | 'import' | 'load' | 'export',
  options: { fileKey?: boolean } = {},
): { outcome: KeychainOutcome; home: string; keyFile: string } {
  const home = mkdtempSync(join(tmpdir(), 'mentra-keychain-'));
  temporaryDirectories.push(home);
  const keyFile = join(home, 'signing-keys', 'com.example.app.json');
  if (options.fileKey) {
    mkdirSync(join(home, 'signing-keys'), { recursive: true });
    writeFileSync(keyFile, JSON.stringify(generatePackageSigningKey('com.example.app')), { mode: 0o600 });
  }
  const importPath = join(home, 'import.json');
  writeFileSync(importPath, JSON.stringify(generatePackageSigningKey('com.example.app')), { mode: 0o600 });
  const resultPath = join(home, 'result.json');
  const runner = join(home, 'run.ts');
  const module = JSON.stringify(new URL('./package-signing-key.ts', import.meta.url).pathname);
  writeFileSync(
    runner,
    `
    import { writeFileSync } from 'node:fs';
    import * as keys from ${module};
    let setCalls = 0;
    Object.defineProperty(Bun, 'secrets', {
      value: {
        get: async () => {
          if (${JSON.stringify(keychain)} === 'unreadable') throw new Error('User interaction is not allowed.');
          return null;
        },
        set: async () => { setCalls += 1; },
      },
    });
    const run = {
      create: () => keys.createAndSavePackageSigningKey('com.example.app'),
      import: () => keys.importPackageSigningKey('com.example.app', ${JSON.stringify(importPath)}),
      load: () => keys.loadPackageSigningKey('com.example.app'),
      export: () => keys.exportPackageSigningKey('com.example.app', ${JSON.stringify(join(home, 'export.json'))}),
    }[${JSON.stringify(operation)}];
    try {
      const value = await run();
      const key = value && typeof value === 'object' && 'key' in value ? value.key : value;
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
        ok: true,
        setCalls,
        ...(key && typeof key === 'object' && 'publicKeyJwk' in key ? { fingerprint: keys.publisherKeyFingerprint(key.publicKeyJwk) } : {}),
      }));
    } catch (error) {
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ok: false, name: error.name, message: error.message, setCalls }));
    }
  `,
  );
  const result = spawnSync(process.execPath, [runner], {
    cwd: home,
    timeout: 10_000,
    encoding: 'utf8',
    env: { ...process.env, MENTRA_CLI_HOME: home, MENTRA_MINIAPP_SIGNING_KEY_FILE: '', MENTRA_MINIAPP_SIGNING_KEY_JSON: '' },
  });
  expect(result.status).toBe(0);
  return { outcome: JSON.parse(readFileSync(resultPath, 'utf8')) as KeychainOutcome, home, keyFile };
}

describe('package publisher signing keys when the keychain cannot be read', () => {
  test.each(['create', 'import'] as const)('%s fails without creating or storing any key', (operation) => {
    const { outcome, keyFile } = withStubbedKeychain('unreadable', operation);
    expect(outcome.ok).toBe(false);
    expect(outcome.name).toBe('PackageSigningKeyReadError');
    expect(outcome.message).toContain('Could not read the publisher signing key for com.example.app');
    expect(outcome.message).toContain('Nothing was created or changed');
    expect(outcome.setCalls).toBe(0);
    expect(existsSync(keyFile)).toBe(false);
  });

  test.each(['load', 'export'] as const)('%s fails instead of treating the key as missing', (operation) => {
    const { outcome, home } = withStubbedKeychain('unreadable', operation);
    expect(outcome.ok).toBe(false);
    expect(outcome.name).toBe('PackageSigningKeyReadError');
    expect(existsSync(join(home, 'export.json'))).toBe(false);
  });

  test('does not fall back to a file key whose keychain counterpart cannot be checked', () => {
    const { outcome, keyFile } = withStubbedKeychain('unreadable', 'load', { fileKey: true });
    expect(outcome.ok).toBe(false);
    expect(outcome.name).toBe('PackageSigningKeyReadError');
    expect(existsSync(keyFile)).toBe(true);
  });

  test('treats only a successful empty lookup as no key', () => {
    const { outcome, keyFile } = withStubbedKeychain('empty', 'create');
    expect(outcome.ok).toBe(true);
    expect(outcome.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(outcome.setCalls).toBe(1);
    expect(existsSync(keyFile)).toBe(false);
  });
});
