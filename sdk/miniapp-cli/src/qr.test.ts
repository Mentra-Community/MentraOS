import {afterEach, describe, expect, test} from 'bun:test';
import {chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';
import {writeQRPng} from './qr.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mentra-qr-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      chmodSync(dir, 0o700);
      rmSync(dir, {recursive: true, force: true});
    } catch {
      // best-effort cleanup
    }
  }
});

describe('writeQRPng', () => {
  test('creates a file with mode 0o600 and non-empty PNG content', async () => {
    const dir = makeTempDir();
    const outPath = join(dir, 'qr.png');
    await writeQRPng('miniapp://dev?url=http%3A%2F%2F192.168.1.1%3A3000', outPath);

    const st = statSync(outPath);
    expect(st.size).toBeGreaterThan(0);
    // Mask off higher mode bits so comparison is portable across platforms.
    expect(st.mode & 0o777).toBe(0o600);

    const header = readFileSync(outPath).subarray(0, 8);
    // PNG magic number
    expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test('overwrites the same path in place on a second call', async () => {
    const dir = makeTempDir();
    const outPath = join(dir, 'qr.png');
    await writeQRPng('miniapp://dev?url=http%3A%2F%2F192.168.1.1%3A3000', outPath);
    const first = readFileSync(outPath);

    await writeQRPng('miniapp://dev?url=http%3A%2F%2F10.0.0.1%3A3000', outPath);
    const second = readFileSync(outPath);

    expect(Buffer.compare(first, second)).not.toBe(0);
    expect(statSync(outPath).isFile()).toBe(true);
  });

  test('does not throw when the output directory is unwritable', async () => {
    const dir = makeTempDir();
    const readonlyDir = join(dir, 'readonly');
    // Create a directory entry that exists as a file, so writing qr.png under it fails.
    writeFileSync(readonlyDir, 'not-a-directory');
    const outPath = join(readonlyDir, 'qr.png');

    await expect(writeQRPng('miniapp://dev?test=1', outPath)).resolves.toBeUndefined();
  });
});
