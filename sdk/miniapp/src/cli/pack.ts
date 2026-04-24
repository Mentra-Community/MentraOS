import { existsSync, readFileSync, copyFileSync } from 'fs';
import { resolve, join } from 'path';
import { validateManifest } from './manifest.js';

export async function pack(): Promise<void> {
  const cwd = process.cwd();
  const distDir = resolve(cwd, 'dist');
  const manifestSrc = resolve(cwd, 'miniapp.json');
  const iconSrc = resolve(cwd, 'icon.png');

  // Verify dist/ exists
  if (!existsSync(distDir)) {
    console.error('Error: dist/ directory not found. Build your miniapp first.');
    process.exit(1);
  }

  // Verify miniapp.json exists
  if (!existsSync(manifestSrc)) {
    console.error('Error: miniapp.json not found in current directory');
    process.exit(1);
  }

  // Read and validate manifest
  const manifestRaw = readFileSync(manifestSrc, 'utf-8');
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    console.error('Error: miniapp.json is not valid JSON');
    process.exit(1);
  }

  const { valid, errors } = validateManifest(manifest);
  if (!valid) {
    console.error('Manifest validation failed:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  // Copy miniapp.json into dist/
  copyFileSync(manifestSrc, join(distDir, 'miniapp.json'));

  // Copy icon.png into dist/ if it exists
  if (existsSync(iconSrc)) {
    copyFileSync(iconSrc, join(distDir, 'icon.png'));
  } else {
    console.warn('Warning: icon.png not found in project root, skipping');
  }

  const packageName = manifest.packageName as string;
  const version = manifest.version as string;
  const outputName = `${packageName}-${version}.zip`;
  const outputPath = resolve(cwd, outputName);

  // Create ZIP using system zip command
  const zipProc = Bun.spawn(['zip', '-r', outputPath, '.'], {
    cwd: distDir,
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const exitCode = await zipProc.exited;
  if (exitCode !== 0) {
    console.error('Error: zip command failed');
    process.exit(1);
  }

  console.log(`\nPacked: ${outputPath}`);
}
