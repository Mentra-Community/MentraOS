import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';

import { signBundleArchive, verifySignedBundleArchive } from './bundle-signing';
import { generatePackageSigningKey } from './package-signing-key';

async function unsignedBundle(version = '1.0.0') {
  const zip = new JSZip();
  zip.file('miniapp.json', JSON.stringify({ packageName: 'com.example.signed', version }));
  zip.file('background/index.js', 'export const signed = true');
  return zip.generateAsync({ type: 'uint8array' });
}

describe('signed miniapp bundles', () => {
  test('embeds and verifies publisher identity', async () => {
    const key = generatePackageSigningKey('com.example.signed');
    const signed = await signBundleArchive(await unsignedBundle(), key);
    await expect(verifySignedBundleArchive(signed)).resolves.toMatchObject({
      packageName: 'com.example.signed',
      version: '1.0.0',
    });
  });

  test('rejects changed executable content', async () => {
    const key = generatePackageSigningKey('com.example.signed');
    const zip = await JSZip.loadAsync(await signBundleArchive(await unsignedBundle(), key));
    zip.file('background/index.js', 'export const signed = false');
    const changed = await zip.generateAsync({ type: 'uint8array' });
    await expect(verifySignedBundleArchive(changed)).rejects.toThrow('does not match');
  });

  test('rejects a stripped publisher signature', async () => {
    const key = generatePackageSigningKey('com.example.signed');
    const zip = await JSZip.loadAsync(await signBundleArchive(await unsignedBundle(), key));
    zip.remove('META-INF/MENTRA.SIG');
    await expect(verifySignedBundleArchive(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(
      'exactly one META-INF/MENTRA.SIG',
    );
  });

  test('rejects duplicate raw ZIP paths before JSZip can collapse them', async () => {
    const zip = new JSZip();
    zip.file('miniapp.json', JSON.stringify({ packageName: 'com.example.signed', version: '1.0.0' }));
    zip.file('background/index.js', 'one');
    zip.file('background/other.js', 'two');
    const archive = await zip.generateAsync({ type: 'uint8array' });
    patchCentralName(archive, 'background/other.js', 'background/index.js');

    await expect(signBundleArchive(archive, generatePackageSigningKey('com.example.signed'))).rejects.toThrow(
      'duplicate path',
    );
  });

  test('rejects a signing key for another package', async () => {
    const key = generatePackageSigningKey('com.example.other');
    await expect(signBundleArchive(await unsignedBundle(), key)).rejects.toThrow('belongs to');
  });
});

function patchCentralName(archive: Uint8Array, expectedName: string, replacement: string): void {
  if (expectedName.length !== replacement.length) throw new Error('replacement ZIP name must have equal length');
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = 0; offset <= archive.byteLength - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 46;
    const name = new TextDecoder().decode(archive.subarray(nameStart, nameStart + nameLength));
    if (name !== expectedName) continue;
    archive.set(new TextEncoder().encode(replacement), nameStart);
    return;
  }
  throw new Error(`central ZIP entry not found: ${expectedName}`);
}
