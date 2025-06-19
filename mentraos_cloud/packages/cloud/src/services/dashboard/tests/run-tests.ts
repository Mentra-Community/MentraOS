/**
 * Dashboard Test Runner
 * 
 * Executes tests for the dashboard manager implementation.
 */
import { DashboardTestHarness } from './DashboardTestHarness';

// Create test harness
const testHarness = new DashboardTestHarness();

// Run tests with delay between each test
async function runTests() {
  console.log('\n-----------------------------------------');
  console.log('DASHBOARD SYSTEM - TEST SUITE');
  console.log('-----------------------------------------\n');
  
  // Run basic test
  await testHarness.runBasicTest();
  
  // Wait for the basic test to complete
  await new Promise(resolve => setTimeout(resolve, 6000));
  
  console.log('\n-----------------------------------------\n');
  
  // Run app lifecycle test
  await testHarness.runAppLifecycleTest();
  
  // Wait for the app lifecycle test to complete
  await new Promise(resolve => setTimeout(resolve, 6000));
  
  console.log('\n-----------------------------------------');
  console.log('ALL DASHBOARD TESTS COMPLETE');
  console.log('-----------------------------------------\n');
}

// Run the tests
runTests().catch(error => {
  console.error('Error running dashboard tests:', error);
  process.exit(1);
});