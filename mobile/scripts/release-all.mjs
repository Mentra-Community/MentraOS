#!/usr/bin/env zx

// Orchestrates a full release by delegating to the platform-specific scripts.
// All Android logic lives in release-android.mjs; all iOS logic in release-ios.mjs.
//
// Each child script writes its summary block to a file (see SUMMARY_PATHS in
// release-utils.mjs). We re-print both summaries at the very end so they don't
// get buried under the next script's output.

import { readFile, rm } from 'fs/promises';
import { SUMMARY_PATHS } from './release-utils.mjs';

// Clear stale summaries from previous runs.
for (const filePath of Object.values(SUMMARY_PATHS)) {
  await rm(filePath, { force: true });
}

console.log('\n━━━ Running Android release ━━━');
await $({ stdio: 'inherit' })`zx ./scripts/release-android.mjs`;

console.log('\n━━━ Running iOS release ━━━');
await $({ stdio: 'inherit' })`zx ./scripts/release-ios.mjs`;

// Re-print both summaries at the bottom so they're visible together.
console.log('\n━━━ Release summary ━━━\n');
for (const filePath of Object.values(SUMMARY_PATHS)) {
  try {
    const content = await readFile(filePath, 'utf-8');
    console.log(content);
  } catch {
    // Summary file missing — child script bailed before writing it.
  }
}
