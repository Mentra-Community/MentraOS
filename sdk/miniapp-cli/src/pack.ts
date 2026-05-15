import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'fs';
import { resolve, join } from 'path';
import { validateManifest } from './manifest.js';

export interface PackOptions {
  /** Where to write the resulting zip. Defaults to cwd. */
  outDir?: string;
  /** Quiet stdout. The `install` command swallows pack output and prints
   * its own progress; standalone `pack` calls leave it on. */
  silent?: boolean;
}

/**
 * Validate manifest, copy manifest+icon into dist/, zip dist/ into
 * `<packageName>-<version>.zip`. Returns the absolute path of the zip.
 */
export async function pack(opts: PackOptions = {}): Promise<string> {
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
  } else if (!opts.silent) {
    console.warn('Warning: icon.png not found in project root, skipping');
  }

  const packageName = manifest.packageName as string;
  const version = manifest.version as string;
  const outputName = `${packageName}-${version}.zip`;
  const outDir = opts.outDir ? resolve(cwd, opts.outDir) : cwd;
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const outputPath = resolve(outDir, outputName);

  // Create ZIP using system zip command
  const zipProc = Bun.spawn(['zip', '-r', outputPath, '.'], {
    cwd: distDir,
    stdout: opts.silent ? 'pipe' : 'inherit',
    stderr: opts.silent ? 'pipe' : 'inherit',
  });

  const exitCode = await zipProc.exited;
  if (exitCode !== 0) {
    console.error('Error: zip command failed');
    process.exit(1);
  }

  if (!opts.silent) {
    console.log(`\nPacked: ${outputPath}`);
  }
  return outputPath;
}
