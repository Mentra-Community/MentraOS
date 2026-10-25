#!/usr/bin/env zx
import { copyPublicMiniapps } from './local-miniapps.mjs';

console.log('Running preinstall...');

// The root workspace lists miniapps/*: in the Mentra monorepo, put the public
// miniapps' copies there first, or the install rewrites its lockfile without them.
copyPublicMiniapps();

// Navigate to parent directory and run bun install
await $({ stdio: 'inherit', cwd: '..' })`bun install`;

console.log('✅ Preinstall completed successfully!');
