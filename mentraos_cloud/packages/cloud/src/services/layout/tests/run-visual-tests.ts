#!/usr/bin/env bun

/**
 * Visual test runner for DisplayManager tests
 * 
 * This script runs all test scenarios with visual output enabled.
 */

import { readdirSync } from 'fs';
import { join } from 'path';
// Use simple ANSI color codes instead of chalk for Bun compatibility
const colors = {
  blue: (text: string) => `\x1b[34m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`
};

// Override console.log to add timestamps
const originalConsoleLog = console.log;
console.log = function(...args) {
  const date = new Date();
  const timestamp = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}.${date.getMilliseconds().toString().padStart(3, '0')}`;
  originalConsoleLog.apply(console, [`[${timestamp}]`, ...args]);
};

// Find all test files
const scenariosDir = join(__dirname, 'scenarios');
const testFiles = readdirSync(scenariosDir)
  .filter(file => file.endsWith('.test.ts'))
  .map(file => join(scenariosDir, file));

// Results tracking
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failedTestNames: string[] = [];

// Run each test file
async function runTests() {
  console.log(colors.blue('=== DisplayManager Visual Tests ==='));
  console.log(colors.blue(`Found ${testFiles.length} test files`));
  
  for (const testFile of testFiles) {
    console.log(colors.yellow(`\nRunning tests in ${testFile}...`));
    
    try {
      // Import the test file
      const module = await import(testFile);
      
      // Get all exported test functions (any function starting with "test")
      const testFunctions = Object.entries(module)
        .filter(([name, value]) => name.startsWith('test') && typeof value === 'function')
        .map(([name, func]) => ({ name, func }));
      
      console.log(colors.yellow(`Found ${testFunctions.length} tests`));
      
      // Run each test function
      for (const { name, func } of testFunctions) {
        totalTests++;
        console.log(colors.cyan(`\n▶️ Running test: ${name}`));
        
        try {
          await func();
          passedTests++;
          console.log(colors.green(`✅ Test passed: ${name}`));
        } catch (error) {
          failedTests++;
          failedTestNames.push(name);
          console.log(colors.red(`❌ Test failed: ${name}`));
          console.log(colors.red(error));
        }
      }
    } catch (error) {
      console.log(colors.red(`❌ Error loading test file: ${testFile}`));
      console.log(colors.red(error));
    }
  }
  
  // Print summary
  console.log(colors.blue('\n=== Test Summary ==='));
  console.log(colors.blue(`Total tests: ${totalTests}`));
  console.log(colors.green(`Passed: ${passedTests}`));
  console.log(colors.red(`Failed: ${failedTests}`));
  
  if (failedTestNames.length > 0) {
    console.log(colors.red('\nFailed tests:'));
    failedTestNames.forEach(name => console.log(colors.red(`- ${name}`)));
  }
  
  // Exit with appropriate code
  process.exit(failedTests > 0 ? 1 : 0);
}

runTests().catch(error => {
  console.log(colors.red('Fatal error running tests:'));
  console.log(colors.red(error));
  process.exit(1);
});