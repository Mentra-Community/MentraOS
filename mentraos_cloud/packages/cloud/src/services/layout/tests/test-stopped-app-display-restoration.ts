/**
 * Manual test for the stopped app display restoration fix.
 * 
 * This directly tests the specific method of DisplayManager that had the bug.
 */

import DisplayManager from '../DisplayManager6.1';
import { strict as assert } from 'assert';
import { systemApps } from '../../core/system-apps';

/**
 * Test that savedDisplayBeforeBoot is checked for app still running
 */
async function testSavedDisplayChecksAppRunning() {
  console.log('Testing that savedDisplayBeforeBoot checks if app is still running');
  
  // Create an instance of DisplayManager
  const displayManager = new DisplayManager();
  
  // Directly manipulate its internal state to simulate the bug scenario
  const stoppedAppName = 'com.example.stoppedapp';
  const runningAppName = 'com.example.runningapp';
  
  // Save some fake user session
  displayManager['userSession'] = {
    userId: 'test-user',
    activeAppSessions: [runningAppName], // Only the running app is active
    websocket: {
      readyState: 1,
      send: () => true
    },
    logger: console
  } as any;
  
  // Test 1: When app is stopped
  console.log('\nTest 1: Stopped app display should not be restored');
  
  // Keep track of sends with the stopped app name
  let stoppedAppDisplayRestored = false;
  
  // Set the saved display to be from a stopped app
  displayManager['displayState'].savedDisplayBeforeBoot = {
    displayRequest: {
      packageName: stoppedAppName,
      layout: { text: 'This is from stopped app' } as any
    },
    startedAt: new Date()
  } as any;
  
  // Empty boot queue
  displayManager['bootDisplayQueue'].clear();
  
  // Mock the necessary methods to detect if the app's display is being restored
  const originalSendToWebSocket = displayManager['sendToWebSocket'];
  
  // Mock sendToWebSocket to check what gets sent
  displayManager['sendToWebSocket'] = (displayRequest: any, ...args: any[]) => {
    // If this is a request to restore the stopped app's display, that's a bug
    if (displayRequest.packageName === stoppedAppName) {
      stoppedAppDisplayRestored = true;
      console.log('BUGGY BEHAVIOR: Stopped app display was incorrectly restored');
    } else {
      console.log(`Display sent: ${displayRequest.packageName} (this is OK if it's a dashboard clear)`);
    }
    return true; // Pretend send was successful
  };
  
  // Disable showNextDisplay to just focus on the saved display part
  const originalShowNextDisplay = displayManager['showNextDisplay'];
  displayManager['showNextDisplay'] = () => {
    console.log('showNextDisplay was called (expected)');
    // No-op for this test
  };
  
  // Call the method with the bug fix
  displayManager['processBootQueue']();
  
  // Restore original methods
  displayManager['showNextDisplay'] = originalShowNextDisplay;
  
  // Verify the stopped app's display was not restored
  assert.equal(stoppedAppDisplayRestored, false, 'Stopped app display should NOT be restored');
  
  // Test 2: When app is still running
  console.log('\nTest 2: Running app display should be restored');
  
  // Keep track of sends with the running app name
  let runningAppDisplayRestored = false;
  
  // Set the saved display to be from a running app
  displayManager['displayState'].savedDisplayBeforeBoot = {
    displayRequest: {
      packageName: runningAppName,
      layout: { text: 'This is from running app' } as any
    },
    startedAt: new Date()
  } as any;
  
  // Mock sendToWebSocket again
  displayManager['sendToWebSocket'] = (displayRequest: any, ...args: any[]) => {
    // If this is a request to restore the running app's display, that's what we want
    if (displayRequest.packageName === runningAppName) {
      runningAppDisplayRestored = true;
      console.log('CORRECT BEHAVIOR: Running app display was properly restored');
    } else {
      console.log(`Display sent: ${displayRequest.packageName}`);
    }
    return true; // Pretend send was successful
  };
  
  // Disable showNextDisplay for this test
  displayManager['showNextDisplay'] = () => {
    console.log('showNextDisplay was called (should not happen with running app)');
  };
  
  // Call the method with the bug fix
  displayManager['processBootQueue']();
  
  // Verify the running app's display WAS restored
  assert.equal(runningAppDisplayRestored, true, 'Running app display should be restored');
  
  // Restore original methods
  displayManager['sendToWebSocket'] = originalSendToWebSocket;
  displayManager['showNextDisplay'] = originalShowNextDisplay;
  
  console.log('\n✅ Test passed! The fix correctly prevents restoring displays from stopped apps.');
}

// Run the test
if (require.main === module) {
  (async () => {
    try {
      await testSavedDisplayChecksAppRunning();
      console.log('\nAll tests completed successfully');
    } catch (error) {
      console.error('\nTest failed:', error);
      process.exit(1);
    }
  })();
}