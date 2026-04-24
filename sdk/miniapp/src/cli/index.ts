#!/usr/bin/env bun

import { dev } from './dev.js';
import { pack } from './pack.js';

const subcommand = process.argv[2];

switch (subcommand) {
  case 'dev':
    await dev();
    break;
  case 'pack':
    await pack();
    break;
  default:
    console.log('Usage: mentra-miniapp <command>\n');
    console.log('Commands:');
    console.log('  dev   Start dev server with hot reload and QR code');
    console.log('  pack  Package miniapp into a distributable ZIP');
    process.exit(subcommand ? 1 : 0);
}
