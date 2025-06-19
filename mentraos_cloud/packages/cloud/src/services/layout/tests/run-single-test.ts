#!/usr/bin/env bun

/**
 * Run a single test file to debug issues
 */

import * as path from 'path';

const testFile = process.argv[2];

if (!testFile) {
  console.error('Please provide a test file to run');
  process.exit(1);
}

// Resolve the test file path
const testFilePath = path.resolve(__dirname, 'scenarios', `${testFile}.test.ts`);

console.log(`Running test file: ${testFilePath}`);

// Import and run the test functions
import(testFilePath)
  .then(async (module) => {
    // Find all exported test functions (those starting with "test")
    const testFunctions = Object.entries(module)
      .filter(([name, value]) => name.startsWith('test') && typeof value === 'function')
      .map(([name, func]) => ({ name, func }));
      
    console.log(`Found ${testFunctions.length} tests`);
    
    // Run each test function
    for (const { name, func } of testFunctions) {
      console.log(`\n▶️ Running test: ${name}`);
      
      try {
        await func();
        console.log(`✅ Test passed: ${name}`);
      } catch (error) {
        console.log(`❌ Test failed: ${name}`);
        console.error(error);
      }
    }
  })
  .catch((error) => {
    console.error('Error loading test file:', error);
    process.exit(1);
  });