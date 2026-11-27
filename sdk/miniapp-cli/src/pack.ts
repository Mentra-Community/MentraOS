import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  lstatSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, join, relative, sep } from 'path';
import JSZip from 'jszip';
import { buildProduction } from './build.js';
import { signBundleArchive, verifySignedBundleArchive } from './bundle-signing.js';
import { warnIfPlaceholderIcon } from './icon.js';
import { validateManifest, withApiLevel } from './manifest.js';
import { missingSigningKeyError, resolvePackageSigningKey, type PackageSigningKey } from './package-signing-key.js';
import { buildReproducibleZip, type ZipFile } from './reproducible-zip.js';
import { isSemver, listedVersions, mergeVersions, type VersionEntry } from './versions.js';

export interface PackOptions {
  /** Miniapp project root. Defaults to the current working directory. */
  cwd?: string;
  /** Run the production build before zipping. Defaults to false. */
  build?: boolean;
  /** The folder to write, ready to upload to the miniapp's URL. Defaults to build/. */
  outDir?: string;
  /** Quiet stdout. `dev --production` swallows the bundle's output and prints
   * its own progress; standalone `pack` calls leave it on. */
  silent?: boolean;
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
  /**
   * The miniapp's URL, where this build will be uploaded. `pack` reads the
   * miniapp.json published there and keeps the versions it lists. Without it,
   * the list comes from the miniapp.json already in the output folder. A clean
   * checkout, such as CI, has no output folder, so it passes this.
   */
  url?: string;
}

/** A production bundle, in memory: what `pack` writes and `dev --production` serves. */
export interface PackedBundle {
  /** The ZIP, signed when signing was asked for. */
  archive: Uint8Array;
  /** The ZIP's SHA-256, in lowercase hex. */
  sha256: string;
  /** The name `pack` gives the ZIP. */
  zipName: string;
  /** The project's miniapp.json, which is also the ZIP's. */
  manifest: Record<string, unknown>;
  packageName: string;
  version: string;
  /** The publisher key's fingerprint; empty for an unsigned bundle. */
  publisherFingerprint: string;
}

/**
 * Validate manifest, copy manifest+icon into dist/, zip dist/ into
 * `build/<packageName>-<version>-<hash>.zip`, where `<hash>` is the first 8
 * hex digits of the ZIP's SHA-256. Returns the absolute path of the zip.
 *
 * The same files always pack to the same ZIP (`buildReproducibleZip`), and
 * with the same publisher key to the same signed ZIP. A phone updates when the
 * hash its miniapp's URL serves changes, so a ZIP that changed with the time it
 * was packed would look like a new build to every phone on every deploy.
 *
 * `build/` is then ready to upload as is to the miniapp's URL. It holds what a
 * miniapp URL serves, the same files Mentra's first-party publisher puts on its
 * host:
 *
 *   <packageName>-<version>-<hash>.zip   the ZIP; ZIPs of earlier builds stay
 *                                        beside it, and no build ever replaces
 *                                        another's file
 *   <icon>                               the icon miniapp.json names, from the ZIP
 *   miniapp.json                         the ZIP's miniapp.json plus bundle: {url, sha256}
 *                                        and versions, the versions a phone can
 *                                        be pinned to (versions.ts)
 *
 * `versions` gets this build's entry, in place of one for the same version, and
 * keeps the entries already published: the ones `opts.url` serves, or else the
 * ones in the output folder's miniapp.json whose ZIPs are still in the folder.
 *
 * `build/` is self-ignoring: a `.gitignore` containing `*` is written into
 * it on creation (the Cargo `target/` trick), so packed zips stay out of
 * version control no matter which repo the miniapp lives in — no root
 * .gitignore coordination needed.
 */
export async function pack(opts: PackOptions = {}): Promise<string> {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const bundle = await buildBundle(opts);
  const { archive, manifest, packageName, version, publisherFingerprint } = bundle;
  const bundleSha256 = bundle.sha256;
  const outputName = bundle.zipName;
  const outDir = resolve(cwd, opts.outDir ?? 'build');

  // Read before anything is written: a list that can't be read stops the pack.
  const published = opts.url
    ? await publishedVersions(opts.url, packageName, opts.silent)
    : packedVersions(outDir, packageName, opts.silent);
  // `bundle.url` and each entry's `url` are relative to the miniapp URL, where
  // the ZIPs sit beside miniapp.json. An entry kept from the published list
  // keeps the URL it was published with.
  let versions = published;
  if (isSemver(version)) {
    versions = mergeVersions(published, { version, url: outputName, sha256: bundleSha256 });
  } else if (!opts.silent) {
    // A phone reads no list that has a version it can't parse.
    console.warn(`Warning: version "${version}" is not a semantic version, so it is not listed in versions.`);
  }
  const served = { ...manifest, bundle: { url: outputName, sha256: bundleSha256 }, versions };
  const servedText = `${JSON.stringify(served, null, 2)}\n`;
  if (Buffer.byteLength(servedText) > MAX_SERVED_MANIFEST_BYTES) {
    throw new Error(
      `The served miniapp.json would be ${Buffer.byteLength(servedText)} bytes. ` +
        `The Mentra App reads at most ${MAX_SERVED_MANIFEST_BYTES}, so it could not install this miniapp.`,
    );
  }

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const selfIgnore = join(outDir, '.gitignore');
  if (!existsSync(selfIgnore)) {
    writeFileSync(selfIgnore, '*\n');
  }
  const outputPath = resolve(outDir, outputName);
  const temporaryPath = resolve(outDir, `.${outputName}.${process.pid}.${Date.now()}.tmp`);

  // Written beside the destination and moved into place with the files that
  // name it. The same build packed again replaces its own ZIP with the same
  // bytes, so the ZIP a pack returns is always one it just wrote.
  const staged: StagedFile[] = [];
  let staleIcon: string | null = null;
  try {
    writeFileSync(temporaryPath, archive);
    const icon = await iconFromArchive(archive, manifest.icon, opts.silent);
    // What the miniapp's URL serves, every file written before any is
    // replaced, then swapped in in the order a host should receive them: the
    // ZIP, the icon, and last the miniapp.json that names them.
    if (icon) staged.push(stageFile(outDir, join(outDir, icon.path), icon.bytes));
    staged.push(stageFile(outDir, join(outDir, 'miniapp.json'), servedText));
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
    console.log(`Versions: ${versions.map((listed) => listed.version).join(', ') || 'none'}`);
    console.log(`Upload the ${relative(cwd, outDir) || '.'} folder to your miniapp's URL.`);
  }
  return outputPath;
}

/**
 * The project's production bundle, in memory: validate miniapp.json, copy it
 * and the icon into dist/, and zip dist/, signed when asked. It writes nothing
 * outside dist/.
 */
export async function buildBundle(opts: PackOptions = {}): Promise<PackedBundle> {
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
  // The served copy names its ZIP and lists its versions; the ZIP can't name itself.
  for (const field of ['bundle', 'versions']) {
    if (field in manifest) {
      console.error(`Error: miniapp.json must not declare ${field}. pack writes it into the miniapp.json it serves.`);
      process.exit(1);
    }
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

  // miniapp.json into dist/, with the SDK's API level
  manifest = withApiLevel(manifest, cwd);
  writeFileSync(join(distDir, 'miniapp.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Copy icon.png into dist/ if it exists
  if (existsSync(iconSrc)) {
    if (!opts.silent) warnIfPlaceholderIcon(cwd);
    copyFileSync(iconSrc, join(distDir, 'icon.png'));
  } else if (!opts.silent) {
    console.warn('Warning: icon.png not found in project root, skipping');
  }

  const packageName = manifest.packageName as string;
  const version = manifest.version as string;

  // The ZIP is made in memory and nothing is written until it exists: a failed
  // pack must never destroy the last publishable artifact.
  let archive = await buildReproducibleZip(distFiles(distDir), 'DEFLATE');
  const wantsSignature = opts.sign === true || Boolean(opts.signingKey) || Boolean(opts.signingKeyPath);
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
  }
  const sha256 = createHash('sha256').update(archive).digest('hex');
  // The name carries the hash, so a new build never replaces a file a phone or
  // a CDN already has, whether or not the version changed.
  const zipName = packedZipName(packageName, version, sha256);
  return { archive, sha256, zipName, manifest, packageName, version, publisherFingerprint };
}

/** The most the Mentra App and Mentra's servers read of a served miniapp.json. */
const MAX_SERVED_MANIFEST_BYTES = 64 * 1024;

/** How long `pack --url` waits for the published miniapp.json. */
const PUBLISHED_MANIFEST_TIMEOUT_MS = 30_000;

/**
 * The versions the miniapp.json published at `url` lists, read now. Nothing
 * published there yet (the host answers 404) is an empty list. Anything else
 * that isn't this package's readable miniapp.json is an error: packing on
 * would write a list without the published versions, and uploading that would
 * leave every phone pinned to one of them with a pin that can't be met.
 */
async function publishedVersions(url: string, packageName: string, silent?: boolean): Promise<VersionEntry[]> {
  let manifestUrl: URL;
  try {
    manifestUrl = new URL('miniapp.json', url.replace(/(\/miniapp\.json)?\/*$/, '/'));
  } catch {
    throw new Error(`--url is not a URL: ${url}`);
  }
  if (manifestUrl.protocol !== 'https:' && manifestUrl.protocol !== 'http:') {
    throw new Error(`--url must be an http or https URL: ${url}`);
  }
  const cannotKeep = "so pack can't keep the versions published there";
  let response: Response;
  try {
    response = await fetch(manifestUrl, {
      headers: { 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(PUBLISHED_MANIFEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Could not reach ${manifestUrl}, ${cannotKeep}`, { cause: error });
  }
  if (response.status === 404) {
    if (!silent) console.log(`Nothing is published at ${manifestUrl} yet: starting a new versions list.`);
    return [];
  }
  if (!response.ok) throw new Error(`${manifestUrl} answered ${response.status}, ${cannotKeep}`);
  let served: unknown;
  try {
    served = JSON.parse(await response.text());
  } catch {
    throw new Error(`${manifestUrl} is not JSON, ${cannotKeep}`);
  }
  if (typeof served !== 'object' || served === null || Array.isArray(served)) {
    throw new Error(`${manifestUrl} is not a miniapp.json, ${cannotKeep}`);
  }
  const published = served as Record<string, unknown>;
  if (published.packageName !== packageName) {
    throw new Error(`${manifestUrl} is ${String(published.packageName)}'s miniapp.json, not ${packageName}'s`);
  }
  try {
    return listedVersions(published);
  } catch (error) {
    throw new Error(`${manifestUrl}: ${(error as Error).message}, ${cannotKeep}`);
  }
}

/**
 * The versions the last pack into `outDir` listed, for this package. An entry
 * whose ZIP is no longer in the folder is left out, with a warning: the folder
 * is what gets uploaded, and a listed version needs its ZIP online. An entry
 * with an absolute URL names a ZIP on another host, and is kept.
 */
function packedVersions(outDir: string, packageName: string, silent?: boolean): VersionEntry[] {
  const path = join(outDir, 'miniapp.json');
  let served: unknown;
  try {
    served = JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    // No earlier pack, or a file this pack is about to replace anyway.
    return [];
  }
  if (typeof served !== 'object' || served === null || Array.isArray(served)) return [];
  if ((served as Record<string, unknown>).packageName !== packageName) return [];
  let listed: VersionEntry[];
  try {
    listed = listedVersions(served as Record<string, unknown>);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}. Fix the list, or delete the file to start a new one.`);
  }
  return listed.filter((entry) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(entry.url) || entry.url.startsWith('/')) return true;
    const zip = resolve(outDir, entry.url);
    const inFolder = !relative(outDir, zip).split(sep).includes('..');
    if (inFolder && existsSync(zip) && lstatSync(zip).isFile()) return true;
    if (!silent) {
      console.warn(
        `Warning: ${entry.url} is not in ${outDir}, so version ${entry.version} is no longer listed. ` +
          'Pass --url to keep the versions your miniapp URL already serves.',
      );
    }
    return false;
  });
}

/** How many hex digits of its SHA-256 a ZIP's name carries. */
const ZIP_NAME_HASH_LENGTH = 8;

/** The name `pack` gives a build's ZIP: `<packageName>-<version>-<first 8 hex of its SHA-256>.zip`. */
export function packedZipName(packageName: string, version: string, sha256: string): string {
  return `${packageName}-${version}-${sha256.slice(0, ZIP_NAME_HASH_LENGTH)}.zip`;
}

/**
 * The ZIP the last pack into `outDir` wrote for this package and version: the
 * one that folder's miniapp.json names. Null when it names another release, or
 * a ZIP that isn't there. ZIPs of earlier builds stay in the folder, so the
 * newest can't be told from the file names.
 */
export function packedZipPath(outDir: string, packageName: string, version: string): string | null {
  try {
    const served = JSON.parse(readFileSync(join(outDir, 'miniapp.json'), 'utf-8')) as {
      packageName?: unknown;
      version?: unknown;
      bundle?: { url?: unknown };
    };
    const url = served.bundle?.url;
    if (served.packageName !== packageName || served.version !== version) return null;
    if (typeof url !== 'string' || !url.endsWith('.zip') || basename(url) !== url) return null;
    const path = join(outDir, url);
    return lstatSync(path).isFile() ? path : null;
  } catch {
    return null;
  }
}

/**
 * Every file under dist/, as the ZIP holds it: its path from dist/, with `/`
 * between folders. A link is followed, as `zip -r` followed it, so the ZIP
 * holds files only. A file that can't be read fails the pack.
 */
function distFiles(distDir: string): ZipFile[] {
  const files: ZipFile[] = [];
  const visited = new Set<string>();
  const walk = (dir: string, prefix: string) => {
    // A link back to a folder already being packed would never end.
    const real = realpathSync(dir);
    if (visited.has(real)) throw new Error(`dist/${prefix} links back into dist/, so it can't be packed`);
    visited.add(real);
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const entry = `${prefix}${name}`;
      let stat;
      try {
        stat = statSync(path);
      } catch (error) {
        throw new Error(`dist/${entry} can't be read, so it can't be packed`, { cause: error });
      }
      if (stat.isDirectory()) walk(path, `${entry}/`);
      else if (stat.isFile()) files.push({ entry, bytes: readFileSync(path) });
    }
    visited.delete(real);
  };
  walk(distDir, '');
  return files;
}

/** An icon path the host serves beside miniapp.json, as Mentra's publisher accepts one. */
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/;

/**
 * The icon miniapp.json names, read from the ZIP. Null when it is on another
 * host or isn't in the ZIP; the latter is warned about, since the served
 * miniapp.json would name a file the folder doesn't have.
 */
export async function iconFromArchive(
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
