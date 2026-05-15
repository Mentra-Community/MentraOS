#!/usr/bin/env bun

import { dev } from './dev.js';
import { release } from './release.js';
import { pack } from './pack.js';
import { schemaPrint, regenerateSchemaFile } from './schema.js';
import { addPermissionCmd, listPermissionsCmd, removePermissionCmd } from './permission.js';
import { addHardwareCmd, listHardwareCmd, removeHardwareCmd } from './hardware.js';
import { runManifestWizard } from './manifest-wizard.js';

const subcommand = process.argv[2];
const subcommandArg = process.argv[3];

function printUsage(): void {
  console.log('Usage: mentra-miniapp <command>\n');
  console.log('Commands:');
  console.log('  dev                              Start dev server with hot reload and QR code');
  console.log('  release                          Build, pack, and serve a QR to install on a phone');
  console.log('  pack                             Package miniapp into a distributable ZIP');
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

switch (subcommand) {
  case 'dev':
    await dev();
    break;
  case 'release':
    await release({noCache: process.argv.includes('--no-cache')});
    break;
  case 'pack':
    await pack();
    break;
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
