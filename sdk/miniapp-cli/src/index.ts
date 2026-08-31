#!/usr/bin/env bun

import { dev } from './dev.js';
import { release } from './release.js';
import { pack } from './pack.js';
import { schemaPrint, regenerateSchemaFile } from './schema.js';
import { addPermissionCmd, listPermissionsCmd, removePermissionCmd } from './permission.js';
import { addHardwareCmd, listHardwareCmd, removeHardwareCmd } from './hardware.js';
import { runManifestWizard } from './manifest-wizard.js';
import {
  createAndSavePackageSigningKey,
  exportPackageSigningKey,
  importPackageSigningKey,
  loadPackageSigningKey,
  publisherKeyFingerprint,
} from './package-signing-key.js';

const subcommand = process.argv[2];
const subcommandArg = process.argv[3];

function printUsage(): void {
  console.log('Usage: mentra-miniapp <command>\n');
  console.log('Commands:');
  console.log('  dev                              Start dev server with hot reload and QR code');
  console.log('                                   Options: --qr-output <path>  write PNG QR to path');
  console.log('  release                          Build, pack, and serve a QR to install on a phone');
  console.log('                                   Options: --no-cache  --qr-output <path>  --signing-key <path>');
  console.log(
    '  pack                             Production-build and sign miniapp (--no-build, --signing-key <path>)',
  );
  console.log('  keys create <package>            Create a durable publisher signing key');
  console.log('  keys show <package>              Show a publisher signing key fingerprint');
  console.log('  keys import <package> <path>     Import a publisher signing key');
  console.log('  keys export <package> <path>     Export a publisher signing key backup');
  console.log('  manifest                         Edit miniapp.json interactively');
  console.log('  permission list                  List declared permissions');
  console.log('  permission add [TYPE]            Add a permission (interactive without TYPE)');
  console.log('  permission remove [TYPE]         Remove a declared permission');
  console.log('  hardware list                    List declared hardware requirements');
  console.log('  hardware add [TYPE] [LEVEL]      Add a hardware requirement');
  console.log('  hardware remove [TYPE]           Remove a declared hardware requirement');
  console.log('  schema print                     Print the miniapp.json JSON Schema to stdout');
  console.log('  schema regenerate                Regenerate the published schema file (CLI internal)');
}

function flagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  if (!value || value.startsWith('-')) {
    console.error(`Error: ${flag} requires a path argument`);
    process.exit(1);
  }
  return value;
}

switch (subcommand) {
  case 'dev':
    await dev({ qrOutput: flagValue('--qr-output') });
    break;
  case 'release':
    await release({
      noCache: process.argv.includes('--no-cache'),
      qrOutput: flagValue('--qr-output'),
      signingKeyPath: flagValue('--signing-key'),
    });
    break;
  case 'pack':
    // Build with NODE_ENV=production before zipping, so `pack` never ships
    // a stale dev-mode dist/ left behind by `dev`. `--no-build` zips dist/
    // as-is for callers that manage the build themselves.
    await pack({
      build: !process.argv.includes('--no-build'),
      signingKeyPath: flagValue('--signing-key'),
    });
    break;
  case 'keys': {
    const operation = subcommandArg;
    const packageName = process.argv[4];
    if (!packageName) {
      console.error('Usage: mentra-miniapp keys <create|show|import|export> <packageName> [path]');
      process.exit(1);
    }
    if (operation === 'create') {
      const { key, storage } = await createAndSavePackageSigningKey(packageName);
      console.log(`Created ${publisherKeyFingerprint(key.publicKeyJwk)} for ${packageName} in ${storage}`);
    } else if (operation === 'show') {
      const key = await loadPackageSigningKey(packageName);
      if (!key) throw new Error(`No publisher signing key exists for ${packageName}`);
      console.log(publisherKeyFingerprint(key.publicKeyJwk));
    } else if (operation === 'import') {
      const inputPath = process.argv[5];
      if (!inputPath) throw new Error('keys import requires an input path');
      const { key, storage } = await importPackageSigningKey(packageName, inputPath);
      console.log(`Imported ${publisherKeyFingerprint(key.publicKeyJwk)} for ${packageName} into ${storage}`);
    } else if (operation === 'export') {
      const outputPath = process.argv[5];
      if (!outputPath) throw new Error('keys export requires an output path');
      console.log(await exportPackageSigningKey(packageName, outputPath));
      console.log('Keep this private key file secret and store it in a secure backup system.');
    } else {
      console.error('Usage: mentra-miniapp keys <create|show|import|export> <packageName> [path]');
      process.exit(1);
    }
    break;
  }
  case 'manifest':
    await runManifestWizard();
    break;
  case 'permission':
    if (subcommandArg === 'list') {
      await listPermissionsCmd();
    } else if (subcommandArg === 'add') {
      await addPermissionCmd(process.argv[4]);
    } else if (subcommandArg === 'remove') {
      await removePermissionCmd(process.argv[4]);
    } else {
      console.error('Usage: mentra-miniapp permission <list|add|remove> [TYPE]');
      process.exit(1);
    }
    break;
  case 'hardware':
    if (subcommandArg === 'list') {
      await listHardwareCmd();
    } else if (subcommandArg === 'add') {
      await addHardwareCmd(process.argv[4], process.argv[5]);
    } else if (subcommandArg === 'remove') {
      await removeHardwareCmd(process.argv[4]);
    } else {
      console.error('Usage: mentra-miniapp hardware <list|add|remove> [TYPE] [LEVEL]');
      process.exit(1);
    }
    break;
  case 'schema':
    if (subcommandArg === 'print') {
      schemaPrint();
    } else if (subcommandArg === 'regenerate') {
      regenerateSchemaFile();
    } else {
      console.error('Usage: mentra-miniapp schema <print|regenerate>');
      process.exit(1);
    }
    break;
  default:
    printUsage();
    process.exit(subcommand ? 1 : 0);
}
