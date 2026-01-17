#!/usr/bin/env zx

/**
 * Runs Live Captions E2E test with audio injection
 *
 * This script:
 *   1. Preps the device (wake, push audio files, etc.)
 *   2. Starts Maestro test in background
 *   3. Waits for Live Captions to start
 *   4. Injects test audio
 *   5. Waits for Maestro to complete and verify transcript
 *
 * Usage:
 *   bun test:maestro:captions                  # Default: uses 09-live-captions-full-e2e.yaml
 *   bun test:maestro:captions --quick          # Uses simpler 08 flow (assumes logged in)
 *   bun test:maestro:captions kangaroos        # Use different audio file
 *   bun test:maestro:captions --quick hello    # Quick mode with specific audio
 *
 * Environment variables (required):
 *   E2E_TEST_EMAIL - Test account email
 *   E2E_TEST_PASSWORD - Test account password
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(__dirname, '..');

// Parse args
const args = process.argv.slice(3);
const quickMode = args.includes('--quick');
const audioArg = args.find(a => !a.startsWith('--')) || 'hello';

// Validate environment variables
if (!process.env.E2E_TEST_EMAIL || !process.env.E2E_TEST_PASSWORD) {
  console.error('ERROR: Missing required environment variables');
  console.error('  E2E_TEST_EMAIL and E2E_TEST_PASSWORD must be set');
  console.error('');
  console.error('For local dev, add to ~/.zshrc:');
  console.error('  export E2E_TEST_EMAIL="your-test-email"');
  console.error('  export E2E_TEST_PASSWORD="your-test-password"');
  process.exit(1);
}

console.log('');
console.log('=== Live Captions E2E Test with Audio Injection ===');
console.log(`Mode: ${quickMode ? 'quick (assumes logged in)' : 'full (handles login)'}`);
console.log(`Audio: ${audioArg}`);
console.log('');

// Step 1: Prep device
console.log('Step 1: Preparing device...');
await $({ stdio: 'inherit', cwd: mobileDir })`./scripts/prep-test-device.sh`;

// Step 2: Start Maestro test in background
console.log('');
console.log('Step 2: Starting Maestro test...');

// Choose flow based on mode
const flowFile = quickMode
  ? '08-live-captions-with-audio.yaml'
  : '09-live-captions-full-e2e.yaml';
const maestroFlow = path.join(mobileDir, '.maestro/flows', flowFile);

console.log(`  Using flow: ${flowFile}`);

// Build env args for Maestro
const envArgs = [
  '-e', `MAESTRO_APP_ID=com.mentra.mentra`,
  '-e', `E2E_TEST_EMAIL=${process.env.E2E_TEST_EMAIL}`,
  '-e', `E2E_TEST_PASSWORD=${process.env.E2E_TEST_PASSWORD}`,
];

// Run Maestro in background
const maestroProcess = $({
  cwd: mobileDir,
  stdio: 'pipe'
})`maestro test ${envArgs} ${maestroFlow}`;

// Step 3: Wait for Live Captions to start
// Login + onboarding + activate captions takes ~25s
// Need to wait until Captions is fully initialized before injecting
const waitTime = quickMode ? 15000 : 35000;
console.log(`Step 3: Waiting for Live Captions to start (${waitTime/1000}s)...`);
await sleep(waitTime);

// Step 4: Inject test audio
console.log('');
console.log(`Step 4: Injecting test audio (${audioArg})...`);
try {
  await $({ stdio: 'inherit', cwd: mobileDir })`./scripts/inject-test-audio.sh ${audioArg}`;
} catch (e) {
  console.error('Warning: Audio injection may have failed:', e.message);
}

// Step 5: Wait for audio to play and be transcribed
console.log('');
console.log('Step 5: Waiting for transcription (15s)...');
await sleep(15000);

// Step 6: Wait for Maestro to complete
console.log('');
console.log('Step 6: Waiting for Maestro test to complete...');
try {
  const result = await maestroProcess;
  console.log(result.stdout);
  console.log('');
  console.log('=== Test PASSED ===');
} catch (e) {
  console.error('Maestro test output:');
  console.error(e.stdout || e.message);
  if (e.stderr) {
    console.error(e.stderr);
  }
  console.error('');
  console.error('=== Test FAILED ===');
  process.exit(1);
}
