#!/usr/bin/env zx

console.log('Running preinstall...');

// Navigate to parent directory and run bun install
await $({ stdio: 'inherit', cwd: '..' })`bun install`;

console.log('✅ Preinstall completed successfully!');
