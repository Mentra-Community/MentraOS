import {
  existsSync,
  mkdirSync,
  readFileSync,
  copyFileSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, join, relative, sep } from 'path';
import JSZip from 'jszip';
import { buildProduction } from './build.js';
import { signBundleArchive, verifySignedBundleArchive } from './bundle-signing.js';
import { warnIfPlaceholderIcon } from './icon.js';
import { validateManifest } from './manifest.js';
import { missingSigningKeyError, resolvePackageSigningKey, type PackageSigningKey } from './package-signing-key.js';

export interface PackOptions {
  /** Miniapp project root. Defaults to the current working directory. */
  cwd?: string;
  /** Run the production build before zipping. Defaults to false. */
  build?: boolean;
  /** The folder to write, ready to upload to the miniapp's URL. Defaults to build/. */
  outDir?: string;
  /** Quiet stdout. The `release` command swallows pack output and prints
   * its own progress; standalone `pack` calls leave it on. */
  silent?: boolean;
  /** Command used to create the ZIP. Intended for tests and embedders. */
  zipCommand?: string;
  /**
   * Sign the bundle with the package's publisher key.
   *
   * Off by default. Publisher identity is opt-in on the host and sticky: the
   * first signed bundle a package installs pins that key for every later
   * update, and the envelope has no rotation chain. Signing is therefore a
   * one-way door per package — take it deliberately, once the key has somewhere
   * durable to live, not as a side effect of repacking.
   *
   * Passing `signingKey` or `signingKeyPath` is itself that intent and implies
   * this.
   */
  sign?: boolean;
  /** Explicit package signing key. Implies `sign`. */
  signingKey?: PackageSigningKey;
  /** Read a package signing key without importing it into persistent storage. Implies `sign`. */
  signingKeyPath?: string;
}

/**
 * Validate manifest, copy manifest+icon into dist/, zip dist/ into
 * `build/<packageName>-<version>.zip`. Returns the absolute path of the zip.
 *
 * `build/` is then ready to upload as is to the miniapp's URL. It holds what a
 * miniapp URL serves, the same files Mentra's first-party publisher puts on its
 * host:
 *
 *   <packageName>-<version>.zip   the ZIP; older versions' ZIPs stay beside it
 *   <icon>                        the icon miniapp.json names, from the ZIP
 *   miniapp.json                  the ZIP's miniapp.json plus bundle: {url, sha256}
 *
 * `build/` is self-ignoring: a `.gitignore` containing `*` is written into
 * it on creation (the Cargo `target/` trick), so packed zips stay out of
 * version control no matter which repo the miniapp lives in — no root
 * .gitignore coordination needed.
 */
export async function pack(opts: PackOptions = {}): Promise<string> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  if (opts.build) {
    await buildProduction(cwd, { silent: opts.silent });
  }

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
  let publisherFingerprint = '';
  let bundleSha256 = '';
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
  // The served copy names its ZIP; the ZIP can't name itself.
  if ('bundle' in manifest) {
    console.error('Error: miniapp.json must not declare bundle. pack writes it into the miniapp.json it serves.');
    process.exit(1);
  }

  // Enforce two-layer bundle contract when manifest.entry is set.
  // `entry.background` (required for two-layer) must resolve to a file in the
  // bundle. `entry.ui` (optional, for UI-bearing miniapps) likewise. Legacy
  // single-bundle manifests without an `entry` object skip this check —
  // pack still zips dist/ verbatim.
  //
  // Entry paths are relative to the *bundle root*, which is dist/'s contents
  // (we zip from inside dist/ below), so `background/index.js` in the manifest
  // is `dist/background/index.js` on disk — resolve against distDir.
  const entry = manifest.entry as { background?: string; ui?: string } | undefined;
  const realDistDir = realpathSync(distDir);
  if (entry) {
    const checkRelative = (label: string, rel: string | undefined, required: boolean) => {
      if (!rel) {
        if (required) {
          console.error(`Error: manifest.entry.${label} is required for two-layer bundles`);
          process.exit(1);
        }
        return;
      }
      if (
        rel.includes('\\') ||
        isAbsolute(rel) ||
        rel.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
      ) {
        console.error(`Error: manifest.entry.${label} must be a safe relative path inside dist/`);
        process.exit(1);
      }
      const abs = resolve(distDir, rel);
      const relativePath = relative(distDir, abs);
      if (!relativePath || relativePath.split(sep).includes('..')) {
        console.error(`Error: manifest.entry.${label} must be a safe relative path inside dist/`);
        process.exit(1);
      }
      if (
        !existsSync(abs) ||
        !lstatSync(abs).isFile() ||
        relative(realDistDir, realpathSync(abs)).split(sep).includes('..')
      ) {
        console.error(`Error: manifest.entry.${label} points at "${rel}" but dist/${rel} does not exist`);
        process.exit(1);
      }
    };
    checkRelative('background', entry.background, true);
    checkRelative('ui', entry.ui, false);
  }

  // Copy miniapp.json into dist/
  copyFileSync(manifestSrc, join(distDir, 'miniapp.json'));

  // Copy icon.png into dist/ if it exists
  if (existsSync(iconSrc)) {
    if (!opts.silent) warnIfPlaceholderIcon(cwd);
    copyFileSync(iconSrc, join(distDir, 'icon.png'));
  } else if (!opts.silent) {
    console.warn('Warning: icon.png not found in project root, skipping');
  }

  const packageName = manifest.packageName as string;
  const version = manifest.version as string;
  const outputName = `${packageName}-${version}.zip`;
  const outDir = resolve(cwd, opts.outDir ?? 'build');
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const selfIgnore = join(outDir, '.gitignore');
  if (!existsSync(selfIgnore)) {
    writeFileSync(selfIgnore, '*\n');
  }
  const outputPath = resolve(outDir, outputName);
  const temporaryPath = resolve(outDir, `.${outputName}.${process.pid}.${Date.now()}.tmp`);

  // Build beside the destination and atomically replace it only after zip
  // succeeds. A failed pack must never destroy the last publishable artifact.
  const staged: StagedFile[] = [];
  let staleIcon: string | null = null;
  const zipProc = Bun.spawn([opts.zipCommand ?? 'zip', '-r', temporaryPath, '.'], {
    cwd: distDir,
    stdout: opts.silent ? 'ignore' : 'inherit',
    stderr: opts.silent ? 'ignore' : 'inherit',
  });

  try {
    const exitCode = await zipProc.exited;
    if (exitCode !== 0) throw new Error('zip command failed');
    const wantsSignature = opts.sign === true || Boolean(opts.signingKey) || Boolean(opts.signingKeyPath);
    let archive: Uint8Array = readFileSync(temporaryPath);
    if (wantsSignature) {
      const signingKey =
        opts.signingKey ?? (await resolvePackageSigningKey(packageName, { inputPath: opts.signingKeyPath }));
      if (!signingKey) throw missingSigningKeyError(packageName);
      archive = await signBundleArchive(archive, signingKey);
      const verified = await verifySignedBundleArchive(archive);
      if (verified.packageName !== packageName || verified.version !== version) {
        throw new Error('Signed bundle identity does not match miniapp.json');
      }
      publisherFingerprint = verified.publisherKeyFingerprint;
      writeFileSync(temporaryPath, archive);
    }
    bundleSha256 = createHash('sha256').update(archive).digest('hex');
    const icon = await iconFromArchive(archive, manifest.icon, opts.silent);
    const served = { ...manifest, bundle: { url: outputName, sha256: bundleSha256 } };
    // What the miniapp's URL serves, every file written before any is
    // replaced, then swapped in in the order a host should receive them: the
    // ZIP, the icon, and last the miniapp.json that names them.
    if (icon) staged.push(stageFile(outDir, join(outDir, icon.path), icon.bytes));
    staged.push(stageFile(outDir, join(outDir, 'miniapp.json'), `${JSON.stringify(served, null, 2)}\n`));
    replaceFiles([{ temporary: temporaryPath, path: outputPath }, ...staged]);
    if (!icon) staleIcon = staleIconPath(outDir, manifest.icon);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    for (const file of staged) rmSync(file.temporary, { force: true });
    throw error;
  }
  // An earlier pack's icon at that path would be uploaded as this release's.
  if (staleIcon) {
    try {
      rmSync(staleIcon);
    } catch {
      console.warn(`Warning: could not remove ${staleIcon}, an icon this release doesn't have`);
    }
  }

  if (!opts.silent) {
    console.log(`\nPacked: ${outputPath}`);
    console.log(publisherFingerprint ? `Publisher key: ${publisherFingerprint}` : 'Publisher key: unsigned');
    console.log(`SHA-256: ${bundleSha256}`);
    console.log(`Upload the ${relative(cwd, outDir) || '.'} folder to your miniapp's URL.`);
  }
  return outputPath;
}

/** An icon path the host serves beside miniapp.json, as Mentra's publisher accepts one. */
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/**
 * The icon miniapp.json names, read from the ZIP. Null when it is on another
 * host or isn't in the ZIP; the latter is warned about, since the served
 * miniapp.json would name a file the folder doesn't have.
 */
async function iconFromArchive(
  archive: Uint8Array,
  icon: unknown,
  silent: boolean | undefined,
): Promise<{ path: string; bytes: Uint8Array } | null> {
  if (typeof icon !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(icon)) return null;
  const entry = SAFE_RELATIVE_PATH.test(icon) ? (await JSZip.loadAsync(archive)).file(icon) : null;
  if (!entry) {
    if (!silent) {
      console.warn(`Warning: miniapp.json's icon "${icon}" is not in the bundle, so there is no icon to upload.`);
    }
    return null;
  }
  return { path: icon, bytes: await entry.async('uint8array') };
}

/** A file an earlier pack left at the icon path, when this release's ZIP has no icon there. */
function staleIconPath(outDir: string, icon: unknown): string | null {
  if (typeof icon !== 'string' || !SAFE_RELATIVE_PATH.test(icon)) return null;
  const path = join(outDir, icon);
  // Never one of the folder's own files, however the path spells it, and on
  // case-insensitive disks too.
  const name = relative(outDir, path).toLowerCase();
  if (name === 'miniapp.json' || name === '.gitignore' || name.endsWith('.zip')) return null;
  return existsSync(path) && lstatSync(path).isFile() ? path : null;
}

interface StagedFile {
  /** The new content, beside the destination in the output folder. */
  temporary: string;
  path: string;
}

function stageFile(outDir: string, path: string, data: string | Uint8Array): StagedFile {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(outDir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, data);
  return { temporary, path };
}

/**
 * Move staged files into place, in order. If one can't be moved, the ones
 * already replaced get their previous content back, so the folder never pairs
 * a miniapp.json with a ZIP it doesn't describe.
 */
function replaceFiles(files: StagedFile[]): void {
  for (const { path } of files) {
    if (existsSync(path) && lstatSync(path).isDirectory()) {
      throw new Error(`${path} is a folder, so pack can't write a file there`);
    }
  }
  const replaced: { path: string; previous: string | null }[] = [];
  try {
    for (const { temporary, path } of files) {
      const previous = existsSync(path) ? `${temporary}.previous` : null;
      if (previous) renameSync(path, previous);
      replaced.push({ path, previous });
      renameSync(temporary, path);
    }
  } catch (error) {
    for (const { path, previous } of replaced.reverse()) {
      try {
        if (previous) renameSync(previous, path);
        else rmSync(path, { force: true });
      } catch {
        // Keep going: restore as much of the previous folder as possible.
      }
    }
    throw error;
  }
  // The new files are in place; a leftover copy of an old one is only clutter.
  for (const { previous } of replaced) {
    if (!previous) continue;
    try {
      rmSync(previous, { force: true });
    } catch {
      console.warn(`Warning: could not remove ${previous}`);
    }
  }
}
