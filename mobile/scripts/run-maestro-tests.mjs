#!/usr/bin/env zx

/**
 * Runs Maestro E2E tests with proper device preparation
 *
 * Usage:
 *   bun test:maestro              # Run all flows
 *   bun test:maestro auth         # Run flows matching "auth"
 *   bun test:maestro --no-prep    # Skip device prep (for rapid iteration)
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mobileDir = path.resolve(__dirname, '..');
const outputDir = path.join(mobileDir, '.maestro', 'output');

// Parse args
const args = process.argv.slice(3); // skip node, zx, script
const skipPrep = args.includes('--no-prep');
const flowFilter = args.find(arg => !arg.startsWith('--'));

// Check for connected device
async function checkDevice() {
  const result = await $`adb devices`.quiet();
  const lines = result.stdout.trim().split('\n').slice(1);
  const devices = lines.filter(line => line.includes('device'));

  if (devices.length === 0) {
    console.error('ERROR: No Android device connected');
    console.error('Connect a device via USB and enable USB debugging');
    process.exit(1);
  }

  return devices[0].split('\t')[0];
}

// Prep the device
async function prepDevice() {
  console.log('');
  console.log('=== Preparing device for testing ===');
  await $({ stdio: 'inherit', cwd: mobileDir })`./scripts/prep-test-device.sh`;
}

// Prepare output directory
async function prepOutputDir() {
  // Create timestamped subfolder
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runDir = path.join(outputDir, timestamp);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

// Run Maestro tests
async function runTests(flowFilter) {
  const flowsDir = path.join(mobileDir, '.maestro', 'flows');
  const runDir = await prepOutputDir();

  console.log(`Screenshots will be saved to: ${runDir}`);

  let testPath = flowsDir;
  if (flowFilter) {
    // Find matching flow files
    const { stdout } = await $`ls ${flowsDir}`.quiet();
    const flows = stdout.trim().split('\n');
    const matching = flows.filter(f => f.toLowerCase().includes(flowFilter.toLowerCase()));

    if (matching.length === 0) {
      console.error(`No flows matching "${flowFilter}" found`);
      console.error('Available flows:', flows.join(', '));
      process.exit(1);
    }

    if (matching.length === 1) {
      testPath = path.join(flowsDir, matching[0]);
      console.log(`Running single flow: ${matching[0]}`);
    } else {
      console.log(`Running ${matching.length} matching flows:`, matching.join(', '));
      // Run each matching flow
      for (const flow of matching) {
        await $({ stdio: 'inherit', cwd: runDir })`maestro test --output ${runDir} -e MAESTRO_APP_ID=com.mentra.mentra ${path.join(flowsDir, flow)}`;
      }
      return;
    }
  }

  console.log('');
  console.log('=== Running Maestro tests ===');
  await $({ stdio: 'inherit', cwd: runDir })`maestro test --output ${runDir} -e MAESTRO_APP_ID=com.mentra.mentra ${testPath}`;
}

// Main
async function main() {
  const deviceId = await checkDevice();
  console.log(`Using device: ${deviceId}`);

  if (!skipPrep) {
    await prepDevice();
  } else {
    console.log('Skipping device prep (--no-prep)');
  }

  await runTests(flowFilter);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
