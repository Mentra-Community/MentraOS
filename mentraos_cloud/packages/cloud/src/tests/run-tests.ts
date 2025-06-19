/**
 * Test Runner for AugmentOS Cloud
 * 
 * Runs all the test suites for the cloud package.
 */

// Track test results
interface TestResult {
  suite: string;
  passed: boolean;
  summary: any;
  error?: Error;
}

// Run all test suites
async function runAllTests() {
  console.log('🔍 Starting AugmentOS Cloud tests...\n');
  
  const results: TestResult[] = [];
  
  // Test suites to run
  const suites: Array<{ name: string, runner: () => Promise<any> }> = [
    { 
      name: 'Basic Features', 
      runner: async () => {
        const module = await import('../services/layout/tests/scenarios/basic-features.test');
        await module.testBootQueueing();
        await module.testPerAppThrottling();
      }
    },
    { 
      name: 'Boot Scenarios', 
      runner: async () => {
        const module = await import('../services/layout/tests/scenarios/boot-scenarios.test');
        await module.testBootQueueAndProcess();
        await module.testPreBootDisplayPreservation();
        await module.testMultipleAppBoot();
        await module.testAppStopDuringBoot();
        await module.testNoDisplayRestoreForStoppedApps();
      }
    },
    { 
      name: 'Show Throttled After App Stop', 
      runner: async () => {
        const module = await import('../services/layout/tests/scenarios/show-throttled-after-app-stop.test');
        await module.testShowThrottledAfterAppStop();
        await module.testMultipleThrottledRequests();
        await module.testStoppedAppThrottledRequests();
      }
    },
    { 
      name: 'Simple Test', 
      runner: async () => {
        const module = await import('../services/layout/tests/scenarios/simple-test');
        await module.main();
      }
    },
    { 
      name: 'Stop App Display Bug Fix', 
      runner: async () => {
        const module = await import('../services/layout/tests/scenarios/stop-app-display-bug-fix.test');
        await module.testNoDisplayRestoreForStoppedApps();
      }
    },
    { 
      name: 'Transient Display Boot Test', 
      runner: async () => {
        const module = await import('../services/layout/tests/scenarios/transient-display-boot-test');
        await module.testTransientDisplayNotRestored();
      }
    }
  ];
  
  // Run each suite
  for (const suite of suites) {
    console.log(`\n🧪 Running ${suite.name} tests...`);
    try {
      const summary = await suite.runner();
      results.push({
        suite: suite.name,
        passed: true,
        summary
      });
      console.log(`✅ ${suite.name} tests passed!`);
    } catch (error) {
      results.push({
        suite: suite.name,
        passed: false,
        summary: null,
        error: error as Error
      });
      console.error(`❌ ${suite.name} tests failed:`, error);
    }
  }
  
  // Print summary
  console.log('\n📊 Test Results Summary:');
  console.log('------------------------');
  
  let passedCount = 0;
  let failedCount = 0;
  
  for (const result of results) {
    if (result.passed) {
      console.log(`✅ ${result.suite}: Passed`);
      passedCount++;
    } else {
      console.log(`❌ ${result.suite}: Failed - ${result.error?.message || 'Unknown error'}`);
      failedCount++;
    }
  }
  
  console.log('------------------------');
  console.log(`Total: ${results.length} suites, ${passedCount} passed, ${failedCount} failed`);
  
  return {
    total: results.length,
    passed: passedCount,
    failed: failedCount,
    results
  };
}

// Run the tests when this file is executed directly
if (require.main === module) {
  runAllTests()
    .then(summary => {
      if (summary.failed > 0) {
        console.log('\n❌ Some tests failed!');
        process.exit(1);
      } else {
        console.log('\n✅ All tests passed!');
        process.exit(0);
      }
    })
    .catch(error => {
      console.error('Test runner error:', error);
      process.exit(1);
    });
}

export { runAllTests };
